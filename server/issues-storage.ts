// Issues + metrics storage layer for the crashctl-style telemetry pipeline.
// Split from server/storage.ts because the surface is new and self-contained
// (fingerprinting, auto-reopen-on-version-bump, semver comparison, percentile
// summaries) and lives behind its own /api/v1 surface.
//
// Schema lives in shared/schema.ts (issues, issue_events, app_metrics).

import { createHash } from "crypto";
import { db } from "./db";
import { issues, issueEvents, appMetrics } from "@shared/schema";
import type { Issue, IssueEvent, AppMetric } from "@shared/schema";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

// ─── fingerprinting ─────────────────────────────────────────────────────────

const VOLATILE_RE = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuid
  /\b[0-9a-f]{32}\b/gi,                                                  // md5/sha-ish
  /\b\d{10,}\b/g,                                                        // long numbers (timestamps, ids)
  /\bhttps?:\/\/\S+/g,                                                    // urls
  /\b\d+ms\b/g,                                                          // durations
  /\battempt \d+\/\d+/gi,                                                // "attempt 3/5"
  /:\d+:\d+/g,                                                           // :line:col
];

export function normalizeMessage(msg: string): string {
  let out = (msg || "").substring(0, 500);
  for (const re of VOLATILE_RE) out = out.replace(re, "X");
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

// Pull the first frame that looks like app code. Falls back to first line.
export function topStackFrame(stack: string | null | undefined): string | null {
  if (!stack) return null;
  const lines = stack.split("\n").map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/node_modules|react-native\/Libraries|InternalBytecode|hermes:/.test(line)) continue;
    if (/^at\s+/i.test(line) || /\.[jt]sx?:\d+/.test(line)) return line.substring(0, 200);
  }
  return (lines[0] || "").substring(0, 200);
}

export function computeFingerprint(source: string | null | undefined, message: string, stack: string | null | undefined): string {
  const norm = normalizeMessage(message);
  const frame = topStackFrame(stack) || "";
  // Hash on (source, normalized message, top frame). Source matters because the
  // same NPE through error-boundary vs global-error has very different fix paths.
  return createHash("sha1").update(`${source || ""}|${norm}|${frame}`).digest("hex").slice(0, 16);
}

export function deriveExceptionType(message: string): string | null {
  // "TypeError: Cannot read property 'x' of undefined" → "TypeError"
  const m = (message || "").match(/^([A-Z][A-Za-z]+Error|[A-Z][A-Za-z]+Exception)/);
  return m ? m[1] : null;
}

// ─── semver compare (for auto-reopen) ───────────────────────────────────────

