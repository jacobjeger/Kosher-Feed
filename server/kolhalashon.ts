import { execFileSync } from "child_process";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import { normalizeName } from "./name-utils";
import { filterCrossSourceDuplicates, isMergedFeed } from "./episode-dedup";

// Real KH API base URL (from the official Python SDK: pypi.org/project/kolhalashon)
const KH_BASE_URL = "https://srv.kolhalashon.com/api";

// --- Types ---

export interface KHSearchItem {
  SearchItemId: number;
  SearchItemType: number; // 2 = rav, 8 = book, 10 = shiur
  SearchItemTextHebrew: string;
  SearchItemTextEnglish: string;
  SearchItemCount: number;
  ImageFileName: string | null;
}

// --- HTTP Client via curl ---
// Cloudflare fingerprints TLS clients — Node.js axios/fetch get blocked (403)
// but curl with --tlsv1.3 and browser-like sec-fetch headers passes through.

const CURL_HEADERS = [
  "-H", "accept: application/json, text/plain, */*",
  "-H", "accept-language: he-IL,he;q=0.9,en-AU;q=0.8,en;q=0.7,en-US;q=0.6",
  "-H", "authorization-site-key: Bearer 8ea2pe8",
  "-H", "content-type: application/json",
  "-H", "origin: https://www2.kolhalashon.com",
  "-H", "referer: https://www2.kolhalashon.com/",
  '-H', 'sec-ch-ua: "Chromium";v="120", "Google Chrome";v="120", "Not=A?Brand";v="8"',
  "-H", "sec-ch-ua-mobile: ?0",
  '-H', 'sec-ch-ua-platform: "macOS"',
  "-H", "sec-fetch-dest: empty",
  "-H", "sec-fetch-mode: cors",
  "-H", "sec-fetch-site: cross-site",
  "-H", "user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

function curlGet(url: string, timeoutSec: number = 30): string {
  const args = ["-s", "--tlsv1.3", "--max-time", String(timeoutSec), ...CURL_HEADERS, url];
  return execFileSync("curl", args, {
    encoding: "utf8",
    timeout: (timeoutSec + 5) * 1000,
  });
}

function curlPost(url: string, body: string, timeoutSec: number = 30): string {
  const args = ["-s", "--tlsv1.3", "--max-time", String(timeoutSec), "-X", "POST", "-d", body, ...CURL_HEADERS, url];
  return execFileSync("curl", args, {
    encoding: "utf8",
    timeout: (timeoutSec + 5) * 1000,
  });
}

function khGet(path: string): any {
  const raw = curlGet(`${KH_BASE_URL}${path}`);
  try {
    return JSON.parse(raw);
  } catch {
    // Check if CF blocked us
    if (raw.includes("Just a moment") || raw.includes("challenge-platform")) {
      throw Object.assign(new Error("Cloudflare blocked the request"), { response: { status: 403 } });
    }
    throw new Error(`KH API returned non-JSON: ${raw.substring(0, 150)}`);
  }
}

function khPost(path: string, body: any): any {
  const raw = curlPost(`${KH_BASE_URL}${path}`, JSON.stringify(body));
  try {
    return JSON.parse(raw);
  } catch {
    if (raw.includes("Just a moment") || raw.includes("challenge-platform")) {
      throw Object.assign(new Error("Cloudflare blocked the request"), { response: { status: 403 } });
    }
    throw new Error(`KH API returned non-JSON: ${raw.substring(0, 150)}`);
  }
}

// Keep for backward compatibility with routes.ts
export function reloadKHClient() {}

// --- API Functions ---

export function searchItems(keyword: string = "NULL", userId: number = -1, limit: number = 5000): KHSearchItem[] {
  return khGet(`/Search/WebSite_GetSearchItems/${encodeURIComponent(keyword)}/${userId}/1/${limit}`);
}

export function getSpeakerShiurim(ravId: number, fromRow: number, numRows: number): any[] {
  const body = {
    QueryType: -1,
    LangID: -1,
    MasechetID: -1,
    DafNo: -1,
    MasechetIDY: -1,
    DafNoY: -1,
    MoedID: -1,
    ParashaID: -1,
    EnglishDisplay: true,
    MasechetIDYOz: -1,
    DafNoYOz: -1,
    FromRow: fromRow,
    NumOfRows: numRows,
    PrefferedLanguage: -1,
    SearchOrder: 7,
    FiltersArray: [],
    GeneralID: ravId,
    FilterSwitch: "1".repeat(111),
    activefilterType: "all",
  };
  return khPost("/Search/WebSite_GetRavShiurim/", body);
}

export function getShiurDetails(fileId: number): any {
  return khGet(`/TblShiurimLists/WebSite_GetShiurDetails/${fileId}`);
}

export function getAllSpeakerShiurim(ravId: number, maxShiurim: number = 150): any[] {
  const allShiurim: any[] = [];
  const pageSize = 24;
  let fromRow = 0;

  while (fromRow < maxShiurim) {
    const batch = getSpeakerShiurim(ravId, fromRow, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allShiurim.push(...batch);
    if (batch.length < pageSize) break;
    fromRow += pageSize;
  }

  return allShiurim;
}

// --- Helpers ---

function buildSpeakerImageUrl(imageFilename: string | null): string | null {
  if (!imageFilename) return null;
  return `https://www.kolhalashon.com/Images/Ravs/${imageFilename}`;
}

// --- Episode Mapping ---

export function mapKHShiurToEpisodeData(shiur: any, feedId: string) {
  const fileId = shiur.FileId || shiur.FileID;
  const title = shiur.TitleEnglish?.trim() || shiur.TitleHebrew?.trim() || "Untitled";
  const topicParts = [
    shiur.MainTopicEnglish || shiur.MainTopicHebrew,
    shiur.CatDescEnglish1 || shiur.CatDesc1,
  ].filter(Boolean);

  // Audio URL pattern: files are served from the API's download endpoint
  const audioUrl = `${KH_BASE_URL}/files/getLocationOfFileToVideo/${fileId}`;

  return {
    feedId,
    title,
    description: topicParts.join(" > ") || null,
    audioUrl,
    duration: shiur.ShiurDuration || null,
    publishedAt: shiur.RecordDate ? new Date(shiur.RecordDate) : null,
    guid: `kh-${fileId}`,
    imageUrl: null,
    kolhalashonFileId: fileId,
    noDownload: shiur.DisableDownload || false,
  };
}

// --- Sync Logic ---

export async function syncKHSpeakers(): Promise<{ created: number; linked: number; total: number; errors: number }> {
  console.log("KH Sync: searching for speakers...");

  // Use the search endpoint to find ravs
  // Search with "הרב" (Rabbi) and high limit to get all speakers
  let allRavs: KHSearchItem[] = [];
  try {
    const items = searchItems("הרב", -1, 10000);
    if (Array.isArray(items)) {
      allRavs = items.filter(item => item.SearchItemType === 2);
    }
    console.log(`KH Sync: found ${allRavs.length} ravs from search`);
  } catch (e: any) {
    const status = e.response?.status;
    if (status === 403 || status === 503) {
      console.error(`KH Sync: Cloudflare blocked the request (${status}).`);
      return { created: 0, linked: 0, total: 0, errors: 1 };
    }
    console.error(`KH Sync: failed to search speakers — ${e.message?.slice(0, 150)}`);
    return { created: 0, linked: 0, total: 0, errors: 1 };
  }

  if (allRavs.length === 0) {
    console.log("KH Sync: no ravs found in search results");
    return { created: 0, linked: 0, total: 0, errors: 0 };
  }

  // Get all existing feeds for matching
  const allFeeds = await storage.getAllFeeds();
  const existingKHFeeds = new Map<number, string>();
  for (const feed of allFeeds) {
    if ((feed as any).kolhalashonRavId) {
      existingKHFeeds.set((feed as any).kolhalashonRavId, feed.id);
    }
    if (feed.rssUrl.startsWith("kh://")) {
      const id = parseInt(feed.rssUrl.replace("kh://rav/", ""), 10);
      if (id) existingKHFeeds.set(id, feed.id);
    }
  }

  // Build normalized name -> feed map
  const feedsByNormalizedName = new Map<string, typeof allFeeds[0]>();
  for (const feed of allFeeds) {
    if ((feed as any).kolhalashonRavId) continue;
    if (feed.rssUrl.startsWith("kh://")) continue;
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
  let errors = 0;

  for (const rav of allRavs) {
    const ravId = rav.SearchItemId;
    if (!ravId) continue;

    // Already synced
    if (existingKHFeeds.has(ravId)) continue;

    const rawEnglish = rav.SearchItemTextEnglish?.trim() || "";
    const rawHebrew = rav.SearchItemTextHebrew?.trim() || "";
    // KH returns English names as "LastName, Title FirstName" — normalize
    const englishName = rawEnglish === "null" ? "" : rawEnglish;
    const hebrewName = rawHebrew;
    const displayName = englishName || hebrewName || "Unknown Speaker";

    const imageUrl = buildSpeakerImageUrl(rav.ImageFileName);

    // Try to match existing feed by name
    let matchedFeed = englishName ? feedsByNormalizedName.get(normalizeName(englishName)) : undefined;
    if (!matchedFeed && hebrewName) {
      matchedFeed = feedsByNormalizedName.get(normalizeName(hebrewName));
    }
    if (!matchedFeed && englishName.length >= 5) {
      const normalizedEN = normalizeName(englishName);
      for (const [normalizedFeedName, feed] of feedsByNormalizedName) {
        if (normalizedFeedName.includes(normalizedEN) || normalizedEN.includes(normalizedFeedName)) {
          matchedFeed = feed;
          break;
        }
      }
    }

    if (matchedFeed) {
      await storage.updateFeed(matchedFeed.id, {
        kolhalashonRavId: ravId,
        sourceNetwork: matchedFeed.sourceNetwork || "Kol Halashon",
      } as any);
      linked++;
      console.log(`KH Sync: linked "${displayName}" to existing feed "${matchedFeed.title}"`);
    } else {
      try {
        await storage.createFeed({
          title: displayName,
          rssUrl: `kh://rav/${ravId}`,
          imageUrl,
          description: `Shiurim on Kol Halashon`,
          author: displayName,
          categoryId: null,
          sourceNetwork: "Kol Halashon",
          kolhalashonRavId: ravId,
        });
        created++;
      } catch (e: any) {
        if (!e.message?.includes("unique") && !e.message?.includes("duplicate")) {
          console.error(`KH Sync: failed to create feed for "${displayName}":`, e.message);
          errors++;
        }
      }
    }
  }

  console.log(`KH Sync complete: ${created} created, ${linked} linked, ${allRavs.length} total ravs, ${errors} errors`);
  return { created, linked, total: allRavs.length, errors };
}

// --- Episode Refresh ---

export async function refreshKHFeedEpisodes(
  feed: { id: string; title: string; kolhalashonRavId: number },
  feedRecord?: any,
): Promise<{ newEpisodes: number }> {
  const shiurim = getAllSpeakerShiurim(feed.kolhalashonRavId);

  if (!Array.isArray(shiurim) || shiurim.length === 0) {
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }

  // Filter: must have audio, not women-only
  const validShiurim = shiurim.filter(s => {
    if (s.IsWomenOnly) return false;
    if (s.HasAudio === false) return false;
    return true;
  });

  const episodeData = validShiurim
    .filter(s => s.FileId || s.FileID)
    .map(s => mapKHShiurToEpisodeData(s, feed.id));

  // Cross-source dedup for merged feeds
  let finalEpisodeData = episodeData;
  if (feedRecord && isMergedFeed(feedRecord)) {
    const existingEpisodes = await storage.getEpisodesByFeed(feed.id);
    finalEpisodeData = filterCrossSourceDuplicates(episodeData, existingEpisodes, "kh-");
  }

  const inserted = await storage.upsertKHEpisodes(feed.id, finalEpisodeData);

  await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });

  if (inserted.length > 0) {
    console.log(`KH refresh: ${feed.title} — ${inserted.length} new episode(s)`);
    for (const ep of inserted.slice(0, 3)) {
      sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
    }
  }

  return { newEpisodes: inserted.length };
}
