// YTC: download settings + auto-download orchestration.
//
// Phase 1 (per-shiur download button) is wired directly from the
// shiurim card via DownloadsContext — no logic in this file is needed
// for that path. Phase 2 (auto-download) lives here:
//
//   - Settings persisted to AsyncStorage (mode, selected rebbeim,
//     max item cap, Wi-Fi-only).
//   - runYtcAutoDownload(ctx) reads settings, fetches the cached
//     shiurim list, picks the targets, and queues them through the
//     existing DownloadsContext. Runs on YTC home/settings mount.
//
// Why not BackgroundSync.tsx? That subsystem queries shiurpod's
// server feeds; YTC has its own (Firebase) source of truth and
// runs through a different cache. Keeping it scoped here means
// removing YTC later is one delete + a few callsites.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { isOnWifi } from "@/lib/network";
import { fetchShiurim } from "@/lib/ytc/firebase";
import { ytcShiurToEpisodeAndFeed, isYtcEpisodeId } from "@/lib/ytc/audio-adapter";
import { trackShiurDownload } from "@/lib/ytc/analytics";
import type { Shiur } from "@/types/ytc";
import type { Episode, Feed, DownloadedEpisode } from "@/lib/types";

const SETTINGS_KEY = "@ytc_download_settings:v1";

export type YtcAutoDownloadMode = "off" | "all" | "selected";

export interface YtcDownloadSettings {
  mode: YtcAutoDownloadMode;
  selectedRebbeim: string[]; // rebbe names from Shiur.rebbe — case-sensitive match
  maxItems: number; // 50 | 100 | 250 | -1 (unlimited)
  wifiOnly: boolean;
  autoDeleteAfterMs: number; // 0 = off; common: 24h / 48h / 7d / 30d
}

const DEFAULTS: YtcDownloadSettings = {
  mode: "off",
  selectedRebbeim: [],
  maxItems: 50,
  wifiOnly: true,
  autoDeleteAfterMs: 0,
};

// ShiurPod's COMPLETED_KEY (lib/auto-delete-download.ts). YTC episodes get
// marked there too because the shared AudioPlayerContext.markDownloadCompleted
// fires for any played-through episode regardless of source. The global
// ShiurPod sweep skips ytc:* ids; we own the YTC-side cleanup here.
const COMPLETED_KEY = "@shiurpod_completed_downloads";

let _cached: YtcDownloadSettings | null = null;
type Listener = (s: YtcDownloadSettings) => void;
const listeners = new Set<Listener>();

export async function getYtcDownloadSettings(): Promise<YtcDownloadSettings> {
  if (_cached) return _cached;
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<YtcDownloadSettings>;
      _cached = { ...DEFAULTS, ...parsed };
    } else {
      _cached = { ...DEFAULTS };
    }
  } catch {
    _cached = { ...DEFAULTS };
  }
  return _cached;
}

export async function setYtcDownloadSettings(next: YtcDownloadSettings): Promise<void> {
  _cached = next;
  try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  listeners.forEach((fn) => { try { fn(next); } catch {} });
}

export function onYtcDownloadSettingsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Pull every unique rebbe name out of the shiurim collection. Used by the
 *  settings UI to render a checklist; shiurpod's `rebbeim` directory may
 *  not match Shiur.rebbe verbatim, so we go straight to the source. */
