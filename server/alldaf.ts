import axios from "axios";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import { normalizeName } from "./name-utils";
import { filterCrossSourceDuplicates, isMergedFeed } from "./episode-dedup";

// --- Platform Configuration ---

export type OUPlatformKey = "alldaf" | "allmishnah" | "allparsha" | "allhalacha";

interface OUPlatformConfig {
  key: OUPlatformKey;
  label: string;            // Display name
  platformParam: string;    // API platform filter value
  baseUrl: string;          // tRPC base URL
  urlScheme: string;        // e.g. "alldaf://author/"
  guidPrefix: string;       // e.g. "alldaf-"
  feedIdField: "alldafAuthorId" | "allmishnahAuthorId" | "allparshaAuthorId" | "allhalachaAuthorId";
  // tRPC procedure name overrides (AllHalacha uses authorRouter/postRouter instead of authors/posts)
  procedures?: {
    authorsFetchList: string;
    authorsFetchById: string;
    postsFetchList: string;
  };
}

export const OU_PLATFORMS: Record<OUPlatformKey, OUPlatformConfig> = {
  alldaf: {
    key: "alldaf",
    label: "AllDaf",
    platformParam: "AllDaf",
    baseUrl: "https://beta.alldaf.org/api/trpc",
    urlScheme: "alldaf://author/",
    guidPrefix: "alldaf-",
    feedIdField: "alldafAuthorId",
  },
  allmishnah: {
    key: "allmishnah",
    label: "AllMishnah",
    platformParam: "AllMishna",
    baseUrl: "https://allmishnah.org/api/trpc",
    urlScheme: "allmishnah://author/",
    guidPrefix: "allmishnah-",
    feedIdField: "allmishnahAuthorId",
  },
  allparsha: {
    key: "allparsha",
    label: "AllParsha",
    platformParam: "AllParsha",
    baseUrl: "https://allparsha.org/api/trpc",
    urlScheme: "allparsha://author/",
    guidPrefix: "allparsha-",
    feedIdField: "allparshaAuthorId",
  },
  allhalacha: {
    key: "allhalacha",
    label: "AllHalacha",
    platformParam: "AllHalacha",
    baseUrl: "https://allhalacha.org/api/trpc",
    urlScheme: "allhalacha://author/",
    guidPrefix: "allhalacha-",
    feedIdField: "allhalachaAuthorId",
    procedures: {
      authorsFetchList: "authorRouter.fetchList",
      authorsFetchById: "authorRouter.fetchById",
      postsFetchList: "postRouter.fetchList",
    },
  },
};

/** Check if a URL is an API-only scheme (not a real RSS feed) */
export function isApiOnlyUrl(url: string): boolean {
  return url.startsWith("tat://") || url.startsWith("kh://") ||
    Object.values(OU_PLATFORMS).some(c => url.startsWith(c.urlScheme));
}

const DAILY_LEARNING_URL = "https://dailylearnings.outorah.org";
const CLOUDINARY_BASE = "https://res.cloudinary.com/outorah/image/upload";

// --- Types ---

export interface OUAuthor {
  id: number;
  name: string;
  image: string | null;
  postCount: number;
}

export interface OUAuthorDetail extends OUAuthor {
  bio: string | null;
  gender: string | null;
}

export interface OUPost {
  id: number;
  title: string;
  mediaType: string;
  mediaId: string | null;
  videoType: string | null;
  s3Url: string | null;
  hls_url: string | null;
  duration: number;
  episodeNumber: number | null;
  topics: string[];
  hideVideoDownload: boolean;
  publishDate: string | null;
  authors: { id: number; name: string; image: string | null }[];
  series: { id: number; name: string; image: string | null } | null;
  pdf: string | null;
}

// --- API Client ---

async function trpcGet(baseUrl: string, procedures: string, input: Record<string, any>): Promise<any[]> {
  const res = await axios.get(`${baseUrl}/${procedures}`, {
    params: {
      batch: 1,
      input: JSON.stringify(input),
    },
    timeout: 30000,
    headers: { "User-Agent": "ShiurPod/1.0" },
  });
  return res.data;
}

