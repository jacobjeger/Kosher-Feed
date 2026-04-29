import Parser from "rss-parser";
import axios from "axios";
import dns from "dns/promises";
import dns_sync from "dns";
import sax from "sax";
import type { Episode } from "@shared/schema";
import { Readable } from "stream";

dns_sync.setDefaultResultOrder('ipv4first');

try {
  dns_sync.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
} catch {}

const parser = new Parser();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// Per-fetch cap. Many shows publish full archives (1000+ items) in a single
// RSS response; capping low means we never see older episodes. Episodes use
// onConflictDoNothing on guid, so re-ingesting the same items is cheap.
const MAX_EPISODES = 1000;

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

export interface ParsedFeedData {
  title: string;
  description?: string;
  imageUrl?: string;
  author?: string;
  episodes: Omit<Episode, "id" | "createdAt">[];
  responseHeaders?: { etag?: string; lastModified?: string };
  fetchMethod?: 'stream' | 'proxy' | 'cached';
  fetchDurationMs?: number;
}

interface FetchResult {
  method: 'proxy' | 'direct' | 'stream';
  durationMs: number;
  success: boolean;
  error?: string;
}

async function fetchViaProxy(rssUrl: string): Promise<{ xml: string | null; items: any[] | null; feed: any | null; result: FetchResult }> {
  const start = Date.now();
  try {
    const encodedUrl = encodeURIComponent(rssUrl);
    const cacheBust = Date.now();
    const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodedUrl}&count=${MAX_EPISODES}&_t=${cacheBust}`;

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

interface StreamParsedResult {
  feedTitle: string;
  feedDescription: string;
  feedImage: string;
  feedAuthor: string;
  episodes: Omit<Episode, "id" | "createdAt">[];
  responseHeaders?: { etag?: string; lastModified?: string };
}

async function fetchViaStreaming(
  feedId: string,
  rssUrl: string,
  conditionalHeaders?: { etag?: string | null; lastModified?: string | null }
): Promise<{ data: StreamParsedResult | null; notModified: boolean; result: FetchResult }> {
  const start = Date.now();
  const controller = new AbortController();

  const requestHeaders: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  if (conditionalHeaders?.etag) {
    requestHeaders['If-None-Match'] = conditionalHeaders.etag;
  }
  if (conditionalHeaders?.lastModified) {
    requestHeaders['If-Modified-Since'] = conditionalHeaders.lastModified;
  }

  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await axios.get(rssUrl, {
      responseType: 'stream',
      headers: requestHeaders,
      maxRedirects: 5,
      decompress: true,
      signal: controller.signal,
      validateStatus: (status) => status < 400 || status === 304,
    });
    const durationMs = Date.now() - start;

    if (response.status === 304) {
      clearTimeout(timeout);
      response.data.destroy();
      return {
        data: null,
        notModified: true,
        result: { method: 'stream', durationMs, success: true },
      };
    }

    const etag = response.headers['etag'] || undefined;
    const lastModified = response.headers['last-modified'] || undefined;

    return new Promise((resolve) => {
      const saxParser = sax.createStream(false, {
        lowercase: true,
        trim: true,
      });

      let feedTitle = '';
      let feedDescription = '';
      let feedImage = '';
      let feedAuthor = '';
      let inChannel = false;
      let inItem = false;
      let inImage = false;
      let currentTag = '';
      let currentText = '';
      let itemDepth = 0;
      let channelLevelTags = new Set<string>();

      const currentItem: Record<string, string> = {};
      const episodes: Omit<Episode, "id" | "createdAt">[] = [];
      let episodeCount = 0;
      let finished = false;
      // Separate timeout for XML parsing (in case stream hangs during parse)
      const parseTimeout = setTimeout(() => {
        if (!finished) {
          console.warn(`RSS parse timeout for ${rssUrl}`);
          finishStream();
        }
      }, 60000);

      function finishStream() {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearTimeout(parseTimeout);
        try {
          response.data.destroy();
        } catch {}
        try {
          saxParser.end();
        } catch {}
        resolve({
          data: {
            feedTitle: feedTitle || 'Unknown Podcast',
            feedDescription,
            feedImage,
            feedAuthor,
            episodes,
            responseHeaders: { etag, lastModified },
          },
          notModified: false,
          result: { method: 'stream', durationMs: Date.now() - start, success: true },
        });
      }

      saxParser.on('opentag', (node: sax.Tag) => {
        const name = node.name;
        currentText = '';

        if (name === 'channel') {
          inChannel = true;
          return;
        }

        if (name === 'item' || name === 'entry') {
          inItem = true;
          itemDepth++;
          Object.keys(currentItem).forEach(k => delete currentItem[k]);
          return;
        }

        if (name === 'image' && !inItem) {
          inImage = true;
          return;
        }

        if (inItem) {
          currentTag = name;

          if (name === 'enclosure') {
            const url = node.attributes?.url || node.attributes?.URL;
            if (url) currentItem['enclosure_url'] = String(url);
            const len = node.attributes?.length;
            if (len) currentItem['enclosure_length'] = String(len);
            const type = node.attributes?.type;
            if (type) currentItem['enclosure_type'] = String(type);
          }

          if (name === 'itunes:image') {
            const href = node.attributes?.href || node.attributes?.HREF;
            if (href) currentItem['itunes_image'] = String(href);
          }

          if (name === 'itunes:duration') {
            currentTag = 'itunes:duration';
          }
        } else if (inChannel && !inImage) {
          currentTag = name;

          if (name === 'itunes:image') {
            const href = node.attributes?.href || node.attributes?.HREF;
            if (href) feedImage = String(href);
          }
        }
      });

      saxParser.on('text', (text: string) => {
        currentText += text;
      });

      saxParser.on('cdata', (text: string) => {
        currentText += text;
      });

      saxParser.on('closetag', (name: string) => {
        const text = currentText.trim();

        if ((name === 'item' || name === 'entry') && inItem) {
          inItem = false;
          itemDepth--;

          const audioUrl = currentItem['enclosure_url'];
          if (audioUrl) {
            let duration: string | null = currentItem['itunes:duration'] || null;

            if (duration && /^\d+$/.test(duration)) {
              const secs = parseInt(duration, 10);
              const h = Math.floor(secs / 3600);
              const m = Math.floor((secs % 3600) / 60);
              const s = secs % 60;
              duration = h > 0
                ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
                : `${m}:${String(s).padStart(2, '0')}`;
            }

            episodes.push({
              feedId,
              title: currentItem['title'] || 'Untitled Episode',
              description: stripHtml(currentItem['description'] || currentItem['content:encoded'] || currentItem['summary'] || ''),
              audioUrl,
              duration,
              publishedAt: currentItem['pubdate'] ? new Date(currentItem['pubdate']) : null,
              guid: currentItem['guid'] || currentItem['link'] || audioUrl,
              imageUrl: currentItem['itunes_image'] || null,
              adminNotes: null,
              sourceSheetUrl: null,
            });
            episodeCount++;

            if (episodeCount >= MAX_EPISODES) {
              finishStream();
              return;
            }
          }
          return;
        }

        if (name === 'image' && !inItem) {
          inImage = false;
          return;
        }

        if (inItem && text) {
          currentItem[name] = text;
        } else if (inChannel && !inItem && !inImage && text) {
          switch (name) {
            case 'title':
              if (!feedTitle) feedTitle = text;
              break;
            case 'description':
              if (!feedDescription) feedDescription = text;
              break;
            case 'itunes:author':
              if (!feedAuthor) feedAuthor = text;
              break;
            case 'author':
              if (!feedAuthor) feedAuthor = text;
              break;
          }
        } else if (inImage && !inItem && text) {
          if (name === 'url' && !feedImage) {
            feedImage = text;
          }
        }

        currentTag = '';
        currentText = '';
      });

      saxParser.on('error', () => {
        saxParser.resume();
      });

      saxParser.on('end', () => {
        finishStream();
      });

      response.data.on('error', () => {
        finishStream();
      });

      response.data.pipe(saxParser);
    });
  } catch (err: any) {
    clearTimeout(timeout);
    const durationMs = Date.now() - start;
    let errMsg: string;
    if (err.code === 'ERR_CANCELED' || err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.message?.includes('aborted')) {
      errMsg = `Timeout after ${durationMs}ms`;
    } else if (err.response?.status === 304) {
      return {
        data: null,
        notModified: true,
        result: { method: 'stream', durationMs, success: true },
      };
    } else if (err.response) {
      errMsg = `HTTP ${err.response.status}`;
    } else {
      errMsg = err.code || err.message || 'Unknown error';
    }
    return {
      data: null,
      notModified: false,
      result: { method: 'stream', durationMs, success: false, error: errMsg },
    };
  }
}

function logHop(feedTitle: string, result: FetchResult) {
  const status = result.success ? 'OK' : 'FAIL';
  const detail = result.error ? ` — ${result.error}` : '';
  console.log(`  [${result.method.toUpperCase()}] ${feedTitle}: ${status} in ${result.durationMs}ms${detail}`);
}

export async function parseFeed(
  feedId: string,
  rssUrl: string,
  conditionalHeaders?: { etag?: string | null; lastModified?: string | null }
): Promise<ParsedFeedData | null> {
  let hostname: string;
  try {
    hostname = new URL(rssUrl).hostname;
  } catch {
    throw new Error(`Invalid RSS URL: ${rssUrl}`);
  }

  const streamResult = await fetchViaStreaming(feedId, rssUrl, conditionalHeaders);
  logHop(hostname, streamResult.result);

  if (streamResult.result.success && streamResult.notModified) {
    console.log(`  [304] ${hostname}: Not Modified — skipping parse`);
    return null;
  }

  if (streamResult.result.success && streamResult.data) {
    return {
      title: streamResult.data.feedTitle,
      description: streamResult.data.feedDescription || undefined,
      imageUrl: streamResult.data.feedImage || undefined,
      author: streamResult.data.feedAuthor || undefined,
      episodes: streamResult.data.episodes,
      responseHeaders: streamResult.data.responseHeaders,
      fetchMethod: 'stream',
      fetchDurationMs: streamResult.result.durationMs,
    };
  }

  const proxyResult = await fetchViaProxy(rssUrl);
  logHop(hostname, proxyResult.result);

  if (proxyResult.result.success && proxyResult.items && proxyResult.feed) {
    const feedEpisodes: Omit<Episode, "id" | "createdAt">[] = [];

    for (const item of proxyResult.items.slice(0, MAX_EPISODES)) {
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
      fetchMethod: 'proxy',
      fetchDurationMs: proxyResult.result.durationMs,
    };
  }

  throw new Error(`All fetch methods failed for ${rssUrl}: stream(${streamResult.result.error}), proxy(${proxyResult.result.error})`);
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)));
  // Second pass: strip any tags that were produced by entity decoding (double-encoded attacks)
  text = text.replace(/<[^>]*>/g, "");
  return text.trim();
}
