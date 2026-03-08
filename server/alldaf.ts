import axios from "axios";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";

const ALLDAF_BASE_URL = "https://beta.alldaf.org/api/trpc";
const DAILY_LEARNING_URL = "https://dailylearnings.outorah.org";
const CLOUDINARY_BASE = "https://res.cloudinary.com/outorah/image/upload";

// --- Types ---

export interface AllDafAuthor {
  id: number;
  name: string;
  image: string | null;
  postCount: number;
}

export interface AllDafAuthorDetail {
  id: number;
  name: string;
  image: string | null;
  bio: string | null;
  is_alldaf: boolean;
  platform: string[];
  postCount: number;
}

export interface AllDafPost {
  id: number;
  title: string;
  mediaType: string; // "Audio" | "Video"
  mediaId: string | null;
  videoType: string | null;
  s3Url: string | null;
  hls_url: string | null;
  duration: number; // seconds
  episodeNumber: number | null;
  topics: string[];
  hideVideoDownload: boolean;
  publishDate: string | null;
  authors: { id: number; name: string; image: string | null }[];
  series: { id: number; name: string; image: string | null } | null;
  pdf: string | null;
}

export interface AllDafSeries {
  id: number;
  name: string;
  active: boolean;
  platform: string[];
  image?: string | null;
}

// --- API Client ---

async function trpcGet(procedures: string, input: Record<string, any>): Promise<any[]> {
  const res = await axios.get(`${ALLDAF_BASE_URL}/${procedures}`, {
    params: {
      batch: 1,
      input: JSON.stringify(input),
    },
    timeout: 30000,
    headers: { "User-Agent": "ShiurPod/1.0" },
  });
  return res.data;
}

