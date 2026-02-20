import Parser from "rss-parser";
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

async function cachedDnsLookup(hostname: string): Promise<{ address: string; family: number }> {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.ts < DNS_CACHE_TTL) {
    return { address: cached.address, family: cached.family };
  }

  const { address, family } = await dns.lookup(hostname, { family: 4 });
  dnsCache.set(hostname, { address, family, ts: Date.now() });
  return { address, family };
}

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
  let stage = 'init';

  let hostname: string;
  try {
    hostname = new URL(rssUrl).hostname;
  } catch {
    throw new Error(`Invalid RSS URL: ${rssUrl}`);
  }

  stage = 'dns';
  try {
    const { address, family } = await cachedDnsLookup(hostname);
    const dnsMs = Date.now() - startTime;
    if (dnsMs > 3000) {
      console.log(`  DNS slow: ${hostname} → ${address} (IPv${family}) took ${dnsMs}ms`);
    }
  } catch (dnsErr: any) {
    throw new Error(`DNS lookup failed for ${hostname}: ${dnsErr.code || dnsErr.message} (${rssUrl})`);
  }

  stage = 'fetch';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let response: Response;
  try {
    response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShiurPodBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    if (err.name === 'AbortError') {
      throw new Error(`Feed timed out at stage=${stage} after ${elapsed}ms: ${rssUrl}`);
    }
    throw new Error(`Feed fetch failed at stage=${stage} after ${elapsed}ms: ${err.message} (${rssUrl})`);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`Feed returned HTTP ${response.status}: ${rssUrl}`);
  }

  stage = 'body';
  const xml = await response.text();
  if (!xml || xml.length < 50) {
    throw new Error(`Feed returned empty/invalid response (${xml.length} bytes): ${rssUrl}`);
  }

  stage = 'parse';
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
