import axios, { AxiosInstance } from "axios";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import { normalizeName } from "./name-utils";
import { filterCrossSourceDuplicates, isMergedFeed } from "./episode-dedup";

const KH_BASE_URL = "https://www.kolhalashon.com/api";
const KH_DOWNLOAD_BASE = "https://download.kolhalashon.com";

// --- Types ---

export interface KHSpeakerSearchResult {
  RavID: number;
  RavNameHebrew: string;
  RavNameEnglish: string;
  ShiurimCount: number;
  ImageFileName: string | null;
}

export interface KHShiurDetail {
  FileId: number;
  UserId: number;
  UserNameHebrew: string;
  UserNameEnglish: string;
  RavImageFileName: string;
  ShiurDuration: string;
  TitleHebrew: string;
  TitleEnglish: string;
  LanguageId: number;
  MainTopicHebrew: string;
  MainTopicEnglish: string;
  RecordDate: string;
  FolderId: number;
  HasAudio: boolean;
  HasVideo: boolean;
  HasHdVideo: boolean;
  CatId1: string;
  CatDesc1: string;
  CatDescEnglish1: string;
  CatId2: string;
  CatDescEnglish2: string;
  DisableDownload: boolean | null;
  IsLocked: boolean | null;
  DownloadCount: number;
  IsWomenOnly: boolean;
}

export interface KHFileLocation {
  location: string;
}

// --- Axios Client (browser-like headers for Cloudflare) ---

const khClient: AxiosInstance = axios.create({
  baseURL: KH_BASE_URL,
  timeout: 30000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
    "Referer": "https://www.kolhalashon.com/",
    "Origin": "https://www.kolhalashon.com",
  },
});

// Add cf_clearance cookie if available
if (process.env.KH_CF_CLEARANCE) {
  khClient.defaults.headers.common["Cookie"] = `cf_clearance=${process.env.KH_CF_CLEARANCE}`;
}

async function khGet(path: string, retries = 3): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await khClient.get(path);
      return res.data;
    } catch (e: any) {
      const status = e.response?.status;
      if ((status === 403 || status === 503) && attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
}

async function khPost(path: string, body: any, retries = 3): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await khClient.post(path, body);
      return res.data;
    } catch (e: any) {
      const status = e.response?.status;
      if ((status === 403 || status === 503) && attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
}

// --- API Functions ---

export async function searchSpeakers(
  searchText: string = "NULL",
  languageId: number = -1,
  fromRow: number = 0,
  numRows: number = 500,
): Promise<any[]> {
  return khGet(`/Search/WebSite_SearchRav/${encodeURIComponent(searchText)}/${languageId}/1/${fromRow}/${numRows}/true`);
}

export async function getSpeakerCount(searchText: string = "NULL", languageId: number = -1): Promise<number> {
  const data = await khGet(`/Search/WebSite_SearchRavGetCount/${encodeURIComponent(searchText)}/${languageId}`);
  return typeof data === "number" ? data : (data?.VarInt ?? data?.count ?? 0);
}

export async function getSpeakerDetail(ravId: number): Promise<{ hebrewName: string; englishName: string; imageFilename: string | null }> {
  const data = await khGet(`/Ravs/WebSIte_GetRavDafTabls/${ravId}`);
  let hebrewName = "";
  let englishName = "";
  let imageFilename: string | null = null;

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item.VarInt === 100) hebrewName = item.VarString || "";
      if (item.VarInt === 101) englishName = item.VarString || "";
      if (item.VarInt === 102) imageFilename = item.VarString || null;
    }
  }

  return { hebrewName, englishName, imageFilename };
}

export async function getSpeakerShiurimCount(ravId: number, languageId: number = -1): Promise<number> {
  const data = await khGet(`/Ravs/WebSite_GetRavShiurimCount/${ravId}/${languageId}`);
  return data?.VarInt ?? 0;
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
    FilterSwitch: "111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
    activefilterType: "all",
  };
  return khPost("/Search/WebSite_GetRavShiurim/", body);
}

