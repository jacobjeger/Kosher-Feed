import axios, { AxiosInstance } from "axios";
import { execFileSync } from "child_process";
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

// --- HTTP Client ---
// Cloudflare blocks Node.js axios based on TLS fingerprint on some hosts.
// Strategy: try axios → curl → python3, whichever works first stays as default.

const BROWSER_HEADERS: Record<string, string> = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "he-IL,he;q=0.9,en-AU;q=0.8,en;q=0.7,en-US;q=0.6",
  "authorization-site-key": KH_SITE_KEY,
  "content-type": "application/json",
  "origin": "https://www2.kolhalashon.com",
  "referer": "https://www2.kolhalashon.com/",
  "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120", "Not=A?Brand";v="8"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// --- Transport implementations ---

const khAxios: AxiosInstance = axios.create({
  baseURL: KH_BASE_URL,
  timeout: 30000,
  headers: BROWSER_HEADERS,
});

function checkTool(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { encoding: "utf8", timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const hasCurl = checkTool("curl");
const hasPython = checkTool("python3");

console.log(`KH transport: curl=${hasCurl}, python3=${hasPython}`);

// curl transport
const CURL_HEADER_ARGS: string[] = [];
for (const [key, value] of Object.entries(BROWSER_HEADERS)) {
  CURL_HEADER_ARGS.push("-H", `${key}: ${value}`);
}

function curlGet(url: string): any {
  const raw = execFileSync("curl", ["-s", "-f", "--tlsv1.3", "--max-time", "30", ...CURL_HEADER_ARGS, url], {
    encoding: "utf8",
    timeout: 35000,
  });
  return JSON.parse(raw);
}

function curlPost(url: string, body: string): any {
  const raw = execFileSync("curl", ["-s", "-f", "--tlsv1.3", "--max-time", "30", "-X", "POST", "-d", body, ...CURL_HEADER_ARGS, url], {
    encoding: "utf8",
    timeout: 35000,
  });
  return JSON.parse(raw);
}

// python3 transport — uses urllib which has different TLS fingerprint than Node.js
function pythonGet(url: string): any {
  const script = `
import urllib.request, json, ssl
ctx = ssl.create_default_context()
headers = ${JSON.stringify(BROWSER_HEADERS)}
req = urllib.request.Request(url="${url}", headers=headers)
with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
    print(r.read().decode())
`;
  const raw = execFileSync("python3", ["-c", script], {
    encoding: "utf8",
    timeout: 35000,
  });
  return JSON.parse(raw);
}

function pythonPost(url: string, body: string): any {
  const script = `
import urllib.request, json, ssl
ctx = ssl.create_default_context()
headers = ${JSON.stringify(BROWSER_HEADERS)}
data = ${JSON.stringify(body)}.encode('utf-8')
req = urllib.request.Request(url="${url}", data=data, headers=headers, method='POST')
with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
    print(r.read().decode())
`;
  const raw = execFileSync("python3", ["-c", script], {
    encoding: "utf8",
    timeout: 35000,
  });
  return JSON.parse(raw);
}

// --- Smart transport: try each method, remember what works ---

type TransportMethod = "axios" | "curl" | "python";
let preferredTransport: TransportMethod | null = null;

function isCFBlock(err: any): boolean {
  const status = err?.response?.status;
  if (status === 403 || status === 503) return true;
  if (typeof err?.message === "string" && err.message.includes("403")) return true;
  return false;
}

async function khGet(path: string): Promise<any> {
  const url = `${KH_BASE_URL}${path}`;
  const methods: TransportMethod[] = preferredTransport
    ? [preferredTransport]
    : ["axios", ...(hasCurl ? ["curl" as const] : []), ...(hasPython ? ["python" as const] : [])];

  let lastErr: any;
  for (const method of methods) {
    try {
      let result: any;
      if (method === "axios") {
        const res = await khAxios.get(path);
        result = res.data;
      } else if (method === "curl") {
        result = curlGet(url);
      } else {
        result = pythonGet(url);
      }
      // If this worked and we haven't set a preference yet, remember it
      if (!preferredTransport) {
        preferredTransport = method;
        console.log(`KH: using ${method} transport (working)`);
      }
      return result;
    } catch (err: any) {
      lastErr = err;
      if (isCFBlock(err)) {
        console.log(`KH: ${method} blocked by Cloudflare, trying next...`);
        continue;
      }
      // Non-CF error — don't try other transports
      throw err;
    }
  }
  // All methods failed
  throw lastErr;
}

async function khPost(path: string, body: any): Promise<any> {
  const url = `${KH_BASE_URL}${path}`;
  const bodyStr = JSON.stringify(body);
  const methods: TransportMethod[] = preferredTransport
    ? [preferredTransport]
    : ["axios", ...(hasCurl ? ["curl" as const] : []), ...(hasPython ? ["python" as const] : [])];

  let lastErr: any;
  for (const method of methods) {
    try {
      let result: any;
      if (method === "axios") {
        const res = await khAxios.post(path, body);
        result = res.data;
      } else if (method === "curl") {
        result = curlPost(url, bodyStr);
      } else {
        result = pythonPost(url, bodyStr);
      }
      if (!preferredTransport) {
        preferredTransport = method;
        console.log(`KH: using ${method} transport (working)`);
      }
      return result;
    } catch (err: any) {
      lastErr = err;
      if (isCFBlock(err)) {
        console.log(`KH: ${method} blocked by Cloudflare, trying next...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Keep for backward compatibility with routes.ts
export function reloadKHClient() {
  preferredTransport = null; // reset to re-probe
}

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

  let allRavs: KHSearchItem[] = [];
  try {
    const items = await searchItems("הרב", -1, 10000);
    if (Array.isArray(items)) {
      allRavs = items.filter(item => item.SearchItemType === 2);
    }
    console.log(`KH Sync: found ${allRavs.length} ravs from search`);
  } catch (e: any) {
    const status = e.response?.status;
    if (status === 403 || status === 503) {
      console.error(`KH Sync: Cloudflare blocked the request (${status}). All transports failed.`);
      return { created: 0, linked: 0, total: 0, errors: 1 };
    }
    console.error(`KH Sync: failed to search speakers — ${e.message?.slice(0, 200)}`);
    return { created: 0, linked: 0, total: 0, errors: 1 };
  }

  if (allRavs.length === 0) {
    console.log("KH Sync: no ravs found in search results");
    return { created: 0, linked: 0, total: 0, errors: 0 };
  }

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

    if (existingKHFeeds.has(ravId)) continue;

    const rawEnglish = rav.SearchItemTextEnglish?.trim() || "";
    const rawHebrew = rav.SearchItemTextHebrew?.trim() || "";
    const englishName = rawEnglish === "null" ? "" : rawEnglish;
    const hebrewName = rawHebrew;
    const displayName = englishName || hebrewName || "Unknown Speaker";

    const imageUrl = buildSpeakerImageUrl(rav.ImageFileName);

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
  const shiurim = await getAllSpeakerShiurim(feed.kolhalashonRavId);

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
