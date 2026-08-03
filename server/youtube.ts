import axios from "axios";
import * as storage from "./storage";

// YouTube adapter.
//
// Feeds are playlist-scoped: rssUrl = yt://playlist/{playlistId}. A channel's
// full upload history is itself a playlist (swap the UC prefix for UU), so
// "everything this channel posts" is expressible without a separate code path.
//
// Discovery uses the YouTube Data API v3 (YOUTUBE_API_KEY). Channel RSS
// (feeds/videos.xml) only exposes the 15 newest videos and so can't backfill an
// archive. playlistItems.list costs 1 quota unit per 50-item page, so even a
// 3000-video playlist is 60 units against the free 10,000/day allowance.
//
// IMPORTANT: ingest writes to the youtube_pending review queue, never straight
// to `episodes`. Nothing is visible in the app until an admin approves it.
//
// Audio is never stored as a URL — googlevideo stream URLs expire in ~6h, so
// approved episodes get the placeholder yt://audio/{videoId} and the real
// stream is resolved per playback by server/youtube-audio.ts.

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const MAX_PLAYLIST_PAGES = 200; // 200 * 50 = 10k videos, safety cap

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error(
      "YOUTUBE_API_KEY is not set — YouTube ingest needs a YouTube Data API v3 key",
    );
  }
  return key;
}

async function ytApi<T = any>(path: string, params: Record<string, string | number>): Promise<T> {
  const url = `${YT_API_BASE}/${path}`;
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, {
        params: { ...params, key: apiKey() },
        timeout: 30000,
        headers: { Accept: "application/json" },
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return res.data as T;
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      const reason = e?.response?.data?.error?.errors?.[0]?.reason;
      // Quota exhaustion and bad keys are terminal — retrying burns more quota
      // and can't succeed. 404 (missing playlist) is terminal too.
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        throw new Error(`YouTube API quota exceeded (${reason})`);
      }
      if (status === 400 || status === 403 || status === 404) {
        const msg = e?.response?.data?.error?.message || `HTTP ${status}`;
        throw new Error(`YouTube API error: ${msg}`);
      }
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// --- ID extraction ---

const PLAYLIST_ID_RE = /^(?:PL|UU|OL|LL|FL|RD|TL)[A-Za-z0-9_-]{10,}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

// Turn a channel id into its "uploads" playlist id. UC... -> UU... is a stable
// documented alias; no API call needed.
export function channelIdToUploadsPlaylist(channelId: string): string {
  return "UU" + channelId.slice(2);
}

// Synchronous extraction for the forms that don't need an API lookup:
// a bare playlist id, a bare channel id, or any URL carrying ?list= / /channel/.
export function extractPlaylistId(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  if (raw.startsWith("yt://playlist/")) {
    const id = raw.slice("yt://playlist/".length);
    return id || null;
  }
  if (PLAYLIST_ID_RE.test(raw)) return raw;
  if (CHANNEL_ID_RE.test(raw)) return channelIdToUploadsPlaylist(raw);

  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) return null;

  const list = url.searchParams.get("list");
  if (list && PLAYLIST_ID_RE.test(list)) return list;

  const channelMatch = url.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (channelMatch) return channelIdToUploadsPlaylist(channelMatch[1]);

  return null;
}

// Full resolution, including the forms that require an API call: @handles and
// legacy /c/ + /user/ vanity URLs.
export async function resolvePlaylistInput(input: string): Promise<string | null> {
  const direct = extractPlaylistId(input);
  if (direct) return direct;

  const raw = (input || "").trim();
  let handle: string | null = null;
  let legacyName: string | null = null;

  if (raw.startsWith("@")) {
    handle = raw;
  } else {
    try {
      const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
      const handleMatch = url.pathname.match(/^\/(@[A-Za-z0-9._-]+)/);
      if (handleMatch) handle = handleMatch[1];
      const legacyMatch = url.pathname.match(/^\/(?:c|user)\/([A-Za-z0-9._-]+)/);
      if (legacyMatch) legacyName = legacyMatch[1];
    } catch {
      return null;
    }
  }

  if (handle) {
    const data = await ytApi<any>("channels", { part: "contentDetails", forHandle: handle });
    const uploads = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) return uploads;
  }
  if (legacyName) {
    const data = await ytApi<any>("channels", { part: "contentDetails", forUsername: legacyName });
    const uploads = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) return uploads;
  }
  return null;
}

