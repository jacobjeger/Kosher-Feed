import axios from "axios";
import * as cheerio from "cheerio";
import * as storage from "./storage";
import { sendNewEpisodePushes, PUSH_BACKFILL_THRESHOLD } from "./push";
import { normalizeName } from "./name-utils";
import { filterCrossSourceDuplicates, isMergedFeed, dedupWithinBatch } from "./episode-dedup";

// TorahDownloads adapter.
//
// Site is HTML-only (no JSON API). Audio is served from torahcdn.net and
// streamed by the client; the backend never downloads mp3s.
//
// Pagination scheme verified 2026-05-03: speaker pages use ?page=N (~24
// shiurim/page). /sitemap.xml 404s, so discovery falls back to a single
// crawl of /speakers.html (the directory is not paginated, ~400 entries).
//
// URL scheme: td://speaker/{SpeakerID}. GUID prefix: td-.

const TD_BASE_URL = "https://torahdownloads.com";
const TD_USER_AGENT = "ShiurPod/1.0 (+https://shiurpod.com)";
const TD_THROTTLE_MS = 500; // 2 RPS cap to torahdownloads.com
const TD_CDN_BASE = "https://torahcdn.net/tdn/";
const MAX_PAGES_PER_SPEAKER = 200; // safety cap if pagination detection ever misfires

// Module-scoped throttle. Every request to torahdownloads.com routes through
// tdGet so this gate enforces the 2 RPS limit globally across the process.
let lastRequestAt = 0;

