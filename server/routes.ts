import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as storage from "./storage";
import { parseFeed } from "./rss";
import { sendNewEpisodePushes, sendCustomPush, checkPushReceipts, PUSH_BACKFILL_THRESHOLD } from "./push";
import { getVitals, recordFeedResult } from "./feed-vitals";
import { insertFeedSchema, insertCategorySchema, feedMergeHistory } from "@shared/schema";
import type { Feed } from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import { syncTATSpeakers, refreshTATFeedEpisodes, fetchAllSpeakers } from "./torahanytime";
import { detectOUPlatform, refreshOUFeedEpisodes, syncOUPlatformAuthors, OU_PLATFORMS, fetchPostDetailsBatch, type OUPlatformKey } from "./alldaf";
import { syncKHSpeakers, refreshKHFeedEpisodes, reloadKHClient, getHeaders as getKHHeaders } from "./kolhalashon";
import { extractKhRavId, extractTatSpeakerId } from "./feed-utils";
import { trackErrorForAlert, sendFeedbackNotification } from "./error-alerts";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";

const ON_DEMAND_STALE_MS = 5 * 60 * 1000;

// Default logos for platform feeds without artwork
const KH_DEFAULT_LOGO_PATH = "/api/images/kol-halashon-logo.png";
const OU_DEFAULT_LOGO_PATH = "/api/images/ou-torah-logo.png";
const OU_LOGO_NETWORKS = new Set(["AllDaf", "AllMishnah", "AllParsha", "AllHalacha", "OU Torah"]);

