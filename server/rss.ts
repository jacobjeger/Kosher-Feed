import Parser from "rss-parser";
import dns from "dns/promises";
import type { Episode } from "@shared/schema";

const parser = new Parser();

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
    const { address, family } = await dns.lookup(hostname);
    const dnsMs = Date.now() - startTime;
    if (dnsMs > 3000) {
      console.log(`  DNS slow: ${hostname} → ${address} (IPv${family}) took ${dnsMs}ms`);
    }
  } catch (dnsErr: any) {
    throw new Error(`DNS lookup failed for ${hostname}: ${dnsErr.code || dnsErr.message} (${rssUrl})`);
  }

  stage = 'fetch';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

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