export async function fetchAllAuthors(platform: OUPlatformKey, take: number = 500): Promise<OUAuthor[]> {
  const cfg = OU_PLATFORMS[platform];
  const procedure = cfg.procedures?.authorsFetchList || "authors.fetchList";
  const allAuthors: OUAuthor[] = [];
  let skip = 0;

  while (true) {
    const input: Record<string, any> = cfg.procedures
      ? { "0": { limit: take, offset: skip } }
      : { "0": { sort: [{ field: "postsCount", direction: "desc" }], take, skip, platform: cfg.platformParam, search: "" } };
    const data = await trpcGet(cfg.baseUrl, procedure, input);

    const resultData = data[0]?.result?.data;
    const records = resultData?.records || [];
    if (records.length === 0) {
      if (skip === 0 && resultData !== undefined) {
        console.warn(`${cfg.label}: fetchAllAuthors got data but no records — response shape may have changed:`, JSON.stringify(resultData).slice(0, 200));
      }
      break;
    }

    for (const author of records) {
      allAuthors.push({
        id: author.id,
        name: author.name,
        image: author.image || null,
        postCount: author.postCount || 0,
      });
    }

    if (records.length < take) break;
    skip += take;
    await new Promise(r => setTimeout(r, 200));
  }

  return allAuthors;
}

export async function fetchAuthorById(platform: OUPlatformKey, authorId: number): Promise<OUAuthorDetail | null> {
  const cfg = OU_PLATFORMS[platform];
  const procedure = cfg.procedures?.authorsFetchById || "authors.fetchById";
  try {
    const input: Record<string, any> = cfg.procedures
      ? { "0": { id: authorId } }
      : { "0": { id: authorId, platform: cfg.platformParam } };
    const data = await trpcGet(cfg.baseUrl, procedure, input);
    const author = data[0]?.result?.data;
    if (!author) return null;
    return {
      id: author.id,
      name: author.name,
      image: author.image || null,
      postCount: author.postCount || 0,
      bio: author.bio || null,
      gender: author.gender || null,
    };
  } catch {
    return null;
  }
}

export async function fetchAuthorPosts(platform: OUPlatformKey, authorId: number, limit: number = 50, skip: number = 0): Promise<{ records: OUPost[]; total?: number }> {
  const cfg = OU_PLATFORMS[platform];
  const procedure = cfg.procedures?.postsFetchList || "posts.fetchList";
  const input: Record<string, any> = cfg.procedures
    ? { "0": { authorId, limit, offset: skip } }
    : { "0": { authorId, limit, take: limit, skip, platform: cfg.platformParam, filter: {} } };
  const data = await trpcGet(cfg.baseUrl, procedure, input);
  const result = data[0]?.result?.data || {};
  return { records: result.records || [], total: result.total };
}

export async function fetchAllAuthorPosts(platform: OUPlatformKey, authorId: number): Promise<OUPost[]> {
  const allPosts: OUPost[] = [];
  const limit = 50;
  let skip = 0;

  while (true) {
    const { records } = await fetchAuthorPosts(platform, authorId, limit, skip);
    allPosts.push(...records);

    if (records.length < limit) break;
    skip += limit;
    await new Promise(r => setTimeout(r, 200));
  }

  return allPosts;
}

// --- Daily Learning Schedules ---

export async function fetchDafForDay(date: string): Promise<{ masechta: string; daf: number } | null> {
  try {
    const res = await axios.get(`${DAILY_LEARNING_URL}/getDafForDay`, {
      params: { date },
      timeout: 10000,
    });
    return res.data || null;
  } catch {
    return null;
  }
}

export async function fetchMishnaYomit(date: string): Promise<{ masechta: string; perek: number; mishna: number }[] | null> {
  try {
    const res = await axios.get(`${DAILY_LEARNING_URL}/MishnaYomit`, {
      params: { date },
      timeout: 10000,
    });
    return res.data || null;
  } catch {
    return null;
  }
}

// --- Helpers ---

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildAuthorImageUrl(image: string | null): string | null {
  if (!image) return null;
  return `${CLOUDINARY_BASE}/${image}`;
}

function getAudioUrl(post: OUPost): string | null {
  if (post.s3Url) return post.s3Url;
  if (post.series?.id && post.id) {
    return `https://media.ou.org/torah/${post.series.id}/${post.id}/${post.id}.mp3`;
  }
  if (post.mediaId && post.videoType === "JwPlayer") {
    return `https://cdn.jwplayer.com/manifests/${post.mediaId}.m3u8`;
  }
  if (post.hls_url) return post.hls_url;
  return null;
}

export function mapOUPostToEpisodeData(post: OUPost, feedId: string, guidPrefix: string) {
  const audioUrl = getAudioUrl(post);
  if (!audioUrl) return null;

  const topicStr = Array.isArray(post.topics) && post.topics.length > 0 ? post.topics.join(", ") : null;
  const seriesStr = post.series?.name || null;
  const descParts = [seriesStr, topicStr].filter(Boolean);

  return {
    feedId,
    title: post.title,
    description: descParts.join(" · ") || null,
    audioUrl,
    duration: post.duration ? formatDuration(post.duration) : null,
    publishedAt: post.publishDate ? new Date(post.publishDate) : null,
    guid: `${guidPrefix}${post.id}`,
    imageUrl: post.series?.image ? buildAuthorImageUrl(post.series.image) : null,
    noDownload: post.hideVideoDownload || false,
  };
}

