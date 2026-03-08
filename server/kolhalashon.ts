import axios, { AxiosInstance } from "axios";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import { normalizeName } from "./name-utils";
import { filterCrossSourceDuplicates, isMergedFeed } from "./episode-dedup";

// Real KH API base URL (from the official Python SDK: pypi.org/project/kolhalashon)
const KH_BASE_URL = "https://srv.kolhalashon.com/api";
const KH_SITE_KEY = "Bearer 8ea2pe8";

// --- Types ---

export interface KHSearchItem {
  SearchItemId: number;
  SearchItemType: number; // 2 = rav, 8 = book, 10 = shiur
  SearchItemTextHebrew: string;
  SearchItemTextEnglish: string;
  SearchItemCount: number;
  ImageFileName: string | null;
}

// --- Axios Client ---

function createKHClient(): AxiosInstance {
  const headers: Record<string, string> = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "he-IL,he;q=0.9,en-AU;q=0.8,en;q=0.7,en-US;q=0.6",
    "authorization-site-key": KH_SITE_KEY,
    "content-type": "application/json",
    "origin": "https://www2.kolhalashon.com",
    "referer": "https://www2.kolhalashon.com/",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  // cf_clearance cookie is required to pass Cloudflare
  // Obtain it by visiting www2.kolhalashon.com in a browser and copying the cookie value
  const cfClearance = process.env.KH_CF_CLEARANCE;
  if (cfClearance) {
    headers["cookie"] = `cf_clearance=${cfClearance}`;
  }

  return axios.create({
    baseURL: KH_BASE_URL,
    timeout: 30000,
    headers,
  });
}

let khClient: AxiosInstance = createKHClient();

// Allow hot-reloading the cookie at runtime
export function reloadKHClient() {
  khClient = createKHClient();
}

async function khGet(path: string): Promise<any> {
  const res = await khClient.get(path);
  return res.data;
}

async function khPost(path: string, body: any): Promise<any> {
  const res = await khClient.post(path, body);
  return res.data;
}

function checkCFCookie(): void {
  if (!process.env.KH_CF_CLEARANCE) {
    throw new Error(
      "KH_CF_CLEARANCE env var not set. " +
      "Visit www2.kolhalashon.com in a browser, open DevTools > Application > Cookies, " +
      "copy the cf_clearance value, and set it as KH_CF_CLEARANCE in your environment."
    );
  }
}

// --- API Functions ---

export async function searchItems(keyword: string = "NULL", userId: number = -1): Promise<KHSearchItem[]> {
  return khGet(`/Search/WebSite_GetSearchItems/${encodeURIComponent(keyword)}/${userId}/1/4`);
}

export async function getSpeakerShiurim(ravId: number, fromRow: number, numRows: number): Promise<any[]> {
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

export async function getShiurDetails(fileId: number): Promise<any> {
  return khGet(`/TblShiurimLists/WebSite_GetShiurDetails/${fileId}`);
}

export async function getAllSpeakerShiurim(ravId: number, maxShiurim: number = 150): Promise<any[]> {
  const allShiurim: any[] = [];
  const pageSize = 24;
  let fromRow = 0;

  while (fromRow < maxShiurim) {
    const batch = await getSpeakerShiurim(ravId, fromRow, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allShiurim.push(...batch);
    if (batch.length < pageSize) break;
    fromRow += pageSize;
    await new Promise(r => setTimeout(r, 300));
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
  // For streaming without auth, we use a proxy-friendly URL pattern
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
  checkCFCookie();

  console.log("KH Sync: searching for speakers...");

  // Use the search endpoint to find ravs — search with empty keyword returns all
  let allRavs: KHSearchItem[] = [];
  try {
    const items = await searchItems("NULL", -1);
    if (Array.isArray(items)) {
      allRavs = items.filter(item => item.SearchItemType === 2);
    }
    console.log(`KH Sync: found ${allRavs.length} ravs from search`);
  } catch (e: any) {
    const status = e.response?.status;
    if (status === 403 || status === 503) {
      console.error("KH Sync: Cloudflare blocked the request (403). The KH_CF_CLEARANCE cookie may be expired.");
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

    const englishName = rav.SearchItemTextEnglish?.trim() || "";
    const hebrewName = rav.SearchItemTextHebrew?.trim() || "";
    const displayName = englishName || hebrewName || "Unknown Speaker";
    const shiurimCount = rav.SearchItemCount || 0;

    // Skip speakers with very few shiurim
    if (shiurimCount < 5) continue;

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
          description: `${shiurimCount} shiurim on Kol Halashon`,
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
  checkCFCookie();

  const shiurim = await getAllSpeakerShiurim(feed.kolhalashonRavId);

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