// --- Duration helpers ---

// ISO 8601 duration (PT1H2M3S) -> seconds. Returns null for unparseable input
// and for P0D, which is what the API reports for an in-progress live stream.
export function parseISO8601Duration(iso: string): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const days = parseInt(m[1] || "0", 10);
  const hours = parseInt(m[2] || "0", 10);
  const mins = parseInt(m[3] || "0", 10);
  const secs = parseInt(m[4] || "0", 10);
  const total = days * 86400 + hours * 3600 + mins * 60 + secs;
  return total > 0 ? total : null;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function bestThumbnail(thumbnails: any): string | null {
  if (!thumbnails) return null;
  for (const size of ["maxres", "standard", "high", "medium", "default"]) {
    const t = thumbnails[size];
    if (t?.url) return t.url as string;
  }
  return null;
}

// --- API surface ---

export interface YTPlaylistMeta {
  playlistId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  channelTitle: string | null;
  channelId: string | null;
  itemCount: number;
}

export async function fetchPlaylistMeta(playlistId: string): Promise<YTPlaylistMeta | null> {
  const data = await ytApi<any>("playlists", {
    part: "snippet,contentDetails",
    id: playlistId,
    maxResults: 1,
  });
  const item = data?.items?.[0];
  if (!item) return null;
  return {
    playlistId,
    title: item.snippet?.title || "Untitled Playlist",
    description: item.snippet?.description || null,
    imageUrl: bestThumbnail(item.snippet?.thumbnails),
    channelTitle: item.snippet?.channelTitle || null,
    channelId: item.snippet?.channelId || null,
    itemCount: item.contentDetails?.itemCount ?? 0,
  };
}

export interface YTVideo {
  videoId: string;
  title: string;
  description: string | null;
  publishedAt: Date | null;
  imageUrl: string | null;
  channelTitle: string | null;
  durationSeconds: number | null;
  duration: string | null;
  isLive: boolean;
}

// Walk every page of a playlist. Private/deleted entries are dropped here —
// their snippets carry no usable videoId or title.
export async function fetchPlaylistVideoIds(playlistId: string): Promise<
  { videoId: string; publishedAt: Date | null }[]
