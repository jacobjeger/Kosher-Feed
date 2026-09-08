// Why does playback stall on some episodes and not others?
//
//   npx tsx scripts/probe-audio-origins.ts                       # the worst feeds by stuck count
//   npx tsx scripts/probe-audio-origins.ts --feed "Rav Gershon Ribner"
//   npx tsx scripts/probe-audio-origins.ts --sample 12 --json
//
// Telemetry says what the player saw but not what the origin did. Across 292
// `playback_stuck` events in 30 days, `lastCurrentTime` was 0 and `sawPlaying`
// false in every single one — the audio never advanced a millisecond, so these
// are real stalls, not a HAL reporting `playing=true` late (the assumption
// recorded in contexts/AudioPlayerContext.tsx). 155 were still buffering when
// the 25s watchdog fired; 19 got no status callback at all.
//
// The useful comparison is within a feed: episodes that stalled against
// episodes from the SAME feed that played fine. Same phone population, same
// network conditions, same publisher — so a difference here points at the file
// or the origin rather than at the user's signal.
//
// For each URL we record what the player's first few seconds would encounter:
// the redirect chain (ExoPlayer follows these itself, and a chain that crosses
// hosts or drops the range header is a classic stall), whether the origin
// honours Range at all (no ranges means no seeking and a fragile restart),
// time to first byte, and how fast the first 64 KB actually arrive. A file that
// answers 200 but trickles bytes looks exactly like our stuck signature.

import { db } from "../server/db";
import { sql } from "drizzle-orm";

const SAMPLE = argNum("--sample", 8);
const AS_JSON = process.argv.includes("--json");
const FEED_ARG = argStr("--feed");
const PROBE_BYTES = 65536;
const PROBE_TIMEOUT_MS = 30000;

function argStr(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
function argNum(flag: string, fallback: number): number {
  const v = argStr(flag);
  return v ? Number(v) : fallback;
}

interface Candidate {
  episodeId: string;
  title: string;
  audioUrl: string;
  stuckEvents: number;
  stuckDevices: number;
}

interface ProbeResult extends Candidate {
  group: "stalled" | "control";
  status: number | null;
  finalHost: string;
  hops: number;
  crossHost: boolean;
  acceptsRanges: boolean;
  contentLength: number | null;
  ttfbMs: number | null;
  kbPerSec: number | null;
  error: string | null;
}

// Feeds ranked by stuck events, so the script finds its own targets rather than
// hardcoding today's two worst offenders.
async function worstFeeds(limit: number): Promise<{ feedId: string; title: string; stuck: number }[]> {
  const r = await db.execute(sql`
    SELECT m.feed_id, COALESCE(f.title, m.feed_id) AS title, COUNT(*)::int AS stuck
    FROM app_metrics m LEFT JOIN feeds f ON f.id = m.feed_id
    WHERE m.kind = 'playback_stuck' AND m.created_at > now() - interval '30 days'
      AND m.feed_id IS NOT NULL
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT ${limit}
  `);
  return (r as any).rows.map((x: any) => ({ feedId: x.feed_id, title: x.title, stuck: Number(x.stuck) }));
}

// Episodes from this feed that stalled. Episodes deleted since (the dead-episode
// sweep removed 98 of the 292 events' targets) are skipped — they have no URL
// left to probe, and their stalls are already explained.
async function stalledEpisodes(feedId: string, limit: number): Promise<Candidate[]> {
  const r = await db.execute(sql`
    SELECT e.id, e.title, e.audio_url,
           COUNT(*)::int AS events, COUNT(DISTINCT m.device_id)::int AS devices
    FROM app_metrics m JOIN episodes e ON e.id = m.episode_id
    WHERE m.kind = 'playback_stuck' AND m.feed_id = ${feedId}
      AND m.created_at > now() - interval '30 days'
    GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT ${limit}
  `);
  return (r as any).rows.map(toCandidate);
}

// Episodes from the same feed that started successfully and never stalled.
async function controlEpisodes(feedId: string, limit: number): Promise<Candidate[]> {
  const r = await db.execute(sql`
    SELECT e.id, e.title, e.audio_url, 0 AS events, 0 AS devices
    FROM app_metrics m JOIN episodes e ON e.id = m.episode_id
    WHERE m.kind = 'playback_start_ms' AND m.feed_id = ${feedId}
      AND m.created_at > now() - interval '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM app_metrics s
        WHERE s.kind = 'playback_stuck' AND s.episode_id = m.episode_id
      )
    GROUP BY 1, 2, 3 ORDER BY COUNT(*) DESC LIMIT ${limit}
  `);
  return (r as any).rows.map(toCandidate);
}

function toCandidate(x: any): Candidate {
  return {
    episodeId: x.id,
    title: String(x.title || "").slice(0, 60),
    audioUrl: x.audio_url,
    stuckEvents: Number(x.events || 0),
    stuckDevices: Number(x.devices || 0),
  };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}

// Walk redirects by hand (redirect: "manual") so the chain is visible. A
// ranged GET rather than HEAD: some podcast CDNs answer HEAD from an edge that
// never touches origin, so HEAD can look healthy while playback does not.
async function probe(candidate: Candidate, group: ProbeResult["group"]): Promise<ProbeResult> {
  const base: ProbeResult = {
    ...candidate, group,
    status: null, finalHost: hostOf(candidate.audioUrl), hops: 0, crossHost: false,
    acceptsRanges: false, contentLength: null, ttfbMs: null, kbPerSec: null, error: null,
  };

  let url = candidate.audioUrl;
  const startHost = hostOf(url);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Range": `bytes=0-${PROBE_BYTES - 1}`,
          "User-Agent": "ShiurPod/1.0 (playback probe)",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) { base.status = res.status; base.error = "redirect without Location"; break; }
        url = new URL(next, url).toString();
        base.hops++;
        continue;
      }

      base.status = res.status;
      base.finalHost = hostOf(url);
      base.crossHost = base.finalHost !== startHost;
      base.acceptsRanges = res.status === 206 || (res.headers.get("accept-ranges") || "").includes("bytes");
      const len = res.headers.get("content-range")?.split("/")[1] || res.headers.get("content-length");
      base.contentLength = len && /^\d+$/.test(len) ? Number(len) : null;
      base.ttfbMs = Date.now() - started;

      const body = await res.arrayBuffer();
      const elapsedSec = Math.max((Date.now() - started) / 1000, 0.001);
      base.kbPerSec = Math.round(body.byteLength / 1024 / elapsedSec);
      break;
    }
  } catch (e: any) {
    base.error = e?.name === "AbortError" ? `no response in ${PROBE_TIMEOUT_MS}ms` : (e?.message || String(e));
  } finally {
    clearTimeout(timer);
  }

  return base;
}

