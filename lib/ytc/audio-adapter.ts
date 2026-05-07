// YTC: synthesize shiurpod-shaped Episode + Feed objects from a YTC Shiur,
// then play through ShiurPod's existing AudioPlayerContext (mini-player,
// queue, lock-screen controls, position resume — all reused for free).
//
// Shiurpod's AudioPlayerContext.playEpisode(episode, feed) writes the
// position to AsyncStorage AND POSTs to /api/playback-positions on every
// position change. The synthetic ytc:* ids would pollute the
// playback_positions table — that's filtered out at the source by a
// 1-line guard in contexts/AudioPlayerContext.tsx (search for "// YTC:").
// In-app resume still works because AsyncStorage is allowed through.

import type { Episode, Feed } from "@/lib/types";
import type { Shiur } from "@/types/ytc";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { trackShiurPlay } from "@/lib/ytc/analytics";

export const YTC_FEED_PREFIX = "ytc:feed:";
export const YTC_EPISODE_PREFIX = "ytc:";

/** Convert a Google Drive share URL into a direct-download URL the
 *  player can stream. iOS's AudioPlayerManager.processAudioUrl does
 *  the same — patterns matched: /file/d/{id}/, ?id={id}, /open?id={id}.
 *  Pass-through for anything that doesn't match (most YTC shiurim are
 *  already direct CDN URLs). */
export function processYtcAudioUrl(url: string): string {
  if (!url || !/drive\.google\.com/i.test(url)) return url;
  let id: string | null = null;
  const m1 = url.match(/\/file\/d\/([^/]+)/);
  if (m1) id = m1[1];
  if (!id) {
    const m2 = url.match(/[?&]id=([^&]+)/);
    if (m2) id = m2[1];
  }
  if (!id) return url;
  return `https://drive.google.com/uc?export=download&id=${id}`;
}

/** True when the id was synthesized by this adapter (guards in shared code). */
export function isYtcEpisodeId(id: string): boolean {
  return id.startsWith(YTC_EPISODE_PREFIX);
}

/** Per-rebbe synthetic Feed. Reused as the `feed` arg to playEpisode. */
export function ytcRebbeToFeed(rebbeName: string): Feed {
  const id = `${YTC_FEED_PREFIX}${rebbeName.toLowerCase().replace(/\s+/g, "-")}`;
  return {
    id,
    title: rebbeName,
    rssUrl: "",
    imageUrl: null,
    description: null,
    author: rebbeName,
    categoryId: null,
    isActive: true,
    isFeatured: false,
    scheduledPublishAt: null,
    lastFetchedAt: null,
    createdAt: new Date().toISOString(),
    sourceNetwork: "ytc",
  } as Feed;
}

/** Synthetic Episode wrapping a YTC Shiur. Audio plays from shiur.audioUrl. */
export function ytcShiurToEpisode(shiur: Shiur, feed: Feed): Episode {
  return {
    id: `${YTC_EPISODE_PREFIX}${shiur.id}`,
    feedId: feed.id,
    title: shiur.title,
    description: shiur.description ?? null,
    audioUrl: processYtcAudioUrl(shiur.audioUrl ?? ""),
    duration: null, // YTC Shiur has no duration field; player computes from media
    publishedAt: shiur.date || null,
    guid: `${YTC_EPISODE_PREFIX}${shiur.id}`,
    imageUrl: null,
    adminNotes: null,
    sourceSheetUrl: shiur.pdfUrl ?? null,
    createdAt: shiur.date || new Date().toISOString(),
    noDownload: false, // Downloads ARE supported — see lib/ytc/downloads.ts
  } as Episode;
}

/** Build {episode, feed} from a Shiur. Used by lib/ytc/downloads.ts so the
 *  download subsystem can hand DownloadsContext correctly-shaped objects
 *  without going through the React hook tree. */
export function ytcShiurToEpisodeAndFeed(shiur: Shiur): { episode: Episode; feed: Feed } {
  const feed = ytcRebbeToFeed(shiur.rebbe || "YTC");
  const episode = ytcShiurToEpisode(shiur, feed);
  return { episode, feed };
}

/**
 * Hook returning a single function: pass a Shiur, get playback. Wraps
 * AudioPlayerContext's playEpisode and fires off Firestore's
 * incrementPlayCount fire-and-forget (failures don't block playback).
 */
export function useYtcPlay() {
  const { playEpisode } = useAudioPlayer();
  return async (shiur: Shiur) => {
    if (!shiur.audioUrl) return;
    const feed = ytcRebbeToFeed(shiur.rebbe || "YTC");
    const episode = ytcShiurToEpisode(shiur, feed);
    await playEpisode(episode, feed);
    // /api/track/play increments playCount AND writes the shiurPlays
    // analytics doc atomically. Supersedes the old direct-Firestore
    // incrementPlayCount call.
    trackShiurPlay(shiur.id).catch(() => {});
  };
}

/**
 * Richer hook for screens that need to render play/pause icons in a list
 * of shiurim. Provides:
 *   currentShiurId — id of the YTC shiur currently playing (null if a
 *                    non-YTC episode or nothing is playing)
 *   isPlaying      — playback.isPlaying from the shared player
 *   isLoading      — playback.isLoading
 *   play(shiur)    — start playback of the given shiur
 *   pauseResume()  — toggle pause/resume on the current player
 */
export function useYtcPlayer() {
  const { currentEpisode, playback, playEpisode, pause, resume } = useAudioPlayer();
  const currentShiurId = currentEpisode && isYtcEpisodeId(currentEpisode.id)
    ? currentEpisode.id.slice(YTC_EPISODE_PREFIX.length)
    : null;
  return {
    currentShiurId,
    isPlaying: !!playback.isPlaying,
    isLoading: !!playback.isLoading,
    play: async (shiur: Shiur) => {
      if (!shiur.audioUrl) return;
      const feed = ytcRebbeToFeed(shiur.rebbe || "YTC");
      const episode = ytcShiurToEpisode(shiur, feed);
      await playEpisode(episode, feed);
      // /api/track/play increments playCount AND writes the shiurPlays
    // analytics doc atomically. Supersedes the old direct-Firestore
    // incrementPlayCount call.
    trackShiurPlay(shiur.id).catch(() => {});
    },
    pauseResume: async () => {
      if (playback.isPlaying) await pause();
      else await resume();
    },
  };
}