export async function listAllRebbeim(): Promise<string[]> {
  const shiurim = (await fetchShiurim()) as Shiur[];
  const seen = new Set<string>();
  for (const s of shiurim) {
    if (s.rebbe) seen.add(s.rebbe);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

interface DownloadsLike {
  downloads: DownloadedEpisode[];
  isDownloaded: (id: string) => boolean;
  isDownloading: (id: string) => boolean;
  downloadEpisode: (episode: Episode, feed: Feed) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
}

/** All downloaded items whose id is in the YTC namespace. Useful for
 *  showing a count in the settings page and for storage enforcement. */
export function getYtcDownloads(ctx: DownloadsLike): DownloadedEpisode[] {
  return ctx.downloads.filter((d) => isYtcEpisodeId(d.id));
}

/** Remove all YTC items from the user's downloads. Used by the
 *  "Delete all YTC downloads" action in settings. */
export async function deleteAllYtcDownloads(ctx: DownloadsLike): Promise<number> {
  const ytc = getYtcDownloads(ctx);
  for (const item of ytc) {
    try { await ctx.removeDownload(item.id); } catch {}
  }
  // Also clear their entries from the shared completion log so a future
  // re-download starts a fresh TTL.
  try {
    const raw = await AsyncStorage.getItem(COMPLETED_KEY);
    if (raw) {
      const completed = JSON.parse(raw) as Record<string, number>;
      let changed = false;
      for (const id of Object.keys(completed)) {
        if (id.startsWith("ytc:")) { delete completed[id]; changed = true; }
      }
      if (changed) await AsyncStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
    }
  } catch {}
  return ytc.length;
}

/** Sweep YTC downloads whose listen-completion is older than the user's
 *  configured TTL. No-op when settings.autoDeleteAfterMs is 0. */
export async function cleanupExpiredYtcDownloads(ctx: DownloadsLike): Promise<number> {
  const settings = await getYtcDownloadSettings();
  if (settings.autoDeleteAfterMs <= 0) return 0;

  let completed: Record<string, number>;
  try {
    const raw = await AsyncStorage.getItem(COMPLETED_KEY);
    if (!raw) return 0;
    completed = JSON.parse(raw);
  } catch { return 0; }

  const now = Date.now();
  const ttl = settings.autoDeleteAfterMs;
  const downloadedSet = new Set(getYtcDownloads(ctx).map((d) => d.id));
  const expired: string[] = [];
  for (const [id, completedAt] of Object.entries(completed)) {
    if (!id.startsWith("ytc:")) continue;
    if (!downloadedSet.has(id)) continue; // already removed by other path
    if (now - completedAt >= ttl) expired.push(id);
  }
  for (const id of expired) {
    try { await ctx.removeDownload(id); } catch {}
  }
  // Prune the completion log so it doesn't grow forever.
  if (expired.length > 0) {
    try {
      for (const id of expired) delete completed[id];
      await AsyncStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
    } catch {}
  }
  return expired.length;
}

/** Evict the oldest YTC downloads until count ≤ max. Skips eviction when
 *  max < 0 (unlimited). Items are sorted by `downloadedAt` descending so
 *  the most recent stay. */
export async function enforceYtcStorageLimit(ctx: DownloadsLike, max: number): Promise<void> {
  if (max < 0) return;
  const ytc = getYtcDownloads(ctx).slice().sort(
    (a, b) => new Date(b.downloadedAt).getTime() - new Date(a.downloadedAt).getTime(),
  );
  if (ytc.length <= max) return;
  const overflow = ytc.slice(max);
  for (const item of overflow) {
    try { await ctx.removeDownload(item.id); } catch {}
  }
}

export interface AutoDownloadResult {
  ranAt: string;
  skippedReason?: "off" | "no-wifi" | "no-shiurim";
  queued: number;
  alreadyHave: number;
  evicted: number;
}

/**
 * Run a single pass of YTC auto-download. Idempotent — calling it twice
 * back-to-back is cheap because all the early-out paths and the queue
 * dedup in DownloadsContext.downloadEpisode prevent re-enqueue.
 */
export async function runYtcAutoDownload(ctx: DownloadsLike): Promise<AutoDownloadResult> {
  const ranAt = new Date().toISOString();
  const settings = await getYtcDownloadSettings();

  // Auto-delete runs regardless of auto-download mode — the user can
  // turn auto-download off but still want completed shiurim cleared.
  await cleanupExpiredYtcDownloads(ctx).catch(() => {});

  if (settings.mode === "off") return { ranAt, skippedReason: "off", queued: 0, alreadyHave: 0, evicted: 0 };

  if (settings.wifiOnly) {
    const onWifi = await isOnWifi();
    if (!onWifi) return { ranAt, skippedReason: "no-wifi", queued: 0, alreadyHave: 0, evicted: 0 };
  }

  let shiurim: Shiur[];
  try {
    shiurim = (await fetchShiurim()) as Shiur[];
  } catch {
    return { ranAt, skippedReason: "no-shiurim", queued: 0, alreadyHave: 0, evicted: 0 };
  }
  if (!shiurim.length) return { ranAt, skippedReason: "no-shiurim", queued: 0, alreadyHave: 0, evicted: 0 };

  // Filter by mode + sort newest-first so the "max items" cap keeps the
  // freshest content. Skip shiurim with no audio URL.
  let candidates = shiurim.filter((s) => !!s.audioUrl);
  if (settings.mode === "selected") {
    const set = new Set(settings.selectedRebbeim);
    candidates = candidates.filter((s) => set.has(s.rebbe));
  }
  candidates.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  // Cap to max items so we never queue more than the user wants stored.
  const maxItems = settings.maxItems;
  if (maxItems >= 0) candidates = candidates.slice(0, maxItems);

  let queued = 0;
  let alreadyHave = 0;
  for (const s of candidates) {
    const id = `ytc:${s.id}`;
    if (ctx.isDownloaded(id) || ctx.isDownloading(id)) { alreadyHave += 1; continue; }
    const { episode, feed } = ytcShiurToEpisodeAndFeed(s);
    try {
      // DownloadsContext.downloadEpisode handles queueing + concurrency.
      // Don't await — we want to let the queue run in the background.
      // Fire analytics for each queued item; the track endpoint handles
      // downloadCount increment too.
      trackShiurDownload(s.id).catch(() => {});
      ctx.downloadEpisode(episode, feed).catch(() => {});
      queued += 1;
    } catch {}
  }

  // Evict overflow AFTER queueing so newly-queued items count toward
  // the cap on the next run.
  const beforeCount = getYtcDownloads(ctx).length;
  await enforceYtcStorageLimit(ctx, maxItems);
  const afterCount = getYtcDownloads(ctx).length;
  return { ranAt, queued, alreadyHave, evicted: Math.max(0, beforeCount - afterCount) };
}
