// Removing episodes the publisher has retired.
//
// A show can pull an episode: drop the item from its RSS feed and delete the
// file from storage. Nothing tells us. Ingest only ever adds — every parse is
// an upsert keyed on guid — so the episode stays in the catalogue, keeps its
// place in the show, and every listener who taps it gets a hard failure.
//
// "R' Yoshe Ber: A Talmid's Perspective - Part 2 (Ep. 342)" of The Rabbi
// Orlofsky Show is the case that prompted this: 404 at Backblaze, gone from
// rabbiorlofsky.com's feed, still second from the top of the show in our app,
// and 44 failed plays across 17 devices in a month. Episodes 341 and 343 on
// either side of it are fine.
//
// Deleting catalogue rows off the back of a network probe is the kind of thing
// that goes badly, so the bar here is deliberately high:
//
//   1. Real users must have failed on it. Candidates come from playback_error
//      telemetry, never from a blind crawl of 1.65M episodes.
//   2. The origin must answer 404/410 TWICE, spaced apart. A timeout, a 403 or
//      any 5xx is "transient" and is never acted on — those are how a healthy
//      CDN behaves on a bad day.
//   3. The episode must ALSO be absent from a fresh full parse of the feed. A
//      404 on an item the publisher still lists is a broken link on their side,
//      not a retirement; we record it as `orphaned` for a human and keep it.
//   4. Per-feed and per-sweep caps. A publisher whose whole CDN starts 404ing
//      trips the cap and nothing is deleted.
//
// Every verdict — including the ones that change nothing — lands in
// episode_health, so a later sweep does not re-probe the same URL and there is
// a record of what was removed and why.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { appMetrics, episodeHealth, episodes, feeds } from "@shared/schema";
import { normalizeAudioUrl } from "./audio-url";
import { isCustomSchemeUrl } from "./feed-schemes";
import { parseFeed } from "./rss";

/** How far back to look for playback failures worth investigating. */
const CANDIDATE_WINDOW_DAYS = 14;
/** Failures needed before an episode is worth a probe. */
const MIN_FAILURES = 2;
/** Don't re-probe an episode we already have a verdict for within this window. */
const RECHECK_DAYS = 7;
/** Candidates examined per sweep. */
const MAX_CANDIDATES = 200;
/** Hard ceiling on deletions in one sweep, whatever the evidence says. */
const MAX_REMOVALS_PER_SWEEP = 50;
/** A feed may not lose more than this many episodes in one sweep... */
const MAX_REMOVALS_PER_FEED = 25;
/** ...nor more than this fraction of its catalogue. */
const MAX_FEED_REMOVAL_FRACTION = 0.1;
/** Gap between the two confirming probes. */
const PROBE_GAP_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 404 and 410 are the only statuses that mean "this is not coming back". */
const DEAD_STATUSES = new Set([404, 410]);

type ProbeResult = { status: number | null; detail: string };

export interface SweepOptions {
  dryRun?: boolean;
  /** Override the deletion ceiling; still bounded by the per-feed caps. */
  maxRemovals?: number;
}

export interface SweepSummary {
  candidates: number;
  probed: number;
  ok: number;
  transient: number;
  orphaned: number;
  removed: number;
  skipped: number;
}

/**
 * Range-GET the URL a player would actually fetch. Deliberately a real ranged
 * GET rather than a HEAD: several podcast CDNs answer HEAD with a 404 or a 405
 * while serving the file perfectly well, which would fabricate exactly the
 * evidence this sweep acts on.
 */
async function probe(url: string): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-1", "User-Agent": "ShiurPod-health/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (res.body) await res.body.cancel();
    return { status: res.status, detail: `HTTP ${res.status}` };
  } catch (e: any) {
    return { status: null, detail: `${e?.cause?.code || e?.name || "error"}` };
  }
}

/**
 * True for URLs this sweep is allowed to judge. Platform adapters (Kol
 * Halashon, YouTube, TorahAnytime…) mint or proxy their URLs per playback and
 * have their own lifecycle — a probe of the stored value proves nothing about
 * whether the shiur still exists.
 */