async function tdGet(path: string): Promise<string> {
  const wait = TD_THROTTLE_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = path.startsWith("http") ? path : `${TD_BASE_URL}${path}`;
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout: 30000,
        headers: { "User-Agent": TD_USER_AGENT, "Accept": "text/html,*/*" },
        responseType: "text",
        // 4xx other than 429 should not be retried; let them throw.
        validateStatus: s => s >= 200 && s < 300,
      });
      return res.data as string;
    } catch (e: any) {
      const status = e?.response?.status;
      lastErr = e;
      if (status && status >= 400 && status < 500 && status !== 429) throw e;
      const backoff = 500 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// --- ID extractors (exported for unit-style sanity checks) ---

export function extractSpeakerIdFromHref(href: string): number | null {
  const m = href.match(/\/?s-(\d+)(?:[-.]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

export function extractCategoryIdFromHref(href: string): number | null {
  const m = href.match(/\/?c-(\d+)(?:[-.]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

export function extractShiurIdFromHref(href: string): number | null {
  const m = href.match(/\bshiur-(\d+)(?:\.html)?/);
  return m ? parseInt(m[1], 10) : null;
}

// --- Length parser ---

export function parseLength(text: string): number | null {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  let total = 0;
  let matched = false;
  const h = t.match(/(\d+)\s*(?:hours?|hrs?|h\b)/);
  if (h) { total += parseInt(h[1], 10) * 3600; matched = true; }
  const m = t.match(/(\d+)\s*(?:minutes?|mins?|m\b)/);
  if (m) { total += parseInt(m[1], 10) * 60; matched = true; }
  const s = t.match(/(\d+)\s*(?:seconds?|secs?|s\b)/);
  if (s) { total += parseInt(s[1], 10); matched = true; }
  if (!matched || total <= 0) return null;
  return total;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Parse a Gregorian date like "May 3, '26" or "May 3, 2026".
export function parseGregorianDate(text: string): Date | null {
  if (!text) return null;
  const m = text.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s*'?(\d{2,4})/);
  if (!m) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const d = new Date(`${m[1]} ${m[2]}, ${year} 12:00:00 UTC`);
  return isNaN(d.getTime()) ? null : d;
}

// --- Detail page parser ---

export interface TDShiurDetail {
  shiurId: number;
  title: string;
  description: string | null;
  speakerId: number | null;
  speakerName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  language: string | null;
  durationSeconds: number | null;
  audioUrl: string;
  publishedAt: Date | null;
}

export function parseShiurPage(html: string, shiurId: number): TDShiurDetail | null {
  const $ = cheerio.load(html);

  // The page uses a structured shiur-detail panel keyed by stable IDs:
  //   #v_title    — title text
  //   #v_speaker  — wraps <a href="/s-{id}-...">Speaker Name</a>
  //   #v_cat      — wraps <a href="/c-{id}-...">Category Name</a>
  //   #v_lang     — language as plain text
  //   #l_len      — full "Length: N min" string (label and value combined)
  // These are far more reliable than DOM-position or label-text scanning, so
  // prefer them; fall back to the previous heuristics only if missing.
  let title = $("#v_title").text().trim();
  if (!title) {
    // Last-resort fallback: pull from <title>, strip " - {speaker} - TD{id}".
    const t = $("title").text().trim();
    title = t.replace(/\s*-\s*TD\d+\s*$/, "").replace(/\s*-\s*[^-]+$/, "").trim();
  }
  if (!title) return null;

  let speakerId: number | null = null;
  let speakerName: string | null = null;
  const speakerA = $("#v_speaker a").first();
  if (speakerA.length > 0) {
    const href = speakerA.attr("href") || "";
    speakerId = extractSpeakerIdFromHref(href);
    speakerName = speakerA.text().trim() || null;
  }

  let categoryId: number | null = null;
  let categoryName: string | null = null;
  const catA = $("#v_cat a").first();
  if (catA.length > 0) {
    const href = catA.attr("href") || "";
    categoryId = extractCategoryIdFromHref(href);
    categoryName = catA.text().trim() || null;
  }

  const language = $("#v_lang").text().trim() || null;

  // Length: #l_len contains "Length: 5 min" (label + value combined).
  let durationSeconds: number | null = null;
  const rawLen = $("#l_len").text().trim();
  if (rawLen) {
    const valueOnly = rawLen.replace(/^Length\s*:?/i, "").trim();
    durationSeconds = parseLength(valueOnly);
    if (!durationSeconds) {
      console.warn(`TorahDownloads: shiur ${shiurId} length unparseable: "${valueOnly.slice(0, 40)}"`);
    }
  }

  // Audio URL: prefer the explicit torahcdn.net link in the page; fall back
  // to the canonical pattern derived from ShiurID (HAR-verified).
  let audioUrl: string | null = null;
  $("a").each((_, el) => {
    if (audioUrl) return;
    const href = $(el).attr("href") || "";
    if (href.startsWith("https://torahcdn.net/tdn/") || href.startsWith("http://torahcdn.net/tdn/")) {
      audioUrl = href.replace(/^http:/, "https:");
    }
  });
  if (!audioUrl) audioUrl = `${TD_CDN_BASE}${shiurId}.mp3`;

  // Date: the shiur detail page does NOT render a per-shiur upload date
  // anywhere — the only Gregorian date in the body is the "today" indicator
  // in the navbar (e.g. "May 3, '26" next to the parsha dropdown). Earlier
  // versions of this parser scraped that and ended up dating every episode
  // to the day it was scraped. Real upload dates come from a separate HEAD
  // request to the CDN (see fetchShiurUploadDate); leave null here so the
  // wrong date never propagates.
  const publishedAt: Date | null = null;

  return {
    shiurId,
    title,
    description: null, // some shiurim render a blurb; left null when not cleanly isolatable from the panel
    speakerId,
    speakerName,
    categoryId,
    categoryName,
    language,
    durationSeconds,
    audioUrl,
    publishedAt,
  };
}

// torahcdn.net (Cloudflare-fronted S3) returns the actual file's Last-Modified
// header, and on older shiurim also exposes x-amz-meta-cb-modifiedtime — the
// original upload date from a prior storage system (more accurate than the S3
// migration timestamp). This is the only reliable source of per-shiur dates;
// the website's HTML doesn't render one. Bypass tdGet's site throttle since
// torahcdn.net is a different (CDN-fronted) host with no rate limit issues.
// Diagnostic flavor: returns full debug info instead of just Date|null. Used
// by the admin /api/admin/diagnostics/td-cdn-probe endpoint to figure out
// why production is missing CDN hits when curl probes succeed.
export async function fetchShiurUploadDateDebug(shiurId: number): Promise<{
  url: string; usedProxy: boolean; status: number | null; error: string | null;
  lastModified: string | null; cbModifiedTime: string | null; resolvedDate: string | null;
}> {
  const proxyBase = process.env.KH_PROXY_URL;
  const proxyKey = process.env.KH_PROXY_KEY;
  let url: string;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  if (proxyBase) {
    url = `${proxyBase.replace(/\/$/, "")}/td/tdn/${shiurId}.mp3`;
    if (proxyKey) headers["x-proxy-key"] = proxyKey;
  } else {
    url = `${TD_CDN_BASE}${shiurId}.mp3`;
    headers["Accept"] = "*/*";
    headers["Origin"] = "https://torahdownloads.com";
    headers["Referer"] = "https://torahdownloads.com/";
  }
  try {
    const res = await axios.head(url, {
      timeout: 10000, headers,
      validateStatus: s => s >= 200 && s < 600,
    });
    const h = res.headers || {};
    const cb = typeof h["x-amz-meta-cb-modifiedtime"] === "string" ? h["x-amz-meta-cb-modifiedtime"] : null;
    const lm = typeof h["last-modified"] === "string" ? h["last-modified"] : null;
    const raw = cb || lm;
    const d = raw ? new Date(raw) : null;
    return {
      url, usedProxy: !!proxyBase, status: res.status, error: null,
      lastModified: lm, cbModifiedTime: cb,
      resolvedDate: d && !isNaN(d.getTime()) ? d.toISOString() : null,
    };
  } catch (e: any) {
    return {
      url, usedProxy: !!proxyBase, status: e?.response?.status ?? null,
      error: `${e?.code || ""}: ${e?.message?.slice(0, 200) || String(e).slice(0, 200)}`,
      lastModified: null, cbModifiedTime: null, resolvedDate: null,
    };
  }
}

export async function fetchShiurUploadDate(shiurId: number): Promise<Date | null> {
  // torahcdn.net's Cloudflare front silently drops requests from Railway IPs
  // (100% miss rate from prod vs 100% hit rate from a residential IP). Route
  // through the same KH-proxy CF Worker we use for Kol Halashon — it has a
  // /td/* passthrough that re-issues the request from inside Cloudflare's
  // network with browser-like headers. Falls back to direct CDN access when
  // KH_PROXY_URL isn't configured (local dev).
  const proxyBase = process.env.KH_PROXY_URL;
  const proxyKey = process.env.KH_PROXY_KEY;
  let url: string;
  let extraHeaders: Record<string, string> = {};
  if (proxyBase) {
    url = `${proxyBase.replace(/\/$/, "")}/td/tdn/${shiurId}.mp3`;
    if (proxyKey) extraHeaders["x-proxy-key"] = proxyKey;
  } else {
    url = `${TD_CDN_BASE}${shiurId}.mp3`;
    extraHeaders = {
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://torahdownloads.com",
      "Referer": "https://torahdownloads.com/",
    };
  }

  try {
    const res = await axios.head(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...extraHeaders,
      },
      validateStatus: s => s >= 200 && s < 500, // accept 4xx so we can log the status
    });
    if (res.status >= 400) {
      if ((globalThis as any).__td_cdn_4xx_logged !== true) {
        console.warn(`fetchShiurUploadDate: ${res.status} for shiur ${shiurId} via ${proxyBase ? "proxy" : "direct"} (logging once)`);
        (globalThis as any).__td_cdn_4xx_logged = true;
      }
      return null;
    }
    const headers = res.headers || {};
    const cb = headers["x-amz-meta-cb-modifiedtime"];
    const lm = headers["last-modified"];
    const raw = (typeof cb === "string" && cb) || (typeof lm === "string" && lm) || null;
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  } catch (e: any) {
    if ((globalThis as any).__td_cdn_err_logged !== true) {
      console.warn(`fetchShiurUploadDate: HEAD threw for shiur ${shiurId} via ${proxyBase ? "proxy" : "direct"}: ${e?.code || e?.message?.slice(0, 100)} (logging once)`);
      (globalThis as any).__td_cdn_err_logged = true;
    }
    return null;
  }
}

export function mapTDShiurToEpisodeData(detail: TDShiurDetail, feedId: string) {
  const descParts: string[] = [];
  if (detail.description) descParts.push(detail.description);
  if (detail.categoryName) descParts.push(detail.categoryName);
  if (detail.language) descParts.push(detail.language);
  return {
    feedId,
    title: detail.title,
    description: descParts.join(" · ") || null,
    audioUrl: detail.audioUrl,
    duration: detail.durationSeconds ? formatDuration(detail.durationSeconds) : null,
    publishedAt: detail.publishedAt,
    guid: `td-${detail.shiurId}`,
    imageUrl: null,
    torahdownloadsShiurId: detail.shiurId,
    noDownload: false,
  };
}

// --- Discovery ---

export interface TDSpeakerRef {
  id: number;
  name: string;
  shiurCount: number;
}

export async function fetchAllSpeakers(): Promise<TDSpeakerRef[]> {
  const html = await tdGet("/speakers.html");
  const $ = cheerio.load(html);
  const speakers = new Map<number, TDSpeakerRef>();
  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!/^\/?s-\d+/.test(href)) return;
    const id = extractSpeakerIdFromHref(href);
    if (!id || speakers.has(id)) return;
    const name = $(el).text().trim();
    if (!name) return;
    // The directory renders a per-speaker shiur count near the link. Best-
    // effort grab; if we can't find one, treat as unknown (count=0) and let
    // the refresh path discover whether the speaker actually has content.
    let shiurCount = 0;
    const surroundingText = $(el).parent().text().replace(name, "");
    const cm = surroundingText.match(/\b(\d{1,5})\b/);
    if (cm) shiurCount = parseInt(cm[1], 10);
    speakers.set(id, { id, name, shiurCount });
  });
  return Array.from(speakers.values());
}

export async function fetchSpeakerShiurPage(speakerId: number, page: number = 1): Promise<{ shiurIds: number[]; hasNextPage: boolean }> {
  // Slug suffix is cosmetic; /s-{id}.html resolves the same as the slugged form.
  const path = page === 1 ? `/s-${speakerId}.html` : `/s-${speakerId}.html?page=${page}`;
  let html: string;
  try {
    html = await tdGet(path);
  } catch (e: any) {
    if (e?.response?.status === 404) return { shiurIds: [], hasNextPage: false };
    throw e;
  }
  const $ = cheerio.load(html);
  const ids: number[] = [];
  const seen = new Set<number>();
  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!/^\/?shiur-\d+/.test(href)) return;
    const id = extractShiurIdFromHref(href);
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  });
  let hasNextPage = false;
  const nextRe = new RegExp(`\\?page=${page + 1}\\b`);
  $("a").each((_, el) => {
    if (hasNextPage) return;
    const href = $(el).attr("href") || "";
    if (nextRe.test(href)) hasNextPage = true;
  });
  return { shiurIds: ids, hasNextPage };
}

