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

/**
 * Filter out episodes that are likely duplicates of existing episodes
 * from other sources. Matches on date (within 24h) AND duration (within 2min).
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

    // Can't dedup without both date and duration
    if (epDate === null || epDur === null) return true;

    const isDuplicate = otherSourceEps.some(existing => {
      const existingDate = existing.publishedAt ? new Date(existing.publishedAt).getTime() : null;
      const existingDur = parseDurationToSeconds(existing.duration);

      if (existingDate === null || existingDur === null) return false;

      const dateDiff = Math.abs(epDate - existingDate);
      const durDiff = Math.abs(epDur - existingDur);

      return dateDiff < 86400000 && durDiff < 120; // within 24hrs and 2min
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
}): boolean {
  const apiSchemes = ["tat://", "kh://", "alldaf://", "allmishnah://", "allparsha://", "allhalacha://"];
  const hasRealRss = feed.rssUrl && !apiSchemes.some(s => feed.rssUrl.startsWith(s));

  const platformCount = [
    feed.tatSpeakerId,
    feed.alldafAuthorId,
    feed.allmishnahAuthorId,
    feed.allparshaAuthorId,
    feed.allhalachaAuthorId,
    feed.kolhalashonRavId,
  ].filter(id => id != null).length;

  // Merged if has real RSS + any platform, or multiple platforms
  return (hasRealRss && platformCount > 0) || platformCount > 1;
}
