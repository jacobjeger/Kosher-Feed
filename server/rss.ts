import Parser from "rss-parser";
import type { Episode } from "@shared/schema";

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'KosherPodcastApp/1.0',
  },
});

interface ParsedFeedData {
  title: string;
  description?: string;
  imageUrl?: string;
  author?: string;
  episodes: Omit<Episode, "id" | "createdAt">[];
}

export async function parseFeed(feedId: string, rssUrl: string): Promise<ParsedFeedData> {
  const feed = await parser.parseURL(rssUrl);

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
