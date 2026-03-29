import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as storage from "./storage";
import { parseFeed } from "./rss";
import { sendNewEpisodePushes, sendCustomPush, checkPushReceipts } from "./push";
import { getVitals, recordFeedResult } from "./feed-vitals";
import { insertFeedSchema, insertCategorySchema, feedMergeHistory } from "@shared/schema";
import type { Feed } from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import { syncTATSpeakers, refreshTATFeedEpisodes, fetchAllSpeakers } from "./torahanytime";
import { detectOUPlatform, refreshOUFeedEpisodes, syncOUPlatformAuthors, OU_PLATFORMS, type OUPlatformKey } from "./alldaf";
import { syncKHSpeakers, refreshKHFeedEpisodes, reloadKHClient, getHeaders as getKHHeaders } from "./kolhalashon";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";

const ON_DEMAND_STALE_MS = 5 * 60 * 1000;

// Default logo for Kol Halashon feeds without a speaker image
const KH_DEFAULT_LOGO_PATH = "/api/images/kol-halashon-logo.svg";

function addKHDefaultImage(feed: any, baseUrl?: string): any {
  if (!feed.imageUrl && feed.sourceNetwork === "Kol Halashon") {
    const prefix = baseUrl || "";
    return { ...feed, imageUrl: prefix + KH_DEFAULT_LOGO_PATH };
  }
  return feed;
}

// Resolve KH audio URLs through the proxy worker
function resolveKHAudioUrl(audioUrl: string): { url: string; headers: Record<string, string> } {
  const khMatch = audioUrl.match(/https?:\/\/srv\.kolhalashon\.com\/api\/files\/(?:GetMp3FileToPlay|getLocationOfFileToVideo)\/(\d+)/);
  if (khMatch) {
    const fileId = khMatch[1];
    const headers = getKHHeaders();
    if (process.env.KH_PROXY_URL) {
      const proxyBase = process.env.KH_PROXY_URL.replace(/\/$/, "") + "/api";
      return { url: `${proxyBase}/files/GetMp3FileToPlay/${fileId}`, headers };
    }
    return { url: `https://srv.kolhalashon.com/api/files/GetMp3FileToPlay/${fileId}`, headers };
  }
  return { url: audioUrl, headers: { "User-Agent": "ShiurPod/1.0" } };
}

function detectSourceNetwork(rssUrl: string): string | null {
  try {
    const hostname = new URL(rssUrl).hostname.toLowerCase();
    if (hostname.includes("torahanytime") || hostname.includes("torah-anytime")) {
      return "Torah Anytime";
    }
  } catch {}
  return null;
}
const refreshingFeeds = new Set<string>();

async function onDemandRefreshFeed(feedId: string): Promise<void> {
  if (refreshingFeeds.has(feedId)) return;

  try {
    const feed = await storage.getFeedById(feedId);
    if (!feed || !feed.isActive) return;

    const lastFetched = feed.lastFetchedAt ? new Date(feed.lastFetchedAt).getTime() : 0;
    if (Date.now() - lastFetched < ON_DEMAND_STALE_MS) return;

    refreshingFeeds.add(feedId);
    console.log(`On-demand refresh: ${feed.title} (last fetched ${feed.lastFetchedAt ? Math.round((Date.now() - lastFetched) / 60000) + 'm ago' : 'never'})`);

    // TAT feed: refresh from TorahAnytime API
    const isOnDemandTatUrl = feed.rssUrl.startsWith("tat://");
    const onDemandTatId = feed.tatSpeakerId ?? (isOnDemandTatUrl ? parseInt(feed.rssUrl.replace("tat://speaker/", ""), 10) || null : null);
    if (onDemandTatId) {
      await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: onDemandTatId });
      // Also refresh RSS if this is a merged feed (has real RSS URL)
      if (!isOnDemandTatUrl) {
        const parsed = await parseFeed(feed.id, feed.rssUrl);
        if (parsed) {
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          await storage.upsertEpisodes(feed.id, episodeData);
        }
      }
      return;
    }

    // OU Torah platform feed (AllDaf, AllMishnah, AllParsha)
    const onDemandOU = detectOUPlatform(feed as any);
    if (onDemandOU) {
      await refreshOUFeedEpisodes(onDemandOU.platform, { id: feed.id, title: feed.title, authorId: onDemandOU.authorId }, feed);
      const ouCfg = OU_PLATFORMS[onDemandOU.platform];
      if (!feed.rssUrl.startsWith(ouCfg.urlScheme)) {
        const parsed = await parseFeed(feed.id, feed.rssUrl);
        if (parsed) {
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          await storage.upsertEpisodes(feed.id, episodeData);
        }
      }
      return;
    }

    // Kol Halashon feed
    const isKhUrl = feed.rssUrl.startsWith("kh://");
    const onDemandKhId = (feed as any).kolhalashonRavId ?? (isKhUrl ? parseInt(feed.rssUrl.replace("kh://rav/", ""), 10) || null : null);
    if (onDemandKhId) {
      await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: onDemandKhId }, feed);
      if (!isKhUrl) {
        const parsed = await parseFeed(feed.id, feed.rssUrl);
        if (parsed) {
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          await storage.upsertEpisodes(feed.id, episodeData);
        }
      }
      return;
    }

    // Regular RSS feed (skip TAT/OU/KH-only URLs)
    const isOUUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
    if (!feed.rssUrl || isOnDemandTatUrl || isOUUrl || isKhUrl) return;
    const parsed = await parseFeed(feed.id, feed.rssUrl);
    if (!parsed) {
      await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
      return;
    }
    const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
    const inserted = await storage.upsertEpisodes(feed.id, episodeData);
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });

    if (inserted.length > 0) {
      console.log(`On-demand refresh: ${feed.title} found ${inserted.length} new episode(s)`);
      for (const ep of inserted.slice(0, 3)) {
        sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
      }
    }
  } catch (e: any) {
    console.log(`On-demand refresh failed for ${feedId}: ${e.message?.slice(0, 100)}`);
  } finally {
    refreshingFeeds.delete(feedId);
  }
}

