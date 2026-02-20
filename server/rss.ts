import Parser from "rss-parser";
import axios from "axios";
import https from "https";
import http from "http";
import dns from "dns/promises";
import dns_sync from "dns";
import type { Episode } from "@shared/schema";

dns_sync.setDefaultResultOrder('ipv4first');

try {
  dns_sync.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
} catch {}

const parser = new Parser();

const DNS_CACHE_TTL = 15 * 60 * 1000;
const dnsCache = new Map<string, { address: string; family: number; ts: number }>();

function cachedLookup(hostname: string, _options: any, callback: (err: Error | null, address: string, family: number) => void) {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.ts < DNS_CACHE_TTL) {
    return callback(null, cached.address, cached.family);
  }
  dns.lookup(hostname, { family: 4 }).then(
    ({ address, family }) => {
      dnsCache.set(hostname, { address, family, ts: Date.now() });
      callback(null, address, family);
    },
    (err) => callback(err, '', 0)
  );
}

const httpsAgent = new https.Agent({
  lookup: cachedLookup as any,
  keepAlive: true,
  timeout: 15000,
  maxSockets: 10,
});

const httpAgent = new http.Agent({
  lookup: cachedLookup as any,
  keepAlive: true,
  timeout: 15000,
  maxSockets: 10,
});

const rssClient = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  httpAgent,
  httpsAgent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ShiurPodBot/1.0)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
  responseType: 'text',
  decompress: true,
});

export async function preResolveHostnames(urls: string[]): Promise<void> {
  const hostnames = new Set<string>();
  for (const url of urls) {
    try {
      hostnames.add(new URL(url).hostname);
    } catch {}
  }

  const unique = [...hostnames].filter(h => {
    const cached = dnsCache.get(h);
    return !cached || Date.now() - cached.ts >= DNS_CACHE_TTL;
  });

  if (unique.length === 0) return;

  console.log(`Pre-resolving ${unique.length} hostname(s)...`);
  const results = await Promise.allSettled(
    unique.map(async (h) => {
      const start = Date.now();
      const { address, family } = await dns.lookup(h, { family: 4 });
      dnsCache.set(h, { address, family, ts: Date.now() });
      const ms = Date.now() - start;
      if (ms > 2000) console.log(`  DNS slow: ${h} → ${address} took ${ms}ms`);
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

export async function parseFeed(feedId: string, rssUrl: string): Promise<ParsedFeedData> {
  const startTime = Date.now();

  let hostname: string;
  try {
    hostname = new URL(rssUrl).hostname;
  } catch {
    throw new Error(`Invalid RSS URL: ${rssUrl}`);
  }

  let xml: string;
  try {
    const response = await rssClient.get(rssUrl);
    xml = response.data;
    const elapsed = Date.now() - startTime;
    if (elapsed > 5000) {
      console.log(`  Slow fetch: ${hostname} took ${elapsed}ms`);
    }
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      throw new Error(`Feed timed out after ${elapsed}ms: ${rssUrl}`);
    }
    if (err.response) {
      throw new Error(`Feed returned HTTP ${err.response.status}: ${rssUrl}`);
    }
    throw new Error(`Feed fetch failed after ${elapsed}ms: ${err.code || err.message} (${rssUrl})`);
  }

  if (!xml || xml.length < 50) {
    throw new Error(`Feed returned empty/invalid response (${xml?.length || 0} bytes): ${rssUrl}`);
  }

  const feed = await parser.parseString(xml);

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