function parseVer(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const m = v.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

// Returns true when `a` is strictly newer than `b`. If either is unparseable,
// we default to true — better to falsely reopen than to silently miss a
// regression.
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = parseVer(a), pb = parseVer(b);
  if (!pa || !pb) return true;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

// ─── ingest ─────────────────────────────────────────────────────────────────

export interface IngestEventInput {
  message: string;
  stack?: string | null;
  source?: string | null;
  severity?: "fatal" | "nonfatal" | "warn";
  deviceId?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  breadcrumbs?: any;
  metadata?: any;
  // Optional explicit fingerprint — used when migrating from legacy hash.
  fingerprintOverride?: string;
}

export interface IngestEventResult {
  fingerprint: string;
  status: string;
  isNew: boolean;
  isRegression: boolean;
}

// Insert one event + upsert the parent issue. Wrapped in a single tx so
// the issue counters never drift from issue_events row count. Uses
// INSERT ... ON CONFLICT DO NOTHING for the new-row path so two events with
// the same fingerprint arriving concurrently can't violate the PK — whichever
// loses the race falls through to the UPDATE branch below.
export async function ingestEvent(input: IngestEventInput): Promise<IngestEventResult> {
  const fp = input.fingerprintOverride || computeFingerprint(input.source, input.message, input.stack);
  const exception = deriveExceptionType(input.message);
  const frame = topStackFrame(input.stack);
  const severity: "fatal" | "nonfatal" | "warn" = input.severity || "nonfatal";

  return await db.transaction(async (tx) => {
    const title = (input.message || "(no message)").substring(0, 300);
    const inserted = await tx.insert(issues).values({
      fingerprint: fp,
      title,
      exception,
      source: input.source || null,
      severity,
      status: "active",
      firstSeen: new Date(),
      lastSeen: new Date(),
      count: 1,
      uniqueDeviceCount: input.deviceId ? 1 : 0,
      platforms: input.platform ? [input.platform] : [],
      appVersions: input.appVersion ? [input.appVersion] : [],
      topStackFrame: frame,
      topMessage: title,
    }).onConflictDoNothing({ target: issues.fingerprint }).returning({ fp: issues.fingerprint });

    const isNew = inserted.length > 0;
    let isRegression = false;
    let newStatus: string = "active";

    if (!isNew) {
      const [cur] = await tx.select().from(issues).where(eq(issues.fingerprint, fp)).limit(1);
      if (!cur) {
        // Vanishingly rare — row inserted then immediately deleted between
        // our INSERT and SELECT. Bail without touching counters.
        await tx.insert(issueEvents).values({
          fingerprint: fp,
          deviceId: input.deviceId || null,
          platform: input.platform || null,
          appVersion: input.appVersion || null,
          message: (input.message || "").substring(0, 5000),
          stack: input.stack ? input.stack.substring(0, 10000) : null,
          breadcrumbs: input.breadcrumbs || null,
          source: input.source || null,
          metadata: input.metadata || null,
        });
        return { fingerprint: fp, status: "active", isNew: false, isRegression: false };
      }
      // Auto-reopen: a resolved issue surfaces again on a newer build → regressed.
      // "Newer" means either a higher appVersion (native build bump) OR — for
      // OTA-shipped fixes where appVersion stays put — a metadata.ota.createdAt
      // strictly greater than the OTA snapshot we captured at resolve time.
      // Same-build recurrence keeps the "resolved" mark (probably stale device).
      const versionNewer = isNewerVersion(input.appVersion, cur.resolvedAtVersion);
      const eventOtaCreatedRaw = input.metadata?.ota?.createdAt;
      const eventOtaCreated = eventOtaCreatedRaw ? new Date(eventOtaCreatedRaw) : null;
      const otaNewer = !!(cur.resolvedAtUpdateCreatedAt && eventOtaCreated
        && eventOtaCreated.getTime() > cur.resolvedAtUpdateCreatedAt.getTime());
      if (cur.status === "resolved" && (versionNewer || otaNewer)) {
        isRegression = true;
        newStatus = "regressed";
      } else if (cur.status === "regressed") {
        newStatus = "regressed";
      } else if (cur.status === "archived") {
        // Archived stays archived. We still record the event so we can un-archive
        // manually if the volume warrants it, but no status flip.
        newStatus = "archived";
      } else {
        newStatus = "active";
      }
      // Bump severity if a fatal occurrence arrives for a nonfatal issue.
      const nextSeverity = severity === "fatal" ? "fatal" : cur.severity;

      const nextPlatforms = input.platform && !cur.platforms.includes(input.platform)
        ? [...cur.platforms, input.platform].slice(-8) : cur.platforms;
      const nextVersions = input.appVersion && !cur.appVersions.includes(input.appVersion)
        ? [...cur.appVersions, input.appVersion].slice(-12) : cur.appVersions;

      await tx.update(issues).set({
        lastSeen: new Date(),
        count: cur.count + 1,
        // Cheap approximation — UNIQUE COUNT(DISTINCT device_id) computed lazily by
        // listIssues; this column is just a hint used for sorting.
        uniqueDeviceCount: cur.uniqueDeviceCount + (input.deviceId ? 1 : 0),
        platforms: nextPlatforms,
        appVersions: nextVersions,
        severity: nextSeverity,
        status: newStatus,
        topStackFrame: cur.topStackFrame || frame,
        topMessage: cur.topMessage || input.message.substring(0, 300),
      }).where(eq(issues.fingerprint, fp));
    }

    await tx.insert(issueEvents).values({
      fingerprint: fp,
      deviceId: input.deviceId || null,
      platform: input.platform || null,
      appVersion: input.appVersion || null,
      message: (input.message || "").substring(0, 5000),
      stack: input.stack ? input.stack.substring(0, 10000) : null,
      breadcrumbs: input.breadcrumbs || null,
      source: input.source || null,
      metadata: input.metadata || null,
    });

    return { fingerprint: fp, status: newStatus, isNew, isRegression };
  });
}

// ─── list / get ─────────────────────────────────────────────────────────────

export interface ListIssuesFilters {
  status?: "active" | "resolved" | "regressed" | "archived" | "all";
  severity?: "fatal" | "nonfatal" | "warn";
  q?: string;
  version?: string;
  platform?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  sort?: "last_seen" | "count" | "users" | "first_seen";
}

export async function listIssues(filters: ListIssuesFilters): Promise<Issue[]> {
  const conds: any[] = [];
  const status = filters.status || "active";
  if (status !== "all") {
    if (status === "active") {
      // "active" view should include regressed — they're the most urgent thing.
      conds.push(inArray(issues.status, ["active", "regressed"]));
    } else {
      conds.push(eq(issues.status, status));
    }
  }
  if (filters.severity) conds.push(eq(issues.severity, filters.severity));
  if (filters.q) {
    const needle = `%${filters.q}%`;
    conds.push(or(ilike(issues.title, needle), ilike(issues.topMessage, needle)));
  }
  if (filters.version) conds.push(sql`${filters.version} = ANY(${issues.appVersions})`);
  if (filters.platform) conds.push(sql`${filters.platform} = ANY(${issues.platforms})`);
  if (filters.since) conds.push(gte(issues.lastSeen, filters.since));
  if (filters.until) conds.push(lte(issues.lastSeen, filters.until));

  const sortCol =
    filters.sort === "count" ? desc(issues.count) :
    filters.sort === "users" ? desc(issues.uniqueDeviceCount) :
    filters.sort === "first_seen" ? desc(issues.firstSeen) :
    desc(issues.lastSeen);

  return db.select().from(issues)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sortCol)
    .limit(Math.min(filters.limit || 50, 500));
}