export async function fetchAllAuthors(take: number = 500): Promise<AllDafAuthor[]> {
  const allAuthors: AllDafAuthor[] = [];
  let skip = 0;

  while (true) {
    const data = await trpcGet("authors.fetchList", {
      "0": {
        sort: [{ field: "postsCount", direction: "desc" }],
        take,
        skip,
        platform: "AllDaf",
        search: "",
      },
    });

    const records = data[0]?.result?.data?.records || [];
    if (records.length === 0) break;

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

export async function fetchAuthorDetail(authorId: number): Promise<AllDafAuthorDetail | null> {
  const data = await trpcGet("authors.fetchById", {
    "0": { id: authorId, platform: "AllDaf" },
  });
  return data[0]?.result?.data || null;
}

export async function fetchAuthorSeries(authorId: number): Promise<AllDafSeries[]> {
  const data = await trpcGet("series.fetchListByAuthor", {
    "0": { authorId, platform: "AllDaf" },
  });
  return data[0]?.result?.data || [];
}

export async function fetchAuthorPosts(authorId: number, limit: number = 50, skip: number = 0): Promise<{ records: AllDafPost[]; total?: number }> {
  const data = await trpcGet("posts.fetchList", {
    "0": {
      authorId,
      limit,
      take: limit,
      skip,
      platform: "AllDaf",
      filter: {},
    },
  });
  const result = data[0]?.result?.data || {};
  return { records: result.records || [], total: result.total };
}

export async function fetchAllAuthorPosts(authorId: number): Promise<AllDafPost[]> {
  const allPosts: AllDafPost[] = [];
  const limit = 50;
  let skip = 0;

  while (true) {
    const { records } = await fetchAuthorPosts(authorId, limit, skip);
    allPosts.push(...records);

    if (records.length < limit) break;
    skip += limit;
    await new Promise(r => setTimeout(r, 200));
  }

  return allPosts;
}

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

function getAudioUrl(post: AllDafPost): string | null {
  // Direct S3 URL
  if (post.s3Url) return post.s3Url;

  // Try to build S3 URL from series + post ID
  if (post.series?.id && post.id) {
    return `https://media.ou.org/torah/${post.series.id}/${post.id}/${post.id}.mp3`;
  }

  // JWPlayer video — can use HLS manifest
  if (post.mediaId && post.videoType === "JwPlayer") {
    return `https://cdn.jwplayer.com/manifests/${post.mediaId}.m3u8`;
  }

  if (post.hls_url) return post.hls_url;

  return null;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/\b(rabbi|rav|r\.|r'|rebbetzin|harav|hagaon|moreinu|dr\.?|mrs?\.?)\b/gi, "")
    .replace(/\b(shiurim|shiur|lectures?|podcast|audio|video|series|classes?|torah|daf yomi|daf|gemara)\b/gi, "")
    .replace(/\b[a-z]\.\s*/gi, "")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mapAllDafPostToEpisodeData(post: AllDafPost, feedId: string) {
  const audioUrl = getAudioUrl(post);
  if (!audioUrl) return null;

  const topicStr = post.topics?.length > 0 ? post.topics.join(", ") : null;
  const seriesStr = post.series?.name || null;
  const descParts = [seriesStr, topicStr].filter(Boolean);

  return {
    feedId,
    title: post.title,
    description: descParts.join(" · ") || null,
    audioUrl,
    duration: post.duration ? formatDuration(post.duration) : null,
    publishedAt: post.publishDate ? new Date(post.publishDate) : null,
    guid: `alldaf-${post.id}`,
    imageUrl: post.series?.image ? buildAuthorImageUrl(post.series.image) : null,
    noDownload: post.hideVideoDownload || false,
  };
}

// --- Sync Logic ---

export async function syncAllDafAuthors(): Promise<{ created: number; linked: number; total: number }> {
  console.log("AllDaf Sync: fetching all authors...");
  const authors = await fetchAllAuthors();
  console.log(`AllDaf Sync: found ${authors.length} authors`);

  const allFeeds = await storage.getAllFeeds();
  const existingAllDafFeeds = new Map<number, string>();
  for (const feed of allFeeds) {
    if ((feed as any).alldafAuthorId) {
      existingAllDafFeeds.set((feed as any).alldafAuthorId, feed.id);
    }
    // Also check rssUrl pattern
    if (feed.rssUrl.startsWith("alldaf://author/")) {
      const authorId = parseInt(feed.rssUrl.replace("alldaf://author/", ""), 10);
      if (authorId) existingAllDafFeeds.set(authorId, feed.id);
    }
  }

  // Build normalized name -> feed map for matching
  const feedsByNormalizedName = new Map<string, typeof allFeeds[0]>();
  for (const feed of allFeeds) {
    if ((feed as any).alldafAuthorId) continue;
    if (feed.rssUrl.startsWith("alldaf://")) continue;
    if (feed.author) {
      feedsByNormalizedName.set(normalizeName(feed.author), feed);
    }
    if (feed.title) {
      const normalizedTitle = normalizeName(feed.title);
      if (!feedsByNormalizedName.has(normalizedTitle)) {
        feedsByNormalizedName.set(normalizedTitle, feed);
      }
    }
  }

  let created = 0;
  let linked = 0;

  for (const author of authors) {
    if (author.postCount === 0) continue;
    if (existingAllDafFeeds.has(author.id)) continue;

    const normalizedAuthorName = normalizeName(author.name);
    const photoUrl = buildAuthorImageUrl(author.image);

    // Try to match existing feed by name
    let matchedFeed = feedsByNormalizedName.get(normalizedAuthorName);
    if (!matchedFeed && normalizedAuthorName.length >= 5) {
      for (const [normalizedFeedName, feed] of feedsByNormalizedName) {
        if (normalizedFeedName.includes(normalizedAuthorName) || normalizedAuthorName.includes(normalizedFeedName)) {
          matchedFeed = feed;
          break;
        }
      }
    }

    if (matchedFeed) {
      await storage.updateFeed(matchedFeed.id, {
        sourceNetwork: matchedFeed.sourceNetwork || "AllDaf",
      } as any);
      // Store alldafAuthorId via the rssUrl approach won't work for merged feeds.
      // We'll use a direct DB update for the alldafAuthorId column
      await storage.setAlldafAuthorId(matchedFeed.id, author.id);
      linked++;
      console.log(`AllDaf Sync: linked "${author.name}" to existing feed "${matchedFeed.title}"`);
    } else {
      try {
        await storage.createFeed({
          title: author.name,
          rssUrl: `alldaf://author/${author.id}`,
          imageUrl: photoUrl,
          description: `${author.postCount} shiurim on AllDaf`,
          author: author.name,
          categoryId: null,
          sourceNetwork: "AllDaf",
        });
        // Set alldafAuthorId on the newly created feed
        const newFeed = (await storage.getAllFeeds()).find(f => f.rssUrl === `alldaf://author/${author.id}`);
        if (newFeed) {
          await storage.setAlldafAuthorId(newFeed.id, author.id);
        }
        created++;
      } catch (e: any) {
        if (!e.message?.includes("unique") && !e.message?.includes("duplicate")) {
          console.error(`AllDaf Sync: failed to create feed for "${author.name}":`, e.message);
        }
      }
    }
  }

  console.log(`AllDaf Sync complete: ${created} created, ${linked} linked, ${authors.length} total authors`);
  return { created, linked, total: authors.length };
}

// --- Episode Refresh for AllDaf Feeds ---

export async function refreshAllDafFeedEpisodes(feed: { id: string; title: string; alldafAuthorId: number }): Promise<{ newEpisodes: number }> {
  const posts = await fetchAllAuthorPosts(feed.alldafAuthorId);

  const episodeData = posts
    .map(p => mapAllDafPostToEpisodeData(p, feed.id))
    .filter((ep): ep is NonNullable<typeof ep> => ep !== null);

  const inserted = await storage.upsertAllDafEpisodes(feed.id, episodeData);

  await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });

  if (inserted.length > 0) {
    console.log(`AllDaf refresh: ${feed.title} — ${inserted.length} new episode(s)`);
    for (const ep of inserted.slice(0, 3)) {
      sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
    }
  }

  return { newEpisodes: inserted.length };
}
