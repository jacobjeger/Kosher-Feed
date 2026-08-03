import { Innertube, type Types } from "youtubei.js";

// YouTube audio-stream resolver.
//
// YouTube exposes no stable audio URL. The googlevideo.com URLs handed out by
// the player are signed and expire in roughly 6 hours, so they can never be
// stored on the episode row — episodes hold the placeholder yt://audio/{id}
// and this module resolves a fresh URL at playback time.
//
// Client choice matters: the WEB client now demands a Proof-of-Origin token
// and reliably fails from datacenter IPs. The mobile/TV clients still serve
// adaptive formats without one, so we try those in order and fall through on
// failure. If YouTube tightens this further, the fix is usually just a
// youtubei.js bump plus a reorder of CLIENT_CHAIN.
//
// Known operational risk: Railway runs on datacenter IPs, which YouTube
// bot-checks far more aggressively than residential ones. If resolution starts
// failing across the board, set YOUTUBE_HTTP_PROXY to route through a
// residential proxy.

// IOS leads because it's what actually resolves on a healthy session — it won
// every probe from Railway once the session was fresh. The rest are fallbacks
// for the cases where a single client is restricted (age-gate, embed rules).
// Order matters for latency: every client that fails before the winning one
// costs a round trip on each cold resolve.
//
// WEB is deliberately absent — it unconditionally requires a Proof-of-Origin
// token now and would fail every time.
const CLIENT_CHAIN: Types.InnerTubeClient[] = [
  "IOS",
  "ANDROID",
  "TV",
  "TV_SIMPLY",
  "ANDROID_VR",
  "YTMUSIC_ANDROID",
  "WEB_EMBEDDED",
  "TV_EMBEDDED",
  "MWEB",
];

// googlevideo URLs carry an expiry in the `expire` query param (unix seconds).
// Cache a little under that so we never hand the client a URL that dies
// mid-listen. Falls back to this when no expiry can be read.
const DEFAULT_TTL_MS = 90 * 60 * 1000; // 90 minutes
const EXPIRY_SAFETY_MS = 15 * 60 * 1000; // stop using a URL 15 min before expiry
const MAX_CACHE_ENTRIES = 500;
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // don't hammer a video that just failed

export interface ResolvedAudio {
  url: string;
  mimeType: string;
  contentLength: number | null;
  durationMs: number | null;
  client: string;
}

interface CacheEntry {
  value: ResolvedAudio | null; // null = negative cache (recent failure)
  expiresAt: number;
  error?: string;
}

const cache = new Map<string, CacheEntry>();
// Collapses concurrent requests for the same video into one resolve. Without
// it, ten listeners starting the same shiur at once means ten Innertube calls.
const inflight = new Map<string, Promise<ResolvedAudio>>();

let innertube: Innertube | null = null;
let innertubePromise: Promise<Innertube> | null = null;

async function getInnertube(): Promise<Innertube> {
  if (innertube) return innertube;
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      retrieve_player: true,
      generate_session_locally: true,
    }).then((yt) => {
      innertube = yt;
      return yt;
    }).catch((e) => {
      innertubePromise = null;
      throw e;
    });
  }
  return innertubePromise;
}

// Force a fresh Innertube session. YouTube rotates the player JS periodically;
// a stale cached player is a common cause of sudden decipher failures.
export function resetInnertube(): void {
  innertube = null;
  innertubePromise = null;
}

function ttlFromUrl(url: string): number {
  try {
    const expire = new URL(url).searchParams.get("expire");
    if (expire) {
      const expiresAtMs = parseInt(expire, 10) * 1000;
      const ttl = expiresAtMs - Date.now() - EXPIRY_SAFETY_MS;
      if (ttl > 60_000) return ttl;
    }
  } catch {}
  return DEFAULT_TTL_MS;
}

function pruneCache(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
  // Still oversized after dropping expired entries — evict oldest-inserted.
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

let lastSessionRotateAt = 0;
const SESSION_ROTATE_COOLDOWN_MS = 60_000;

async function resolveUncached(videoId: string): Promise<ResolvedAudio> {
  try {
    return await attemptResolve(videoId);
  } catch (firstErr: any) {
    // YouTube flags the Innertube SESSION, not just the host. Once it decides
    // a session is a bot, every client in the chain starts answering
    // "Streaming data not available" — including clients that worked minutes
    // earlier. Minting a fresh session clears it, which is why a redeploy
    // always appears to "fix" YouTube playback.
    //
    // Rotate and retry once. The cooldown stops a run of genuinely dead
    // videos (private, deleted, region-locked) from spinning up a new session
    // per request — those fail for real reasons a new session won't change.
    if (Date.now() - lastSessionRotateAt < SESSION_ROTATE_COOLDOWN_MS) throw firstErr;
    lastSessionRotateAt = Date.now();
    console.warn(`YouTube audio: all clients failed for ${videoId} — rotating Innertube session and retrying`);
    resetInnertube();
    const resolved = await attemptResolve(videoId);
    console.log(`YouTube audio: session rotation recovered ${videoId}`);
    return resolved;
  }
}

async function attemptResolve(videoId: string): Promise<ResolvedAudio> {
  const yt = await getInnertube();
  const errors: string[] = [];

  for (const client of CLIENT_CHAIN) {
    try {
      const format = await yt.getStreamingData(videoId, {
        type: "audio",
        quality: "best",
        client,
      });
      const url = format?.url;
      if (!url) {
        errors.push(`${client}: no url on format`);
        continue;
      }
      // Which client won matters operationally — when YouTube tightens things
      // again, the logs show exactly which clients are still viable.
      console.log(`YouTube audio: resolved ${videoId} via ${client}`);
      return {
        url,
        mimeType: format.mime_type || "audio/mp4",
        contentLength: format.content_length ?? null,
        durationMs: format.approx_duration_ms ?? null,
        client,
      };
    } catch (e: any) {
      errors.push(`${client}: ${e?.message?.slice(0, 120) || "unknown"}`);
    }
  }

  throw new Error(`No audio format for ${videoId} — ${errors.join("; ")}`);
}

export async function resolveAudioStream(videoId: string): Promise<ResolvedAudio> {
  const now = Date.now();
  const hit = cache.get(videoId);
  if (hit && hit.expiresAt > now) {
    if (hit.value) return hit.value;
    throw new Error(hit.error || `Audio unavailable for ${videoId}`);
  }

  const existing = inflight.get(videoId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const resolved = await resolveUncached(videoId);
      cache.set(videoId, { value: resolved, expiresAt: Date.now() + ttlFromUrl(resolved.url) });
      pruneCache();
      return resolved;
    } catch (e: any) {
      const message = e?.message || `Audio unavailable for ${videoId}`;
      cache.set(videoId, { value: null, expiresAt: Date.now() + NEGATIVE_TTL_MS, error: message });
      pruneCache();
      throw e;
    } finally {
      inflight.delete(videoId);
    }
  })();

  inflight.set(videoId, promise);
  return promise;
}

// Drop a cached entry — used when a proxied stream 403s mid-flight, which means
// the signed URL went stale earlier than its advertised expiry.
export function invalidateAudioCache(videoId: string): void {
  cache.delete(videoId);
}

export function audioCacheStats(): { entries: number; positive: number; negative: number } {
  let positive = 0;
  let negative = 0;
  const now = Date.now();
  for (const v of cache.values()) {
    if (v.expiresAt <= now) continue;
    if (v.value) positive++;
    else negative++;
  }
  return { entries: cache.size, positive, negative };
}

export const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