function isProbeable(audioUrl: string): boolean {
  if (!audioUrl || isCustomSchemeUrl(audioUrl)) return false;
  if (audioUrl.startsWith("/")) return false;
  if (!/^https?:\/\//i.test(audioUrl)) return false;
  try {
    return new URL(audioUrl).hostname !== "srv.kolhalashon.com";
  } catch {
    return false;
  }
}

async function recordVerdict(row: {
  episodeId: string;
  feedId: string | null;
  episodeTitle: string | null;
  audioUrl: string;
  status: string;
  httpStatus: number | null;
  detail: string;
  removedAt?: Date | null;
}) {
  await db
    .insert(episodeHealth)
    .values({ ...row, checkedAt: new Date(), removedAt: row.removedAt ?? null })
    .onConflictDoUpdate({
      target: episodeHealth.episodeId,
      set: {
        feedId: row.feedId,
        episodeTitle: row.episodeTitle,
        audioUrl: row.audioUrl,
        status: row.status,
        httpStatus: row.httpStatus,
        detail: row.detail,
        checkedAt: new Date(),
        removedAt: row.removedAt ?? null,
      },
    });
}

/** Episodes real users failed on recently, minus the ones we judged lately. */
async function findCandidates(): Promise<
  { episodeId: string; failures: number; devices: number }[]
> {
  const since = new Date(Date.now() - CANDIDATE_WINDOW_DAYS * DAY_MS);
  const staleBefore = new Date(Date.now() - RECHECK_DAYS * DAY_MS);

  const recentlyJudged = db
    .select({ id: episodeHealth.episodeId })
    .from(episodeHealth)
    .where(gte(episodeHealth.checkedAt, staleBefore));

  const rows = await db
    .select({
      episodeId: appMetrics.episodeId,
      failures: sql<number>`count(*)::int`,
      devices: sql<number>`count(distinct ${appMetrics.deviceId})::int`,
    })
    .from(appMetrics)
    .where(
      and(
        eq(appMetrics.kind, "playback_error"),
        gte(appMetrics.createdAt, since),
        sql`${appMetrics.episodeId} is not null`,
        sql`${appMetrics.episodeId} not in ${recentlyJudged}`,
      ),
    )
    .groupBy(appMetrics.episodeId)
    .having(sql`count(*) >= ${MIN_FAILURES}`)
    .orderBy(desc(sql`count(*)`))
    .limit(MAX_CANDIDATES);

  return rows
    .filter((r): r is typeof r & { episodeId: string } => !!r.episodeId)
    .map((r) => ({ episodeId: r.episodeId, failures: r.failures, devices: r.devices }));
}

/**
 * Everything the current feed still publishes, as a lookup. Both guids and raw
 * enclosure URLs go in: a publisher that changes its guid scheme would
 * otherwise make its entire back catalogue look retired at once.
 */
async function fetchLivePublishedKeys(feedId: string, rssUrl: string): Promise<Set<string> | null> {
  const parsed = await parseFeed(feedId, rssUrl);
  // null is a 304, which tells us nothing about item membership. An empty item
  // list is a feed having a bad day, not a publisher deleting their archive.
  if (!parsed || parsed.episodes.length === 0) return null;

  const keys = new Set<string>();
  for (const ep of parsed.episodes) {
    if (ep.guid) keys.add(ep.guid);
    if (ep.audioUrl) {
      keys.add(ep.audioUrl);
      keys.add(normalizeAudioUrl(ep.audioUrl));
    }
  }
  return keys;
}

export async function sweepDeadEpisodes(opts: SweepOptions = {}): Promise<SweepSummary> {
  const dryRun = opts.dryRun ?? false;
  const removalBudget = Math.min(opts.maxRemovals ?? MAX_REMOVALS_PER_SWEEP, MAX_REMOVALS_PER_SWEEP);

  const summary: SweepSummary = {
    candidates: 0, probed: 0, ok: 0, transient: 0, orphaned: 0, removed: 0, skipped: 0,
  };

  const candidates = await findCandidates();
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  const rows = await db
    .select({
      id: episodes.id,
      feedId: episodes.feedId,
      title: episodes.title,
      guid: episodes.guid,
      audioUrl: episodes.audioUrl,
    })
    .from(episodes)
    .where(inArray(episodes.id, candidates.map((c) => c.episodeId)));

  // Probe first, feed by feed second: a feed is only re-parsed if something in
  // it actually looks dead, which keeps a sweep to a handful of feed fetches.
  const deadByFeed = new Map<string, typeof rows>();

  for (const ep of rows) {
    if (!isProbeable(ep.audioUrl)) {
      summary.skipped++;
      continue;
    }

    const target = normalizeAudioUrl(ep.audioUrl);
    summary.probed++;

    const first = await probe(target);
    if (first.status !== null && !DEAD_STATUSES.has(first.status) && first.status < 400) {
      summary.ok++;
      await recordVerdict({
        episodeId: ep.id, feedId: ep.feedId, episodeTitle: ep.title, audioUrl: target,
        status: "ok", httpStatus: first.status, detail: first.detail,
      });
      continue;
    }

    if (first.status === null || !DEAD_STATUSES.has(first.status)) {
      summary.transient++;
      await recordVerdict({
        episodeId: ep.id, feedId: ep.feedId, episodeTitle: ep.title, audioUrl: target,
        status: "transient", httpStatus: first.status, detail: first.detail,
      });
      continue;
    }

    // First probe says gone. Confirm it is not a blip before going further.
    await sleep(PROBE_GAP_MS);
    const second = await probe(target);
    if (second.status === null || !DEAD_STATUSES.has(second.status)) {
      summary.transient++;
      await recordVerdict({
        episodeId: ep.id, feedId: ep.feedId, episodeTitle: ep.title, audioUrl: target,
        status: "transient", httpStatus: second.status,
        detail: `first ${first.detail}, then ${second.detail}`,
      });
      continue;
    }

    if (!deadByFeed.has(ep.feedId)) deadByFeed.set(ep.feedId, []);
    deadByFeed.get(ep.feedId)!.push(ep);
  }

  for (const [feedId, dead] of deadByFeed) {
    const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);

    // Without a parseable feed there is no second signal, so nothing can be
    // deleted. Record the 404s so a human can see them.
    if (!feed || isCustomSchemeUrl(feed.rssUrl)) {
      for (const ep of dead) {
        summary.orphaned++;
        await recordVerdict({
          episodeId: ep.id, feedId, episodeTitle: ep.title,
          audioUrl: normalizeAudioUrl(ep.audioUrl), status: "orphaned", httpStatus: 404,
          detail: "origin 404 but feed cannot be re-parsed to confirm removal",
        });
      }
      continue;
    }

    let live: Set<string> | null = null;
    try {
      live = await fetchLivePublishedKeys(feedId, feed.rssUrl);
    } catch {
      live = null;
    }

    if (!live) {
      for (const ep of dead) {
        summary.transient++;
        await recordVerdict({
          episodeId: ep.id, feedId, episodeTitle: ep.title,
          audioUrl: normalizeAudioUrl(ep.audioUrl), status: "transient", httpStatus: 404,
          detail: "origin 404 but the feed did not return a usable item list",
        });
      }
      continue;
    }

    const stillPublished = dead.filter(
      (ep) => live!.has(ep.guid) || live!.has(ep.audioUrl) || live!.has(normalizeAudioUrl(ep.audioUrl)),
    );
    const retired = dead.filter((ep) => !stillPublished.includes(ep));

    for (const ep of stillPublished) {
      summary.orphaned++;
      await recordVerdict({
        episodeId: ep.id, feedId, episodeTitle: ep.title,
        audioUrl: normalizeAudioUrl(ep.audioUrl), status: "orphaned", httpStatus: 404,
        detail: "origin 404 but the publisher still lists this item — likely a broken link",
      });
    }

    if (retired.length === 0) continue;

    // Caps. A publisher whose storage goes fully 404 while their feed keeps
    // rotating old items out would otherwise look like a mass retirement.
    const feedCap = Math.max(
      1,
      Math.min(MAX_REMOVALS_PER_FEED, Math.floor((feed.episodeCount || 0) * MAX_FEED_REMOVAL_FRACTION)),
    );
    if (retired.length > feedCap) {
      for (const ep of retired) {
        summary.transient++;
        await recordVerdict({
          episodeId: ep.id, feedId, episodeTitle: ep.title,
          audioUrl: normalizeAudioUrl(ep.audioUrl), status: "transient", httpStatus: 404,
          detail: `${retired.length} episode(s) of "${feed.title}" look retired at once, over the cap of ${feedCap} — not acting`,
        });
      }
      console.warn(
        `Dead-episode sweep: "${feed.title}" had ${retired.length} apparent retirements (cap ${feedCap}). Left alone — check the feed.`,
      );
      continue;
    }

    for (const ep of retired) {
      if (summary.removed >= removalBudget) {
        summary.skipped++;
        continue;
      }
      const audioUrl = normalizeAudioUrl(ep.audioUrl);
      if (!dryRun) {
        await db.delete(episodes).where(eq(episodes.id, ep.id));
      }
      summary.removed++;
      await recordVerdict({
        episodeId: ep.id, feedId, episodeTitle: ep.title, audioUrl,
        status: dryRun ? "orphaned" : "removed", httpStatus: 404,
        detail: dryRun
          ? "would remove: origin 404 and no longer in the feed (dry run)"
          : "origin 404 and no longer published in the feed",
        removedAt: dryRun ? null : new Date(),
      });
      console.log(
        `Dead-episode sweep: ${dryRun ? "would remove" : "removed"} "${ep.title}" from "${feed.title}" (${audioUrl})`,
      );
    }
  }

  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Daily sweep, first run 10 minutes after boot so it never fights startup. */
export function startDeadEpisodeSweep(): void {
  if (timer) return;
  const run = async () => {
    try {
      const t0 = Date.now();
      const s = await sweepDeadEpisodes();
      if (s.candidates > 0) {
        console.log(
          `Dead-episode sweep: ${s.candidates} candidate(s), ${s.probed} probed — ` +
            `${s.ok} ok, ${s.transient} transient, ${s.orphaned} orphaned, ${s.removed} removed ` +
            `in ${Date.now() - t0}ms`,
        );
      }
    } catch (e: any) {
      console.error(`Dead-episode sweep failed: ${e?.message?.slice(0, 200)}`);
    }
  };
  setTimeout(run, 10 * 60 * 1000);
  timer = setInterval(run, DAY_MS);
}
