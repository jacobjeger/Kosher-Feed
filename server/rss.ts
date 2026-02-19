import Parser from "rss-parser";
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

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
    if (err.name === 'AbortError') {
      throw new Error(`Feed fetch timed out after 20s: ${rssUrl}`);
    }
    throw new Error(`Feed fetch failed: ${err.message} (${rssUrl})`);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`Feed returned HTTP ${response.status}: ${rssUrl}`);
  }

  const xml = await response.text();
  if (!xml || xml.length < 50) {
    throw new Error(`Feed returned empty/invalid response (${xml.length} bytes): ${rssUrl}`);
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