export interface TDIncrementalContext {
  knownIds: Set<number>;
  stopAfterConsecutive: number;
}

export async function fetchAllSpeakerShiurIds(speakerId: number, incremental?: TDIncrementalContext): Promise<number[]> {
  const allIds: number[] = [];
  let page = 1;
  let consecutiveKnown = 0;

  while (page <= MAX_PAGES_PER_SPEAKER) {
    const { shiurIds, hasNextPage } = await fetchSpeakerShiurPage(speakerId, page);
    allIds.push(...shiurIds);

    if (incremental) {
      let stop = false;
      for (const id of shiurIds) {
        if (incremental.knownIds.has(id)) {
          consecutiveKnown++;
          if (consecutiveKnown >= incremental.stopAfterConsecutive) { stop = true; break; }
        } else {
          consecutiveKnown = 0;
        }
      }
      if (stop) break;
    }

    if (!hasNextPage || shiurIds.length === 0) break;
    page++;
  }

  return allIds;
}

export async function fetchShiurDetail(shiurId: number): Promise<TDShiurDetail | null> {
  let html: string;
  try {
    html = await tdGet(`/shiur-${shiurId}.html`);
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
  const parsed = parseShiurPage(html, shiurId);
  if (!parsed) return null;
  // Page parser leaves publishedAt null intentionally (see comment in
  // parseShiurPage). Backfill from the CDN file's Last-Modified — fast HEAD,
  // off the site's throttle since the CDN is a separate host.
  parsed.publishedAt = await fetchShiurUploadDate(shiurId);
  return parsed;
}

// --- Sync logic ---

export async function syncTorahDownloadsSpeakers(): Promise<{ created: number; linked: number; total: number; errors: number }> {
  console.log("TorahDownloads Sync: fetching speaker directory...");
  let allSpeakers: TDSpeakerRef[];
  try {
    allSpeakers = await fetchAllSpeakers();
  } catch (e: any) {
    console.error(`TorahDownloads Sync: speaker fetch failed — ${e.message?.slice(0, 200)}`);
    return { created: 0, linked: 0, total: 0, errors: 1 };
  }
  console.log(`TorahDownloads Sync: found ${allSpeakers.length} speakers`);
  if (allSpeakers.length === 0) return { created: 0, linked: 0, total: 0, errors: 0 };

  const allFeeds = await storage.getAllFeeds();
  const existing = new Map<number, string>();
  for (const feed of allFeeds) {
    const id = (feed as any).torahdownloadsSpeakerId;
    if (id) existing.set(id, feed.id);
    if (feed.rssUrl.startsWith("td://speaker/")) {
      const fromUrl = parseInt(feed.rssUrl.replace("td://speaker/", ""), 10);
      if (fromUrl) existing.set(fromUrl, feed.id);
    }
  }

  const feedsByNormalizedName = new Map<string, typeof allFeeds[0]>();
  for (const feed of allFeeds) {
    if ((feed as any).torahdownloadsSpeakerId) continue;
    if (feed.rssUrl.startsWith("td://speaker/")) continue;
    if (feed.author) {
      const n = normalizeName(feed.author);
      if (n.length >= 3) feedsByNormalizedName.set(n, feed);
    }
    if (feed.title) {
      const n = normalizeName(feed.title);
      if (n.length >= 3 && !feedsByNormalizedName.has(n)) feedsByNormalizedName.set(n, feed);
    }
  }

  const isWomanName = (s: string) => /\b(rebbetzin|rabbanit|mrs\.?|ms\.?|miss)\b/i.test(s);

  let created = 0, linked = 0, errors = 0;
  for (const sp of allSpeakers) {
    if (existing.has(sp.id)) continue;
    if (isWomanName(sp.name)) continue;

    const normalized = normalizeName(sp.name);
    let matched = feedsByNormalizedName.get(normalized);
    if (!matched && normalized.length >= 5) {
      for (const [k, feed] of feedsByNormalizedName) {
        if (k.length >= 5 && (k.includes(normalized) || normalized.includes(k))) {
          matched = feed; break;
        }
      }
    }

    if (matched) {
      try {
        // setTorahDownloadsSpeakerId clears sourceNetwork automatically when
        // the link makes the feed multi-source. No legacy sourceNetwork
        // override — adding TD as a second source on an RSS-or-platform
        // feed shouldn't tag the whole thing "TorahDownloads".
        await storage.setTorahDownloadsSpeakerId(matched.id, sp.id);
        linked++;
        console.log(`TorahDownloads Sync: linked "${sp.name}" to existing feed "${matched.title}"`);
      } catch (e: any) {
        console.error(`TorahDownloads Sync: link failed for "${sp.name}":`, e.message);
        errors++;
      }
    } else {
      try {
        const description = sp.shiurCount > 0
          ? `${sp.shiurCount} shiurim on TorahDownloads`
          : "Shiurim on TorahDownloads";
        const newFeed = await storage.createFeed({
          title: sp.name,
          rssUrl: `td://speaker/${sp.id}`,
          imageUrl: null,
          description,
          author: sp.name,
          categoryId: null,
          sourceNetwork: "TorahDownloads",
          torahdownloadsSpeakerId: sp.id,
        } as any);
        // Belt-and-braces: explicit set in case insert schema strips the column.
        if (!(newFeed as any).torahdownloadsSpeakerId) {
          await storage.setTorahDownloadsSpeakerId(newFeed.id, sp.id);
        }
        created++;
      } catch (e: any) {
        if (!e.message?.includes("unique") && !e.message?.includes("duplicate")) {
          console.error(`TorahDownloads Sync: failed to create feed for "${sp.name}":`, e.message);
          errors++;
        }
      }
    }
  }

  console.log(`TorahDownloads Sync complete: ${created} created, ${linked} linked, ${allSpeakers.length} total, ${errors} errors`);
  return { created, linked, total: allSpeakers.length, errors };
}

// --- Episode refresh ---

export async function refreshTorahDownloadsFeedEpisodes(
  feed: { id: string; title: string; torahdownloadsSpeakerId: number },
  feedRecord?: any,
  opts?: { full?: boolean },
): Promise<{ newEpisodes: number }> {
  // Quick check: pull page 1. If newest already exists and we're not in full
  // mode, skip the rest of the crawl.
  let firstPage: { shiurIds: number[]; hasNextPage: boolean };
  try {
    firstPage = await fetchSpeakerShiurPage(feed.torahdownloadsSpeakerId, 1);
  } catch (e: any) {
    console.error(`TorahDownloads refresh: ${feed.title} — page 1 fetch failed: ${e.message?.slice(0, 100)}`);
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }
  if (firstPage.shiurIds.length === 0) {
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }
  if (!opts?.full) {
    const newest = firstPage.shiurIds[0];
    const exists = await storage.episodeExistsByGuid(feed.id, `td-${newest}`);
    if (exists) {
      await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
      return { newEpisodes: 0 };
    }
  }

  // Crawl all speaker pages, with incremental early-exit (stop after 20
  // consecutive known shiur IDs, like TAT/KH/OU).
  const incremental = opts?.full
    ? undefined
    : { knownIds: await storage.getRecentTorahDownloadsShiurIds(feed.id, 50), stopAfterConsecutive: 20 };
  let allShiurIds: number[];
  try {
    allShiurIds = await fetchAllSpeakerShiurIds(feed.torahdownloadsSpeakerId, incremental);
  } catch (e: any) {
    console.error(`TorahDownloads refresh: ${feed.title} — speaker crawl failed: ${e.message?.slice(0, 100)}`);
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0 };
  }

  // Filter out already-stored shiurim before fetching detail pages — each
  // detail fetch costs a 500ms throttled request, so skipping the archive
  // we already have is ~100x cheaper.
  const existingIds = await storage.getRecentTorahDownloadsShiurIds(feed.id, 5000);
  const newIds = allShiurIds.filter(id => !existingIds.has(id));

  const detailsList: TDShiurDetail[] = [];
  for (const id of newIds) {
    try {
      const detail = await fetchShiurDetail(id);
      if (detail) detailsList.push(detail);
    } catch (e: any) {
      console.warn(`TorahDownloads refresh: ${feed.title} — detail ${id} failed: ${e.message?.slice(0, 80)}`);
    }
  }

  let episodeData = detailsList.map(d => mapTDShiurToEpisodeData(d, feed.id));

  // Within-batch dedup: collapse same-title+same-day variants in this fetch.
  episodeData = dedupWithinBatch(episodeData);

  if (feedRecord && isMergedFeed(feedRecord)) {
    const existingEpisodes = await storage.getEpisodesByFeed(feed.id);
    episodeData = filterCrossSourceDuplicates(episodeData, existingEpisodes, "td-");
  }

  const inserted = await storage.upsertTorahDownloadsEpisodes(feed.id, episodeData);
  await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });

  if (inserted.length > 0) {
    console.log(`TorahDownloads refresh: ${feed.title} — ${inserted.length} new episode(s)`);
    if (inserted.length <= PUSH_BACKFILL_THRESHOLD) {
      for (const ep of inserted.slice(0, 3)) {
        sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id, publishedAt: (ep as any).publishedAt }, feed.title).catch(() => {});
      }
    }
  }
  return { newEpisodes: inserted.length };
}
