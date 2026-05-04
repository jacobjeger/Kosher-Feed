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
// strip punctuation, and strip common audio/video format suffixes that
// some publishers append for differentiating the same shiur's media
// variants. So all of these match each other:
//   "Parashat Chukat - The Mystery of the Missing Yud"
//   "Parashat Chukat: The Mystery of the Missing Yud"
//   "Parashat Chukat - The Mystery of the Missing Yud. audio"
//   "Parashat Chukat - The Mystery of the Missing Yud (video)"
export function normalizeTitle(s: string | null | undefined): string {
  if (!s) return "";
  let out = s.toLowerCase();
  // Trim trailing audio/video/mp3/mp4 markers BEFORE stripping punctuation,
  // since they often appear as ". audio", " - video", "(audio version)" etc.
  out = out.replace(/[\s.\-_()\[\]]*\b(audio|video|mp3|mp4|m4a|wav|hd|sd)(\s+version)?[\s.\-_()\[\]]*$/i, "");
  out = out.replace(/[^\p{L}\p{N}\s]/gu, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// Within-batch dedup: collapse new episodes that share the same normalized
// title AND the same publish-day. Picks one canonical entry per group —
// preferring the one with longer duration (more likely the actual shiur,
// not a teaser clip), then falling back to the longest title (more
// descriptive). When two RSS items represent the audio + video of the same
// shiur, this keeps one before they ever reach upsertEpisodes.
export function dedupWithinBatch<T extends { title?: string | null; publishedAt?: Date | string | null; duration?: string | null }>(
  newEpisodes: T[],
): T[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const ep of newEpisodes) {
    const title = normalizeTitle(ep.title);
    const day = ep.publishedAt
      ? new Date(typeof ep.publishedAt === "string" ? ep.publishedAt : ep.publishedAt.toISOString()).toISOString().slice(0, 10)
      : "";
    if (!title || !day) {
      // No usable fingerprint — keep verbatim.
      order.push(`__pass_${order.length}`);
      groups.set(`__pass_${order.length - 1}`, [ep]);
      continue;
    }
    const key = `${title}|${day}`;
    if (!groups.has(key)) {
      groups.set(key, [ep]);
      order.push(key);
    } else {
      groups.get(key)!.push(ep);
    }
  }
  const out: T[] = [];
  for (const key of order) {
    const grp = groups.get(key)!;
    if (grp.length === 1) {
      out.push(grp[0]);
      continue;
    }
    // Pick canonical: longest duration first; tie-break by longest title.
    grp.sort((a, b) => {
      const da = parseDurationToSeconds(a.duration ?? null) ?? 0;
      const db = parseDurationToSeconds(b.duration ?? null) ?? 0;
      if (da !== db) return db - da;
      return (b.title || "").length - (a.title || "").length;
    });
    out.push(grp[0]);
  }
  return out;
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