const uploadDir = path.join(process.cwd(), "uploads", "apk");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const apkStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const uniqueName = `shiurpod-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});
const apkUpload = multer({
  storage: apkStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.apk')) {
      cb(null, true);
    } else {
      cb(new Error('Only .apk files are allowed'));
    }
  },
});

function requireAdmin(req: Request, res: Response): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export async function registerRoutes(app: Express): Promise<Server> {
  await storage.resetAllAdmins("akivajeger", "1340ne174TH").catch(() => {});

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Serve static brand images (e.g. Kol Halashon logo)
  app.get("/api/images/:name", (req: Request, res: Response) => {
    const name = req.params.name?.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!name) return res.status(400).send("Invalid name");
    const filePath = path.resolve(process.cwd(), "assets", "images", name);
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
    const ext = path.extname(name).toLowerCase();
    const mimeTypes: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  });

  app.post("/api/admin/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      const valid = await storage.verifyAdmin(username, password);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const token = Buffer.from(`${username}:${password}`).toString("base64");
      res.json({ token });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const adminAuth = async (req: Request, res: Response, next: Function) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [username, password] = decoded.split(":");
    const valid = await storage.verifyAdmin(username, password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    next();
  };

  // Categories
  app.get("/api/categories", async (_req: Request, res: Response) => {
    try {
      const cats = await storage.getAllCategories();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(cats);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/categories", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const data = insertCategorySchema.parse(req.body);
      const cat = await storage.createCategory(data);
      res.json(cat);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/admin/categories/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteCategory(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/auto-categorize", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const { autoCategorizeFeeds } = await import("./auto-categorize");
      await autoCategorizeFeeds();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Feeds
  app.get("/api/feeds", async (req: Request, res: Response) => {
    try {
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const feedList = await storage.getActiveFeeds();
      const mappings = await storage.getAllFeedCategoryMappings();
      let feedsWithCategories = feedList.map(f => {
        const catIds = mappings.filter(m => m.feedId === f.id).map(m => m.categoryId);
        return addKHDefaultImage({ ...f, categoryIds: catIds.length > 0 ? catIds : (f.categoryId ? [f.categoryId] : []) }, baseUrl);
      });

      // Sort by popularity if requested
      if (req.query.sort === "popular") {
        const stats = await storage.getAllFeedStats();
        feedsWithCategories = feedsWithCategories.sort((a, b) => {
          const aStats = stats.get(a.id) || { subscriberCount: 0, listenCount: 0 };
          const bStats = stats.get(b.id) || { subscriberCount: 0, listenCount: 0 };
          const aScore = aStats.subscriberCount * 3 + aStats.listenCount;
          const bScore = bStats.subscriberCount * 3 + bStats.listenCount;
          return bScore - aScore;
        });
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(feedsWithCategories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Featured Feeds (must be before :id routes)
  app.get("/api/feeds/featured", async (_req: Request, res: Response) => {
    try {
      const featured = await storage.getFeaturedFeeds();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(featured);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Feed search (searches ALL active feeds including hidden-from-browse)
  app.get("/api/feeds/search", async (req: Request, res: Response) => {
    try {
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const q = (req.query.q as string || "").trim();
      if (q.length < 2) return res.json([]);
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const results = await storage.searchFeeds(q, limit);
      const mappings = await storage.getAllFeedCategoryMappings();
      const enriched = results.map(f => {
        const catIds = mappings.filter(m => m.feedId === f.id).map(m => m.categoryId);
        return addKHDefaultImage({ ...f, categoryIds: catIds.length > 0 ? catIds : (f.categoryId ? [f.categoryId] : []) }, baseUrl);
      });
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/feeds/category/:categoryId", async (req: Request, res: Response) => {
    try {
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const legacyFeeds = await storage.getFeedsByCategory(req.params.categoryId);
      const junctionFeeds = await storage.getFeedsByCategories(req.params.categoryId);
      const allFeedsMap = new Map<string, any>();
      for (const f of legacyFeeds) allFeedsMap.set(f.id, f);
      for (const f of junctionFeeds) allFeedsMap.set(f.id, f);
      res.json(Array.from(allFeedsMap.values()).map(f => addKHDefaultImage(f, baseUrl)));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Maggid Shiur - feeds grouped by author/speaker
  app.get("/api/feeds/maggid-shiur", async (req: Request, res: Response) => {
    try {
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const grouped = await storage.getActiveFeedsGroupedByAuthor();
      const enriched = grouped.map((g: any) => ({
        ...g,
        feeds: g.feeds.map((f: any) => addKHDefaultImage(f, baseUrl)),
      }));
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(enriched);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ping", (_req: Request, res: Response) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // Single feed by ID (works for all feeds regardless of showInBrowse)
  app.get("/api/feeds/:id", async (req: Request, res: Response) => {
    try {
      const feed = await storage.getFeedById(req.params.id);
      if (!feed) return res.status(404).json({ error: "Feed not found" });
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const mappings = await storage.getAllFeedCategoryMappings();
      const catIds = mappings.filter(m => m.feedId === feed.id).map(m => m.categoryId);
      res.json(addKHDefaultImage({ ...feed, categoryIds: catIds.length > 0 ? catIds : (feed.categoryId ? [feed.categoryId] : []) }, baseUrl));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/feeds/:id/episodes", async (req: Request, res: Response) => {
    try {
      const feedId = req.params.id;
      const refresh = req.query.refresh === "1";

      if (refresh) {
        await onDemandRefreshFeed(feedId);
      } else {
        onDemandRefreshFeed(feedId).catch(() => {});
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const paginated = req.query.paginated === "1";
      const slim = req.query.slim === "1";
      const sort = (req.query.sort as string) || 'newest';
      const eps = await storage.getEpisodesByFeedPaginated(feedId, page, limit, sort);
      res.setHeader("Cache-Control", "public, max-age=30");

      const mapEpisode = (ep: any) => slim ? ({
        id: ep.id,
        feedId: ep.feedId,
        title: ep.title,
        audioUrl: ep.audioUrl,
        duration: ep.duration,
        publishedAt: ep.publishedAt,
        imageUrl: ep.imageUrl,
      }) : ep;

      if (paginated) {
        const totalCount = await storage.getEpisodeCountByFeed(req.params.id);
        const totalPages = Math.ceil(totalCount / limit);
        res.json({
          episodes: eps.map(mapEpisode),
          page,
          totalPages,
          totalCount,
          hasMore: page < totalPages,
        });
      } else {
        res.json(eps.map(mapEpisode));
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/feeds", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const feedList = await storage.getAllFeeds();
      const mappings = await storage.getAllFeedCategoryMappings();
      const feedStats = await storage.getAllFeedStats();
      const feedsWithCategories = feedList.map(f => {
        const catIds = mappings.filter(m => m.feedId === f.id).map(m => m.categoryId);
        const stats = feedStats.get(f.id) || { episodeCount: 0, subscriberCount: 0, listenCount: 0 };
        return { ...f, categoryIds: catIds.length > 0 ? catIds : (f.categoryId ? [f.categoryId] : []), ...stats };
      });
      res.json(feedsWithCategories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/feeds", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { rssUrl, categoryId, categoryIds, sourceNetwork } = req.body;
      if (!rssUrl) return res.status(400).json({ error: "rssUrl is required" });

      const parsed = await parseFeed("temp", rssUrl);
      if (!parsed) return res.status(500).json({ error: "Could not parse feed" });

      const effectiveCategoryId = categoryId || (categoryIds && categoryIds.length > 0 ? categoryIds[0] : null);
      const feed = await storage.createFeed({
        title: parsed.title,
        rssUrl,
        imageUrl: parsed.imageUrl || null,
        description: parsed.description || null,
        author: parsed.author || null,
        categoryId: effectiveCategoryId,
        sourceNetwork: sourceNetwork || detectSourceNetwork(rssUrl),
      });

      const effectiveCategoryIds = (categoryIds && Array.isArray(categoryIds) && categoryIds.length > 0)
        ? categoryIds
        : (categoryId ? [categoryId] : []);
      if (effectiveCategoryIds.length > 0) {
        await storage.setFeedCategories(feed.id, effectiveCategoryIds);
      }

      const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
      await storage.upsertEpisodes(feed.id, episodeData);

      res.json(feed);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put("/api/admin/feeds/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { categoryIds, ...feedData } = req.body;
      const feed = await storage.updateFeed(req.params.id, feedData);
      if (categoryIds && Array.isArray(categoryIds)) {
        await storage.setFeedCategories(req.params.id, categoryIds);
      }
      res.json(feed);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/admin/feeds/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteFeed(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/feeds/:id/refresh", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const allFeeds = await storage.getAllFeeds();
      const feed = allFeeds.find(f => f.id === req.params.id);
      if (!feed) return res.status(404).json({ error: "Feed not found" });

      let totalNew = 0;

      // TAT refresh
      const isTatFeedUrl = feed.rssUrl.startsWith("tat://");
      const effectiveSpeakerId = feed.tatSpeakerId ?? (isTatFeedUrl ? parseInt(feed.rssUrl.replace("tat://speaker/", ""), 10) || null : null);
      if (effectiveSpeakerId) {
        const tatResult = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveSpeakerId });
        totalNew += tatResult.newEpisodes;
      }

      // OU Torah platform refresh (AllDaf, AllMishnah, AllParsha, AllHalacha)
      const ouDetected = detectOUPlatform(feed as any);
      if (ouDetected) {
        const ouResult = await refreshOUFeedEpisodes(ouDetected.platform, { id: feed.id, title: feed.title, authorId: ouDetected.authorId });
        totalNew += ouResult.newEpisodes;
      }

      // KH refresh
      const isKhFeedUrl = feed.rssUrl.startsWith("kh://");
      const effectiveKhId = (feed as any).kolhalashonRavId ?? (isKhFeedUrl ? parseInt(feed.rssUrl.replace("kh://rav/", ""), 10) || null : null);
      if (effectiveKhId) {
        const khResult = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: effectiveKhId }, feed);
        totalNew += khResult.newEpisodes;
      }

      // RSS refresh (skip for TAT-only, OU-only, and KH-only feeds)
      const isOUFeedUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
      if (!isTatFeedUrl && !isOUFeedUrl && !isKhFeedUrl) {
        const parsed = await parseFeed(feed.id, feed.rssUrl);
        if (parsed) {
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          const inserted = await storage.upsertEpisodes(feed.id, episodeData);
          totalNew += inserted.length;

          await storage.updateFeed(feed.id, {
            lastFetchedAt: new Date(),
            title: parsed.title,
            imageUrl: parsed.imageUrl || feed.imageUrl,
            description: parsed.description || feed.description,
            author: parsed.author || feed.author,
          });

          if (inserted.length > 0) {
            for (const ep of inserted.slice(0, 3)) {
              sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
            }
          }
        }
      }

      res.json({ newEpisodes: totalNew });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/feeds/refresh-all", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const allFeeds = await storage.getActiveFeeds();
      let totalNew = 0;
      for (const feed of allFeeds) {
        try {
          // TAT feed refresh
          const isTatUrl = feed.rssUrl.startsWith("tat://");
          const effectiveTatId = feed.tatSpeakerId ?? (isTatUrl ? parseInt(feed.rssUrl.replace("tat://speaker/", ""), 10) || null : null);
          if (effectiveTatId) {
            const tatResult = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveTatId });
            totalNew += tatResult.newEpisodes;
          }
          // OU Torah platform refresh (AllDaf, AllMishnah, AllParsha, AllHalacha)
          const ouRefresh = detectOUPlatform(feed as any);
          if (ouRefresh) {
            const ouResult = await refreshOUFeedEpisodes(ouRefresh.platform, { id: feed.id, title: feed.title, authorId: ouRefresh.authorId });
            totalNew += ouResult.newEpisodes;
          }
          // KH feed refresh
          const isKhRssUrl = feed.rssUrl.startsWith("kh://");
          const bulkKhId = (feed as any).kolhalashonRavId ?? (isKhRssUrl ? parseInt(feed.rssUrl.replace("kh://rav/", ""), 10) || null : null);
          if (bulkKhId) {
            const khResult = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: bulkKhId }, feed);
            totalNew += khResult.newEpisodes;
          }
          // RSS refresh (skip for TAT-only, OU-only, and KH-only feeds)
          const isOURssUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
          if (!feed.rssUrl.startsWith("tat://") && !isOURssUrl && !isKhRssUrl) {
            const parsed = await parseFeed(feed.id, feed.rssUrl);
            if (!parsed) { await storage.updateFeed(feed.id, { lastFetchedAt: new Date() }); continue; }
            const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
            const inserted = await storage.upsertEpisodes(feed.id, episodeData);
            totalNew += inserted.length;
            await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
            if (inserted.length > 0) {
              for (const ep of inserted.slice(0, 3)) {
                sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
              }
            }
          }
        } catch (e) {
          console.error(`Failed to refresh feed ${feed.title}:`, e);
        }
      }
      res.json({ refreshed: allFeeds.length, newEpisodes: totalNew });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Episodes

  // Batch fetch episodes by IDs (used by favorites screen)
  app.post("/api/episodes/batch", async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.json([]);
      const eps = await storage.getEpisodesByIds(ids.slice(0, 200));
      res.json(eps);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/episodes/latest", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const slim = req.query.slim === "1";
      const eps = await storage.getLatestEpisodes(limit);
      res.setHeader("Cache-Control", "public, max-age=30");
      if (slim) {
        res.json(eps.map(ep => ({
          id: ep.id,
          feedId: ep.feedId,
          title: ep.title,
          audioUrl: ep.audioUrl,
          duration: ep.duration,
          publishedAt: ep.publishedAt,
          imageUrl: ep.imageUrl,
        })));
      } else {
        res.json(eps);
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Listens
  app.post("/api/listens", async (req: Request, res: Response) => {
    try {
      const { episodeId, deviceId } = req.body;
      if (!episodeId || !deviceId) return res.status(400).json({ error: "episodeId and deviceId required" });
      await storage.recordListen(episodeId, deviceId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/playback-positions", async (req: Request, res: Response) => {
    try {
      const { episodeId, feedId, deviceId, positionMs, durationMs, completed } = req.body;
      if (!episodeId || !deviceId) return res.status(400).json({ error: "episodeId and deviceId required" });
      const pos = await storage.syncPlaybackPosition(episodeId, feedId || "", deviceId, positionMs || 0, durationMs || 0, completed || false);
      res.json(pos);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/playback-positions/:deviceId", async (req: Request, res: Response) => {
    try {
      const positions = await storage.getPlaybackPositions(req.params.deviceId);
      res.json(positions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/queue/:deviceId", async (req: Request, res: Response) => {
    try {
      const items = await storage.getQueueForDevice(req.params.deviceId);
      res.json(items);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/queue/:deviceId", async (req: Request, res: Response) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
      await storage.saveQueue(req.params.deviceId, items);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/episodes/trending", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const eps = await storage.getTrendingEpisodes(limit);
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json(eps);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Recommendations
  const recommendationCache = new Map<string, { data: Feed[]; ts: number }>();
  app.get("/api/recommendations/:deviceId", async (req: Request, res: Response) => {
    try {
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const { deviceId } = req.params;
      const limit = parseInt(req.query.limit as string) || 10;
      const cached = recommendationCache.get(deviceId);
      if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
        res.setHeader("Cache-Control", "public, max-age=60");
        return res.json(cached.data.map((f: any) => addKHDefaultImage(f, baseUrl)));
      }
      const recs = await storage.getRecommendations(deviceId, limit);
      recommendationCache.set(deviceId, { data: recs, ts: Date.now() });
      // Clean old cache entries
      if (recommendationCache.size > 1000) {
        const now = Date.now();
        for (const [key, val] of recommendationCache) {
          if (now - val.ts > 10 * 60 * 1000) recommendationCache.delete(key);
        }
      }
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(recs.map((f: any) => addKHDefaultImage(f, baseUrl)));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Analytics
  app.get("/api/admin/analytics", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const analytics = await storage.getAnalytics();
      res.json(analytics);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Podcast Search (iTunes Search API - free, no key needed)
  app.get("/api/admin/search-podcasts", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const term = req.query.term as string;
      if (!term || term.trim().length < 2) {
        return res.json({ results: [] });
      }
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=podcast&limit=20`;
      const response = await fetch(url);
      const data = await response.json() as any;
      const results = (data.results || []).map((r: any) => ({
        name: r.collectionName || r.trackName,
        artist: r.artistName,
        artworkUrl: r.artworkUrl600 || r.artworkUrl100,
        feedUrl: r.feedUrl,
        genre: r.primaryGenreName,
        episodeCount: r.trackCount,
      })).filter((r: any) => r.feedUrl);
      res.json({ results });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // RSS Feed Preview (parse without saving)
  app.post("/api/admin/preview-feed", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { rssUrl } = req.body;
      if (!rssUrl) return res.status(400).json({ error: "rssUrl is required" });
      const parsed = await parseFeed("preview", rssUrl);
      if (!parsed) return res.status(500).json({ error: "Could not parse feed" });
      res.json({
        title: parsed.title,
        description: parsed.description,
        author: parsed.author,
        imageUrl: parsed.imageUrl,
        episodeCount: parsed.episodes.length,
        latestEpisode: parsed.episodes[0]?.title || null,
      });
    } catch (e: any) {
      res.status(400).json({ error: "Could not parse RSS feed: " + e.message });
    }
  });

  // Subscriptions
  app.get("/api/subscriptions/:deviceId", async (req: Request, res: Response) => {
    try {
      const subs = await storage.getSubscriptions(req.params.deviceId);
      res.json(subs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/subscriptions/:deviceId/feeds", async (req: Request, res: Response) => {
    try {
      const feedList = await storage.getSubscribedFeeds(req.params.deviceId);
      res.json(feedList);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/subscriptions/:deviceId/episodes", async (req: Request, res: Response) => {
    try {
      const eps = await storage.getEpisodesForSubscribedFeeds(req.params.deviceId);
      res.json(eps);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/subscriptions", async (req: Request, res: Response) => {
    try {
      const { deviceId, feedId } = req.body;
      if (!deviceId || !feedId) return res.status(400).json({ error: "deviceId and feedId required" });
      const sub = await storage.addSubscription(deviceId, feedId);
      res.json(sub || { ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/subscriptions/:deviceId/:feedId", async (req: Request, res: Response) => {
    try {
      await storage.removeSubscription(req.params.deviceId, req.params.feedId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Notification Preferences (per-feed mute/unmute)
  app.get("/api/notification-preferences/:deviceId/:feedId", async (req: Request, res: Response) => {
    try {
      const pref = await storage.getNotificationPreference(req.params.deviceId, req.params.feedId);
      res.json({ muted: pref?.muted ?? false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/notification-preferences/mute", async (req: Request, res: Response) => {
    try {
      const { deviceId, feedId } = req.body;
      if (!deviceId || !feedId) return res.status(400).json({ error: "deviceId and feedId required" });
      await storage.muteNotificationsForFeed(deviceId, feedId);
      res.json({ muted: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/notification-preferences/:deviceId/:feedId", async (req: Request, res: Response) => {
    try {
      await storage.unmuteNotificationsForFeed(req.params.deviceId, req.params.feedId);
      res.json({ muted: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Favorites
  app.get("/api/favorites/:deviceId", async (req: Request, res: Response) => {
    try {
      const favs = await storage.getFavorites(req.params.deviceId);
      res.json(favs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/favorites", async (req: Request, res: Response) => {
    try {
      const { episodeId, deviceId } = req.body;
      if (!episodeId || !deviceId) return res.status(400).json({ error: "episodeId and deviceId required" });
      const fav = await storage.addFavorite(episodeId, deviceId);
      res.json(fav || { ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/favorites/:deviceId/:episodeId", async (req: Request, res: Response) => {
    try {
      await storage.removeFavorite(req.params.episodeId, req.params.deviceId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Playback Position Sync
  app.post("/api/positions/sync", async (req: Request, res: Response) => {
    try {
      const { episodeId, feedId, deviceId, positionMs, durationMs, completed } = req.body;
      if (!episodeId || !feedId || !deviceId) return res.status(400).json({ error: "episodeId, feedId, and deviceId required" });
      await storage.syncPlaybackPosition(episodeId, feedId, deviceId, positionMs || 0, durationMs || 0, completed || false);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/positions/:deviceId", async (req: Request, res: Response) => {
    try {
      const positions = await storage.getPlaybackPositions(req.params.deviceId);
      res.json(positions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/positions/:deviceId/:episodeId", async (req: Request, res: Response) => {
    try {
      const pos = await storage.getPlaybackPosition(req.params.episodeId, req.params.deviceId);
      res.json(pos || { positionMs: 0, durationMs: 0, completed: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/completed/:deviceId", async (req: Request, res: Response) => {
    try {
      const completed = await storage.getCompletedEpisodes(req.params.deviceId);
      res.json(completed);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Listening Stats
  app.get("/api/stats/:deviceId", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getListeningStats(req.params.deviceId);
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Popular This Week
  app.get("/api/episodes/popular", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const eps = await storage.getWeeklyPopularEpisodes(limit);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(eps);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Feed Listener Count
  app.get("/api/feeds/:id/listeners", async (req: Request, res: Response) => {
    try {
      const count = await storage.getFeedListenerCount(req.params.id);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/public-stats", async (_req: Request, res: Response) => {
    try {
      const allFeeds = await storage.getAllFeeds();
      const activeFeeds = allFeeds.filter(f => f.isActive);
      const analytics = await storage.getAnalytics();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({
        shiurimCount: activeFeeds.length,
        episodeCount: analytics.totalEpisodes,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Global Episode Search
  app.get("/api/episodes/search", async (req: Request, res: Response) => {
    try {
      const q = req.query.q as string;
      const limit = parseInt(req.query.limit as string) || 30;
      if (!q || q.trim().length < 2) return res.json([]);
      const eps = await storage.searchEpisodes(q, limit);
      res.json(eps);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/episodes/:id/download", async (req: Request, res: Response) => {
    try {
      const episode = await storage.getEpisodeById(req.params.id);
      if (!episode) return res.status(404).json({ error: "Episode not found" });
      if (!episode.audioUrl) return res.status(404).json({ error: "No audio URL" });

      const feed = await storage.getFeedById(episode.feedId);
      const author = feed?.author || feed?.title || "";
      const safeAuthor = author.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_").substring(0, 60);
      const safeTitle = (episode.title || "episode").replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_").substring(0, 100);
      const filename = safeAuthor ? `${safeAuthor}_-_${safeTitle}.mp3` : `${safeTitle}.mp3`;

      const resolved = resolveKHAudioUrl(episode.audioUrl);
      const audioResp = await fetch(resolved.url, {
        headers: resolved.headers,
        redirect: "follow",
      });

      if (!audioResp.ok) return res.status(502).json({ error: "Failed to fetch audio" });

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", audioResp.headers.get("content-type") || "audio/mpeg");
      const contentLength = audioResp.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);

      const reader = audioResp.body?.getReader();
      if (!reader) return res.status(502).json({ error: "No stream" });

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.writableEnded) res.write(Buffer.from(value));
        }
        res.end();
      };
      await pump();
    } catch (e: any) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // KH audio proxy — resolves the getLocationOfFileToVideo and streams/redirects audio
  app.get("/api/audio/kh/:fileId", async (req: Request, res: Response) => {
    try {
      const fileId = req.params.fileId;
      if (!fileId || !/^\d+$/.test(fileId)) return res.status(400).json({ error: "Invalid file ID" });

      // KH serves MP3 audio via: srv.kolhalashon.com/api/files/GetMp3FileToPlay/{fileId}
      const khPath = `/api/files/GetMp3FileToPlay/${fileId}`;
      const headers = getKHHeaders();
      headers["accept"] = "*/*";

      const proxyUrl = process.env.KH_PROXY_URL;
      const urlsToTry = proxyUrl
        ? [`${proxyUrl.replace(/\/$/, "")}${khPath}`, `https://srv.kolhalashon.com${khPath}`]
        : [`https://srv.kolhalashon.com${khPath}`];

      for (const url of urlsToTry) {
        try {
          const rangeHeader = req.headers.range;
          const reqHeaders: Record<string, string> = { ...headers };
          if (rangeHeader) reqHeaders["Range"] = rangeHeader;

          const audioResp = await fetch(url, {
            headers: reqHeaders,
            redirect: "follow",
            signal: AbortSignal.timeout(30000),
          });

          if (audioResp.ok || audioResp.status === 206) {
            console.log(`KH audio: ${fileId} serving from ${url.includes("proxy") ? "proxy" : "direct"}`);
            res.status(audioResp.status);
            res.setHeader("Content-Type", audioResp.headers.get("content-type") || "audio/mpeg");
            const cl = audioResp.headers.get("content-length");
            if (cl) res.setHeader("Content-Length", cl);
            const cr = audioResp.headers.get("content-range");
            if (cr) res.setHeader("Content-Range", cr);
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("Cache-Control", "public, max-age=86400");

            const reader = audioResp.body?.getReader();
            if (!reader) return res.status(502).json({ error: "No stream" });
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.writableEnded) res.write(Buffer.from(value));
            }
            res.end();
            return;
          }
          console.log(`KH audio: ${url} returned ${audioResp.status}`);
        } catch (e: any) {
          console.log(`KH audio: ${url} failed — ${e.message?.slice(0, 100)}`);
        }
      }

      return res.status(502).json({ error: "Failed to fetch KH audio" });
    } catch (e: any) {
      console.error(`KH audio proxy error for ${req.params.fileId}:`, e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // What's New (episodes from subscribed feeds)
  app.get("/api/whatsnew/:deviceId", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const since = req.query.since ? new Date(req.query.since as string) : undefined;
      const eps = await storage.getNewEpisodesForSubscribedFeeds(req.params.deviceId, limit, since);
      res.json(eps);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Featured toggle
  app.put("/api/admin/feeds/:id/featured", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { featured } = req.body;
      await storage.setFeedFeatured(req.params.id, featured);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Maggid Shiur (speaker) management
  app.get("/api/admin/maggid-shiurim", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const profiles = await storage.getAllMaggidShiurim();
      res.json(profiles);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/maggid-shiurim", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { name, imageUrl, bio } = req.body;
      if (!name) return res.status(400).json({ error: "Name is required" });
      const profile = await storage.createMaggidShiur({ name, imageUrl: imageUrl || null, bio: bio || null });
      res.json(profile);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put("/api/admin/maggid-shiurim/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { name, imageUrl, bio } = req.body;
      const profile = await storage.updateMaggidShiur(req.params.id, { name, imageUrl: imageUrl || null, bio: bio || null });
      res.json(profile);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/admin/maggid-shiurim/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteMaggidShiur(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: TorahAnytime sync
  app.post("/api/admin/tat/sync-speakers", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const result = await syncTATSpeakers();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Toggle all TAT feeds active/inactive
  app.post("/api/admin/tat/toggle", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });
      const allFeeds = await storage.getAllFeeds();
      const tatOnlyFeeds = allFeeds.filter(f => f.tatSpeakerId != null && f.rssUrl.startsWith("tat://"));
      console.log(`TAT toggle: enabled=${enabled}, found ${tatOnlyFeeds.length} TAT-only feeds`);
      let updated = 0;
      for (const feed of tatOnlyFeeds) {
        if (feed.isActive !== enabled) {
          await storage.updateFeed(feed.id, { isActive: enabled });
          updated++;
        }
      }
      console.log(`TAT toggle: updated ${updated} feeds`);
      res.json({ updated, enabled, totalFound: tatOnlyFeeds.length });
    } catch (e: any) {
      console.error("TAT toggle error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get TAT status
  app.get("/api/admin/tat/status", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const allFeeds = await storage.getAllFeeds();
      const tatFeeds = allFeeds.filter(f => f.tatSpeakerId != null);
      const tatOnlyFeeds = tatFeeds.filter(f => f.rssUrl.startsWith("tat://"));
      const activeCount = tatOnlyFeeds.filter(f => f.isActive).length;
      const enabled = activeCount > 0;
      res.json({ enabled, totalTATFeeds: tatOnlyFeeds.length, activeTATFeeds: activeCount, mergedFeeds: tatFeeds.length - tatOnlyFeeds.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Remove all female TAT speaker feeds
  app.post("/api/admin/tat/remove-female-feeds", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const speakers = await fetchAllSpeakers();
      const femaleSpeakerIds = new Set(speakers.filter(s => s.female).map(s => s.id));

      const allFeeds = await storage.getAllFeeds();
      let removed = 0;
      for (const feed of allFeeds) {
        if (feed.tatSpeakerId && femaleSpeakerIds.has(feed.tatSpeakerId)) {
          await storage.deleteFeed(feed.id);
          removed++;
          console.log(`Removed female speaker feed: "${feed.title}" (TAT speaker ${feed.tatSpeakerId})`);
        }
      }
      res.json({ removed, totalFemaleSpakers: femaleSpeakerIds.size });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Link/unlink feed to TAT speaker
  app.put("/api/admin/feeds/:id/tat-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { tatSpeakerId } = req.body;
      if (!tatSpeakerId) return res.status(400).json({ error: "tatSpeakerId required" });
      const feed = await storage.updateFeed(req.params.id, { tatSpeakerId } as any);
      res.json(feed);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/feeds/:id/tat-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feed = await storage.updateFeed(req.params.id, { tatSpeakerId: null } as any);
      res.json(feed);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- OU Torah Platform Integration (AllDaf, AllMishnah, AllParsha) ---

  // Generic endpoints for each OU platform
  for (const cfg of Object.values(OU_PLATFORMS)) {
    const platformRoute = cfg.key; // "alldaf", "allmishnah", "allparsha"

    // Sync authors
    app.post(`/api/admin/${platformRoute}/sync-authors`, adminAuth as any, async (_req: Request, res: Response) => {
      try {
        const result = await syncOUPlatformAuthors(cfg.key);
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // Toggle active/inactive
    app.post(`/api/admin/${platformRoute}/toggle`, adminAuth as any, async (req: Request, res: Response) => {
      try {
        const { enabled } = req.body;
        if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });
        const allFeeds = await storage.getAllFeeds();
        const platformOnlyFeeds = allFeeds.filter(f => (f as any)[cfg.feedIdField] != null && f.rssUrl.startsWith(cfg.urlScheme));
        console.log(`${platformRoute} toggle: enabled=${enabled}, found ${platformOnlyFeeds.length} platform-only feeds`);
        let updated = 0;
        for (const feed of platformOnlyFeeds) {
          if (feed.isActive !== enabled) {
            await storage.updateFeed(feed.id, { isActive: enabled });
            updated++;
          }
        }
        console.log(`${platformRoute} toggle: updated ${updated} feeds`);
        res.json({ updated, enabled, totalFound: platformOnlyFeeds.length });
      } catch (e: any) {
        console.error(`${platformRoute} toggle error:`, e);
        res.status(500).json({ error: e.message });
      }
    });

    // Get status
    app.get(`/api/admin/${platformRoute}/status`, adminAuth as any, async (_req: Request, res: Response) => {
      try {
        const allFeeds = await storage.getAllFeeds();
        const platformFeeds = allFeeds.filter(f => (f as any)[cfg.feedIdField] != null);
        const platformOnlyFeeds = platformFeeds.filter(f => f.rssUrl.startsWith(cfg.urlScheme));
        const activeCount = platformOnlyFeeds.filter(f => f.isActive).length;
        const enabled = activeCount > 0;
        res.json({ enabled, totalFeeds: platformOnlyFeeds.length, activeFeeds: activeCount, mergedFeeds: platformFeeds.length - platformOnlyFeeds.length });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // Link/unlink feed to platform author
    app.put(`/api/admin/feeds/:id/${platformRoute}-link`, adminAuth as any, async (req: Request, res: Response) => {
      try {
        const { authorId } = req.body;
        if (!authorId) return res.status(400).json({ error: "authorId required" });
        await storage.setOUAuthorId(req.params.id, cfg.feedIdField, authorId);
        const feed = await storage.getFeedById(req.params.id);
        res.json(feed);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.delete(`/api/admin/feeds/:id/${platformRoute}-link`, adminAuth as any, async (req: Request, res: Response) => {
      try {
        await storage.setOUAuthorId(req.params.id, cfg.feedIdField, null);
        const feed = await storage.getFeedById(req.params.id);
        res.json(feed);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });
  } // end OU platform loop

  // --- Kol Halashon Integration ---

  // Admin: Sync KH speakers
  app.post("/api/admin/kh/sync-speakers", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const result = await syncKHSpeakers();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Toggle all KH feeds active/inactive
  app.post("/api/admin/kh/toggle", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });
      const allFeeds = await storage.getAllFeeds();
      const khOnlyFeeds = allFeeds.filter(f => (f as any).kolhalashonRavId != null && f.rssUrl.startsWith("kh://"));
      console.log(`KH toggle: enabled=${enabled}, found ${khOnlyFeeds.length} KH-only feeds`);
      let updated = 0;
      for (const feed of khOnlyFeeds) {
        if (feed.isActive !== enabled) {
          await storage.updateFeed(feed.id, { isActive: enabled });
          updated++;
        }
      }
      console.log(`KH toggle: updated ${updated} feeds`);
      res.json({ updated, enabled, totalFound: khOnlyFeeds.length });
    } catch (e: any) {
      console.error("KH toggle error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get KH status
  app.get("/api/admin/kh/status", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const allFeeds = await storage.getAllFeeds();
      const khFeeds = allFeeds.filter(f => (f as any).kolhalashonRavId != null);
      const khOnlyFeeds = khFeeds.filter(f => f.rssUrl.startsWith("kh://"));
      const activeCount = khOnlyFeeds.filter(f => f.isActive).length;
      const enabled = activeCount > 0;
      res.json({
        enabled,
        totalKHFeeds: khOnlyFeeds.length,
        activeKHFeeds: activeCount,
        mergedFeeds: khFeeds.length - khOnlyFeeds.length,
        hasProxy: !!process.env.KH_PROXY_URL,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Link/unlink feed to KH rav
  app.put("/api/admin/feeds/:id/kh-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { kolhalashonRavId } = req.body;
      if (!kolhalashonRavId) return res.status(400).json({ error: "kolhalashonRavId required" });
      await storage.setKHRavId(req.params.id, kolhalashonRavId);
      const feed = await storage.getFeedById(req.params.id);
      res.json(feed);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/feeds/:id/kh-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.setKHRavId(req.params.id, null);
      const feed = await storage.getFeedById(req.params.id);
      res.json(feed);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Merge two feeds (move episodes + subscribers from source into target, delete source)
  app.post("/api/admin/feeds/merge", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { sourceId, targetId } = req.body;
      if (!sourceId || !targetId) return res.status(400).json({ error: "sourceId and targetId required" });
      if (sourceId === targetId) return res.status(400).json({ error: "Cannot merge a feed into itself" });

      const source = await storage.getFeedById(sourceId);
      const target = await storage.getFeedById(targetId);
      if (!source) return res.status(404).json({ error: "Source feed not found" });
      if (!target) return res.status(404).json({ error: "Target feed not found" });

      // Carry over platform IDs from source to target if target doesn't have them
      if (source.tatSpeakerId && !target.tatSpeakerId) {
        await storage.updateFeed(targetId, { tatSpeakerId: source.tatSpeakerId } as any);
      }
      for (const cfg of Object.values(OU_PLATFORMS)) {
        if ((source as any)[cfg.feedIdField] && !(target as any)[cfg.feedIdField]) {
          await storage.setOUAuthorId(targetId, cfg.feedIdField, (source as any)[cfg.feedIdField]);
        }
      }
      if ((source as any).kolhalashonRavId && !(target as any).kolhalashonRavId) {
        await storage.setKHRavId(targetId, (source as any).kolhalashonRavId);
      }

      const result = await storage.mergeFeeds(sourceId, targetId);

      // Record merge history
      await db.insert(feedMergeHistory).values({
        targetFeedId: targetId,
        sourceFeedTitle: source.title,
        sourceFeedAuthor: source.author || null,
        sourceFeedRssUrl: source.rssUrl || null,
        episodesMoved: result.episodesMoved,
        subscriptionsMoved: result.subscriptionsMoved,
      });

      console.log(`Feed merge: "${source.title}" -> "${target.title}" (${result.episodesMoved} episodes, ${result.subscriptionsMoved} subscriptions moved)`);
      res.json({
        message: `Merged "${source.title}" into "${target.title}"`,
        sourceFeed: source.title,
        targetFeed: target.title,
        ...result,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get all merged/linked feeds (feeds with multiple platform sources)
  app.get("/api/admin/mergers", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const allFeeds = await storage.getAllFeeds();
      const merged = allFeeds
        .map(f => {
          const platforms: string[] = [];
          if (f.rssUrl && !f.rssUrl.startsWith("tat://") && !f.rssUrl.startsWith("kh://") && !Object.values(OU_PLATFORMS).some(c => f.rssUrl.startsWith(c.urlScheme))) {
            platforms.push("RSS");
          }
          if (f.tatSpeakerId) platforms.push("Torah Anytime");
          if (f.alldafAuthorId) platforms.push("AllDaf");
          if (f.allmishnahAuthorId) platforms.push("AllMishnah");
          if (f.allparshaAuthorId) platforms.push("AllParsha");
          if (f.allhalachaAuthorId) platforms.push("AllHalacha");
          if ((f as any).kolhalashonRavId) platforms.push("Kol Halashon");
          if (platforms.length < 2) return null;
          return {
            id: f.id,
            title: f.title,
            author: f.author,
            rssUrl: f.rssUrl,
            imageUrl: f.imageUrl,
            platforms,
            tatSpeakerId: f.tatSpeakerId,
            alldafAuthorId: f.alldafAuthorId,
            allmishnahAuthorId: f.allmishnahAuthorId,
            allparshaAuthorId: f.allparshaAuthorId,
            allhalachaAuthorId: f.allhalachaAuthorId,
            kolhalashonRavId: (f as any).kolhalashonRavId,
          };
        })
        .filter(Boolean);
      res.json(merged);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get merge history for a specific feed
  app.get("/api/admin/feeds/:id/merge-history", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const history = await db.select().from(feedMergeHistory)
        .where(eq(feedMergeHistory.targetFeedId, req.params.id))
        .orderBy(desc(feedMergeHistory.mergedAt));
      res.json(history);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get ALL merge history (global view)
  app.get("/api/admin/merge-history", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const history = await storage.getAllMergeHistory();
      res.json(history);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get KH speaker stats
  app.get("/api/admin/kh/speakers", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const speakers = await storage.getKHSpeakerStats();
      res.json(speakers);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Get source breakdown analytics
  app.get("/api/admin/analytics/sources", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const breakdown = await storage.getSourceBreakdown();
      res.json(breakdown);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Recompute KH browse visibility
  app.post("/api/admin/kh/recompute-visibility", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const updated = await storage.recomputeKHBrowseVisibility();
      res.json({ updated, message: `Recomputed KH browse visibility, ${updated} feeds changed` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Unlink a specific platform from a feed
  app.post("/api/admin/feeds/:id/unlink-platform", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { platform } = req.body;
      const feedId = req.params.id;
      const feed = await storage.getFeedById(feedId);
      if (!feed) return res.status(404).json({ error: "Feed not found" });

      switch (platform) {
        case "Torah Anytime":
          await storage.updateFeed(feedId, { tatSpeakerId: null } as any);
          break;
        case "AllDaf":
          await storage.setOUAuthorId(feedId, "alldafAuthorId", null);
          break;
        case "AllMishnah":
          await storage.setOUAuthorId(feedId, "allmishnahAuthorId", null);
          break;
        case "AllParsha":
          await storage.setOUAuthorId(feedId, "allparshaAuthorId", null);
          break;
        case "AllHalacha":
          await storage.setOUAuthorId(feedId, "allhalachaAuthorId", null);
          break;
        case "Kol Halashon":
          await storage.setKHRavId(feedId, null);
          break;
        default:
          return res.status(400).json({ error: "Unknown platform: " + platform });
      }
      console.log(`Unlinked "${platform}" from feed "${feed.title}"`);
      res.json({ ok: true, unlinked: platform, feedTitle: feed.title });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Bulk Feed Import with streaming progress
  app.post("/api/admin/feeds/bulk-import", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { feeds: feedUrls, categoryId } = req.body;
      if (!Array.isArray(feedUrls) || feedUrls.length === 0) return res.status(400).json({ error: "feeds array required" });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const results: { url: string; success: boolean; title?: string; error?: string }[] = [];
      for (let i = 0; i < feedUrls.length; i++) {
        const rssUrl = feedUrls[i];
        try {
          res.write(`data: ${JSON.stringify({ type: "progress", index: i, total: feedUrls.length, url: rssUrl, status: "parsing" })}\n\n`);
          const parsed = await parseFeed("temp", rssUrl);
          if (!parsed) { res.write(`data: ${JSON.stringify({ type: "error", index: i, url: rssUrl, error: "Could not parse feed" })}\n\n`); continue; }
          res.write(`data: ${JSON.stringify({ type: "progress", index: i, total: feedUrls.length, url: rssUrl, status: "saving", title: parsed.title })}\n\n`);
          const feed = await storage.createFeed({
            title: parsed.title,
            rssUrl,
            imageUrl: parsed.imageUrl || null,
            description: parsed.description || null,
            author: parsed.author || null,
            categoryId: categoryId || null,
            sourceNetwork: detectSourceNetwork(rssUrl),
          });
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          await storage.upsertEpisodes(feed.id, episodeData);
          results.push({ url: rssUrl, success: true, title: parsed.title });
          res.write(`data: ${JSON.stringify({ type: "progress", index: i, total: feedUrls.length, url: rssUrl, status: "done", title: parsed.title })}\n\n`);
        } catch (e: any) {
          results.push({ url: rssUrl, success: false, error: e.message });
          res.write(`data: ${JSON.stringify({ type: "progress", index: i, total: feedUrls.length, url: rssUrl, status: "error", error: e.message })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ type: "complete", results })}\n\n`);
      res.end();
    } catch (e: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: e.message });
      }
    }
  });

  // Admin: Episode Notes & Source Sheets
  app.put("/api/admin/episodes/:id/notes", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { adminNotes, sourceSheetUrl } = req.body;
      const { db } = await import("./db");
      const { episodes } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [updated] = await db.update(episodes).set({ adminNotes, sourceSheetUrl }).where(eq(episodes.id, req.params.id)).returning();
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Notifications
  app.get("/api/admin/notifications", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const notifs = await storage.getAdminNotifications();
      res.json(notifs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/notifications", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { title, message } = req.body;
      if (!title || !message) return res.status(400).json({ error: "title and message required" });
      const notif = await storage.createAdminNotification(title, message);
      res.json(notif);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/notifications/:id/send", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.markNotificationSent(req.params.id);
      res.json({ ok: true, sent: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Enhanced Analytics
  app.get("/api/admin/analytics/enhanced", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const analytics = await storage.getEnhancedAnalytics();
      res.json(analytics);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/analytics/listeners", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const analytics = await storage.getListenerAnalytics();
      res.json(analytics);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Scheduled Publishing
  app.put("/api/admin/feeds/:id/schedule", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { scheduledPublishAt } = req.body;
      const feed = await storage.updateFeed(req.params.id, {
        scheduledPublishAt: scheduledPublishAt ? new Date(scheduledPublishAt) : null,
        isActive: !scheduledPublishAt,
      });
      res.json(feed);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Record listen with duration
  app.post("/api/listens/duration", async (req: Request, res: Response) => {
    try {
      const { episodeId, deviceId, durationMs } = req.body;
      if (!episodeId || !deviceId) return res.status(400).json({ error: "episodeId and deviceId required" });
      await storage.recordListenWithDuration(episodeId, deviceId, durationMs || 0);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Error Reports - public endpoint (no auth needed, devices send errors here)
  app.post("/api/error-reports", async (req: Request, res: Response) => {
    try {
      const { deviceId, level, message, stack, source, platform, appVersion } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });
      const report = await storage.createErrorReport({
        deviceId: deviceId || null,
        level: level || "error",
        message: (message as string).substring(0, 5000),
        stack: stack ? (stack as string).substring(0, 10000) : null,
        source: source || null,
        platform: platform || null,
        appVersion: appVersion || null,
      });
      res.json({ ok: true, id: report.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Batch error reports
  app.post("/api/error-reports/batch", async (req: Request, res: Response) => {
    try {
      const { reports } = req.body;
      if (!Array.isArray(reports)) return res.status(400).json({ error: "reports array required" });
      const limited = reports.slice(0, 20);
      const results = [];
      for (const r of limited) {
        if (!r.message) continue;
        const report = await storage.createErrorReport({
          deviceId: r.deviceId || null,
          level: r.level || "error",
          message: (r.message as string).substring(0, 5000),
          stack: r.stack ? (r.stack as string).substring(0, 10000) : null,
          source: r.source || null,
          platform: r.platform || null,
          appVersion: r.appVersion || null,
        });
        results.push(report.id);
      }
      res.json({ ok: true, count: results.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Error Reports
  app.get("/api/admin/error-reports", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const level = req.query.level as string || undefined;
      const resolved = req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined;
      const reports = await storage.getErrorReports({ page, limit, level, resolved });
      res.json(reports);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/admin/error-reports/:id/resolve", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const report = await storage.resolveErrorReport(req.params.id);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/error-reports/resolved", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const count = await storage.deleteResolvedErrorReports();
      res.json({ ok: true, deleted: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Feedback - public endpoint (no auth needed)
  app.post("/api/feedback", async (req: Request, res: Response) => {
    try {
      const { deviceId, type, subject, message, contactInfo, deviceLogs } = req.body;
      if (!subject || !message) return res.status(400).json({ error: "subject and message required" });
      if (!["shiur_request", "technical_issue"].includes(type)) return res.status(400).json({ error: "type must be shiur_request or technical_issue" });
      let logsStr: string | null = null;
      if (deviceLogs && typeof deviceLogs === "string") {
        logsStr = deviceLogs.substring(0, 50000);
      } else if (Array.isArray(deviceLogs)) {
        logsStr = JSON.stringify(deviceLogs).substring(0, 50000);
      }
      const fb = await storage.createFeedback({
        deviceId: deviceId || null,
        type: type || "shiur_request",
        subject: (subject as string).substring(0, 200),
        message: (message as string).substring(0, 5000),
        contactInfo: contactInfo ? (contactInfo as string).substring(0, 200) : null,
        deviceLogs: logsStr,
      });
      res.json({ ok: true, id: fb.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: Feedback management
  app.get("/api/admin/feedback", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const type = req.query.type as string || undefined;
      const status = req.query.status as string || undefined;
      const data = await storage.getFeedbackList({ page, limit, type, status });
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/admin/feedback/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { status, adminNotes } = req.body;
      const fb = await storage.updateFeedbackStatus(req.params.id, status, adminNotes);
      res.json(fb);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/feedback/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteFeedback(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Push Token Registration
  app.post("/api/push-token", async (req: Request, res: Response) => {
    try {
      const { deviceId, token, platform, provider } = req.body;
      if (!deviceId || !token) return res.status(400).json({ error: "deviceId and token required" });
      const result = await storage.registerPushToken(deviceId, token, platform || "unknown", provider || "expo");
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/push-token", async (req: Request, res: Response) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: "token required" });
      await storage.removePushToken(token);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/share/episode/:id", async (req: Request, res: Response) => {
    try {
      const episode = await storage.getEpisodeById(req.params.id);
      if (!episode) return res.status(404).json({ error: "Episode not found" });
      const allFeeds = await storage.getAllFeeds();
      const feed = allFeeds.find(f => f.id === episode.feedId);
      res.json({
        episode: {
          id: episode.id,
          title: episode.title,
          description: episode.description,
          audioUrl: episode.audioUrl,
          imageUrl: episode.imageUrl,
          duration: episode.duration,
          publishedAt: episode.publishedAt,
        },
        feed: feed ? { id: feed.id, title: feed.title, imageUrl: feed.imageUrl } : null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/share/episode/:id", async (req: Request, res: Response) => {
    try {
      const episode = await storage.getEpisodeById(req.params.id);
      if (!episode) return res.status(404).send("Episode not found");
      const allFeeds = await storage.getAllFeeds();
      const feed = allFeeds.find(f => f.id === episode.feedId);
      const timestamp = req.query.t ? parseInt(req.query.t as string) : 0;
      const host = req.get("host") || "";
      const protocol = req.protocol;
      const baseUrl = `${protocol}://${host}`;

      res.send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${episode.title} - ShiurPod</title>
  <meta property="og:title" content="${episode.title}">
  <meta property="og:description" content="${feed?.title || 'ShiurPod'}${timestamp > 0 ? ' - at ' + Math.floor(timestamp / 60000) + ':' + String(Math.floor((timestamp % 60000) / 1000)).padStart(2, '0') : ''}">
  <meta property="og:image" content="${episode.imageUrl || feed?.imageUrl || ''}">
  <meta property="og:type" content="music.song">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0A1628;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:400px;width:100%;text-align:center;background:#1a2744;border-radius:16px;padding:32px 24px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
    .artwork{width:180px;height:180px;border-radius:12px;object-fit:cover;margin:0 auto 20px}
    h1{font-size:18px;margin-bottom:8px;line-height:1.3}
    .feed{color:#8BA4C4;font-size:14px;margin-bottom:24px}
    .btn{display:inline-block;background:#3B82F6;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:600;font-size:16px;margin:8px}
    .btn:hover{background:#2563EB}
    .audio-wrap{margin-top:20px}
    audio{width:100%}
  </style>
</head><body>
  <div class="card">
    <img class="artwork" src="${episode.imageUrl || feed?.imageUrl || ''}" alt="">
    <h1>${episode.title}</h1>
    <p class="feed">${feed?.title || ''}</p>
    <a class="btn" href="shiurpod://episode/${episode.id}${timestamp > 0 ? '?t=' + timestamp : ''}">Open in ShiurPod</a>
    <div class="audio-wrap">
      <audio controls preload="none" src="${episode.audioUrl}"></audio>
    </div>
  </div>
</body></html>`);
    } catch (e: any) {
      res.status(500).send("Error loading episode");
    }
  });

  // Contact form (public)
  app.post("/api/contact", async (req: Request, res: Response) => {
    try {
      const { name, email, message } = req.body;
      if (!name || !message) {
        return res.status(400).json({ error: "Name and message are required" });
      }
      const msg = await storage.createContactMessage(name, email || null, message);
      res.json({ ok: true, id: msg.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: get contact messages with pagination and filtering
  app.get("/api/admin/contact-messages", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 30;
      const status = (req.query.status as string) || undefined;
      const allMessages = await storage.getAllContactMessages();
      const filtered = status ? allMessages.filter((m: any) => m.status === status) : allMessages;
      const total = filtered.length;
      const start = (page - 1) * limit;
      const messages = filtered.slice(start, start + limit);
      res.json({ messages, total, page, totalPages: Math.ceil(total / limit) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: update contact message status
  app.put("/api/admin/contact-messages/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { status } = req.body;
      if (status === 'read') {
        await storage.markContactMessageRead(req.params.id);
      } else {
        await storage.updateContactMessageStatus(req.params.id, status);
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: delete contact message
  app.delete("/api/admin/contact-messages/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteContactMessage(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: change password
  app.post("/api/admin/change-password", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "All fields are required" });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: "New password must be at least 6 characters" });
      }
      const adminUser = await storage.getAdminUser("admin");
      if (!adminUser) {
        return res.status(404).json({ error: "Admin user not found" });
      }
      const changed = await storage.changeAdminPassword("admin", currentPassword, newPassword);
      if (!changed) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public: get active APK info
  app.get("/api/apk/latest", async (_req: Request, res: Response) => {
    try {
      const apk = await storage.getActiveApk();
      if (!apk) return res.json({ available: false });
      res.json({ available: true, version: apk.version, fileSize: apk.fileSize, uploadedAt: apk.createdAt });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public: download the active APK
  app.get("/api/apk/download", async (_req: Request, res: Response) => {
    try {
      const apk = await storage.getActiveApk();
      if (!apk) return res.status(404).json({ error: "No APK available" });

      if (apk.fileData) {
        const buffer = Buffer.from(apk.fileData, "base64");
        res.setHeader("Content-Disposition", `attachment; filename="${apk.originalName}"`);
        res.setHeader("Content-Type", "application/vnd.android.package-archive");
        res.setHeader("Content-Length", buffer.length.toString());
        return res.send(buffer);
      }

      const filePath = path.join(uploadDir, apk.filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
      res.setHeader("Content-Disposition", `attachment; filename="${apk.originalName}"`);
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.sendFile(filePath);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: upload APK
  app.post("/api/admin/apk/upload", adminAuth as any, apkUpload.single("apk"), async (req: Request, res: Response) => {
    try {
      const file = (req as any).file;
      if (!file) return res.status(400).json({ error: "No APK file uploaded" });
      const version = req.body.version || null;

      const filePath = path.join(uploadDir, file.filename);
      const fileBuffer = fs.readFileSync(filePath);
      const fileData = fileBuffer.toString("base64");

      const apk = await storage.createApkUpload({
        filename: file.filename,
        originalName: file.originalname,
        version,
        fileSize: file.size,
        fileData,
      });

      try { fs.unlinkSync(filePath); } catch (_) {}

      res.json({ ok: true, apk });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: list all APKs
  app.get("/api/admin/apk", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const apks = await storage.getAllApkUploads();
      res.json(apks);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: set active APK
  app.put("/api/admin/apk/:id/activate", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.setActiveApk(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: delete APK
  app.delete("/api/admin/apk/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteApkUpload(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public: get active sponsor
  app.get("/api/sponsor", async (_req: Request, res: Response) => {
    try {
      const sponsor = await storage.getActiveSponsor();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(sponsor || null);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: list all sponsors
  app.get("/api/admin/sponsors", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const allSponsors = await storage.getAllSponsors();
      res.json(allSponsors);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: create sponsor
  app.post("/api/admin/sponsors", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { name, text, logoUrl, linkUrl } = req.body;
      if (!name) return res.status(400).json({ error: "Name is required" });
      const sponsor = await storage.createSponsor({ name, text, logoUrl, linkUrl });
      res.json(sponsor);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: update sponsor
  app.put("/api/admin/sponsors/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const sponsor = await storage.updateSponsor(req.params.id, req.body);
      res.json(sponsor);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: delete sponsor
  app.delete("/api/admin/sponsors/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteSponsor(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/push-tokens", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const tokens = await storage.getAllPushTokens();
      res.json(tokens);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/push-tokens/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.removePushTokenById(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/send-push", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { title, body, deviceId } = req.body;
      if (!title || !body) {
        res.status(400).json({ error: "Title and body are required" });
        return;
      }
      const result = await sendCustomPush(title, body, deviceId || undefined);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/push-receipts", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { ticketIds } = req.body;
      if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
        res.status(400).json({ error: "ticketIds array is required" });
        return;
      }
      const result = await checkPushReceipts(ticketIds);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/feed-vitals", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const vitals = getVitals();
      res.json(vitals);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/force-sync/:feedId", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feedId = req.params.feedId as string;
      const feed = await storage.getFeedById(feedId);
      if (!feed || !feed.rssUrl) {
        res.status(404).json({ error: "Feed not found" });
        return;
      }

      const start = Date.now();
      try {
        // Handle TAT feeds
        const isForceTatUrl = feed.rssUrl.startsWith("tat://");
        const forceTatId = feed.tatSpeakerId ?? (isForceTatUrl ? parseInt(feed.rssUrl.replace("tat://speaker/", ""), 10) || null : null);
        if (forceTatId) {
          const tatResult = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: forceTatId });
          res.json({ status: "ok", method: "tat", newEpisodes: tatResult.newEpisodes, durationMs: Date.now() - start });
          return;
        }

        // Handle OU Torah platform feeds (AllDaf, AllMishnah, AllParsha)
        const forceOU = detectOUPlatform(feed as any);
        if (forceOU) {
          const ouResult = await refreshOUFeedEpisodes(forceOU.platform, { id: feed.id, title: feed.title, authorId: forceOU.authorId });
          res.json({ status: "ok", method: forceOU.platform, newEpisodes: ouResult.newEpisodes, durationMs: Date.now() - start });
          return;
        }

        // Handle KH feeds
        const isForceKhUrl = feed.rssUrl.startsWith("kh://");
        const forceKhId = (feed as any).kolhalashonRavId ?? (isForceKhUrl ? parseInt(feed.rssUrl.replace("kh://rav/", ""), 10) || null : null);
        if (forceKhId) {
          const khResult = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: forceKhId }, feed);
          res.json({ status: "ok", method: "kh", newEpisodes: khResult.newEpisodes, durationMs: Date.now() - start });
          return;
        }

        const parsed = await parseFeed(feed.id, feed.rssUrl, {
          etag: feed.etag,
          lastModified: feed.lastModifiedHeader,
        });

        if (parsed === null) {
          await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
          recordFeedResult({
            feedId: feed.id,
            feedTitle: feed.title,
            method: 'cached',
            success: true,
            durationMs: Date.now() - start,
            episodesFound: 0,
            newEpisodes: 0,
            timestamp: Date.now(),
          });
          res.json({ status: "304", message: "Not Modified", durationMs: Date.now() - start });
          return;
        }

        const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
        const inserted = await storage.upsertEpisodes(feed.id, episodeData);

        const updateData: any = { lastFetchedAt: new Date() };
        if (parsed.responseHeaders?.etag) updateData.etag = parsed.responseHeaders.etag;
        if (parsed.responseHeaders?.lastModified) updateData.lastModifiedHeader = parsed.responseHeaders.lastModified;
        await storage.updateFeed(feed.id, updateData);

        const durationMs = Date.now() - start;
        recordFeedResult({
          feedId: feed.id,
          feedTitle: feed.title,
          method: parsed.fetchMethod || 'stream',
          success: true,
          durationMs,
          episodesFound: parsed.episodes.length,
          newEpisodes: inserted.length,
          timestamp: Date.now(),
        });

        res.json({
          status: "ok",
          method: parsed.fetchMethod,
          durationMs,
          episodesFound: parsed.episodes.length,
          newEpisodes: inserted.length,
        });
      } catch (syncErr: any) {
        recordFeedResult({
          feedId: feed.id,
          feedTitle: feed.title,
          method: 'stream',
          success: false,
          durationMs: Date.now() - start,
          episodesFound: 0,
          newEpisodes: 0,
          error: syncErr.message?.slice(0, 200),
          timestamp: Date.now(),
        });
        res.json({ status: "error", error: syncErr.message?.slice(0, 200), durationMs: Date.now() - start });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Announcements (public)
  app.get("/api/announcements/:deviceId", async (req: Request, res: Response) => {
    try {
      const anns = await storage.getAnnouncementsForDevice(req.params.deviceId);
      res.json(anns);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/announcements/:id/dismiss", async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.body;
      if (!deviceId) return res.status(400).json({ error: "deviceId required" });
      await storage.dismissAnnouncement(req.params.id, deviceId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Announcements (admin)
  app.get("/api/admin/announcements", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const anns = await storage.getAllAnnouncements();
      // Add dismiss counts
      const result = await Promise.all(anns.map(async (ann) => ({
        ...ann,
        dismissCount: await storage.getAnnouncementDismissCount(ann.id),
      })));
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/announcements", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const ann = await storage.createAnnouncement(req.body);
      res.json(ann);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/admin/announcements/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const ann = await storage.updateAnnouncement(req.params.id, req.body);
      res.json(ann);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/announcements/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteAnnouncement(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Notification tap tracking
  app.post("/api/notification-tap", async (req: Request, res: Response) => {
    try {
      const { deviceId, notificationType, episodeId, feedId } = req.body;
      if (!deviceId) {
        res.status(400).json({ error: "deviceId required" });
        return;
      }
      await storage.recordNotificationTap({ deviceId, notificationType, episodeId, feedId });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/notification-taps", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const stats = await storage.getNotificationTapStats(days);
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public: get all config as flat JSON
  app.get("/api/config", async (_req: Request, res: Response) => {
    try {
      const config = await storage.getAllConfig();
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(config);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: get all config entries with descriptions
  app.get("/api/admin/config", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const entries = await storage.getAllConfigEntries();
      res.json(entries);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: update a config value
  app.put("/api/admin/config/:key", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const { value, description } = req.body;
      if (value === undefined) return res.status(400).json({ error: "value is required" });
      await storage.setConfig(key, value, description);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: delete a config entry
  app.delete("/api/admin/config/:key", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteConfig(req.params.key);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin: seed default config values
  app.post("/api/admin/config/seed", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const defaults: { key: string; value: any; description: string }[] = [
        { key: "homeSections", value: ["continue", "featured", "trending", "allShiurim", "recommended", "maggidShiur", "categories", "recent"], description: "Home screen section order and visibility" },
        { key: "defaultSkipForward", value: 30, description: "Default skip forward seconds" },
        { key: "defaultSkipBackward", value: 30, description: "Default skip backward seconds" },
        { key: "defaultMaxEpisodes", value: 5, description: "Default max episodes per feed" },
        { key: "carouselAutoScrollMs", value: 5000, description: "Featured carousel auto-scroll interval (ms)" },
        { key: "featureFlags", value: { showRecommended: true, showMaggidShiur: true, showTrending: true, showContinueListening: true }, description: "Feature toggles for app sections" },
        { key: "minAppVersion", value: "1.0.0", description: "Minimum supported app version" },
      ];
      let seeded = 0;
      for (const d of defaults) {
        const existing = await storage.getConfig(d.key);
        if (existing === null) {
          await storage.setConfig(d.key, d.value, d.description);
          seeded++;
        }
      }
      res.json({ success: true, seeded, total: defaults.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