export async function getAllSpeakerShiurim(ravId: number, maxShiurim: number = 150): Promise<any[]> {
  const allShiurim: any[] = [];
  const pageSize = 50;
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

export async function getFileLocation(fileId: number): Promise<string> {
  const data = await khGet(`/files/getLocationOfFileToVideo/${fileId}`);
  return data?.location || "";
}

export function buildAudioUrl(location: string, fileId: number): string {
  // location is like "42368/42368707", we need the prefix "42368"
  const prefix = location.split("/")[0];
  return `${KH_DOWNLOAD_BASE}/${prefix}/${fileId}.mp3`;
}

// --- Helpers ---

function buildSpeakerImageUrl(imageFilename: string | null): string | null {
  if (!imageFilename) return null;
  return `https://www.kolhalashon.com/Images/Ravs/${imageFilename}`;
}

function getSpeakerDisplayName(detail: { hebrewName: string; englishName: string }): string {
  return detail.englishName?.trim() || detail.hebrewName?.trim() || "Unknown Speaker";
}

// --- Episode Mapping ---

export function mapKHShiurToEpisodeData(shiur: any, feedId: string, audioUrl: string) {
  const title = shiur.TitleEnglish?.trim() || shiur.TitleHebrew?.trim() || shiur.ShiurName?.trim() || "Untitled";
  const topicParts = [
    shiur.MainTopicEnglish || shiur.MainTopicHebrew,
    shiur.CatDescEnglish1 || shiur.CatDesc1,
  ].filter(Boolean);

  return {
    feedId,
    title,
    description: topicParts.join(" > ") || null,
    audioUrl,
    duration: shiur.ShiurDuration || null,
    publishedAt: shiur.RecordDate ? new Date(shiur.RecordDate) : null,
    guid: `kh-${shiur.FileId || shiur.FileID}`,
    imageUrl: null,
    kolhalashonFileId: shiur.FileId || shiur.FileID,
    noDownload: shiur.DisableDownload || false,
  };
}

// --- Sync Logic ---

export async function syncKHSpeakers(): Promise<{ created: number; linked: number; total: number; errors: number }> {
  console.log("KH Sync: fetching speaker count...");
  let totalSpeakers: number;
  try {
    totalSpeakers = await getSpeakerCount();
    console.log(`KH Sync: ${totalSpeakers} total speakers`);
  } catch (e: any) {
    console.error(`KH Sync: failed to get speaker count — ${e.message?.slice(0, 100)}`);
    return { created: 0, linked: 0, total: 0, errors: 1 };
  }

  // Fetch all speakers in pages
  const allSpeakers: any[] = [];
  const pageSize = 100;
  for (let fromRow = 0; fromRow < totalSpeakers; fromRow += pageSize) {
    try {
      const batch = await searchSpeakers("NULL", -1, fromRow, pageSize);
      if (Array.isArray(batch)) allSpeakers.push(...batch);
      if (fromRow + pageSize < totalSpeakers) {
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e: any) {
      console.error(`KH Sync: failed to fetch speakers page ${fromRow}: ${e.message?.slice(0, 100)}`);
    }
  }

  console.log(`KH Sync: fetched ${allSpeakers.length} speaker records`);

  // Get all existing feeds for matching
  const allFeeds = await storage.getAllFeeds();
  const existingKHFeeds = new Map<number, string>();
  for (const feed of allFeeds) {
    if (feed.kolhalashonRavId) {
      existingKHFeeds.set(feed.kolhalashonRavId, feed.id);
    }
    if (feed.rssUrl.startsWith("kh://")) {
      const id = parseInt(feed.rssUrl.replace("kh://rav/", ""), 10);
      if (id) existingKHFeeds.set(id, feed.id);
    }
  }

  // Build normalized name -> feed map (match against ALL feeds, including those with other platform IDs)
  const feedsByNormalizedName = new Map<string, typeof allFeeds[0]>();
  for (const feed of allFeeds) {
    if (feed.kolhalashonRavId) continue; // already linked to KH
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

  for (const speaker of allSpeakers) {
    const ravId = speaker.RavID || speaker.ravId || speaker.Id;
    if (!ravId) continue;

    // Already synced
    if (existingKHFeeds.has(ravId)) continue;

    // Get speaker detail for names
    let detail: { hebrewName: string; englishName: string; imageFilename: string | null };
    try {
      detail = await getSpeakerDetail(ravId);
    } catch (e: any) {
      errors++;
      continue;
    }

    const englishName = detail.englishName?.trim() || "";
    const hebrewName = detail.hebrewName?.trim() || "";
    const displayName = getSpeakerDisplayName(detail);

    // Skip speakers with very few shiurim
    let shiurimCount = speaker.ShiurimCount || speaker.shiurimCount || 0;
    if (shiurimCount === 0) {
      try {
        shiurimCount = await getSpeakerShiurimCount(ravId);
      } catch { /* ignore */ }
    }
    if (shiurimCount < 5) continue;

    const imageUrl = buildSpeakerImageUrl(detail.imageFilename);

    // Try to match existing feed by name
    // 1. Exact normalized match (English name)
    let matchedFeed = englishName ? feedsByNormalizedName.get(normalizeName(englishName)) : undefined;
    // 2. Try Hebrew name
    if (!matchedFeed && hebrewName) {
      matchedFeed = feedsByNormalizedName.get(normalizeName(hebrewName));
    }
    // 3. Substring match on English name
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
      // Link existing feed to this KH speaker
      await storage.updateFeed(matchedFeed.id, {
        kolhalashonRavId: ravId,
        sourceNetwork: matchedFeed.sourceNetwork || "Kol Halashon",
      } as any);
      linked++;
      console.log(`KH Sync: linked "${displayName}" to existing feed "${matchedFeed.title}"`);
    } else {
      // Create new feed for this KH speaker
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

    // Rate limit: small delay between speaker detail lookups
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`KH Sync complete: ${created} created, ${linked} linked, ${allSpeakers.length} total speakers, ${errors} errors`);
  return { created, linked, total: allSpeakers.length, errors };
}

// --- Episode Refresh ---

export async function refreshKHFeedEpisodes(
  feed: { id: string; title: string; kolhalashonRavId: number },
  feedRecord?: any,
): Promise<{ newEpisodes: number }> {
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

  // Resolve audio URLs
  const episodeData: any[] = [];
  for (const shiur of validShiurim) {
    const fileId = shiur.FileId || shiur.FileID;
    if (!fileId) continue;

    let audioUrl: string;
    try {
      const location = await getFileLocation(fileId);
      if (!location) continue;
      audioUrl = buildAudioUrl(location, fileId);
    } catch {
      // Fallback: try predictable pattern
      const prefix = Math.floor(fileId / 1000) * 1000;
      audioUrl = `${KH_DOWNLOAD_BASE}/${prefix}/${fileId}.mp3`;
    }

    episodeData.push(mapKHShiurToEpisodeData(shiur, feed.id, audioUrl));

    // Rate limit file location lookups
    await new Promise(r => setTimeout(r, 50));
  }

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