> {
  const out: { videoId: string; publishedAt: Date | null }[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const params: Record<string, string | number> = {
      part: "contentDetails,status",
      playlistId,
      maxResults: 50,
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await ytApi<any>("playlistItems", params);
    for (const item of data?.items || []) {
      const videoId = item?.contentDetails?.videoId;
      if (!videoId) continue;
      const privacy = item?.status?.privacyStatus;
      if (privacy === "private") continue;
      const vp = item?.contentDetails?.videoPublishedAt;
      out.push({ videoId, publishedAt: vp ? new Date(vp) : null });
    }
    pageToken = data?.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PLAYLIST_PAGES);

  if (pageToken) {
    console.warn(`YouTube: playlist ${playlistId} exceeded ${MAX_PLAYLIST_PAGES} pages — truncated`);
  }
  return out;
}

// videos.list in batches of 50 (1 quota unit per batch) for the fields
// playlistItems doesn't carry: real duration and live-broadcast state.
export async function fetchVideoDetails(videoIds: string[]): Promise<YTVideo[]> {
  const out: YTVideo[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await ytApi<any>("videos", {
      part: "snippet,contentDetails,status",
      id: batch.join(","),
      maxResults: 50,
    });
    for (const item of data?.items || []) {
      const videoId = item?.id;
      if (!videoId) continue;
      const live = item?.snippet?.liveBroadcastContent;
      const isLive = live === "live" || live === "upcoming";
      const durationSeconds = parseISO8601Duration(item?.contentDetails?.duration || "");
      out.push({
        videoId,
        title: item.snippet?.title || "Untitled",
        description: item.snippet?.description || null,
        publishedAt: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : null,
        imageUrl: bestThumbnail(item.snippet?.thumbnails),
        channelTitle: item.snippet?.channelTitle || null,
        durationSeconds,
        duration: durationSeconds != null ? formatDuration(durationSeconds) : null,
        isLive,
      });
    }
  }
  return out;
}

// --- Ingest ---

export interface YTIngestResult {
  queued: number;
  skippedKnown: number;
  skippedLive: number;
  totalInPlaylist: number;
  shortCircuited: boolean;
}

// Pull a playlist and queue anything unseen for review.
//
// Cheap-path: playlists.list reports contentDetails.itemCount for 1 quota unit.
// If that matches how many videos we already know about for this feed, the
// playlist hasn't changed and we skip the page crawl entirely. Pass
// { full: true } to force the crawl regardless.
export async function ingestYouTubePlaylist(
  feed: { id: string; title: string; youtubePlaylistId: string },
  opts?: { full?: boolean },
): Promise<YTIngestResult> {
  const playlistId = feed.youtubePlaylistId;
  const known = await storage.getKnownYouTubeVideoIds(feed.id);

  let totalInPlaylist = 0;
  if (!opts?.full) {
    try {
      const meta = await fetchPlaylistMeta(playlistId);
      if (meta) {
        totalInPlaylist = meta.itemCount;
        if (meta.itemCount > 0 && meta.itemCount <= known.size) {
          await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
          return {
            queued: 0,
            skippedKnown: known.size,
            skippedLive: 0,
            totalInPlaylist: meta.itemCount,
            shortCircuited: true,
          };
        }
      }
    } catch (e: any) {
      // Metadata is only an optimisation — fall through to the full crawl.
      console.warn(`YouTube ingest: ${feed.title} — meta check failed: ${e.message?.slice(0, 100)}`);
    }
  }

  const entries = await fetchPlaylistVideoIds(playlistId);
  totalInPlaylist = entries.length || totalInPlaylist;

  const newIds = entries.map((e) => e.videoId).filter((id) => !known.has(id));
  const skippedKnown = entries.length - newIds.length;

  if (newIds.length === 0) {
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { queued: 0, skippedKnown, skippedLive: 0, totalInPlaylist, shortCircuited: false };
  }

  const details = await fetchVideoDetails(newIds);

  // Live and scheduled broadcasts have no finished audio track to resolve —
  // they'll be picked up on a later crawl once they've ended and acquired a
  // real duration.
  const ready = details.filter((v) => !v.isLive);
  const skippedLive = details.length - ready.length;

  const rows = ready.map((v) => ({
    feedId: feed.id,
    videoId: v.videoId,
    title: v.title,
    description: v.description,
    duration: v.duration,
    durationSeconds: v.durationSeconds,
    publishedAt: v.publishedAt,
    imageUrl: v.imageUrl,
    channelTitle: v.channelTitle,
  }));

  const queued = await storage.queueYouTubePending(rows);
  await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });

  if (queued > 0) {
    console.log(`YouTube ingest: ${feed.title} — ${queued} video(s) queued for review`);
  }

  return { queued, skippedKnown, skippedLive, totalInPlaylist, shortCircuited: false };
}

// Called by the refresh scheduler. Returns 0 "new episodes" by design — nothing
// becomes an episode here, it only enters the review queue.
export async function refreshYouTubeFeedEpisodes(
  feed: { id: string; title: string; youtubePlaylistId: string },
  _feedRecord?: any,
  opts?: { full?: boolean },
): Promise<{ newEpisodes: number; queued: number }> {
  try {
    const result = await ingestYouTubePlaylist(feed, opts);
    return { newEpisodes: 0, queued: result.queued };
  } catch (e: any) {
    console.error(`YouTube refresh failed for ${feed.title}: ${e.message?.slice(0, 160)}`);
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0, queued: 0 };
  }
}

// Pull the YouTube playlist id off a feed, whether it's stored in the column or
// only encoded in the rssUrl (legacy/manual rows).
export function extractYouTubePlaylistId(feed: {
  rssUrl?: string;
  youtubePlaylistId?: string | null;
}): string | null {
  if (feed.youtubePlaylistId) return feed.youtubePlaylistId;
  if (feed.rssUrl?.startsWith("yt://playlist/")) {
    return feed.rssUrl.slice("yt://playlist/".length) || null;
  }
  return null;
}