function addDefaultImage(feed: any, baseUrl?: string): any {
  if (feed.imageUrl) return feed;
  const prefix = baseUrl || "";
  if (feed.sourceNetwork === "Kol Halashon") {
    return { ...feed, imageUrl: prefix + KH_DEFAULT_LOGO_PATH };
  }
  if (OU_LOGO_NETWORKS.has(feed.sourceNetwork)) {
    return { ...feed, imageUrl: prefix + OU_DEFAULT_LOGO_PATH };
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
/** Safely handle errors in public endpoints — log details server-side, return generic message to client */
function publicError(res: Response, e: any, status = 500) {
  console.error("API error:", e?.message || e);
  if (!res.headersSent) res.status(status).json({ error: "Something went wrong" });
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
    const onDemandTatId = extractTatSpeakerId(feed);
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
    const onDemandKhId = extractKhRavId(feed as any);
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
      if (inserted.length <= PUSH_BACKFILL_THRESHOLD) {
        for (const ep of inserted.slice(0, 3)) {
          sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
        }
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
  // Seed initial admin from env vars only if no admin exists yet
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (adminUser && adminPass) {
    const exists = await storage.adminExists().catch(() => false);
    if (!exists) {
      await storage.resetAllAdmins(adminUser, adminPass).catch(e => console.error("Failed to seed admin:", e));
      console.log("Initial admin account created from environment variables");
    }
  }

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
      publicError(res, e);
    }
  });

  // Cache admin auth to avoid bcrypt on every request (5 min TTL)
  const _adminAuthCache = new Map<string, number>();
  const ADMIN_AUTH_TTL = 5 * 60 * 1000;

  const adminAuth = async (req: Request, res: Response, next: Function) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const token = authHeader.slice(6);
    const cachedAt = _adminAuthCache.get(token);
    if (cachedAt && Date.now() - cachedAt < ADMIN_AUTH_TTL) {
      return next();
    }
    const decoded = Buffer.from(token, "base64").toString();
    const [username, password] = decoded.split(":");
    const valid = await storage.verifyAdmin(username, password);
    if (!valid) {
      _adminAuthCache.delete(token);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    _adminAuthCache.set(token, Date.now());
    // Evict old entries
    if (_adminAuthCache.size > 20) {
      const now = Date.now();
      for (const [k, v] of _adminAuthCache) { if (now - v > ADMIN_AUTH_TTL) _adminAuthCache.delete(k); }
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.post("/api/admin/auto-categorize", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const { autoCategorizeFeeds } = await import("./auto-categorize");
      await autoCategorizeFeeds();
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
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
        return addDefaultImage({ ...f, categoryIds: catIds.length > 0 ? catIds : (f.categoryId ? [f.categoryId] : []) }, baseUrl);
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
      publicError(res, e);
    }
  });

  // Featured Feeds (must be before :id routes)
  app.get("/api/feeds/featured", async (_req: Request, res: Response) => {
    try {
      const featured = await storage.getFeaturedFeeds();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(featured);
    } catch (e: any) {
      publicError(res, e);
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
        return addDefaultImage({ ...f, categoryIds: catIds.length > 0 ? catIds : (f.categoryId ? [f.categoryId] : []) }, baseUrl);
      });
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json(enriched);
    } catch (e: any) {
      publicError(res, e);
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
      res.json(Array.from(allFeedsMap.values()).map(f => addDefaultImage(f, baseUrl)));
    } catch (e: any) {
      publicError(res, e);
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
        feeds: g.feeds.map((f: any) => addDefaultImage(f, baseUrl)),
      }));
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(enriched);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/ping", (_req: Request, res: Response) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // Single feed by ID (works for all feeds regardless of showInBrowse)
  app.get("/api/feeds/:id", async (req: Request, res: Response) => {
    try {
      const feed = await storage.getFeedById(req.params.id);
      if (!feed || !feed.isActive) return res.status(404).json({ error: "Feed not found" });
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const mappings = await storage.getAllFeedCategoryMappings();
      const catIds = mappings.filter(m => m.feedId === feed.id).map(m => m.categoryId);
      res.json(addDefaultImage({ ...feed, categoryIds: catIds.length > 0 ? catIds : (feed.categoryId ? [feed.categoryId] : []) }, baseUrl));
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/feeds/:id/episodes", async (req: Request, res: Response) => {
    try {
      const feedId = req.params.id;
      const feed = await storage.getFeedById(feedId);
      if (!feed || !feed.isActive) return res.status(404).json({ error: "Feed not found" });
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
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.post("/api/admin/feeds/:id/refresh", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feed = await storage.getFeedById(req.params.id);
      if (!feed) return res.status(404).json({ error: "Feed not found" });

      const fullRefresh = req.query.full === "true";
      let totalNew = 0;

      // TAT refresh
      const isTatFeedUrl = feed.rssUrl.startsWith("tat://");
      const effectiveSpeakerId = extractTatSpeakerId(feed);
      if (effectiveSpeakerId) {
        const tatResult = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveSpeakerId }, feed, { full: fullRefresh });
        totalNew += tatResult.newEpisodes;
      }

      // OU Torah platform refresh (AllDaf, AllMishnah, AllParsha, AllHalacha)
      const ouDetected = detectOUPlatform(feed as any);
      if (ouDetected) {
        const ouResult = await refreshOUFeedEpisodes(ouDetected.platform, { id: feed.id, title: feed.title, authorId: ouDetected.authorId }, feed, { full: fullRefresh });
        totalNew += ouResult.newEpisodes;
      }

      // KH refresh (KH already does its own incremental check; ?full=true is currently informational)
      const isKhFeedUrl = feed.rssUrl.startsWith("kh://");
      const effectiveKhId = extractKhRavId(feed as any);
      if (effectiveKhId) {
        const khResult = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: effectiveKhId }, feed);
        totalNew += khResult.newEpisodes;
      }

      // RSS refresh (skip for TAT-only, OU-only, and KH-only feeds)
      const isOUFeedUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
      if (!isTatFeedUrl && !isOUFeedUrl && !isKhFeedUrl) {
        // For ?full=true: bypass both etag and incremental — pull the entire
        // archive. Otherwise pass etag/lastModified so unchanged feeds short-
        // circuit at HTTP 304 without parsing, and pass the incremental
        // context so partial-change feeds early-exit during SAX walk.
        const conditionalHeaders = fullRefresh
          ? undefined
          : { etag: feed.etag, lastModified: feed.lastModifiedHeader };
        const incremental = fullRefresh
          ? undefined
          : { knownGuids: await storage.getRecentEpisodeGuids(feed.id, 50), stopAfterConsecutive: 20 };
        const parsed = await parseFeed(feed.id, feed.rssUrl, conditionalHeaders, incremental);
        if (parsed) {
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          const inserted = await storage.upsertEpisodes(feed.id, episodeData);
          totalNew += inserted.length;

          const updateData: any = {
            lastFetchedAt: new Date(),
            title: parsed.title,
            imageUrl: parsed.imageUrl || feed.imageUrl,
            description: parsed.description || feed.description,
            author: parsed.author || feed.author,
          };
          if (parsed.responseHeaders?.etag) updateData.etag = parsed.responseHeaders.etag;
          if (parsed.responseHeaders?.lastModified) updateData.lastModifiedHeader = parsed.responseHeaders.lastModified;
          await storage.updateFeed(feed.id, updateData);

          if (inserted.length > 0 && inserted.length <= PUSH_BACKFILL_THRESHOLD) {
            for (const ep of inserted.slice(0, 3)) {
              sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
            }
          }
        } else {
          // parseFeed returned null = 304 Not Modified. Just update lastFetchedAt.
          await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
        }
      }

      res.json({ newEpisodes: totalNew });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/feeds/refresh-all", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const fullBulk = req.query.full === "true";
      const allFeeds = await storage.getActiveFeeds();
      let totalNew = 0;
      for (const feed of allFeeds) {
        try {
          // TAT feed refresh
          const isTatUrl = feed.rssUrl.startsWith("tat://");
          const effectiveTatId = extractTatSpeakerId(feed);
          if (effectiveTatId) {
            const tatResult = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveTatId }, feed, { full: fullBulk });
            totalNew += tatResult.newEpisodes;
          }
          // OU Torah platform refresh (AllDaf, AllMishnah, AllParsha, AllHalacha)
          const ouRefresh = detectOUPlatform(feed as any);
          if (ouRefresh) {
            const ouResult = await refreshOUFeedEpisodes(ouRefresh.platform, { id: feed.id, title: feed.title, authorId: ouRefresh.authorId }, feed, { full: fullBulk });
            totalNew += ouResult.newEpisodes;
          }
          // KH feed refresh
          const isKhRssUrl = feed.rssUrl.startsWith("kh://");
          const bulkKhId = extractKhRavId(feed as any);
          if (bulkKhId) {
            const khResult = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: bulkKhId }, feed);
            totalNew += khResult.newEpisodes;
          }
          // RSS refresh (skip for TAT-only, OU-only, and KH-only feeds)
          const isOURssUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
          if (!feed.rssUrl.startsWith("tat://") && !isOURssUrl && !isKhRssUrl) {
            const conditionalHeadersBulk = fullBulk
              ? undefined
              : { etag: feed.etag, lastModified: feed.lastModifiedHeader };
            const incrementalBulk = fullBulk
              ? undefined
              : { knownGuids: await storage.getRecentEpisodeGuids(feed.id, 50), stopAfterConsecutive: 20 };
            const parsed = await parseFeed(feed.id, feed.rssUrl, conditionalHeadersBulk, incrementalBulk);
            if (!parsed) { await storage.updateFeed(feed.id, { lastFetchedAt: new Date() }); continue; }
            const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
            const inserted = await storage.upsertEpisodes(feed.id, episodeData);
            totalNew += inserted.length;
            const updateDataBulk: any = { lastFetchedAt: new Date() };
            if (parsed.responseHeaders?.etag) updateDataBulk.etag = parsed.responseHeaders.etag;
            if (parsed.responseHeaders?.lastModified) updateDataBulk.lastModifiedHeader = parsed.responseHeaders.lastModified;
            await storage.updateFeed(feed.id, updateDataBulk);
            if (inserted.length > 0 && inserted.length <= PUSH_BACKFILL_THRESHOLD) {
              for (const ep of inserted.slice(0, 3)) {
                sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
              }
            }
          }
        } catch (e) {
          const msg = (e as Error)?.message || String(e);
          console.log(`Failed to refresh feed ${feed.title}: ${msg.slice(0, 120)}`);
        }
      }
      res.json({ refreshed: allFeeds.length, newEpisodes: totalNew });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Episodes

  // Batch fetch episodes by IDs (used by favorites screen)
  app.post("/api/episodes/batch", async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.json([]);
      if (ids.length > 200) return res.status(400).json({ error: "Maximum 200 IDs per request" });
      const eps = await storage.getEpisodesByIds(ids);
      res.json(eps);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.post("/api/playback-positions", async (req: Request, res: Response) => {
    try {
      const { episodeId, feedId, deviceId, positionMs, durationMs, completed } = req.body;
      if (!episodeId || !deviceId) return res.status(400).json({ error: "episodeId and deviceId required" });
      const pos = await storage.syncPlaybackPosition(episodeId, feedId || "", deviceId, positionMs || 0, durationMs || 0, completed || false);
      res.json(pos);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/playback-positions/:deviceId", async (req: Request, res: Response) => {
    try {
      const positions = await storage.getPlaybackPositions(req.params.deviceId);
      res.json(positions);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/playback-positions/:deviceId/recent", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 15, 30);
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const results = await storage.getRecentlyPlayed(req.params.deviceId, limit);
      res.json(results.map((r: any) => ({
        ...r,
        feedImageUrl: r.feedImageUrl || `${baseUrl}/api/images/icon.png`,
      })));
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/queue/:deviceId", async (req: Request, res: Response) => {
    try {
      const items = await storage.getQueueForDevice(req.params.deviceId);
      res.json(items);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.put("/api/queue/:deviceId", async (req: Request, res: Response) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
      await storage.saveQueue(req.params.deviceId, items);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/episodes/trending", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const eps = await storage.getTrendingEpisodes(limit);
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json(eps);
    } catch (e: any) {
      publicError(res, e);
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
        return res.json(cached.data.map((f: any) => addDefaultImage(f, baseUrl)));
      }
      const recs = await storage.getRecommendations(deviceId, limit);
      recommendationCache.set(deviceId, { data: recs, ts: Date.now() });
      // Evict stale entries and enforce hard cap
      const now = Date.now();
      for (const [key, val] of recommendationCache) {
        if (now - val.ts > 10 * 60 * 1000) recommendationCache.delete(key);
      }
      // Hard cap: drop oldest entries if cache grows too large
      while (recommendationCache.size > 500) {
        const oldest = recommendationCache.keys().next().value;
        if (oldest) recommendationCache.delete(oldest);
        else break;
      }
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(recs.map((f: any) => addDefaultImage(f, baseUrl)));
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Analytics
  app.get("/api/admin/analytics", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const analytics = await storage.getAnalytics();
      res.json(analytics);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.get("/api/subscriptions/:deviceId/feeds", async (req: Request, res: Response) => {
    try {
      const feedList = await storage.getSubscribedFeeds(req.params.deviceId);
      res.json(feedList);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/subscriptions/:deviceId/episodes", async (req: Request, res: Response) => {
    try {
      const eps = await storage.getEpisodesForSubscribedFeeds(req.params.deviceId);
      res.json(eps);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/subscriptions", async (req: Request, res: Response) => {
    try {
      const { deviceId, feedId } = req.body;
      if (!deviceId || !feedId) return res.status(400).json({ error: "deviceId and feedId required" });
      const sub = await storage.addSubscription(deviceId, feedId);

      // Auto-activate inactive feeds so they enter the refresh cycle (no-op if already active)
      try { await storage.activateFeedIfInactive(feedId); }
      catch (e: any) { console.debug("Auto-activate on subscribe failed:", e.message); }

      res.json(sub || { ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/subscriptions/:deviceId/:feedId", async (req: Request, res: Response) => {
    try {
      await storage.removeSubscription(req.params.deviceId, req.params.feedId);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Notification Preferences (per-feed mute/unmute)
  app.get("/api/notification-preferences/:deviceId/:feedId", async (req: Request, res: Response) => {
    try {
      const pref = await storage.getNotificationPreference(req.params.deviceId, req.params.feedId);
      res.json({ muted: pref?.muted ?? false });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/notification-preferences/mute", async (req: Request, res: Response) => {
    try {
      const { deviceId, feedId } = req.body;
      if (!deviceId || !feedId) return res.status(400).json({ error: "deviceId and feedId required" });
      await storage.muteNotificationsForFeed(deviceId, feedId);
      res.json({ muted: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/notification-preferences/:deviceId/:feedId", async (req: Request, res: Response) => {
    try {
      await storage.unmuteNotificationsForFeed(req.params.deviceId, req.params.feedId);
      res.json({ muted: false });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Favorites
  app.get("/api/favorites/:deviceId", async (req: Request, res: Response) => {
    try {
      const favs = await storage.getFavorites(req.params.deviceId);
      res.json(favs);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/favorites", async (req: Request, res: Response) => {
    try {
      const { episodeId, deviceId } = req.body;
      if (!episodeId || !deviceId) return res.status(400).json({ error: "episodeId and deviceId required" });
      const fav = await storage.addFavorite(episodeId, deviceId);
      res.json(fav || { ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/favorites/:deviceId/:episodeId", async (req: Request, res: Response) => {
    try {
      await storage.removeFavorite(req.params.episodeId, req.params.deviceId);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.get("/api/positions/:deviceId", async (req: Request, res: Response) => {
    try {
      const positions = await storage.getPlaybackPositions(req.params.deviceId);
      res.json(positions);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/positions/:deviceId/:episodeId", async (req: Request, res: Response) => {
    try {
      const pos = await storage.getPlaybackPosition(req.params.episodeId, req.params.deviceId);
      res.json(pos || { positionMs: 0, durationMs: 0, completed: false });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/completed/:deviceId", async (req: Request, res: Response) => {
    try {
      const completed = await storage.getCompletedEpisodes(req.params.deviceId);
      res.json(completed);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Listening Stats
  app.get("/api/stats/:deviceId", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getListeningStats(req.params.deviceId);
      res.json(stats);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Feed Listener Count
  app.get("/api/feeds/:id/listeners", async (req: Request, res: Response) => {
    try {
      const count = await storage.getFeedListenerCount(req.params.id);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ count });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/public-stats", async (_req: Request, res: Response) => {
    try {
      // Use lightweight queries instead of full getAnalytics() which runs 8+ joins
      const [activeFeedCount, episodeCount] = await Promise.all([
        storage.getActiveFeedCount(),
        storage.getTotalEpisodeCount(),
      ]);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json({
        shiurimCount: activeFeedCount,
        episodeCount: episodeCount,
      });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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

  // General audio proxy — fallback for clients that can't connect directly (e.g. SSL cert issues on Android)
  app.get("/api/audio/proxy", async (req: Request, res: Response) => {
    try {
      const url = req.query.url as string;
      if (!url) return res.status(400).json({ error: "Missing url param" });
      // Validate URL is a proper HTTPS URL to prevent SSRF
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return res.status(400).json({ error: "Only HTTPS URLs are supported" });
        // Block internal/private/reserved IPs
        const host = parsed.hostname.toLowerCase();
        if (host === "localhost" || host.startsWith("127.") || host === "0.0.0.0" || host.startsWith("0.") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.") || host.startsWith("169.254.") || host.endsWith(".internal") || host === "[::1]" || host.startsWith("[fe") || host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[::") || host.includes("localhost") || host.includes("metadata.google") || host.includes("metadata.aws")) {
          return res.status(400).json({ error: "Invalid URL" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid URL" });
      }
      const rangeHeader = req.headers.range;
      const reqHeaders: Record<string, string> = { "User-Agent": "ShiurPod/1.0" };
      if (rangeHeader) reqHeaders["Range"] = rangeHeader;
      const audioResp = await fetch(url, { headers: reqHeaders, redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (!audioResp.ok && audioResp.status !== 206) return res.status(audioResp.status).json({ error: `Upstream ${audioResp.status}` });
      res.status(audioResp.status);
      res.setHeader("Content-Type", audioResp.headers.get("content-type") || "audio/mpeg");
      const cl = audioResp.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      const cr = audioResp.headers.get("content-range");
      if (cr) res.setHeader("Content-Range", cr);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=3600");
      const reader = audioResp.body?.getReader();
      if (!reader) return res.status(502).json({ error: "No stream" });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    } catch (e: any) {
      if (!res.headersSent) res.status(502).json({ error: e.message });
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
      publicError(res, e);
    }
  });

  // Admin: Featured toggle
  app.put("/api/admin/feeds/:id/featured", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { featured } = req.body;
      await storage.setFeedFeatured(req.params.id, featured);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Maggid Shiur (speaker) management
  app.get("/api/admin/maggid-shiurim", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const profiles = await storage.getAllMaggidShiurim();
      res.json(profiles);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Admin: TorahAnytime sync
  app.post("/api/admin/tat/sync-speakers", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const result = await syncTATSpeakers();
      res.json(result);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Toggle all TAT feeds active/inactive.
  // When enabling: run syncTATSpeakers first so any speakers whose feed
  // rows were deleted get recreated. Then set is_active=true on all
  // TAT-only feeds (so the toggle is idempotent — click to enable and
  // the full TAT catalog reappears even after the feeds were pruned).
  app.post("/api/admin/tat/toggle", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });

      let syncResult: { created: number; linked: number; total: number } | null = null;
      if (enabled) {
        // Re-sync first so missing TAT-only feeds are recreated.
        try {
          syncResult = await syncTATSpeakers();
          console.log(`TAT toggle: sync created=${syncResult.created} linked=${syncResult.linked} total=${syncResult.total}`);
        } catch (e: any) {
          console.error("TAT toggle: sync failed:", e.message);
        }
      }

      // Batch-update with a single SQL statement instead of looping
      // N feeds × one UPDATE each (which was taking minutes on ~1100 feeds).
      const updated = await storage.bulkToggleTATFeeds(enabled);
      console.log(`TAT toggle: updated ${updated} feeds to is_active=${enabled}`);
      res.json({ updated, enabled, sync: syncResult });
    } catch (e: any) {
      console.error("TAT toggle error:", e);
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.delete("/api/admin/feeds/:id/tat-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feed = await storage.updateFeed(req.params.id, { tatSpeakerId: null } as any);
      res.json(feed);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.delete("/api/admin/feeds/:id/kh-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.setKHRavId(req.params.id, null);
      const feed = await storage.getFeedById(req.params.id);
      res.json(feed);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Admin: Get ALL merge history (global view)
  app.get("/api/admin/merge-history", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const history = await storage.getAllMergeHistory();
      res.json(history);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Get KH speaker stats
  app.get("/api/admin/kh/speakers", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const speakers = await storage.getKHSpeakerStats();
      res.json(speakers);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Get source breakdown analytics
  app.get("/api/admin/analytics/sources", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const breakdown = await storage.getSourceBreakdown();
      res.json(breakdown);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Recompute KH browse visibility
  app.post("/api/admin/kh/recompute-visibility", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const updated = await storage.recomputeKHBrowseVisibility();
      res.json({ updated, message: `Recomputed KH browse visibility, ${updated} feeds changed` });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Admin: Notifications
  app.get("/api/admin/notifications", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const notifs = await storage.getAdminNotifications();
      res.json(notifs);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/notifications", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { title, message } = req.body;
      if (!title || !message) return res.status(400).json({ error: "title and message required" });
      const notif = await storage.createAdminNotification(title, message);
      res.json(notif);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/notifications/:id/send", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.markNotificationSent(req.params.id);
      res.json({ ok: true, sent: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Enhanced Analytics
  app.get("/api/admin/analytics/enhanced", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const analytics = await storage.getEnhancedAnalytics();
      res.json(analytics);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/admin/analytics/listeners", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const analytics = await storage.getListenerAnalytics();
      res.json(analytics);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Error Reports - public endpoint (no auth needed, devices send errors here)
  app.post("/api/error-reports", async (req: Request, res: Response) => {
    try {
      const { deviceId, level, message, stack, source, platform, appVersion, metadata } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });
      const report = await storage.createErrorReport({
        deviceId: deviceId || null,
        level: level || "error",
        message: (message as string).substring(0, 5000),
        stack: stack ? (stack as string).substring(0, 10000) : null,
        source: source || null,
        platform: platform || null,
        appVersion: appVersion || null,
        metadata: metadata ? (metadata as string).substring(0, 2000) : null,
      });
      trackErrorForAlert({ level: level || "error", message: message as string, source, platform, appVersion });
      res.json({ ok: true, id: report.id });
    } catch (e: any) {
      publicError(res, e);
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
          metadata: r.metadata ? (r.metadata as string).substring(0, 2000) : null,
        });
        trackErrorForAlert({ level: r.level || "error", message: r.message, source: r.source, platform: r.platform, appVersion: r.appVersion });
        results.push(report.id);
      }
      res.json({ ok: true, count: results.length });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Device Profile — client sends on every app launch
  app.post("/api/device-profile", async (req: Request, res: Response) => {
    try {
      const { deviceId, platform, osVersion, deviceModel, deviceBrand, screenWidth, screenHeight, appVersion, locale, timezone } = req.body;
      if (!deviceId) return res.status(400).json({ error: "deviceId required" });

      // Resolve IP to country/city
      const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
      let country: string | null = null;
      let city: string | null = null;

      // Use ip-api.com free tier for geo lookup (no API key needed, 45 req/min limit)
      if (clientIp && clientIp !== "127.0.0.1" && clientIp !== "::1") {
        try {
          const geoRes = await fetch(`http://ip-api.com/json/${clientIp}?fields=country,city`, { signal: AbortSignal.timeout(3000) });
          if (geoRes.ok) {
            const geo = await geoRes.json() as any;
            country = geo.country || null;
            city = geo.city || null;
          }
        } catch {}
      }

      await storage.upsertDeviceProfile({
        deviceId,
        platform: platform || null,
        osVersion: osVersion || null,
        deviceModel: deviceModel || null,
        deviceBrand: deviceBrand || null,
        screenWidth: screenWidth || null,
        screenHeight: screenHeight || null,
        appVersion: appVersion || null,
        locale: locale || null,
        timezone: timezone || null,
        country,
        city,
        ipAddress: clientIp,
      });
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Device Analytics
  app.get("/api/admin/analytics/devices", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const data = await storage.getDeviceAnalytics();
      res.json(data);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Website Analytics: record page view (public, called from landing page JS)
  const _pvRateLimit = new Map<string, number>();
  app.post("/api/analytics/pageview", async (req: Request, res: Response) => {
    try {
      const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      // Rate limit: max 10 page views per IP per minute
      const now = Date.now();
      const lastHit = _pvRateLimit.get(clientIp) || 0;
      if (now - lastHit < 6000) return res.json({ ok: true }); // silently skip
      _pvRateLimit.set(clientIp, now);
      // Clean old entries every 1000 hits
      if (_pvRateLimit.size > 1000) {
        for (const [ip, ts] of _pvRateLimit) { if (now - ts > 60000) _pvRateLimit.delete(ip); }
      }

      const ua = req.headers["user-agent"] || "";
      const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
      const isTablet = /iPad|Tablet/i.test(ua);
      const deviceType = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";

      // Geo resolve (reuse ip-api.com pattern)
      let country: string | null = null;
      let city: string | null = null;
      if (clientIp && clientIp !== "127.0.0.1" && clientIp !== "::1") {
        try {
          const geoRes = await fetch(`http://ip-api.com/json/${clientIp}?fields=country,city`, { signal: AbortSignal.timeout(2000) });
          if (geoRes.ok) { const geo = await geoRes.json() as any; country = geo.country || null; city = geo.city || null; }
        } catch {}
      }

      await storage.recordPageView({
        path: (req.body.path || "/").substring(0, 500),
        referrer: req.body.referrer ? String(req.body.referrer).substring(0, 1000) : null,
        userAgent: ua.substring(0, 500),
        ipAddress: clientIp,
        country, city, deviceType,
        sessionId: req.body.sessionId || null,
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.json({ ok: true }); // don't fail the page load
    }
  });

  // Admin: Website Analytics
  app.get("/api/admin/analytics/website", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const data = await storage.getWebsiteAnalytics();
      res.json(data);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // TEMP diagnostic: recent episode inserts. Useful for understanding catalog
  // growth — distinguishes "new content" from cap-bump archive backfill.
  app.get("/api/admin/diagnostics/recent-episodes", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const hours = Math.min(parseInt((req.query.hours as string) || "24", 10), 168);
      const limit = Math.min(parseInt((req.query.limit as string) || "100", 10), 500);
      const data = await storage.getRecentlyCreatedEpisodes(hours, limit);
      res.json(data);
    } catch (e: any) { publicError(res, e); }
  });

  // Admin: list duplicate-title feed groups for the Duplicates review page.
  app.get("/api/admin/duplicates", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const groups = await storage.getDuplicateTitleFeedGroups();
      res.json({ count: groups.length, groups });
    } catch (e: any) { publicError(res, e); }
  });

  // Admin: merge two feeds — move subs from `removeId` to `keepId`, then
  // delete `removeId`.
  app.post("/api/admin/duplicates/merge", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { keepId, removeId } = req.body || {};
      if (!keepId || !removeId) return res.status(400).json({ error: "keepId and removeId required" });
      const result = await storage.mergeFeedsKeepFirst(keepId, removeId);
      res.json(result);
    } catch (e: any) { publicError(res, e); }
  });

  // TEMP one-off backfill: fill publishedAt for OU-source episodes with null
  // published_at by batch-fetching post details from the OU API. Processes one
  // platform (alldaf/allmishnah/allparsha/allhalacha) per call. ?batch=N caps
  // how many episodes to process this call (default 500).
  app.post("/api/admin/diagnostics/backfill-ou-pubdate/:platform", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const platform = req.params.platform as keyof typeof OU_PLATFORMS;
      const cfg = OU_PLATFORMS[platform];
      if (!cfg) return res.status(400).json({ error: "Unknown platform" });
      const batchSize = Math.min(parseInt((req.query.batch as string) || "500", 10), 2000);

      const candidates = await storage.getNullPubdateOuEpisodeIds(cfg.guidPrefix, batchSize);
      if (candidates.length === 0) return res.json({ processed: 0, updated: 0, remaining: 0 });

      const dateMap = await fetchPostDetailsBatch(platform, candidates.map(c => c.postId));
      const updates: { episodeId: string; publishedAt: Date }[] = [];
      for (const c of candidates) {
        const d = dateMap.get(c.postId);
        const dateStr = d?.publishDate || d?.createdAt;
        if (dateStr) updates.push({ episodeId: c.episodeId, publishedAt: new Date(dateStr) });
      }
      const updated = await storage.setPublishedAtByEpisodeIds(updates);

      // Remaining null count for this platform (cheap query)
      const remainingRows = await storage.getNullPubdateOuEpisodeIds(cfg.guidPrefix, 1);
      res.json({
        processed: candidates.length,
        withDates: updates.length,
        updated,
        moreRemaining: remainingRows.length > 0,
      });
    } catch (e: any) { publicError(res, e); }
  });

  // TEMP one-off sweep: find RSS feeds with null published_at episodes.
  app.get("/api/admin/diagnostics/null-pubdate-feeds", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const feeds = await storage.getRssFeedsWithNullPublishedAt();
      res.json({ count: feeds.length, feeds });
    } catch (e: any) { publicError(res, e); }
  });

  // TEMP one-off backfill: re-fetch one feed's RSS source and UPDATE
  // published_at on rows where it's currently null.
  app.post("/api/admin/diagnostics/backfill-pubdate/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feed = await storage.getFeedById(req.params.id);
      if (!feed) return res.status(404).json({ error: "Feed not found" });
      // Skip non-RSS sources where we have no useful publish date.
      const isRss = !feed.rssUrl.startsWith("tat://") && !feed.rssUrl.startsWith("kh://")
        && !Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
      if (!isRss) return res.json({ updated: 0, reason: "non-RSS source" });

      // Force a fresh parse — no etag, no incremental, full archive.
      const parsed = await parseFeed(feed.id, feed.rssUrl, undefined, undefined);
      if (!parsed) return res.json({ updated: 0, reason: "parse failed" });

      const items = parsed.episodes
        .filter(e => e.publishedAt && e.guid)
        .map(e => ({ guid: e.guid as string, publishedAt: e.publishedAt as Date }));
      const updated = await storage.backfillPublishedAtFromGuids(feed.id, items);
      res.json({ updated, scanned: parsed.episodes.length, withDates: items.length });
    } catch (e: any) { publicError(res, e); }
  });

  // Admin: Paginated, searchable user list
  app.get("/api/admin/users", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === "string" ? req.query.search : "";
      const sort = (typeof req.query.sort === "string" ? req.query.sort : "lastSeen") as any;
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10) || 50, 200) : 50;
      const offset = req.query.offset ? Math.max(parseInt(req.query.offset as string, 10) || 0, 0) : 0;
      const data = await storage.listUsers({ search, sort, limit, offset });
      res.json(data);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Device Usage Stats for a specific device
  app.get("/api/admin/device/:deviceId", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const [profile, usage] = await Promise.all([
        storage.getDeviceProfile(req.params.deviceId),
        storage.getDeviceUsageStats(req.params.deviceId),
      ]);
      res.json({ profile: profile || null, usage });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Conversations — user-facing
  app.get("/api/conversations/:deviceId", async (req: Request, res: Response) => {
    try {
      const convs = await storage.getConversationsForDevice(req.params.deviceId);
      res.json(convs);
    } catch (e: any) { publicError(res, e); }
  });

  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const { deviceId, subject, message, feedbackId } = req.body;
      if (!deviceId || !subject || !message) return res.status(400).json({ error: "deviceId, subject, message required" });
      const conv = await storage.createConversation(deviceId, subject, message, feedbackId);
      res.json(conv);
    } catch (e: any) { publicError(res, e); }
  });

  app.get("/api/conversations/:deviceId/:conversationId", async (req: Request, res: Response) => {
    try {
      // Verify conversation belongs to this device
      const convs = await storage.getConversationsForDevice(req.params.deviceId);
      if (!convs.some(c => c.id === req.params.conversationId)) {
        return res.status(403).json({ error: "Not your conversation" });
      }
      const msgs = await storage.getConversationMessages(req.params.conversationId);
      await storage.markMessagesRead(req.params.conversationId, "admin");
      res.json(msgs);
    } catch (e: any) { publicError(res, e); }
  });

  app.post("/api/conversations/:conversationId/messages", async (req: Request, res: Response) => {
    try {
      const { message, deviceId } = req.body;
      if (!message || !deviceId) return res.status(400).json({ error: "message and deviceId required" });
      // Verify conversation belongs to this device
      const convs = await storage.getConversationsForDevice(deviceId);
      if (!convs.some(c => c.id === req.params.conversationId)) {
        return res.status(403).json({ error: "Not your conversation" });
      }
      // Force sender to "user" — only admin endpoint can send as admin
      const msg = await storage.addMessage(req.params.conversationId, "user", message);
      res.json(msg);
    } catch (e: any) { publicError(res, e); }
  });

  // Admin: Conversations
  app.get("/api/admin/conversations", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const status = req.query.status as string || undefined;
      const data = await storage.getAdminConversations({ page, limit, status });
      res.json(data);
    } catch (e: any) { publicError(res, e); }
  });

  // Fast lookup: find conversation by feedbackId (avoids loading all conversations)
  app.get("/api/admin/conversations/by-feedback/:feedbackId", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const conv = await storage.getConversationByFeedbackId(req.params.feedbackId);
      res.json(conv || null);
    } catch (e: any) { publicError(res, e); }
  });

  app.get("/api/admin/conversations/:id/messages", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const msgs = await storage.getConversationMessages(req.params.id);
      await storage.markMessagesRead(req.params.id, "user");
      res.json(msgs);
    } catch (e: any) { publicError(res, e); }
  });

  app.post("/api/admin/conversations/:id/reply", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });
      const msg = await storage.addMessage(req.params.id, "admin", message);

      // Send push notification to alert user (direct lookup, not N+1)
      try {
        const conv = await storage.getConversationById(req.params.id);
        if (!conv?.deviceId) {
          console.warn(`Reply push: conversation ${req.params.id} has no deviceId — cannot notify`);
        } else {
          const result = await sendCustomPush(
            "ShiurPod Team",
            message.substring(0, 100),
            conv.deviceId,
            { screen: "messages", conversationId: req.params.id },
          );
          console.log(`Reply push to ${conv.deviceId}: sent=${result.sent} failed=${result.failed} — ${result.details.slice(0, 3).join(" | ")}`);
        }
      } catch (e: any) { console.error(`Push on reply FAILED for conv ${req.params.id}:`, e.message); }

      res.json(msg);
    } catch (e: any) { publicError(res, e); }
  });

  app.put("/api/admin/conversations/:id/close", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.closeConversation(req.params.id);
      res.json({ ok: true });
    } catch (e: any) { publicError(res, e); }
  });

  // Admin: Error Health Dashboard
  app.get("/api/admin/error-health", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const health = await storage.getErrorHealth();
      res.json(health);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Error Reports
  app.get("/api/admin/error-reports", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const level = req.query.level as string || undefined;
      const resolved = req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined;
      const source = req.query.source as string || undefined;
      const search = req.query.search as string || undefined;
      const reports = await storage.getErrorReports({ page, limit, level, resolved, source, search });
      res.json(reports);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Grouped Error Reports (by message)
  app.get("/api/admin/error-reports/grouped", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const data = await storage.getGroupedErrorReports(limit);
      res.json(data);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Occurrences of a specific grouped error
  app.get("/api/admin/error-reports/grouped/:messageHash/occurrences", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const data = await storage.getErrorOccurrences(req.params.messageHash, limit);
      res.json(data);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.put("/api/admin/error-reports/:id/resolve", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const report = await storage.resolveErrorReport(req.params.id);
      res.json(report);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/admin/error-reports/resolved", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const count = await storage.deleteResolvedErrorReports();
      res.json({ ok: true, deleted: count });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Resolve an entire error group (all errors matching the same messageHash).
  // Use after shipping a fix — new occurrences (still unresolved) will surface
  // immediately if the fix didn't actually work.
  app.put("/api/admin/error-reports/grouped/:messageHash/resolve", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const count = await storage.resolveErrorGroup(req.params.messageHash);
      res.json({ ok: true, resolved: count });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Reopen a previously resolved group.
  app.put("/api/admin/error-reports/grouped/:messageHash/reopen", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const count = await storage.reopenErrorGroup(req.params.messageHash);
      res.json({ ok: true, reopened: count });
    } catch (e: any) {
      publicError(res, e);
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

      // Auto-create a conversation so the feedback appears in the user's message center
      if (deviceId) {
        try {
          await storage.createConversation(
            deviceId,
            (subject as string).substring(0, 200),
            (message as string).substring(0, 5000),
            fb.id,
          );
        } catch (e: any) { console.error("Auto-create conversation for feedback failed:", e.message); }
      }

      // Email notification with full dashboard info
      try {
        const profile = deviceId ? await storage.getDeviceProfile(deviceId) : null;
        sendFeedbackNotification({
          type: type || "shiur_request",
          subject: subject as string,
          message: message as string,
          contactInfo: contactInfo as string || null,
          deviceId: deviceId || null,
          deviceModel: profile?.deviceModel || null,
          deviceBrand: profile?.deviceBrand || null,
          platform: profile?.platform || null,
          osVersion: profile?.osVersion || null,
          appVersion: profile?.appVersion || null,
          country: profile?.country || null,
          city: profile?.city || null,
          deviceLogs: logsStr,
        });
      } catch {}

      res.json({ ok: true, id: fb.id });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.put("/api/admin/feedback/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { status, adminNotes } = req.body;
      const fb = await storage.updateFeedbackStatus(req.params.id, status, adminNotes);
      res.json(fb);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/admin/feedback/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteFeedback(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.delete("/api/push-token", async (req: Request, res: Response) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: "token required" });
      await storage.removePushToken(token);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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

      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const safeTitle = esc(episode.title || "");
      const safeFeedTitle = esc(feed?.title || "");
      const safeImgUrl = esc(episode.imageUrl || feed?.imageUrl || "");
      const safeAudioUrl = esc(episode.audioUrl || "");

      res.send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle} - ShiurPod</title>
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeFeedTitle}${timestamp > 0 ? ' - at ' + Math.floor(timestamp / 60000) + ':' + String(Math.floor((timestamp % 60000) / 1000)).padStart(2, '0') : ''}">
  <meta property="og:image" content="${safeImgUrl}">
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
    <img class="artwork" src="${safeImgUrl}" alt="">
    <h1>${safeTitle}</h1>
    <p class="feed">${safeFeedTitle}</p>
    <a class="btn" href="shiurpod://episode/${esc(episode.id)}${timestamp > 0 ? '?t=' + timestamp : ''}">Open in ShiurPod</a>
    <div class="audio-wrap">
      <audio controls preload="none" src="${safeAudioUrl}"></audio>
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
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Admin: delete contact message
  app.delete("/api/admin/contact-messages/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteContactMessage(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Public: get active APK info
  app.get("/api/apk/latest", async (_req: Request, res: Response) => {
    try {
      const apk = await storage.getActiveApk();
      if (!apk) return res.json({ available: false });
      res.json({ available: true, version: apk.version, fileSize: apk.fileSize, uploadedAt: apk.createdAt });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Admin: list all APKs
  app.get("/api/admin/apk", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const apks = await storage.getAllApkUploads();
      res.json(apks);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: set active APK
  app.put("/api/admin/apk/:id/activate", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.setActiveApk(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: delete APK
  app.delete("/api/admin/apk/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteApkUpload(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Public: get active sponsor
  app.get("/api/sponsor", async (_req: Request, res: Response) => {
    try {
      const sponsor = await storage.getActiveSponsor();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(sponsor || null);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: list all sponsors
  app.get("/api/admin/sponsors", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const allSponsors = await storage.getAllSponsors();
      res.json(allSponsors);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  // Admin: update sponsor
  app.put("/api/admin/sponsors/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const sponsor = await storage.updateSponsor(req.params.id, req.body);
      res.json(sponsor);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: delete sponsor
  app.delete("/api/admin/sponsors/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteSponsor(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/admin/push-tokens", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const tokens = await storage.getAllPushTokens();
      res.json(tokens);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/admin/push-health", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getPushHealthStats();
      res.json(stats);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Push-related error logs (filtered from error_reports)
  app.get("/api/admin/push-errors", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const reports = await storage.getErrorReports({ page: 1, limit: 50, source: "push", resolved: false });
      res.json(reports);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/admin/push-tokens/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.removePushTokenById(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/send-push", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { title, body, deviceId, data } = req.body;
      if (!title || !body) {
        res.status(400).json({ error: "Title and body are required" });
        return;
      }
      const result = await sendCustomPush(title, body, deviceId || undefined, data || undefined);
      res.json(result);
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.get("/api/admin/feed-vitals", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const vitals = getVitals();
      res.json(vitals);
    } catch (e: any) {
      publicError(res, e);
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

      // Auto-activate feed when admin force-syncs it
      if (!feed.isActive) {
        await storage.activateFeedIfInactive(feedId);
      }

      const start = Date.now();
      try {
        // Handle TAT feeds
        const isForceTatUrl = feed.rssUrl.startsWith("tat://");
        const forceTatId = extractTatSpeakerId(feed);
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
        const forceKhId = extractKhRavId(feed as any);
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
        res.status(502).json({ status: "error", error: syncErr.message?.slice(0, 200), durationMs: Date.now() - start });
      }
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Announcements (public)
  app.get("/api/announcements/:deviceId", async (req: Request, res: Response) => {
    try {
      const anns = await storage.getAnnouncementsForDevice(req.params.deviceId);
      res.json(anns);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/announcements/:id/dismiss", async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.body;
      if (!deviceId) return res.status(400).json({ error: "deviceId required" });
      await storage.dismissAnnouncement(req.params.id, deviceId);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Announcements (admin)
  app.get("/api/admin/announcements", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const anns = await storage.getAllAnnouncements();
      const dismissCounts = await storage.getAnnouncementDismissCounts(anns.map(a => a.id));
      const result = anns.map(ann => ({ ...ann, dismissCount: dismissCounts.get(ann.id) || 0 }));
      res.json(result);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/announcements", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const ann = await storage.createAnnouncement(req.body);
      res.json(ann);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.put("/api/admin/announcements/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const ann = await storage.updateAnnouncement(req.params.id, req.body);
      res.json(ann);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/admin/announcements/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteAnnouncement(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
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
      publicError(res, e);
    }
  });

  app.get("/api/admin/notification-taps", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const stats = await storage.getNotificationTapStats(days);
      res.json(stats);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Public: get all config as flat JSON
  app.get("/api/config", async (_req: Request, res: Response) => {
    try {
      const config = await storage.getAllConfig();
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(config);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