function pad(v: any, n: number): string {
  const s = String(v ?? "");
  return (s.length > n - 1 ? s.slice(0, n - 1) : s).padEnd(n);
}

async function main() {
  const feeds = FEED_ARG
    ? (await db.execute(sql`SELECT id AS feed_id, title FROM feeds WHERE title ILIKE ${"%" + FEED_ARG + "%"} LIMIT 3`) as any)
        .rows.map((x: any) => ({ feedId: x.feed_id, title: x.title, stuck: 0 }))
    : await worstFeeds(2);

  if (feeds.length === 0) {
    console.log("No matching feed.");
    return;
  }

  const all: ProbeResult[] = [];

  for (const feed of feeds) {
    const stalled = await stalledEpisodes(feed.feedId, SAMPLE);
    const control = await controlEpisodes(feed.feedId, SAMPLE);

    if (!AS_JSON) {
      console.log(`\n${feed.title}${feed.stuck ? `  (${feed.stuck} stuck events / 30d)` : ""}`);
      console.log(`  probing ${stalled.length} stalled + ${control.length} control episode(s)\n`);
      console.log("  " + pad("GROUP", 10) + pad("ST", 5) + pad("HOPS", 6) + pad("RANGE", 7) +
                  pad("TTFB", 8) + pad("KB/S", 8) + pad("SIZE", 9) + pad("HOST", 26) + "TITLE");
      console.log("  " + "-".repeat(118));
    }

    for (const [group, list] of [["stalled", stalled], ["control", control]] as const) {
      for (const c of list) {
        const r = await probe(c, group);
        all.push(r);
        if (AS_JSON) continue;
        console.log("  " +
          pad(group, 10) +
          pad(r.error ? "ERR" : r.status, 5) +
          pad(r.hops + (r.crossHost ? "*" : ""), 6) +
          pad(r.acceptsRanges ? "yes" : "NO", 7) +
          pad(r.ttfbMs != null ? r.ttfbMs + "ms" : "-", 8) +
          pad(r.kbPerSec != null ? r.kbPerSec : "-", 8) +
          pad(r.contentLength != null ? Math.round(r.contentLength / 1024 / 1024) + "MB" : "-", 9) +
          pad(r.finalHost, 26) +
          (r.error ? `${r.title} — ${r.error}` : r.title));
      }
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  // The comparison that matters: stalled vs control, same feeds, same run.
  for (const group of ["stalled", "control"] as const) {
    const rows = all.filter(r => r.group === group);
    if (rows.length === 0) continue;
    const ok = rows.filter(r => !r.error && r.status && r.status < 400);
    const speeds = ok.map(r => r.kbPerSec || 0).sort((a, b) => a - b);
    const ttfbs = ok.map(r => r.ttfbMs || 0).sort((a, b) => a - b);
    console.log(`\n${group}: ${rows.length} probed · ${rows.length - ok.length} failed · ` +
      `median ${speeds[Math.floor(speeds.length / 2)] ?? 0} KB/s · ` +
      `median TTFB ${ttfbs[Math.floor(ttfbs.length / 2)] ?? 0}ms · ` +
      `${ok.filter(r => !r.acceptsRanges).length} without Range support · ` +
      `${ok.filter(r => r.crossHost).length} redirecting off-host`);
  }
  console.log("\n* = redirect chain ends on a different host than it started.");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