export async function getIssue(fingerprint: string, eventsLimit: number = 20): Promise<{ issue: Issue | null; events: IssueEvent[] }> {
  const [issue] = await db.select().from(issues).where(eq(issues.fingerprint, fingerprint)).limit(1);
  if (!issue) return { issue: null, events: [] };
  const events = await db.select().from(issueEvents)
    .where(eq(issueEvents.fingerprint, fingerprint))
    .orderBy(desc(issueEvents.createdAt))
    .limit(Math.min(eventsLimit, 200));
  return { issue, events };
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

export async function resolveIssue(
  fp: string,
  version: string,
  note: string | null,
  by: string | null,
  ota?: { updateId: string | null; createdAt: Date | null },
): Promise<Issue | null> {
  const [updated] = await db.update(issues).set({
    status: "resolved",
    resolvedAt: new Date(),
    resolvedAtVersion: version,
    resolvedAtUpdateId: ota?.updateId || null,
    resolvedAtUpdateCreatedAt: ota?.createdAt || null,
    resolvedNote: note,
    resolvedBy: by,
  }).where(eq(issues.fingerprint, fp)).returning();
  return updated || null;
}

export async function reopenIssue(fp: string): Promise<Issue | null> {
  const [updated] = await db.update(issues).set({
    status: "active",
    resolvedAt: null,
    resolvedAtVersion: null,
    resolvedAtUpdateId: null,
    resolvedAtUpdateCreatedAt: null,
    resolvedNote: null,
    resolvedBy: null,
    archivedAt: null,
  }).where(eq(issues.fingerprint, fp)).returning();
  return updated || null;
}

export async function archiveIssue(fp: string): Promise<Issue | null> {
  const [updated] = await db.update(issues).set({
    status: "archived",
    archivedAt: new Date(),
  }).where(eq(issues.fingerprint, fp)).returning();
  return updated || null;
}

// Fold one fingerprint's events into another (when grouping was too granular).
// The source row is archived rather than deleted so the merge is reversible
// by manually reopening it.
export async function mergeIssue(fromFp: string, intoFp: string): Promise<{ merged: number; into: Issue | null }> {
  if (fromFp === intoFp) return { merged: 0, into: null };
  return await db.transaction(async (tx) => {
    const [from] = await tx.select().from(issues).where(eq(issues.fingerprint, fromFp)).limit(1);
    const [into] = await tx.select().from(issues).where(eq(issues.fingerprint, intoFp)).limit(1);
    if (!from || !into) return { merged: 0, into: into || null };

    const updated = await tx.update(issueEvents)
      .set({ fingerprint: intoFp })
      .where(eq(issueEvents.fingerprint, fromFp))
      .returning({ id: issueEvents.id });

    const mergedPlatforms = Array.from(new Set([...into.platforms, ...from.platforms])).slice(-8);
    const mergedVersions = Array.from(new Set([...into.appVersions, ...from.appVersions])).slice(-12);
    const [next] = await tx.update(issues).set({
      count: into.count + from.count,
      uniqueDeviceCount: into.uniqueDeviceCount + from.uniqueDeviceCount,
      platforms: mergedPlatforms,
      appVersions: mergedVersions,
      lastSeen: from.lastSeen > into.lastSeen ? from.lastSeen : into.lastSeen,
      firstSeen: from.firstSeen < into.firstSeen ? from.firstSeen : into.firstSeen,
      severity: from.severity === "fatal" ? "fatal" : into.severity,
    }).where(eq(issues.fingerprint, intoFp)).returning();

    const mergeNote = `${from.resolvedNote ? from.resolvedNote + " " : ""}[merged into ${intoFp}]`;
    await tx.update(issues).set({
      status: "archived",
      archivedAt: new Date(),
      resolvedNote: mergeNote,
    }).where(eq(issues.fingerprint, fromFp));

    return { merged: updated.length, into: next || null };
  });
}

// ─── stats ──────────────────────────────────────────────────────────────────

export async function getStats(): Promise<{
  lastHour: number;
  last24h: number;
  last7d: number;
  fatal24h: number;
  uniqueDevices24h: number;
  activeIssues: number;
  regressedIssues: number;
  byVersion: { appVersion: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
  bySource: { source: string; count: number }[];
}> {
  const now = Date.now();
  const h1 = new Date(now - 60 * 60 * 1000);
  const d1 = new Date(now - 24 * 60 * 60 * 1000);
  const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const [counts] = await db.select({
    lastHour: sql<number>`COUNT(*) FILTER (WHERE ${issueEvents.createdAt} > ${h1})`,
    last24h: sql<number>`COUNT(*) FILTER (WHERE ${issueEvents.createdAt} > ${d1})`,
    last7d: sql<number>`COUNT(*) FILTER (WHERE ${issueEvents.createdAt} > ${d7})`,
    uniqueDevices24h: sql<number>`COUNT(DISTINCT ${issueEvents.deviceId}) FILTER (WHERE ${issueEvents.createdAt} > ${d1})`,
  }).from(issueEvents);

  const [fatalCounts] = await db.select({
    fatal24h: sql<number>`COUNT(*) FILTER (WHERE ${issues.severity} = 'fatal')`,
    activeIssues: sql<number>`COUNT(*) FILTER (WHERE ${issues.status} IN ('active','regressed'))`,
    regressedIssues: sql<number>`COUNT(*) FILTER (WHERE ${issues.status} = 'regressed')`,
  }).from(issues);

  const byVersion = await db.select({
    appVersion: sql<string>`COALESCE(${issueEvents.appVersion}, 'unknown')`,
    count: sql<number>`COUNT(*)`,
  }).from(issueEvents).where(gte(issueEvents.createdAt, d7))
    .groupBy(sql`COALESCE(${issueEvents.appVersion}, 'unknown')`)
    .orderBy(desc(sql`COUNT(*)`)).limit(10);

  const byPlatform = await db.select({
    platform: sql<string>`COALESCE(${issueEvents.platform}, 'unknown')`,
    count: sql<number>`COUNT(*)`,
  }).from(issueEvents).where(gte(issueEvents.createdAt, d7))
    .groupBy(sql`COALESCE(${issueEvents.platform}, 'unknown')`)
    .orderBy(desc(sql`COUNT(*)`)).limit(10);

  const bySource = await db.select({
    source: sql<string>`COALESCE(${issueEvents.source}, 'unknown')`,
    count: sql<number>`COUNT(*)`,
  }).from(issueEvents).where(gte(issueEvents.createdAt, d7))
    .groupBy(sql`COALESCE(${issueEvents.source}, 'unknown')`)
    .orderBy(desc(sql`COUNT(*)`)).limit(10);

  return {
    lastHour: Number(counts?.lastHour || 0),
    last24h: Number(counts?.last24h || 0),
    last7d: Number(counts?.last7d || 0),
    uniqueDevices24h: Number(counts?.uniqueDevices24h || 0),
    fatal24h: Number(fatalCounts?.fatal24h || 0),
    activeIssues: Number(fatalCounts?.activeIssues || 0),
    regressedIssues: Number(fatalCounts?.regressedIssues || 0),
    byVersion: byVersion.map(r => ({ appVersion: r.appVersion, count: Number(r.count) })),
    byPlatform: byPlatform.map(r => ({ platform: r.platform, count: Number(r.count) })),
    bySource: bySource.map(r => ({ source: r.source, count: Number(r.count) })),
  };
}

// ─── metrics ────────────────────────────────────────────────────────────────

export interface IngestMetricInput {
  kind: string;
  valueNum?: number | null;
  valueText?: string | null;
  deviceId?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  episodeId?: string | null;
  feedId?: string | null;
  networkType?: string | null;
  cdnHost?: string | null;
  metadata?: any;
}

export async function ingestMetric(input: IngestMetricInput): Promise<void> {
  await db.insert(appMetrics).values({
    kind: input.kind.substring(0, 80),
    valueNum: typeof input.valueNum === "number" ? input.valueNum : null,
    valueText: input.valueText ? input.valueText.substring(0, 500) : null,
    deviceId: input.deviceId || null,
    platform: input.platform || null,
    appVersion: input.appVersion || null,
    episodeId: input.episodeId ? input.episodeId.substring(0, 200) : null,
    feedId: input.feedId ? input.feedId.substring(0, 200) : null,
    networkType: input.networkType || null,
    cdnHost: input.cdnHost ? input.cdnHost.substring(0, 200) : null,
    metadata: input.metadata || null,
  });
}

export async function ingestMetricBatch(inputs: IngestMetricInput[]): Promise<number> {
  if (!inputs.length) return 0;
  const rows = inputs.slice(0, 100).map(input => ({
    kind: input.kind.substring(0, 80),
    valueNum: typeof input.valueNum === "number" ? input.valueNum : null,
    valueText: input.valueText ? input.valueText.substring(0, 500) : null,
    deviceId: input.deviceId || null,
    platform: input.platform || null,
    appVersion: input.appVersion || null,
    episodeId: input.episodeId ? input.episodeId.substring(0, 200) : null,
    feedId: input.feedId ? input.feedId.substring(0, 200) : null,
    networkType: input.networkType || null,
    cdnHost: input.cdnHost ? input.cdnHost.substring(0, 200) : null,
    metadata: input.metadata || null,
  }));
  await db.insert(appMetrics).values(rows);
  return rows.length;
}

export interface MetricSummaryRow {
  bucket: string;
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
}

const BUCKET_COL: Record<string, any> = {
  version: sql`COALESCE(${appMetrics.appVersion}, 'unknown')`,
  cdn: sql`COALESCE(${appMetrics.cdnHost}, 'unknown')`,
  network: sql`COALESCE(${appMetrics.networkType}, 'unknown')`,
  platform: sql`COALESCE(${appMetrics.platform}, 'unknown')`,
  episode: sql`COALESCE(${appMetrics.episodeId}, 'unknown')`,
  feed: sql`COALESCE(${appMetrics.feedId}, 'unknown')`,
};

export async function summarizeMetrics(opts: {
  kind: string;
  bucket?: "version" | "cdn" | "network" | "platform" | "episode" | "feed";
  version?: string;
  platform?: string;
  windowMs?: number;
  limit?: number;
}): Promise<{ buckets: MetricSummaryRow[]; overall: MetricSummaryRow }> {
  const since = new Date(Date.now() - (opts.windowMs || 7 * 24 * 60 * 60 * 1000));
  const conds: any[] = [eq(appMetrics.kind, opts.kind), gte(appMetrics.createdAt, since)];
  if (opts.version) conds.push(eq(appMetrics.appVersion, opts.version));
  if (opts.platform) conds.push(eq(appMetrics.platform, opts.platform));

  const bucketCol = opts.bucket ? BUCKET_COL[opts.bucket] : null;

  if (bucketCol) {
    const rows = await db.select({
      bucket: sql<string>`${bucketCol}`,
      count: sql<number>`COUNT(*)`,
      p50: sql<number>`PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
      p95: sql<number>`PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
      p99: sql<number>`PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
      avg: sql<number>`AVG(${appMetrics.valueNum})`,
    }).from(appMetrics)
      .where(and(...conds))
      .groupBy(sql`${bucketCol}`)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(Math.min(opts.limit || 30, 200));

    const [overall] = await db.select({
      bucket: sql<string>`'all'`,
      count: sql<number>`COUNT(*)`,
      p50: sql<number>`PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
      p95: sql<number>`PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
      p99: sql<number>`PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
      avg: sql<number>`AVG(${appMetrics.valueNum})`,
    }).from(appMetrics).where(and(...conds));

    return {
      buckets: rows.map(r => ({
        bucket: String(r.bucket || "unknown"),
        count: Number(r.count || 0),
        p50: r.p50 != null ? Number(r.p50) : null,
        p95: r.p95 != null ? Number(r.p95) : null,
        p99: r.p99 != null ? Number(r.p99) : null,
        avg: r.avg != null ? Number(r.avg) : null,
      })),
      overall: {
        bucket: "all",
        count: Number(overall?.count || 0),
        p50: overall?.p50 != null ? Number(overall.p50) : null,
        p95: overall?.p95 != null ? Number(overall.p95) : null,
        p99: overall?.p99 != null ? Number(overall.p99) : null,
        avg: overall?.avg != null ? Number(overall.avg) : null,
      },
    };
  }

  const [overall] = await db.select({
    bucket: sql<string>`'all'`,
    count: sql<number>`COUNT(*)`,
    p50: sql<number>`PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
    p95: sql<number>`PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
    p99: sql<number>`PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY ${appMetrics.valueNum})`,
    avg: sql<number>`AVG(${appMetrics.valueNum})`,
  }).from(appMetrics).where(and(...conds));

  return {
    buckets: [],
    overall: {
      bucket: "all",
      count: Number(overall?.count || 0),
      p50: overall?.p50 != null ? Number(overall.p50) : null,
      p95: overall?.p95 != null ? Number(overall.p95) : null,
      p99: overall?.p99 != null ? Number(overall.p99) : null,
      avg: overall?.avg != null ? Number(overall.avg) : null,
    },
  };
}

// OTA adoption: how many distinct devices reported the `ota_active` heartbeat
// per update bundle in the time window. Used by the admin dashboard "OTA
// Adoption" card and `shiurctl ota`. Latest published updateId floats to
// the top of the list (highest "last_seen") so the dashboard can highlight
// it as "current build".
export async function getOtaAdoption(windowMs: number = 24 * 60 * 60 * 1000): Promise<{
  buckets: { updateId: string; channel: string | null; runtimeVersion: string | null; deviceCount: number; eventCount: number; isEmbedded: boolean; firstSeen: string; lastSeen: string }[];
  byChannel: { channel: string; deviceCount: number }[];
  totalDevices: number;
  windowMs: number;
}> {
  const since = new Date(Date.now() - windowMs);
  const rows = await db.select({
    updateId: sql<string>`COALESCE(${appMetrics.valueText}, 'embedded')`,
    channel: sql<string>`(${appMetrics.metadata} ->> 'channel')`,
    runtimeVersion: sql<string>`(${appMetrics.metadata} ->> 'runtimeVersion')`,
    isEmbedded: sql<boolean>`(${appMetrics.metadata} ->> 'isEmbeddedLaunch')::boolean`,
    deviceCount: sql<number>`COUNT(DISTINCT ${appMetrics.deviceId})`,
    eventCount: sql<number>`COUNT(*)`,
    firstSeen: sql<string>`MIN(${appMetrics.createdAt})`,
    lastSeen: sql<string>`MAX(${appMetrics.createdAt})`,
  }).from(appMetrics)
    .where(and(eq(appMetrics.kind, "ota_active"), gte(appMetrics.createdAt, since)))
    .groupBy(
      sql`COALESCE(${appMetrics.valueText}, 'embedded')`,
      sql`(${appMetrics.metadata} ->> 'channel')`,
      sql`(${appMetrics.metadata} ->> 'runtimeVersion')`,
      sql`(${appMetrics.metadata} ->> 'isEmbeddedLaunch')::boolean`,
    )
    .orderBy(desc(sql`MAX(${appMetrics.createdAt})`))
    .limit(30);

  const channelRows = await db.select({
    channel: sql<string>`COALESCE(${appMetrics.metadata} ->> 'channel', 'unknown')`,
    deviceCount: sql<number>`COUNT(DISTINCT ${appMetrics.deviceId})`,
  }).from(appMetrics)
    .where(and(eq(appMetrics.kind, "ota_active"), gte(appMetrics.createdAt, since)))
    .groupBy(sql`COALESCE(${appMetrics.metadata} ->> 'channel', 'unknown')`)
    .orderBy(desc(sql`COUNT(DISTINCT ${appMetrics.deviceId})`));

  const [totalRow] = await db.select({
    devices: sql<number>`COUNT(DISTINCT ${appMetrics.deviceId})`,
  }).from(appMetrics).where(and(eq(appMetrics.kind, "ota_active"), gte(appMetrics.createdAt, since)));

  return {
    buckets: rows.map(r => ({
      updateId: String(r.updateId || "embedded"),
      channel: r.channel || null,
      runtimeVersion: r.runtimeVersion || null,
      isEmbedded: r.isEmbedded === true,
      deviceCount: Number(r.deviceCount || 0),
      eventCount: Number(r.eventCount || 0),
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    })),
    byChannel: channelRows.map(r => ({ channel: r.channel || "unknown", deviceCount: Number(r.deviceCount || 0) })),
    totalDevices: Number(totalRow?.devices || 0),
    windowMs,
  };
}

// Snapshot the latest OTA bundle on a channel, sourced from our own
// ota_active heartbeats (no eas-cli roundtrip). Used by the resolve
// endpoint to capture { updateId, createdAt } so a future event whose
// metadata.ota.createdAt is strictly greater can auto-reopen the issue.
// Returns null when no device has emitted ota_active for that channel
// yet (e.g. brand-new install of a channel).
export async function getLatestOtaForChannel(channel: string): Promise<{ updateId: string; createdAt: Date | null } | null> {
  const [row] = await db.select({
    updateId: appMetrics.valueText,
    metadata: appMetrics.metadata,
    createdAt: appMetrics.createdAt,
  }).from(appMetrics)
    .where(and(
      eq(appMetrics.kind, "ota_active"),
      sql`(${appMetrics.metadata} ->> 'channel') = ${channel}`,
    ))
    .orderBy(desc(appMetrics.createdAt))
    .limit(1);
  if (!row?.updateId) return null;
  const meta: any = row.metadata || {};
  const otaCreatedAtRaw = meta.createdAt || meta.ota?.createdAt;
  return {
    updateId: String(row.updateId),
    createdAt: otaCreatedAtRaw ? new Date(String(otaCreatedAtRaw)) : null,
  };
}

// Distinct metric kinds seen recently — used by the admin "Metrics" tab dropdown
// and `shiurctl metrics --list-kinds`.
export async function listMetricKinds(windowMs: number = 7 * 24 * 60 * 60 * 1000): Promise<{ kind: string; count: number }[]> {
  const since = new Date(Date.now() - windowMs);
  const rows = await db.select({
    kind: appMetrics.kind,
    count: sql<number>`COUNT(*)`,
  }).from(appMetrics).where(gte(appMetrics.createdAt, since))
    .groupBy(appMetrics.kind)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(50);
  return rows.map(r => ({ kind: r.kind, count: Number(r.count) }));
}
