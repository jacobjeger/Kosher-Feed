// Watching the Kol Halashon path, because losing it is losing most of the app.
//
// Kol Halashon is 1,222,503 of 1,650,988 episodes — 74% of the catalogue — and
// none of it is served from our own storage. It reaches listeners through
// srv.kolhalashon.com, which blocks Railway's IPs, via the Cloudflare worker in
// kh-proxy/. That is a lot of app resting on one upstream that can withdraw
// access without telling us.
//
// On 2026-09-05 it did. Every KH request began failing, /api/audio/kh/* served
// 502, and nothing anywhere raised an alarm: playback_error only fires after
// five retries exhaust, so telemetry logged two events across the whole fleet
// while three quarters of the catalogue was unplayable. It surfaced days later
// as a support ticket saying "nothing is playing".
//
// This probe exists so that never costs days again. It is deliberately dumb —
// one request, on a timer, against the same upstream the audio route uses.

import { and, isNotNull, sql } from "drizzle-orm";
import { db } from "./db";
import { episodes } from "@shared/schema";
import { sendOutageAlert } from "./error-alerts";
import { getHeaders as getKHHeaders } from "./kolhalashon";

const PROBE_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_PROBE_DELAY_MS = 2 * 60 * 1000;
/** Consecutive failures before alerting — one bad probe is not an outage. */
const FAILURES_BEFORE_ALERT = 2;
// Don't re-alert about an outage already reported within this window.
//
// Deliberately a full day rather than a few hours. The failure this was built
// for is not a blip that clears itself: Kol Halashon moved their API to
// www.kolhalashon.com and put audio behind signed, expiring play tokens, so
// the outage persists until someone talks to them. Mailing every six hours
// about a known, unfixable-by-us condition trains people to ignore the alert,
// which costs us the NEXT outage.
const RE_ALERT_MS = 24 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
let lastAlertAt = 0;
let wasDown = false;

export interface KhProbeResult {
  ok: boolean;
  status: number | null;
  detail: string;
  fileId: string | null;
  via: "proxy" | "direct" | "none";
}

/** A real KH file id from the catalogue, so the probe tests a real object. */
async function pickFileId(): Promise<string | null> {
  const [row] = await db
    .select({ id: episodes.kolhalashonFileId })
    .from(episodes)
    .where(and(isNotNull(episodes.kolhalashonFileId), sql`${episodes.kolhalashonFileId} > 0`))
    .orderBy(sql`random()`)
    .limit(1);
  return row?.id != null ? String(row.id) : null;
}

/**
 * Ask for the first two bytes of one shiur, the way the audio route would.
 *
 * A ranged GET, not a HEAD: the audio route streams with Range, and some CDNs
 * answer HEAD differently from GET, which would make the probe agree with
 * itself while listeners still failed.
 */
export async function probeKolHalashon(): Promise<KhProbeResult> {
  const fileId = await pickFileId();
  if (!fileId) return { ok: false, status: null, detail: "no KH episode in the catalogue to probe", fileId: null, via: "none" };

  const path = `/api/files/GetMp3FileToPlay/${fileId}`;
  const proxyUrl = process.env.KH_PROXY_URL;
  const attempts: { url: string; via: "proxy" | "direct" }[] = proxyUrl
    ? [{ url: `${proxyUrl.replace(/\/$/, "")}${path}`, via: "proxy" }, { url: `https://srv.kolhalashon.com${path}`, via: "direct" }]
    : [{ url: `https://srv.kolhalashon.com${path}`, via: "direct" }];

  // Record EVERY attempt, not just the last. Reporting only the final one says
  // "direct: HTTP 403" and hides that the worker was tried and failed first,
  // which points the reader away from the proxy — the thing most likely to be
  // at fault, and the thing they have to fix.
  const tried: string[] = [];
  let last: KhProbeResult = { ok: false, status: null, detail: "no attempt made", fileId, via: "none" };
  for (const { url, via } of attempts) {
    try {
      // The route's own headers, from the one place that defines them, so the
      // probe cannot pass while real playback fails on a header we forgot to
      // mirror. (KH_AUTH_TOKEN holds the FULL header value, "Bearer x", not
      // the bare token — getHeaders is the only thing that should know that.)
      const headers: Record<string, string> = { ...getKHHeaders(), accept: "*/*", Range: "bytes=0-1" };
      const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
      // Drain so the socket is released; two bytes, so this is free.
      try { await res.arrayBuffer(); } catch {}
      const type = res.headers.get("content-type") || "";
      // Audio, not a JSON error or an HTML block page rendered with a 200.
      const ok = (res.ok || res.status === 206) && !/json|html/i.test(type);
      tried.push(`${via}: HTTP ${res.status} ${type || "(no content-type)"}`);
      last = { ok, status: res.status, detail: tried.join(" | "), fileId, via };
      if (ok) return last;
    } catch (e: any) {
      tried.push(`${via}: ${e?.cause?.code || e?.message?.slice(0, 80) || "fetch failed"}`);
      last = { ok: false, status: null, detail: tried.join(" | "), fileId, via };
    }
  }
  return last;
}

async function runProbe(): Promise<void> {
  let result: KhProbeResult;
  try {
    result = await probeKolHalashon();
  } catch (e: any) {
    console.error(`KH health: probe threw — ${e?.message?.slice(0, 160)}`);
    return;
  }

  if (result.ok) {
    if (wasDown) {
      console.log(`KH health: RECOVERED (${result.detail}, via ${result.via})`);
      await sendOutageAlert("✅ ShiurPod: Kol Halashon is serving audio again", [
        `Probe succeeded: <b>${result.detail}</b> via the ${result.via}.`,
        `File id ${result.fileId}. 74% of the catalogue is reachable again.`,
      ]);
    }
    consecutiveFailures = 0;
    wasDown = false;
    return;
  }

  consecutiveFailures++;
  console.error(
    `KH health: probe FAILED (${consecutiveFailures}x) — ${result.detail} via ${result.via}, file ${result.fileId}`,
  );

  const due = Date.now() - lastAlertAt > RE_ALERT_MS;
  if (consecutiveFailures >= FAILURES_BEFORE_ALERT && due) {
    lastAlertAt = Date.now();
    wasDown = true;
    await sendOutageAlert("🚨 ShiurPod: Kol Halashon audio is DOWN (74% of the catalogue)", [
      `Last probe: <b>${result.detail}</b> (via the ${result.via}, file id ${result.fileId}).`,
      `Failed ${consecutiveFailures} consecutive probes, so <code>/api/audio/kh/*</code> is serving 502 and roughly three quarters of the catalogue will not play.`,
      `Most likely cause: the <code>authorization-site-key</code> the worker sends has been rotated, or KH is blocking our IPs. Check <code>kh-proxy/worker.js</code> and the <code>KH_AUTH_TOKEN</code> secret.`,
      `Downloaded episodes still play — the app resolves those locally.`,
    ]);
  }
}

/** Probe shortly after boot, then every 15 minutes. */
export function startKolHalashonHealthCheck(): void {
  if (timer) return;
  setTimeout(() => { runProbe().catch(() => {}); }, FIRST_PROBE_DELAY_MS);
  timer = setInterval(() => { runProbe().catch(() => {}); }, PROBE_INTERVAL_MS);
}