// --- Generic Sync Logic ---

export async function syncOUPlatformAuthors(platform: OUPlatformKey): Promise<{ created: number; linked: number; total: number }> {
  const cfg = OU_PLATFORMS[platform];
  console.log(`${cfg.label} Sync: fetching all authors...`);
  const authors = await fetchAllAuthors(platform);
  console.log(`${cfg.label} Sync: found ${authors.length} authors`);

  const allFeeds = await storage.getAllFeeds();
  const existingFeeds = new Map<number, string>();
  for (const feed of allFeeds) {
    const authorId = (feed as any)[cfg.feedIdField];
    if (authorId) {
      existingFeeds.set(authorId, feed.id);
    }
    if (feed.rssUrl.startsWith(cfg.urlScheme)) {
      const id = parseInt(feed.rssUrl.replace(cfg.urlScheme, ""), 10);
      if (id) existingFeeds.set(id, feed.id);
    }
  }

  // Build normalized name -> feed map for matching
  const feedsByNormalizedName = new Map<string, typeof allFeeds[0]>();
  for (const feed of allFeeds) {
    if ((feed as any)[cfg.feedIdField]) continue;
    if (feed.rssUrl.startsWith(cfg.urlScheme)) continue;
    if (feed.author) {
      const n = normalizeName(feed.author);
      if (n.length >= 3) feedsByNormalizedName.set(n, feed);
    }
    if (feed.title) {
      const normalizedTitle = normalizeName(feed.title);
      if (normalizedTitle.length >= 3 && !feedsByNormalizedName.has(normalizedTitle)) {
        feedsByNormalizedName.set(normalizedTitle, feed);
      }
    }
  }

  let created = 0;
  let linked = 0;

  const isWomanName = (s: string) => /\b(rebbetzin|rabbanit|mrs\.?|ms\.?|miss)\b/i.test(s);

  for (const author of authors) {
    if (author.postCount === 0) continue;
    if (existingFeeds.has(author.id)) continue;
    if (isWomanName(author.name)) continue;

    // Fetch full author detail for bio and gender
    const detail = await fetchAuthorById(platform, author.id);
    if (detail?.gender?.toLowerCase() === "female") continue;

    const normalizedAuthorName = normalizeName(author.name);
    const photoUrl = buildAuthorImageUrl(author.image);
    const bio = detail?.bio ? detail.bio.replace(/<[^>]+>/g, "").trim() : null;

    let matchedFeed = feedsByNormalizedName.get(normalizedAuthorName);
    if (!matchedFeed && normalizedAuthorName.length >= 5) {
      for (const [normalizedFeedName, feed] of feedsByNormalizedName) {
        if (normalizedFeedName.length >= 5 &&
            (normalizedFeedName.includes(normalizedAuthorName) || normalizedAuthorName.includes(normalizedFeedName))) {
          matchedFeed = feed;
          break;
        }
      }
    }

    if (matchedFeed) {
      const updates: Record<string, any> = {
        sourceNetwork: matchedFeed.sourceNetwork || cfg.label,
      };
      // Update image if feed doesn't have one and we have an author photo
      if (!matchedFeed.imageUrl && photoUrl) {
        updates.imageUrl = photoUrl;
      }
      // Update bio if we have one and the feed's description is empty/placeholder
      if (bio && bio.length > 10) {
        const curDesc = matchedFeed.description?.trim() || "";
        if (!curDesc || /^\d+ shiurim on /.test(curDesc) || curDesc === "Shiurim on Kol Halashon") {
          updates.description = bio;
        }
      }
      await storage.updateFeed(matchedFeed.id, updates as any);
      await storage.setOUAuthorId(matchedFeed.id, cfg.feedIdField, author.id);
      linked++;
      console.log(`${cfg.label} Sync: linked "${author.name}" to existing feed "${matchedFeed.title}"`);
    } else {
      try {
        const description = (bio && bio.length > 10) ? bio : `${author.postCount} shiurim on ${cfg.label}`;
        const newFeed = await storage.createFeed({
          title: author.name,
          rssUrl: `${cfg.urlScheme}${author.id}`,
          imageUrl: photoUrl,
          description,
          author: author.name,
          categoryId: null,
          sourceNetwork: cfg.label,
        });
        await storage.setOUAuthorId(newFeed.id, cfg.feedIdField, author.id);
        created++;
      } catch (e: any) {
        if (!e.message?.includes("unique") && !e.message?.includes("duplicate")) {
          console.error(`${cfg.label} Sync: failed to create feed for "${author.name}":`, e.message);
        }
      }
    }
    // Small delay between author detail fetches
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`${cfg.label} Sync complete: ${created} created, ${linked} linked, ${authors.length} total authors`);
  return { created, linked, total: authors.length };
}

