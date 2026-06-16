// /api/v1 — Bearer-auth telemetry surface mirroring crashctl.
//
// One endpoint for the shiurctl CLI AND the rebuilt web admin to call.
// PORTAL_API_KEY env var holds the shared token. The web admin server-renders
// the token into its HTML so the JS in admin.html can use it; the token is
// never exposed to the public app.

import type { Express, Request, Response } from "express";
import * as iss from "./issues-storage";
import * as storage from "./storage";
import fs from "node:fs";
import path from "node:path";
import { trackErrorForAlert } from "./error-alerts";

// Express 5 widens req.query values to string | string[] | ParsedQs[]. Most
// callers want a single string; q() collapses arrays to their first element.
const q = (v: any): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
};
const qn = (v: any): number | undefined => {
  const s = q(v);
  if (s == null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

function ok(res: Response, data: any) {
  res.json({ ok: true, data });
}
function publicError(res: Response, e: any, status = 500) {
  console.error("v1 API error:", e?.message || e);
  if (!res.headersSent) res.status(status).json({ ok: false, error: e?.message || "Something went wrong" });
}

export function registerV1Routes(app: Express) {
  const portalToken = process.env.PORTAL_API_KEY || "";

  // Accept either a Bearer token (CLI / external scripts using PORTAL_API_KEY)
  // OR the admin's existing Basic auth (so the rebuilt admin dashboard reuses
  // its existing credentials). 5-min cache for the Basic path so we don't
  // bcrypt on every page action.
  const basicCache = new Map<string, number>();
  const BASIC_TTL = 5 * 60 * 1000;
  const portalAuth = async (req: Request, res: Response, next: Function) => {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) {
      if (!portalToken) {
        return res.status(503).json({ ok: false, error: "PORTAL_API_KEY not configured on server" });
      }
      if (h.slice(7).trim() === portalToken) return next();
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    if (h.startsWith("Basic ")) {
      const tok = h.slice(6).trim();
      const at = basicCache.get(tok);
      if (at && Date.now() - at < BASIC_TTL) return next();
      try {
        const [u, p] = Buffer.from(tok, "base64").toString().split(":");
        if (await storage.verifyAdmin(u, p)) {
          basicCache.set(tok, Date.now());
          return next();
        }
      } catch {}
    }
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  };

  // ── ingest (public — devices post here) ───────────────────────────────────

  app.post("/api/v1/ingest/events", async (req: Request, res: Response) => {
    try {
      const { events } = req.body || {};
      if (!Array.isArray(events)) return res.status(400).json({ ok: false, error: "events array required" });
      const results: { fingerprint: string; status: string; isRegression: boolean }[] = [];
      let regressionFp: string | null = null;
      for (const ev of events.slice(0, 50)) {
        if (!ev?.message) continue;
        try {
          const severity = ev.severity === "fatal" ? "fatal" : ev.severity === "warn" ? "warn" : "nonfatal";
          const r = await iss.ingestEvent({
            message: String(ev.message),
            stack: ev.stack ? String(ev.stack) : null,
            source: ev.source ? String(ev.source) : null,
            severity,
            deviceId: ev.deviceId || null,
            platform: ev.platform || null,
            appVersion: ev.appVersion || null,
            breadcrumbs: ev.breadcrumbs || null,
            metadata: ev.metadata || null,
          });
          results.push({ fingerprint: r.fingerprint, status: r.status, isRegression: r.isRegression });
          if (r.isRegression && !regressionFp) regressionFp = r.fingerprint;
          // Feed the spike-alert detector so when v1 is the only ingest path
          // (after every device picks up the OTA), error spikes still page.
          if (severity !== "warn") {
            trackErrorForAlert({
              level: severity === "fatal" ? "error" : "error",
              message: String(ev.message),
              source: ev.source || undefined,
              platform: ev.platform || undefined,
              appVersion: ev.appVersion || undefined,
            });
          }
        } catch (innerE: any) {
          // Don't let one bad event poison the batch.
          console.error("ingestEvent failed:", innerE?.message || innerE);
        }
      }
      // Fire-and-forget regression alert (handled in error-alerts).
      if (regressionFp) {
        import("./error-alerts").then(m => m.alertRegression?.(regressionFp!)).catch(() => {});
      }
      res.json({ ok: true, accepted: results.length, results });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/v1/ingest/metrics", async (req: Request, res: Response) => {
    try {
      const { metrics } = req.body || {};
      if (!Array.isArray(metrics)) return res.status(400).json({ ok: false, error: "metrics array required" });
      const written = await iss.ingestMetricBatch(metrics.map((m: any) => ({
        kind: String(m.kind || "unknown"),
        valueNum: typeof m.valueNum === "number" ? m.valueNum : null,
        valueText: m.valueText ? String(m.valueText) : null,
        deviceId: m.deviceId || null,
        platform: m.platform || null,
        appVersion: m.appVersion || null,
        episodeId: m.episodeId || null,
        feedId: m.feedId || null,
        networkType: m.networkType || null,
        cdnHost: m.cdnHost || null,
        metadata: m.metadata || null,
      })));
      res.json({ ok: true, accepted: written });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Native crashes get their own endpoint so the JS-side replayer can flag
  // them as fatal without trusting client-supplied severity for everything.
  app.post("/api/v1/ingest/native-crash", async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const r = await iss.ingestEvent({
        message: String(body.message || body.exceptionName || "Native crash"),
        stack: body.stack ? String(body.stack) : null,
        source: "native-crash",
        severity: "fatal",
        deviceId: body.deviceId || null,
        platform: body.platform || null,
        appVersion: body.appVersion || null,
        breadcrumbs: body.breadcrumbs || null,
        metadata: body.metadata || null,
      });
      res.json({ ok: true, fingerprint: r.fingerprint, isRegression: r.isRegression });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // ── portal (CLI + admin) ──────────────────────────────────────────────────

  app.get("/api/v1/issues", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const since = q(req.query.since); const until = q(req.query.until);
      const data = await iss.listIssues({
        status: (q(req.query.status) as any) || "active",
        severity: q(req.query.severity) as any,
        q: q(req.query.q),
        version: q(req.query.version),
        platform: q(req.query.platform),
        since: since ? new Date(since) : undefined,
        until: until ? new Date(until) : undefined,
        limit: qn(req.query.limit) ?? 50,
        sort: q(req.query.sort) as any,
      });
      ok(res, data);
    } catch (e: any) { publicError(res, e); }
  });

  app.get("/api/v1/issues/:fp", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const data = await iss.getIssue(String(req.params.fp), qn(req.query.events) ?? 20);
      if (!data.issue) return res.status(404).json({ ok: false, error: "Not found" });
      ok(res, data);
    } catch (e: any) { publicError(res, e); }
  });

  app.post("/api/v1/issues/:fp/resolve", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const { version, note, by } = req.body || {};
      if (!version) return res.status(400).json({ ok: false, error: "version required — pass --version to shiurctl resolve" });
      const updated = await iss.resolveIssue(String(req.params.fp), String(version), note ? String(note) : null, by ? String(by) : "shiurctl");
      if (!updated) return res.status(404).json({ ok: false, error: "Not found" });
      ok(res, updated);
    } catch (e: any) { publicError(res, e); }
  });

  app.post("/api/v1/issues/:fp/reopen", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const updated = await iss.reopenIssue(String(req.params.fp));
      if (!updated) return res.status(404).json({ ok: false, error: "Not found" });
      ok(res, updated);
    } catch (e: any) { publicError(res, e); }
  });

  app.post("/api/v1/issues/:fp/archive", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const updated = await iss.archiveIssue(String(req.params.fp));
      if (!updated) return res.status(404).json({ ok: false, error: "Not found" });
      ok(res, updated);
    } catch (e: any) { publicError(res, e); }
  });

  app.post("/api/v1/issues/:fp/merge", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const { into } = req.body || {};
      if (!into) return res.status(400).json({ ok: false, error: "into fingerprint required" });
      const r = await iss.mergeIssue(String(req.params.fp), String(into));
      ok(res, r);
    } catch (e: any) { publicError(res, e); }
  });

  app.get("/api/v1/stats", portalAuth as any, async (_req: Request, res: Response) => {
    try {
      const data = await iss.getStats();
      ok(res, data);
    } catch (e: any) { publicError(res, e); }
  });

  app.get("/api/v1/metrics/summary", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const kind = q(req.query.kind);
      if (!kind) return res.status(400).json({ ok: false, error: "kind required" });
      const window = q(req.query.window) || "7d";
      const m = window.match(/^(\d+)(h|d)$/);
      const windowMs = m
        ? Number(m[1]) * (m[2] === "h" ? 3600_000 : 86_400_000)
        : 7 * 86_400_000;
      const data = await iss.summarizeMetrics({
        kind,
        bucket: q(req.query.bucket) as any,
        version: q(req.query.version),
        platform: q(req.query.platform),
        windowMs,
        limit: qn(req.query.limit) ?? 30,
      });
      ok(res, data);
    } catch (e: any) { publicError(res, e); }
  });

  app.get("/api/v1/metrics/kinds", portalAuth as any, async (_req: Request, res: Response) => {
    try {
      const data = await iss.listMetricKinds();
      ok(res, data);
    } catch (e: any) { publicError(res, e); }
  });

  app.get("/api/v1/ota-adoption", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const window = q(req.query.window) || "24h";
      const m = window.match(/^(\d+)(h|d)$/);
      const windowMs = m ? Number(m[1]) * (m[2] === "h" ? 3600_000 : 86_400_000) : 86_400_000;
      const data = await iss.getOtaAdoption(windowMs);
      ok(res, data);
    } catch (e: any) { publicError(res, e); }
  });

  // List recent EAS updates per branch — drives the admin OTA controls so
  // the operator can see "what's the latest on preview" before promoting.
  app.get("/api/v1/ota/updates", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const branch = q(req.query.branch) || "preview";
      if (!process.env.EAS_TOKEN) return res.status(503).json({ ok: false, error: "EAS_TOKEN not configured on server — set it on Railway to enable OTA controls." });
      const { execFile } = await import("node:child_process");
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile("npx", ["--yes", "eas-cli", "update:list", "--branch", branch, "--limit", "5", "--json", "--non-interactive"],
          { cwd: process.cwd(), env: { ...process.env, EAS_NO_VCS: "1" }, maxBuffer: 4 * 1024 * 1024 },
          (err, out) => err ? reject(err) : resolve(out));
      });
      let parsed: any = null;
      try { parsed = JSON.parse(stdout); } catch { parsed = { raw: stdout.substring(0, 2000) }; }
      ok(res, { branch, updates: parsed });
    } catch (e: any) { publicError(res, e); }
  });

  // Promote the latest update from one branch (default: preview) to another
  // (default: production). Uses `eas update:republish` so the bytes ship
  // unchanged — the promoted update group ID is reused, no rebuild.
  //
  // Authorization wall: requires the admin's Basic auth (a Bearer-only call
  // with PORTAL_API_KEY would let any script with the token promote builds,
  // which is too much power for a CLI token). We check by requiring the
  // Authorization header to start with "Basic ".
  app.post("/api/v1/ota/promote", portalAuth as any, async (req: Request, res: Response) => {
    try {
      const h = req.headers.authorization || "";
      if (!h.startsWith("Basic ")) {
        return res.status(403).json({ ok: false, error: "OTA promote requires admin login (Basic auth), not a Bearer token." });
      }
      if (!process.env.EAS_TOKEN) {
        return res.status(503).json({ ok: false, error: "EAS_TOKEN not configured on server. Add it to Railway → ShiurPod → server → Variables." });
      }
      const fromBranch = (req.body?.from as string) || "preview";
      const toBranch = (req.body?.to as string) || "production";
      const message = (req.body?.message as string) || `Promoted from ${fromBranch}`;
      const groupId = req.body?.groupId as string | undefined;
      const { execFile } = await import("node:child_process");
      const args = groupId
        ? ["--yes", "eas-cli", "update:republish", "--group", groupId, "--branch", toBranch, "--message", message, "--non-interactive"]
        : ["--yes", "eas-cli", "update:republish", "--branch", toBranch, "--source-branch", fromBranch, "--message", message, "--non-interactive"];
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile("npx", args, { cwd: process.cwd(), env: { ...process.env, EAS_NO_VCS: "1" }, maxBuffer: 4 * 1024 * 1024 },
          (err, out, errOut) => err ? reject(new Error((errOut || "") + (out || "") || err.message)) : resolve(out));
      });
      ok(res, { from: fromBranch, to: toBranch, message, output: stdout.substring(0, 4000) });
    } catch (e: any) { publicError(res, e); }
  });

  // ── shiurctl one-line installer ───────────────────────────────────────────
  // Matches crashctl's pattern: `curl -fsSL https://shiurpod.com/shiurctl -o shiurctl`.
  app.get("/shiurctl", (_req: Request, res: Response) => {
    try {
      const p = path.join(process.cwd(), "scripts", "shiurctl.js");
      if (!fs.existsSync(p)) return res.status(404).send("shiurctl not found in this deployment");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="shiurctl"');
      fs.createReadStream(p).pipe(res);
    } catch (e: any) {
      res.status(500).send(String(e?.message || e));
    }
  });
}
