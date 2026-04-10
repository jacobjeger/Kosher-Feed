/**
 * Extract platform-specific IDs from feed properties or URL schemes.
 * Centralizes the 12+ duplicated parsing patterns across routes.ts and index.ts.
 */

export function extractKhRavId(feed: { kolhalashonRavId?: number | null; rssUrl: string }): number | null {
  if (feed.kolhalashonRavId) return feed.kolhalashonRavId;
  if (feed.rssUrl.startsWith("kh://rav/")) {
    return parseInt(feed.rssUrl.replace("kh://rav/", ""), 10) || null;
  }
  return null;
}

export function extractTatSpeakerId(feed: { tatSpeakerId?: number | null; rssUrl: string }): number | null {
  if (feed.tatSpeakerId) return feed.tatSpeakerId;
  if (feed.rssUrl.startsWith("tat://speaker/")) {
    return parseInt(feed.rssUrl.replace("tat://speaker/", ""), 10) || null;
  }
  return null;
}