// --- Generic Episode Refresh ---

export async function refreshOUFeedEpisodes(
  platform: OUPlatformKey,
  feed: { id: string; title: string; authorId: number },
  feedRecord?: any,
): Promise<{ newEpisodes: number }> {
  const cfg = OU_PLATFORMS[platform];

  // Quick check: fetch first page to see if newest post already exists
  const { records: firstPage } = await fetchAuthorPosts(platform, feed.authorId, 5, 0);
  if (firstPage.length > 0) {
    const newest = firstPage[0];
    if (newest?.id) {
      const exists = await storage.episodeExistsByGuid(feed.id, `${cfg.guidPrefix}${newest.id}`);
      if (exists) {
        await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
        return { newEpisodes: 0 };
      }
    }
  }

  const posts = await fetchAllAuthorPosts(platform, feed.authorId);

  let episodeData = posts
    .map(p => mapOUPostToEpisodeData(p, feed.id, cfg.guidPrefix))
    .filter((ep): ep is NonNullable<typeof ep> => ep !== null);

  // Cross-source dedup for merged feeds
  if (feedRecord && isMergedFeed(feedRecord)) {
    const existingEpisodes = await storage.getEpisodesByFeed(feed.id);
    episodeData = filterCrossSourceDuplicates(episodeData, existingEpisodes, cfg.guidPrefix);
  }

  const inserted = await storage.upsertOUEpisodes(feed.id, episodeData);

  await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });

  if (inserted.length > 0) {
    console.log(`${cfg.label} refresh: ${feed.title} — ${inserted.length} new episode(s)`);
    for (const ep of inserted.slice(0, 3)) {
      sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
    }
  }

  return { newEpisodes: inserted.length };
}

// --- Convenience wrappers (backward-compatible) ---

export async function syncAllDafAuthors() { return syncOUPlatformAuthors("alldaf"); }
export async function syncAllMishnahAuthors() { return syncOUPlatformAuthors("allmishnah"); }
export async function syncAllParshaAuthors() { return syncOUPlatformAuthors("allparsha"); }
export async function syncAllHalachaAuthors() { return syncOUPlatformAuthors("allhalacha"); }

export async function refreshAllDafFeedEpisodes(feed: { id: string; title: string; alldafAuthorId: number }) {
  return refreshOUFeedEpisodes("alldaf", { id: feed.id, title: feed.title, authorId: feed.alldafAuthorId });
}
export async function refreshAllMishnahFeedEpisodes(feed: { id: string; title: string; allmishnahAuthorId: number }) {
  return refreshOUFeedEpisodes("allmishnah", { id: feed.id, title: feed.title, authorId: feed.allmishnahAuthorId });
}
export async function refreshAllParshaFeedEpisodes(feed: { id: string; title: string; allparshaAuthorId: number }) {
  return refreshOUFeedEpisodes("allparsha", { id: feed.id, title: feed.title, authorId: feed.allparshaAuthorId });
}
export async function refreshAllHalachaFeedEpisodes(feed: { id: string; title: string; allhalachaAuthorId: number }) {
  return refreshOUFeedEpisodes("allhalacha", { id: feed.id, title: feed.title, authorId: feed.allhalachaAuthorId });
}

// --- Helper to detect any OU platform from a feed ---

export function detectOUPlatform(feed: { rssUrl: string; alldafAuthorId?: number | null; allmishnahAuthorId?: number | null; allparshaAuthorId?: number | null; allhalachaAuthorId?: number | null }): { platform: OUPlatformKey; authorId: number } | null {
  for (const cfg of Object.values(OU_PLATFORMS)) {
    const authorId = (feed as any)[cfg.feedIdField];
    if (authorId) return { platform: cfg.key, authorId };

    if (feed.rssUrl.startsWith(cfg.urlScheme)) {
      const id = parseInt(feed.rssUrl.replace(cfg.urlScheme, ""), 10);
      if (id) return { platform: cfg.key, authorId: id };
    }
  }
  return null;
}
