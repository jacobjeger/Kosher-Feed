/**
 * Cross-source episode deduplication for merged feeds.
 * Prevents the same shiur from appearing twice when a feed pulls
 * from multiple sources (e.g. RSS + TAT + KH + OU).
 */
import type { Episode } from "@shared/schema";

/** Parse "H:MM:SS" or "M:SS" duration string to total seconds */
export function parseDurationToSeconds(dur: string | null | undefined): number | null {
  if (!dur) return null;
  const parts = dur.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// Normalize a title for comparison: lowercase, trim, collapse whitespace,
// strip punctuation. So "Parashat Chukat - The Mystery of the Missing Yud"
// matches "Parashat Chukat: The Mystery of the Missing Yud" matches
// "  parashat chukat the mystery of the missing yud  ".
function normalizeTitle(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Filter out episodes that are likely duplicates of existing episodes
 * from other sources. Two episodes count as duplicates if EITHER:
 *   - they share the same normalized title AND fall within 24h of each other, OR
 *   - they fall within 24h AND their durations are within 2 min.
 *
 * The title rule catches the common "same shiur uploaded to RSS and TAT
 * the same day" case the user flagged. The duration fallback catches
 * re-uploads where titles have been renamed (different platform's house
 * style) but the audio file is the same length.
 *
 * Only call this on merged feeds (feeds with multiple source IDs or RSS + platform).
 */
export function filterCrossSourceDuplicates(
  newEpisodes: any[],
  existingEpisodes: Episode[],
  sourcePrefix: string, // "tat-", "kh-", "alldaf-", etc. or "" for RSS
): any[] {
  if (existingEpisodes.length === 0) return newEpisodes;

  // Only compare against episodes from OTHER sources
  const otherSourceEps = existingEpisodes.filter(ep => {
    if (!ep.guid) return true; // RSS episodes without prefix
    if (sourcePrefix && ep.guid.startsWith(sourcePrefix)) return false;
    return true;
  });

  if (otherSourceEps.length === 0) return newEpisodes;

  return newEpisodes.filter(ep => {
    const epDate = ep.publishedAt ? new Date(ep.publishedAt).getTime() : null;
    const epDur = parseDurationToSeconds(ep.duration);
    const epTitle = normalizeTitle(ep.title);

    // Without a date we can't check the 24h window; let it through.
    if (epDate === null) return true;

    const isDuplicate = otherSourceEps.some(existing => {
      const existingDate = existing.publishedAt ? new Date(existing.publishedAt).getTime() : null;
      if (existingDate === null) return false;
      const dateDiff = Math.abs(epDate - existingDate);
      if (dateDiff >= 86400000) return false; // outside 24h: definitely not a duplicate

      // Same date + same title → duplicate (user's stated rule).
      const existingTitle = normalizeTitle(existing.title);
      if (epTitle && existingTitle && epTitle === existingTitle) return true;

      // Fallback: same date + duration within 2 minutes.
      const existingDur = parseDurationToSeconds(existing.duration);
      if (epDur !== null && existingDur !== null && Math.abs(epDur - existingDur) < 120) return true;

      return false;
    });

    return !isDuplicate;
  });
}

/** Check if a feed is merged (has multiple sources) */
export function isMergedFeed(feed: {
  rssUrl: string;
  tatSpeakerId?: number | null;
  alldafAuthorId?: number | null;
  allmishnahAuthorId?: number | null;
  allparshaAuthorId?: number | null;
  allhalachaAuthorId?: number | null;
  kolhalashonRavId?: number | null;
  torahdownloadsSpeakerId?: number | null;
}): boolean {
  const apiSchemes = ["tat://", "kh://", "td://", "alldaf://", "allmishnah://", "allparsha://", "allhalacha://"];
  const hasRealRss = feed.rssUrl && !apiSchemes.some(s => feed.rssUrl.startsWith(s));

  const platformCount = [
    feed.tatSpeakerId,
    feed.alldafAuthorId,
    feed.allmishnahAuthorId,
    feed.allparshaAuthorId,
    feed.allhalachaAuthorId,
    feed.kolhalashonRavId,
    feed.torahdownloadsSpeakerId,
  ].filter(id => id != null).length;

  // Merged if has real RSS + any platform, or multiple platforms
  return (hasRealRss && platformCount > 0) || platformCount > 1;
}
