import Parser from "rss-parser";
import axios from "axios";
import dns from "dns/promises";
import dns_sync from "dns";
import type { Episode } from "@shared/schema";

dns_sync.setDefaultResultOrder('ipv4first');

try {
  dns_sync.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
} catch {}

const parser = new Parser();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const directClient = axios.create({
  timeout: 60000,
  maxRedirects: 5,
  headers: {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  responseType: 'text',
  decompress: true,
});

const proxyClient = axios.create({
  timeout: 30000,
  maxRedirects: 5,
  headers: {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/json',
  },
});

export async function preResolveHostnames(urls: string[]): Promise<void> {
  const hostnames = new Set<string>();
  for (const url of urls) {
    try {
      hostnames.add(new URL(url).hostname);
    } catch {}
  }

  const unique = [...hostnames];
  if (unique.length === 0) return;

  console.log(`Pre-resolving ${unique.length} hostname(s)...`);
  const results = await Promise.allSettled(
    unique.map(async (h) => {
      const start = Date.now();
      await dns.lookup(h, { family: 4 });
      const ms = Date.now() - start;
      if (ms > 2000) console.log(`  DNS slow: ${h} took ${ms}ms`);
    })
  );
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  console.log(`Pre-resolve done: ${ok} ok, ${fail} failed`);
}

interface ParsedFeedData {
  title: string;
  description?: string;
  imageUrl?: string;
  author?: string;
  episodes: Omit<Episode, "id" | "createdAt">[];
}

interface FetchResult {
  method: 'proxy' | 'direct';
  durationMs: number;
  success: boolean;
  error?: string;
}

async function fetchViaProxy(rssUrl: string): Promise<{ xml: string | null; items: any[] | null; feed: any | null; result: FetchResult }> {
  const start = Date.now();
  try {
    const encodedUrl = encodeURIComponent(rssUrl);
    const cacheBust = Date.now();
    const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodedUrl}&_t=${cacheBust}`;

    const response = await proxyClient.get(proxyUrl);
    const durationMs = Date.now() - start;

    if (response.data?.status === 'ok' && response.data?.items) {
      return {
        xml: null,
        items: response.data.items,
        feed: response.data.feed,
        result: { method: 'proxy', durationMs, success: true },
      };
    }

    return {
      xml: null,
      items: null,
      feed: null,
      result: { method: 'proxy', durationMs, success: false, error: `Proxy returned status: ${response.data?.status || 'unknown'}` },
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const errMsg = err.response?.status
      ? `HTTP ${err.response.status}`
      : (err.code || err.message || 'Unknown error');
    return {
      xml: null,
      items: null,
      feed: null,
      result: { method: 'proxy', durationMs, success: false, error: errMsg },
    };
  }
}

async function fetchDirect(rssUrl: string): Promise<{ xml: string; result: FetchResult }> {
  const start = Date.now();
  try {
    const response = await directClient.get(rssUrl);
    const durationMs = Date.now() - start;
    const xml = response.data;

    if (!xml || xml.length < 50) {
      return {
        xml: '',
        result: { method: 'direct', durationMs, success: false, error: `Empty response (${xml?.length || 0} bytes)` },
      };
    }

    return {
      xml,
      result: { method: 'direct', durationMs, success: true },
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    let errMsg: string;
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      errMsg = `Timeout after ${durationMs}ms`;
    } else if (err.response) {
      errMsg = `HTTP ${err.response.status}`;
    } else {
      errMsg = err.code || err.message || 'Unknown error';
    }
    return {
      xml: '',
      result: { method: 'direct', durationMs, success: false, error: errMsg },
    };
  }
}

function logHop(feedTitle: string, result: FetchResult) {
  const status = result.success ? 'OK' : 'FAIL';
  const detail = result.error ? ` — ${result.error}` : '';
  console.log(`  [${result.method.toUpperCase()}] ${feedTitle}: ${status} in ${result.durationMs}ms${detail}`);
}

export async function parseFeed(feedId: string, rssUrl: string): Promise<ParsedFeedData> {
  let hostname: string;
  try {
    hostname = new URL(rssUrl).hostname;
  } catch {
    throw new Error(`Invalid RSS URL: ${rssUrl}`);
  }

  const proxyResult = await fetchViaProxy(rssUrl);
  logHop(hostname, proxyResult.result);

  if (proxyResult.result.success && proxyResult.items && proxyResult.feed) {
    const feedEpisodes: Omit<Episode, "id" | "createdAt">[] = [];

    for (const item of proxyResult.items) {
      const audioUrl = item.enclosure?.link || item.enclosure?.url;
      if (!audioUrl) continue;

      let duration: string | null = null;
      if (item.enclosure?.duration) {
        const secs = Number(item.enclosure.duration);
        if (!isNaN(secs) && secs > 0) {
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = Math.floor(secs % 60);
          duration = h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
        }
      }

      feedEpisodes.push({
        feedId,
        title: item.title || "Untitled Episode",
        description: stripHtml(item.description || item.content || ""),
        audioUrl,
        duration,
        publishedAt: item.pubDate ? new Date(item.pubDate) : null,
        guid: item.guid || item.link || audioUrl,
        imageUrl: item.thumbnail || null,
        adminNotes: null,
        sourceSheetUrl: null,
      });
    }

    return {
      title: proxyResult.feed.title || "Unknown Podcast",
      description: proxyResult.feed.description || "",
      imageUrl: proxyResult.feed.image || undefined,
      author: proxyResult.feed.author || undefined,
      episodes: feedEpisodes,
    };
  }

  const directResult = await fetchDirect(rssUrl);
  logHop(hostname, directResult.result);

  if (!directResult.result.success) {
    throw new Error(`All fetch methods failed for ${rssUrl}: proxy(${proxyResult.result.error}), direct(${directResult.result.error})`);
  }

  const feed = await parser.parseString(directResult.xml);

  const feedEpisodes: Omit<Episode, "id" | "createdAt">[] = [];

  for (const item of feed.items || []) {
    const audioUrl = item.enclosure?.url;
    if (!audioUrl) continue;

    feedEpisodes.push({
      feedId,
      title: item.title || "Untitled Episode",
      description: stripHtml(item.contentSnippet || item.content || item.description || ""),
      audioUrl,
      duration: item.itunes?.duration || null,
      publishedAt: item.pubDate ? new Date(item.pubDate) : null,
      guid: item.guid || item.link || audioUrl,
      imageUrl: item.itunes?.image || null,
      adminNotes: null,
      sourceSheetUrl: null,
    });
  }

  return {
    title: feed.title || "Unknown Podcast",
    description: feed.description || "",
    imageUrl: feed.itunes?.image || feed.image?.url || undefined,
    author: feed.itunes?.author || feed.creator || undefined,
    episodes: feedEpisodes,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
