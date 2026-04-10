import axios from "axios";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import { normalizeName } from "./name-utils";
import { filterCrossSourceDuplicates, isMergedFeed } from "./episode-dedup";

// KH API base URL
const KH_API_BASE = "https://srv.kolhalashon.com/api";


// When KH_PROXY_URL is set, route requests through the Cloudflare Worker proxy
// This bypasses Cloudflare's IP-based blocking on cloud hosting providers
function getBaseUrl(): string {
  const proxyUrl = process.env.KH_PROXY_URL;
  if (proxyUrl) {
    // Proxy URL should point to the CF Worker, e.g. https://kh-proxy.yourname.workers.dev
    // The worker forwards /api/... paths to srv.kolhalashon.com/api/...
    return proxyUrl.replace(/\/$/, "") + "/api";
  }
  return KH_API_BASE;
}

export function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
  };
  // When using proxy, add the proxy auth key
  if (process.env.KH_PROXY_URL && process.env.KH_PROXY_KEY) {
    headers["x-proxy-key"] = process.env.KH_PROXY_KEY;
  }
  // When calling KH directly, add browser-like headers
  if (!process.env.KH_PROXY_URL) {
    Object.assign(headers, {
      "accept-language": "he-IL,he;q=0.9,en-AU;q=0.8,en;q=0.7,en-US;q=0.6",
      "authorization-site-key": "Bearer 8ea2pe8",
      "origin": "https://www2.kolhalashon.com",
      "referer": "https://www2.kolhalashon.com/",
      "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120", "Not=A?Brand";v="8"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  }
  return headers;
}

// --- Types ---

export interface KHSearchItem {
  SearchItemId: number;
  SearchItemType: number; // 2 = rav, 8 = book, 10 = shiur
  SearchItemTextHebrew: string;
  SearchItemTextEnglish: string;
  SearchItemCount: number;
  ImageFileName: string | null;
}

// --- HTTP Client ---

async function khGet(path: string): Promise<any> {
  const url = `${getBaseUrl()}${path}`;
  const res = await axios.get(url, { headers: getHeaders(), timeout: 30000 });
  return res.data;
}

async function khPost(path: string, body: any): Promise<any> {
  const url = `${getBaseUrl()}${path}`;
  const res = await axios.post(url, body, { headers: getHeaders(), timeout: 30000 });
  return res.data;
}

// Keep for backward compatibility
export function reloadKHClient() {}

// --- API Functions ---

export async function searchItems(keyword: string = "NULL", userId: number = -1, limit: number = 5000): Promise<KHSearchItem[]> {
  return khGet(`/Search/WebSite_GetSearchItems/${encodeURIComponent(keyword)}/${userId}/1/${limit}`);
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
    await new Promise(r => setTimeout(r, 50));
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

  const audioUrl = `${KH_API_BASE}/files/GetMp3FileToPlay/${fileId}`;

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
  if (!process.env.KH_PROXY_URL) {
    console.log("KH Sync: skipped — KH_PROXY_URL not set. Deploy the kh-proxy Cloudflare Worker first.");
    return { created: 0, linked: 0, total: 0, errors: 0 };
  }

  console.log("KH Sync: searching for speakers via proxy...");

  let allRavs: KHSearchItem[] = [];
  const ravMap = new Map<number, KHSearchItem>();

  // Search with multiple terms to get comprehensive speaker coverage
  // "NULL" returns all items, "הרב" catches rabbi-titled speakers
  const searchTerms = ["NULL", "הרב", "רב"];
  for (const term of searchTerms) {
    try {
      const items = await searchItems(term, -1, 10000);
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.SearchItemType === 2 && item.SearchItemId && !ravMap.has(item.SearchItemId)) {
            ravMap.set(item.SearchItemId, item);
          }
        }
      }
      console.log(`KH Sync: search "${term}" returned ${Array.isArray(items) ? items.filter(i => i.SearchItemType === 2).length : 0} ravs (${ravMap.size} unique total)`);
    } catch (e: any) {
      console.error(`KH Sync: search "${term}" failed — ${e.message?.slice(0, 200)}`);
    }
    // Small delay between searches
    if (term !== searchTerms[searchTerms.length - 1]) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  allRavs = Array.from(ravMap.values());
  console.log(`KH Sync: found ${allRavs.length} unique ravs from all searches`);

  if (allRavs.length === 0) {
    console.log("KH Sync: no ravs found in search results");
    return { created: 0, linked: 0, total: 0, errors: 0 };
  }

  const allFeeds = await storage.getAllFeeds();

  // Clean up: remove KH-created feeds with no English name (Hebrew-only)
  // and unlink incorrectly linked feeds
  const hasEnglishLetters = (s: string) => /[a-zA-Z]/.test(s);
  const isWomanSpeaker = (s: string) => /\b(rebbetzin|rabbanit|mrs\.?|ms\.?|miss)\b/i.test(s);
  let removed = 0;
  let unlinked = 0;
  for (const feed of allFeeds) {
    // Delete KH-created feeds (kh:// URL) that have no English in their title
    if (feed.rssUrl.startsWith("kh://") && !hasEnglishLetters(feed.title)) {
      await storage.deleteFeed(feed.id);
      removed++;
      continue;
    }
    // Delete KH-created feeds for women speakers
    if (feed.rssUrl.startsWith("kh://") && isWomanSpeaker(feed.title)) {
      await storage.deleteFeed(feed.id);
      removed++;
      continue;
    }
    // Unlink non-KH feeds that got incorrectly linked (have kolhalashonRavId but a real RSS URL)
    if ((feed as any).kolhalashonRavId && !feed.rssUrl.startsWith("kh://")) {
      await storage.setKHRavId(feed.id, null);
      unlinked++;
    }
  }
  if (removed || unlinked) {
    console.log(`KH Sync: cleanup — removed ${removed} Hebrew-only feeds, unlinked ${unlinked} incorrectly linked feeds`);
  }

  // Re-fetch after cleanup
  const cleanFeeds = await storage.getAllFeeds();
  const existingKHFeeds = new Map<number, string>();
  for (const feed of cleanFeeds) {
    if ((feed as any).kolhalashonRavId) {
      existingKHFeeds.set((feed as any).kolhalashonRavId, feed.id);
    }
    if (feed.rssUrl.startsWith("kh://")) {
      const id = parseInt(feed.rssUrl.replace("kh://rav/", ""), 10);
      if (id) existingKHFeeds.set(id, feed.id);
    }
  }

  const feedsByNormalizedName = new Map<string, typeof cleanFeeds[0]>();
  for (const feed of cleanFeeds) {
    if ((feed as any).kolhalashonRavId) continue;
    if (feed.rssUrl.startsWith("kh://")) continue;
    if (feed.author) {
      const normalizedAuthor = normalizeName(feed.author);
      if (normalizedAuthor.length >= 3) {
        feedsByNormalizedName.set(normalizedAuthor, feed);
      }
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
  let errors = 0;

  for (const rav of allRavs) {
    const ravId = rav.SearchItemId;
    if (!ravId) continue;

    if (existingKHFeeds.has(ravId)) continue;

    const rawEnglish = rav.SearchItemTextEnglish?.trim() || "";
    const englishName = rawEnglish === "null" ? "" : rawEnglish;

    // Skip speakers without an English name
    if (!englishName) continue;

    // Skip women speakers (Rebbetzin, Mrs., Rabbanit, etc.)
    const lowerName = englishName.toLowerCase();
    if (/\b(rebbetzin|rabbanit|mrs\.?|ms\.?|miss)\b/i.test(englishName)) continue;

    const displayName = englishName;

    const imageUrl = buildSpeakerImageUrl(rav.ImageFileName);

    // KH names are "LastName, Title FirstName" — normalize and also try "FirstName LastName"
    const normalizedAsIs = normalizeName(englishName);
    let normalizedFlipped = "";
    const commaIdx = englishName.indexOf(",");
    if (commaIdx > 0) {
      const last = englishName.slice(0, commaIdx).trim();
      const first = englishName.slice(commaIdx + 1).trim();
      normalizedFlipped = normalizeName(`${first} ${last}`);
    }

    // Only match on exact normalized names — no substring matching
    let matchedFeed = feedsByNormalizedName.get(normalizedAsIs);
    if (!matchedFeed && normalizedFlipped) {
      matchedFeed = feedsByNormalizedName.get(normalizedFlipped);
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
          showInBrowse: false,
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

  console.log(`KH Sync complete: ${created} created, ${linked} linked, ${removed} removed, ${unlinked} unlinked, ${allRavs.length} total ravs, ${errors} errors`);
  return { created, linked, removed, unlinked, total: allRavs.length, errors };
}

// --- Episode Refresh ---

export async function refreshKHFeedEpisodes(
  feed: { id: string; title: string; kolhalashonRavId: number },
  feedRecord?: any,
): Promise<{ newEpisodes: number }> {
  if (!process.env.KH_PROXY_URL) {
    return { newEpisodes: 0 };
  }

  // Quick check: fetch first page only to see if there's anything new
  let firstPage: any[];
  try {
    firstPage = await getSpeakerShiurim(feed.kolhalashonRavId, 0, 24);
  } catch (e: any) {
    console.error(`KH refresh: ${feed.title} — fetch failed: ${e.message}`);
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }
  if (!Array.isArray(firstPage) || firstPage.length === 0) {
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }

  // Check if the newest episode already exists — if so, skip full pagination
  const newestShiur = firstPage[0];
  const newestFileId = newestShiur?.FileId || newestShiur?.FileID;
  if (newestFileId) {
    const exists = await storage.episodeExistsByGuid(feed.id, `kh-${newestFileId}`);
    if (exists) {
      await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
      return { newEpisodes: 0 };
    }
  }

  // New content detected — do full pagination
  let shiurim: any[];
  try {
    shiurim = await getAllSpeakerShiurim(feed.kolhalashonRavId);
  } catch (e: any) {
    console.error(`KH refresh: ${feed.title} — full fetch failed: ${e.message}`);
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }

  if (!Array.isArray(shiurim) || shiurim.length === 0) {
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }

  const validShiurim = shiurim.filter(s => {
    if (s.IsWomenOnly) return false;
    if (s.HasAudio === false) return false;
    return true;
  });

  const episodeData = validShiurim
    .filter(s => s.FileId || s.FileID)
    .map(s => mapKHShiurToEpisodeData(s, feed.id));

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
