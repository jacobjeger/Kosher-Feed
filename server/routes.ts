import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as storage from "./storage";
import { parseFeed } from "./rss";
import { sendNewEpisodePushes, sendCustomPush, checkPushReceipts, PUSH_BACKFILL_THRESHOLD } from "./push";
import { getVitals, recordFeedResult } from "./feed-vitals";
import { insertFeedSchema, insertCategorySchema, feedMergeHistory } from "@shared/schema";
import type { Feed } from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { syncTATSpeakers, refreshTATFeedEpisodes, fetchAllSpeakers } from "./torahanytime";
import { detectOUPlatform, refreshOUFeedEpisodes, syncOUPlatformAuthors, OU_PLATFORMS, fetchPostDetailsBatch, type OUPlatformKey } from "./alldaf";
import { syncKHSpeakers, refreshKHFeedEpisodes, reloadKHClient, getHeaders as getKHHeaders } from "./kolhalashon";
import { syncTorahDownloadsSpeakers, refreshTorahDownloadsFeedEpisodes, fetchShiurUploadDate, fetchShiurUploadDateDebug } from "./torahdownloads";
import { extractKhRavId, extractTatSpeakerId, extractTorahDownloadsSpeakerId } from "./feed-utils";
import {
  refreshYouTubeFeedEpisodes,
  ingestYouTubePlaylist,
  extractYouTubePlaylistId,
  resolvePlaylistInput,
  fetchPlaylistMeta,
} from "./youtube";
import { resolveAudioStream, invalidateAudioCache, audioCacheStats, YT_VIDEO_ID_RE } from "./youtube-audio";
import { mediaPathFor, mediaUsage, mediaToolingStatus, deleteYouTubeAudio } from "./youtube-media";
import { nudgeYouTubeMediaWorker } from "./youtube-worker";
import { getClientIp } from "./client-ip";
import { evaluateRules, rulesForFeed, describeRule, isValidRulePattern } from "./youtube-rules";
import {
  search as runSearch,
  buildQuery as buildSearchQuery,
  searchEpisodesRanked,
  searchFeedsRanked,
  type SearchType,
} from "./search";
import fsp from "node:fs/promises";
import { trackErrorForAlert, sendFeedbackNotification } from "./error-alerts";
import { registerV1Routes } from "./routes-v1";
import { registerContributorRoutes } from "./contributor-routes";
import { isCustomSchemeUrl, contributorFeedUrl, CONTRIBUTOR_SCHEME } from "./feed-schemes";
import { putObject, headObject, publicUrl, isR2Configured } from "./r2";
import * as iss from "./issues-storage";
import { imageResizeHandler } from "./image-resize";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

// Strip server-internal fields from a Feed before returning it from a
// LIST endpoint. Cuts /api/feeds payload from ~697KB to ~470KB and
// /api/feeds/maggid-shiur (which nests Feeds inside each maggid group)
// from ~718KB.
//
// KEPT (client reads these from the list payload):
//   - sourceNetwork: rendered as a network badge in EpisodeItem,
//     player.tsx, and podcast/[id].tsx (also used by addDefaultImage).
//   - lastFetchedAt: podcast/[id].tsx uses it from feedsQuery.data when
//     present to decide whether to auto-refresh the episode list.
//
// STRIPPED (server-internal, client never reads):
//   rssUrl, etag, lastModifiedHeader, createdAt, scheduledPublishAt,
//   and 7 third-party speaker IDs (tatSpeakerId, alldafAuthorId,
//   allmishnahAuthorId, allparshaAuthorId, allhalachaAuthorId,
//   kolhalashonRavId, torahdownloadsSpeakerId).
//
// Single-feed routes (/api/feeds/:id) keep the full shape for admin /
// detail surfaces.
//
// Call AFTER addDefaultImage() — addDefaultImage reads sourceNetwork.
function slimFeedForList(feed: any): any {
  const {
    rssUrl: _rssUrl,
    etag: _etag,
    lastModifiedHeader: _lastModifiedHeader,
    createdAt: _createdAt,
    scheduledPublishAt: _scheduledPublishAt,
    tatSpeakerId: _tatSpeakerId,
    alldafAuthorId: _alldafAuthorId,
    allmishnahAuthorId: _allmishnahAuthorId,
    allparshaAuthorId: _allparshaAuthorId,
    allhalachaAuthorId: _allhalachaAuthorId,
    kolhalashonRavId: _kolhalashonRavId,
    torahdownloadsSpeakerId: _torahdownloadsSpeakerId,
    ...slim
  } = feed;
  return slim;
}

// Resolve KH audio URLs through the proxy worker
// --- Search: FTS with a safe fallback to the old ILIKE path ---------------
//
// The new implementation is only used once the corpus is actually folded and
// indexed. Until then (and if anything goes wrong) these fall back to the
// original storage functions, so search degrades to "as it was" rather than
// breaking. Readiness is cached because it's checked on every search.
let _ftsReady: boolean | null = null;
let _ftsCheckedAt = 0;
const FTS_CHECK_TTL = 60_000;

async function ftsReady(): Promise<boolean> {
  if (_ftsReady !== null && Date.now() - _ftsCheckedAt < FTS_CHECK_TTL) return _ftsReady;
  try {
    const r: any = await db.execute(sql`
      SELECT (SELECT count(*) FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
               WHERE c.relname = 'episodes_search_gin' AND i.indisvalid) AS idx,
             (SELECT count(*) FROM episodes WHERE search_tsv IS NULL LIMIT 1) AS unfolded
    `);
    const row = r.rows?.[0];
    _ftsReady = Number(row?.idx || 0) > 0 && Number(row?.unfolded || 0) === 0;
  } catch {
    _ftsReady = false;
  }
  _ftsCheckedAt = Date.now();
  return _ftsReady;
}

async function searchEpisodesCompat(q: string, limit: number): Promise<any[]> {
  if (await ftsReady()) {
    try {
      const built = await buildSearchQuery(q, true);
      const r = await searchEpisodesRanked(built, limit);
      // Old shape: a bare array of episode rows. Extra keys are additive and
      // safe for existing clients, which read by property name.
      return r.items.map(e => ({
        id: e.id, feedId: e.feedId, title: e.title, description: e.description,
        audioUrl: e.audioUrl, duration: e.duration, publishedAt: e.publishedAt,
        imageUrl: e.imageUrl, feedTitle: e.feedTitle, feedAuthor: e.feedAuthor,
        feedImageUrl: e.feedImageUrl,
      }));
    } catch (e: any) {
      console.error(`FTS episode search failed, falling back: ${e.message?.slice(0, 120)}`);
    }
  }
  return storage.searchEpisodes(q, limit);
}

async function searchFeedsCompat(q: string, limit: number): Promise<any[]> {
  if (await ftsReady()) {
    try {
      const built = await buildSearchQuery(q, true);
      const r = await searchFeedsRanked(built, limit);
      if (r.items.length > 0) {
        const ids = r.items.map(i => i.id);
        const full = await storage.getFeedsByIds(ids);
        const order = new Map(ids.map((id, i) => [id, i]));
        return full.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      }
      return [];
    } catch (e: any) {
      console.error(`FTS feed search failed, falling back: ${e.message?.slice(0, 120)}`);
    }
  }
  return storage.searchFeeds(q, limit);
}

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

    // TorahDownloads feed
    const isTdUrl = feed.rssUrl.startsWith("td://");
    const onDemandTdId = extractTorahDownloadsSpeakerId(feed as any);
    if (onDemandTdId) {
      await refreshTorahDownloadsFeedEpisodes({ id: feed.id, title: feed.title, torahdownloadsSpeakerId: onDemandTdId }, feed);
      if (!isTdUrl) {
        const parsed = await parseFeed(feed.id, feed.rssUrl);
        if (parsed) {
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          await storage.upsertEpisodes(feed.id, episodeData);
        }
      }
      return;
    }

    // YouTube feeds are deliberately NOT refreshed on demand. A crawl costs API
    // quota and can't change anything the user sees — new videos land in the
    // review queue, not in the feed. Ingest happens on the 6h cron and via the
    // admin sync button only.
    const isYtUrl = feed.rssUrl.startsWith("yt://");

    // Regular RSS feed (skip TAT/OU/KH/TD/YT-only URLs)
    const isOUUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
    if (!feed.rssUrl || isOnDemandTatUrl || isOUUrl || isKhUrl || isTdUrl || isYtUrl || isCustomSchemeUrl(feed.rssUrl)) return;
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
          sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id, publishedAt: (ep as any).publishedAt }, feed.title).catch(() => {});
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

  // On-demand image resize proxy. See server/image-resize.ts for the SSRF
  // protection and Cloudflare-edge-cache design. Must come BEFORE the
  // /api/images/:name static-asset handler so /api/images/resize doesn't
  // get matched as `name=resize`.
  app.get("/api/images/resize", imageResizeHandler as any);

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
        const withImage = addDefaultImage({ ...f, categoryIds: catIds.length > 0 ? catIds : (f.categoryId ? [f.categoryId] : []) }, baseUrl);
        return slimFeedForList(withImage);
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
      res.json(featured.map(slimFeedForList));
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
      // Response shape is unchanged (a bare array) — installed app builds
      // consume it directly, so this must never become an object.
      const results = await searchFeedsCompat(q, limit);
      const mappings = await storage.getAllFeedCategoryMappings();
      const enriched = results.map(f => {
        const catIds = mappings.filter(m => m.feedId === f.id).map(m => m.categoryId);
        return slimFeedForList(addDefaultImage({ ...f, categoryIds: catIds.length > 0 ? catIds : (f.categoryId ? [f.categoryId] : []) }, baseUrl));
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
      res.json(Array.from(allFeedsMap.values()).map(f => slimFeedForList(addDefaultImage(f, baseUrl))));
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
        feeds: g.feeds.map((f: any) => slimFeedForList(addDefaultImage(f, baseUrl))),
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
      const search = (req.query.search as string) || undefined;
      const eps = await storage.getEpisodesByFeedPaginated(feedId, page, limit, sort, search);
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
        const totalCount = await storage.getEpisodeCountByFeed(req.params.id, search);
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

      // TorahDownloads refresh
      const isTdFeedUrl = feed.rssUrl.startsWith("td://");
      const effectiveTdId = extractTorahDownloadsSpeakerId(feed as any);
      if (effectiveTdId) {
        const tdResult = await refreshTorahDownloadsFeedEpisodes({ id: feed.id, title: feed.title, torahdownloadsSpeakerId: effectiveTdId }, feed, { full: fullRefresh });
        totalNew += tdResult.newEpisodes;
      }

      // YouTube refresh — queues for review, so it contributes no new episodes.
      const isYtFeedUrl = feed.rssUrl.startsWith("yt://");
      const effectiveYtId = extractYouTubePlaylistId(feed as any);
      let ytQueued = 0;
      if (effectiveYtId) {
        const ytResult = await refreshYouTubeFeedEpisodes(
          { id: feed.id, title: feed.title, youtubePlaylistId: effectiveYtId },
          feed,
          { full: fullRefresh },
        );
        ytQueued = ytResult.queued;
      }

      // RSS refresh (skip for TAT-only, OU-only, KH-only, TD-only, YT-only feeds)
      const isOUFeedUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
      if (!isTatFeedUrl && !isOUFeedUrl && !isKhFeedUrl && !isTdFeedUrl && !isYtFeedUrl && !isCustomSchemeUrl(feed.rssUrl)) {
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
              sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id, publishedAt: (ep as any).publishedAt }, feed.title).catch(() => {});
            }
          }
        } else {
          // parseFeed returned null = 304 Not Modified. Just update lastFetchedAt.
          await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
        }
      }

      res.json({ newEpisodes: totalNew, youtubeQueued: ytQueued });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/feeds/refresh-all", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const fullBulk = req.query.full === "true";
      const allFeeds = await storage.getActiveFeeds();
      let totalNew = 0;
      let totalYtQueued = 0;
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
          // TorahDownloads feed refresh
          const isTdRssUrl = feed.rssUrl.startsWith("td://");
          const bulkTdId = extractTorahDownloadsSpeakerId(feed as any);
          if (bulkTdId) {
            const tdResult = await refreshTorahDownloadsFeedEpisodes({ id: feed.id, title: feed.title, torahdownloadsSpeakerId: bulkTdId }, feed, { full: fullBulk });
            totalNew += tdResult.newEpisodes;
          }
          // YouTube feed refresh — queues for review, adds no episodes.
          const isYtRssUrl = feed.rssUrl.startsWith("yt://");
          const bulkYtId = extractYouTubePlaylistId(feed as any);
          if (bulkYtId) {
            const ytResult = await refreshYouTubeFeedEpisodes(
              { id: feed.id, title: feed.title, youtubePlaylistId: bulkYtId },
              feed,
              { full: fullBulk },
            );
            totalYtQueued += ytResult.queued;
          }
          // RSS refresh (skip for TAT-only, OU-only, KH-only, TD-only, YT-only feeds)
          const isOURssUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
          if (!feed.rssUrl.startsWith("tat://") && !isOURssUrl && !isKhRssUrl && !isTdRssUrl && !isYtRssUrl && !isCustomSchemeUrl(feed.rssUrl)) {
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
                sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id, publishedAt: (ep as any).publishedAt }, feed.title).catch(() => {});
              }
            }
          }
        } catch (e) {
          const msg = (e as Error)?.message || String(e);
          console.log(`Failed to refresh feed ${feed.title}: ${msg.slice(0, 120)}`);
        }
      }
      res.json({ refreshed: allFeeds.length, newEpisodes: totalNew, youtubeQueued: totalYtQueued });
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
      // limit was previously uncapped here — an unbounded parseInt straight
      // into a LIMIT is a trivial way to make the server do arbitrary work.
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      if (!q || q.trim().length < 2) return res.json([]);
      const eps = await searchEpisodesCompat(q.trim(), limit);
      res.json(eps);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Unified typed search: episodes, feeds, speakers and categories in one
  // round trip, each ranked. Replaces the app making two calls plus filtering
  // the full in-memory feed list client-side.
  app.get("/api/search", async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) {
        return res.json({
          query: q, queryFold: "",
          episodes: { items: [], hasMore: false },
          feeds: { items: [], hasMore: false },
          speakers: { items: [], hasMore: false },
          categories: [], tookMs: 0, impl: "fts",
        });
      }
      if (!(await ftsReady())) {
        return res.status(503).json({ error: "Search index not ready", impl: "ilike" });
      }
      const types = String(req.query.types || "")
        .split(",").map(s => s.trim()).filter(Boolean) as SearchType[];
      // allowPrefix=false for a submitted query; true for as-you-type, where a
      // trailing prefix wildcard makes partial words match.
      const allowPrefix = req.query.prefix !== "false";
      const result = await runSearch({
        q,
        types: types.length ? types : undefined,
        limit: Math.min(parseInt(req.query.limit as string) || 20, 100),
        feedId: (req.query.feedId as string) || undefined,
        allowPrefix,
      });
      res.setHeader("Cache-Control", "public, max-age=30");
      res.setHeader("X-Search-Impl", result.impl);
      res.setHeader("X-Search-Fold", encodeURIComponent(result.queryFold));
      res.json(result);
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

      // Stored YouTube audio lives on our own disk and is recorded as a
      // server-relative path, which fetch() can't take. Stream it straight from
      // the volume instead of round-tripping through HTTP to ourselves.
      const storedMatch = episode.audioUrl.match(/^\/api\/media\/yt\/([A-Za-z0-9_-]{11})\.mp3$/);
      if (storedMatch) {
        const filePath = mediaPathFor(storedMatch[1]);
        try {
          const st = await fsp.stat(filePath);
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Content-Length", String(st.size));
          await pipeline(fs.createReadStream(filePath), res).catch(() => {});
        } catch {
          if (!res.headersSent) res.status(404).json({ error: "Media not found" });
        }
        return;
      }

      // YouTube episodes carry the yt://audio/{videoId} placeholder rather than
      // a fetchable URL — mint a fresh stream URL before downloading, or fetch()
      // would throw on the unsupported protocol.
      let fetchUrl: string;
      let fetchHeaders: Record<string, string>;
      const ytMatch = episode.audioUrl.match(/^yt:\/\/audio\/([A-Za-z0-9_-]{11})$/);
      if (ytMatch) {
        try {
          const ytAudio = await resolveAudioStream(ytMatch[1]);
          fetchUrl = ytAudio.url;
          fetchHeaders = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" };
        } catch (e: any) {
          return res.status(502).json({ error: "Could not resolve YouTube audio" });
        }
      } else {
        const resolved = resolveKHAudioUrl(episode.audioUrl);
        fetchUrl = resolved.url;
        fetchHeaders = resolved.headers;
      }

      const audioResp = await fetch(fetchUrl, {
        headers: fetchHeaders,
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

  // Stored YouTube audio. Approved videos are fetched once and transcoded to
  // mono MP3 on our own disk, so playback is a plain static file — no YouTube
  // request, no signed URLs, no throttling. This is the path real episodes use.
  app.get("/api/media/yt/:file", async (req: Request, res: Response) => {
    try {
      const file = String(req.params.file || "");
      const m = file.match(/^([A-Za-z0-9_-]{11})\.mp3$/);
      if (!m) return res.status(400).json({ error: "Invalid media file" });
      const filePath = mediaPathFor(m[1]);

      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        return res.status(404).json({ error: "Media not found" });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Accept-Ranges", "bytes");
      // Immutable: the file for a given video id never changes once written.
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");

      const range = req.headers.range;
      if (range) {
        const rm = /bytes=(\d*)-(\d*)/.exec(String(range));
        if (rm) {
          const start = rm[1] ? parseInt(rm[1], 10) : 0;
          const end = rm[2] ? parseInt(rm[2], 10) : stat.size - 1;
          if (Number.isNaN(start) || start >= stat.size || start > end) {
            res.setHeader("Content-Range", `bytes */${stat.size}`);
            return res.status(416).end();
          }
          const safeEnd = Math.min(end, stat.size - 1);
          res.status(206);
          res.setHeader("Content-Range", `bytes ${start}-${safeEnd}/${stat.size}`);
          res.setHeader("Content-Length", String(safeEnd - start + 1));
          await pipeline(fs.createReadStream(filePath, { start, end: safeEnd }), res).catch(() => {});
          return;
        }
      }

      res.setHeader("Content-Length", String(stat.size));
      await pipeline(fs.createReadStream(filePath), res).catch(() => {});
    } catch (e: any) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // YouTube audio proxy — resolves an audio-only stream for the video and pipes
  // it back to the client.
  //
  // LEGACY: episodes no longer use this. YouTube throttles repeated reads of a
  // stream so aggressively that live proxying fails within seconds of playback
  // starting, which is why approved videos are downloaded to MP3 instead. Kept
  // only so any episode row written before that change still resolves.
  //
  // Episodes store yt://audio/{videoId} rather than a real URL: googlevideo
  // links are signed and expire in ~6h, so they have to be minted per playback.
  // The bytes are proxied (not 302'd) because the signed URL is tied to the
  // requesting client, and because the app must never be pointed at a
  // youtube.com-family host directly.
  app.get("/api/audio/yt/:videoId", async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId || "");
    if (!YT_VIDEO_ID_RE.test(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const rangeHeader = req.headers.range;

    // One retry: a signed URL can go stale before its advertised expiry, which
    // shows up as a 403 from googlevideo. Drop the cache entry and re-resolve.
    for (let attempt = 0; attempt < 2; attempt++) {
      let resolved;
      try {
        resolved = await resolveAudioStream(videoId);
      } catch (e: any) {
        console.error(`YouTube audio: resolve failed for ${videoId} — ${e.message?.slice(0, 200)}`);
        if (!res.headersSent) res.status(502).json({ error: "Could not resolve YouTube audio" });
        return;
      }

      try {
        const reqHeaders: Record<string, string> = {
          // googlevideo is content-negotiation sensitive; a browser-ish UA is
          // the most reliably served combination.
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          Accept: "*/*",
        };
        if (rangeHeader) reqHeaders["Range"] = rangeHeader;

        const upstream = await fetch(resolved.url, {
          headers: reqHeaders,
          redirect: "follow",
          signal: AbortSignal.timeout(30000),
        });

        if (upstream.status === 403 || upstream.status === 410) {
          invalidateAudioCache(videoId);
          if (attempt === 0) {
            console.log(`YouTube audio: ${videoId} got ${upstream.status}, re-resolving`);
            continue;
          }
          if (!res.headersSent) res.status(502).json({ error: "YouTube stream expired" });
          return;
        }

        if (!upstream.ok && upstream.status !== 206) {
          if (!res.headersSent) res.status(502).json({ error: `Upstream ${upstream.status}` });
          return;
        }

        res.status(upstream.status);
        // Strip codec parameters — some Android players reject the full
        // 'audio/mp4; codecs="mp4a.40.2"' form.
        const upstreamType = upstream.headers.get("content-type") || resolved.mimeType;
        res.setHeader("Content-Type", (upstreamType.split(";")[0] || "audio/mp4").trim());
        const cl = upstream.headers.get("content-length");
        if (cl) res.setHeader("Content-Length", cl);
        const cr = upstream.headers.get("content-range");
        if (cr) res.setHeader("Content-Range", cr);
        res.setHeader("Accept-Ranges", "bytes");
        // Short TTL: the proxy path is stable but the audio behind it is not,
        // and these responses are large enough that long caching hurts.
        res.setHeader("Cache-Control", "public, max-age=3600");

        if (!upstream.body) {
          if (!res.headersSent) res.status(502).json({ error: "No stream" });
          return;
        }
        // pipeline() honours backpressure: it stops pulling from googlevideo
        // whenever the phone's socket is full. A manual read/write loop would
        // buffer the entire track in server memory when the client is slower
        // than the upstream — which, for a 60MB shiur over cellular, is
        // always. It also tears the upstream down if the listener skips or
        // closes the app mid-track.
        await pipeline(Readable.fromWeb(upstream.body as any), res);
        return;
      } catch (e: any) {
        // A listener skipping tracks, seeking, or backgrounding the app aborts
        // the response mid-flight. That's routine, not a failure — don't log it
        // as an error and don't evict a perfectly good cached URL over it.
        const aborted = e?.code === "ERR_STREAM_PREMATURE_CLOSE"
          || e?.code === "ECONNRESET"
          || e?.code === "ERR_STREAM_DESTROYED"
          || res.destroyed;
        if (aborted) return;

        console.error(`YouTube audio: stream failed for ${videoId} — ${e.message?.slice(0, 160)}`);
        invalidateAudioCache(videoId);
        // Once bytes are on the wire we can't start over — a second attempt
        // would append a duplicate copy of the audio to a half-sent response.
        // Kill the connection and let the client re-request instead.
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (attempt === 1) {
          res.status(502).json({ error: "Failed to stream YouTube audio" });
          return;
        }
      }
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

  // ---- Admin: YouTube ----
  //
  // YouTube is the only source with a human gate. Ingest fills a review queue
  // and nothing becomes an episode (or reaches the app) until it's approved
  // here. New YouTube feeds are created with showInBrowse=false and only
  // surface once their first video is approved.

  const adminUsername = (req: Request): string | undefined => {
    try {
      const header = req.headers.authorization || "";
      if (!header.startsWith("Basic ")) return undefined;
      return Buffer.from(header.slice(6), "base64").toString().split(":")[0] || undefined;
    } catch {
      return undefined;
    }
  };

  // Add a YouTube playlist as a feed. Accepts a playlist URL/ID, a channel
  // URL/ID, or an @handle (a channel resolves to its uploads playlist).
  app.post("/api/admin/youtube/feeds", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { url, categoryId, categoryIds, title: titleOverride } = req.body;
      if (!url) return res.status(400).json({ error: "url is required" });

      let playlistId: string | null;
      try {
        playlistId = await resolvePlaylistInput(String(url));
      } catch (e: any) {
        return res.status(400).json({ error: e.message });
      }
      if (!playlistId) {
        return res.status(400).json({ error: "Could not find a YouTube playlist or channel in that URL" });
      }

      const rssUrl = `yt://playlist/${playlistId}`;
      const existing = await storage.getFeedByRssUrl(rssUrl);
      if (existing) {
        return res.status(409).json({ error: "That playlist is already added", feed: existing });
      }

      let meta;
      try {
        meta = await fetchPlaylistMeta(playlistId);
      } catch (e: any) {
        return res.status(400).json({ error: e.message });
      }
      if (!meta) return res.status(404).json({ error: "Playlist not found or is private" });

      const effectiveCategoryId = categoryId || (categoryIds && categoryIds.length > 0 ? categoryIds[0] : null);
      const feed = await storage.createFeed({
        title: titleOverride || meta.title,
        rssUrl,
        imageUrl: meta.imageUrl || null,
        description: meta.description || null,
        author: meta.channelTitle || null,
        categoryId: effectiveCategoryId,
        sourceNetwork: "YouTube",
        youtubePlaylistId: playlistId,
        // Stays hidden until something is approved — otherwise an empty feed
        // shows up in Browse the moment it's added.
        showInBrowse: false,
      } as any);

      if (!(feed as any).youtubePlaylistId) {
        await storage.setYouTubePlaylistId(feed.id, playlistId);
      }

      const effectiveCategoryIds = (Array.isArray(categoryIds) && categoryIds.length > 0)
        ? categoryIds
        : (categoryId ? [categoryId] : []);
      if (effectiveCategoryIds.length > 0) {
        await storage.setFeedCategories(feed.id, effectiveCategoryIds);
      }

      // First crawl pulls the whole archive into the review queue.
      let ingest = { queued: 0, skippedKnown: 0, skippedLive: 0, totalInPlaylist: meta.itemCount, shortCircuited: false };
      try {
        ingest = await ingestYouTubePlaylist(
          { id: feed.id, title: feed.title, youtubePlaylistId: playlistId },
          { full: true },
        );
      } catch (e: any) {
        return res.json({ feed, ingest, warning: `Feed created but ingest failed: ${e.message}` });
      }

      res.json({ feed, ingest });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // List YouTube feeds with their queue counts.
  app.get("/api/admin/youtube/feeds", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const feedList = await storage.getYouTubeFeeds();
      const counts = await storage.getYouTubePendingCountsByFeed();
      res.json(feedList.map(f => ({
        ...f,
        pendingCount: counts.get(f.id)?.pending || 0,
        approvedCount: counts.get(f.id)?.approved || 0,
        rejectedCount: counts.get(f.id)?.rejected || 0,
      })));
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // The review queue itself.
  app.get("/api/admin/youtube/pending", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const result = await storage.listYouTubePending({
        status: (req.query.status as string) || "pending",
        feedId: (req.query.feedId as string) || undefined,
        search: (req.query.search as string) || undefined,
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 50,
        sort: (req.query.sort as "newest" | "oldest") || "newest",
      });
      res.json(result);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.get("/api/admin/youtube/counts", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      res.json(await storage.getYouTubePendingCounts());
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Approve — this is the only path that creates YouTube episodes.
  app.post("/api/admin/youtube/pending/approve", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { ids, all, feedId } = req.body;
      let targetIds: string[] = Array.isArray(ids) ? ids : [];
      if (all) targetIds = await storage.getAllPendingYouTubeIds(feedId || undefined);
      if (targetIds.length === 0) return res.json({ approved: 0, episodes: 0 });

      // Approval only queues the audio fetch — the episode appears once the
      // MP3 is stored. Returning immediately keeps a 300-video bulk approve
      // from blocking on hours of downloading.
      const result = await storage.approveYouTubePending(targetIds, adminUsername(req));
      nudgeYouTubeMediaWorker();

      res.json({ approved: result.approved, queued: result.queued });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/admin/youtube/pending/reject", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { ids, all, feedId, note } = req.body;
      let targetIds: string[] = Array.isArray(ids) ? ids : [];
      if (all) targetIds = await storage.getAllPendingYouTubeIds(feedId || undefined);
      if (targetIds.length === 0) return res.json({ rejected: 0 });
      const rejected = await storage.rejectYouTubePending(targetIds, adminUsername(req), note);
      res.json({ rejected });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Put a rejected video back in the queue.
  app.post("/api/admin/youtube/pending/unreject", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.json({ restored: 0 });
      res.json({ restored: await storage.unrejectYouTubePending(ids) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Re-crawl a playlist for new uploads. ?full=true ignores the itemCount
  // short-circuit and walks every page.
  app.post("/api/admin/youtube/feeds/:id/sync", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feed = await storage.getFeedById(String(req.params.id));
      if (!feed) return res.status(404).json({ error: "Feed not found" });
      const playlistId = extractYouTubePlaylistId(feed as any);
      if (!playlistId) return res.status(400).json({ error: "Not a YouTube feed" });

      const ingest = await ingestYouTubePlaylist(
        { id: feed.id, title: feed.title, youtubePlaylistId: playlistId },
        { full: req.query.full === "true" },
      );
      res.json(ingest);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // --- Keyword rules ---
  //
  // Rules run at ingest so matching videos never sit in the queue. Reject beats
  // approve; anything unmatched still needs a human.

  app.get("/api/admin/youtube/rules", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      res.json(await storage.getYouTubeRules());
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/youtube/rules", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { feedId, action, matchType, field, pattern, note } = req.body;
      const a = action === "reject" ? "reject" : "approve";
      const mt = matchType === "regex" ? "regex" : "contains";
      const f = ["title", "description", "both"].includes(field) ? field : "title";

      const invalid = isValidRulePattern(mt, String(pattern || ""));
      if (invalid) return res.status(400).json({ error: invalid });

      const rule = await storage.createYouTubeRule({
        feedId: feedId || null, action: a, matchType: mt, field: f,
        pattern: String(pattern).trim(), note: note || null,
      });
      res.json(rule);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put("/api/admin/youtube/rules/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { action, matchType, field, pattern, enabled, note } = req.body;
      if (pattern != null || matchType != null) {
        const invalid = isValidRulePattern(String(matchType || "contains"), String(pattern || ""));
        if (invalid) return res.status(400).json({ error: invalid });
      }
      await storage.updateYouTubeRule(String(req.params.id), {
        ...(action != null ? { action: action === "reject" ? "reject" : "approve" } : {}),
        ...(matchType != null ? { matchType: matchType === "regex" ? "regex" : "contains" } : {}),
        ...(field != null ? { field } : {}),
        ...(pattern != null ? { pattern: String(pattern).trim() } : {}),
        ...(enabled != null ? { enabled: !!enabled } : {}),
        ...(note !== undefined ? { note: note || null } : {}),
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/admin/youtube/rules/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.deleteYouTubeRule(String(req.params.id));
      res.json({ ok: true });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Dry run: what would the current rules do to the pending queue right now?
  // Auto-approve publishes without a human, so it should be possible to see the
  // blast radius before committing to it.
  app.post("/api/admin/youtube/rules/preview", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feedId = (req.body?.feedId as string) || undefined;
      const [rules, queue] = await Promise.all([
        storage.getYouTubeRules(),
        storage.listYouTubePending({ status: "pending", feedId, limit: 200, page: 1 }),
      ]);

      const approve: any[] = [];
      const reject: any[] = [];
      for (const item of queue.items) {
        const decision = evaluateRules(rulesForFeed(rules, item.feedId), {
          title: item.title, description: item.description,
        });
        if (!decision) continue;
        const entry = { id: item.id, title: item.title, reason: describeRule(decision.rule) };
        (decision.action === "reject" ? reject : approve).push(entry);
      }

      res.json({
        scanned: queue.items.length,
        totalPending: queue.total,
        approve,
        reject,
        truncated: queue.total > queue.items.length,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Apply the rules to videos already sitting in the queue.
  app.post("/api/admin/youtube/rules/apply", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feedId = (req.body?.feedId as string) || undefined;
      const rules = await storage.getYouTubeRules();
      if (rules.length === 0) return res.json({ approved: 0, rejected: 0 });

      const approveIds: string[] = [];
      const rejectIds: string[] = [];

      // Page through the whole queue, not just the first screen.
      for (let page = 1; page <= 50; page++) {
        const batch = await storage.listYouTubePending({ status: "pending", feedId, limit: 200, page });
        if (batch.items.length === 0) break;
        for (const item of batch.items) {
          const decision = evaluateRules(rulesForFeed(rules, item.feedId), {
            title: item.title, description: item.description,
          });
          if (!decision) continue;
          (decision.action === "reject" ? rejectIds : approveIds).push(item.id);
        }
        if (batch.items.length < 200) break;
      }

      const rejected = rejectIds.length
        ? await storage.rejectYouTubePending(rejectIds, "auto", "Matched a keyword rule")
        : 0;
      const approvedResult = approveIds.length
        ? await storage.approveYouTubePending(approveIds, "auto")
        : { approved: 0, queued: 0 };
      if (approvedResult.approved > 0) nudgeYouTubeMediaWorker();

      res.json({ approved: approvedResult.approved, rejected });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Re-queue a failed download.
  app.post("/api/admin/youtube/media/retry", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.json({ retried: 0 });
      const retried = await storage.retryYouTubeMedia(ids);
      nudgeYouTubeMediaWorker();
      res.json({ retried });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Media pipeline health: is the toolchain present, how much disk is in use,
  // and where the queue stands.
  app.get("/api/admin/youtube/media/status", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const [tooling, usage, counts] = await Promise.all([
        mediaToolingStatus(),
        mediaUsage(),
        storage.getYouTubeMediaCounts(),
      ]);
      res.json({ tooling, usage, counts });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Resolver health. YouTube periodically breaks stream extraction from
  // datacenter IPs, and this is the fastest way to tell "our code is broken"
  // apart from "YouTube is blocking this host".
  app.get("/api/admin/youtube/diagnostics", adminAuth as any, async (req: Request, res: Response) => {
    const videoId = (req.query.videoId as string) || "";
    const out: any = {
      apiKeyConfigured: !!process.env.YOUTUBE_API_KEY,
      cache: audioCacheStats(),
    };
    if (videoId && YT_VIDEO_ID_RE.test(videoId)) {
      const start = Date.now();
      try {
        const resolved = await resolveAudioStream(videoId);
        out.resolve = {
          ok: true,
          client: resolved.client,
          mimeType: resolved.mimeType,
          contentLength: resolved.contentLength,
          durationMs: resolved.durationMs,
          ms: Date.now() - start,
        };
      } catch (e: any) {
        out.resolve = { ok: false, error: e.message?.slice(0, 400), ms: Date.now() - start };
      }
    }
    res.json(out);
  });

  // ---- Admin: speaker identity ----
  //
  // The same rav appears under several author spellings, so his shiurim are
  // split across "speakers" that each look complete. Exact-normal-form matches
  // merge automatically; everything else needs a human, because edit distance
  // cannot tell a typo from a real surname — "Aharoni, Harav David" and
  // "David, Harav Aharon" are one edit apart and are different people.

  app.get("/api/admin/speakers/suggestions", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql`
        SELECT a_norm, b_norm, a_name, b_name, a_episodes, b_episodes
        FROM search.speaker_suggestions
        ORDER BY (a_episodes + b_episodes) DESC
      `);
      const counts: any = await db.execute(sql`
        SELECT
          (SELECT count(*) FROM search.speakers) AS speakers,
          (SELECT count(*) FROM search.speakers WHERE array_length(aliases,1) > 1) AS merged,
          (SELECT count(*) FROM search.speaker_decisions WHERE decision='merge') AS confirmed,
          (SELECT count(*) FROM search.speaker_decisions WHERE decision='reject') AS rejected
      `);
      res.json({ suggestions: r.rows || [], stats: counts.rows?.[0] || {} });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/speakers/decide", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { aNorm, bNorm, decision } = req.body || {};
      if (!aNorm || !bNorm) return res.status(400).json({ error: "aNorm and bNorm are required" });
      if (decision !== "merge" && decision !== "reject") {
        return res.status(400).json({ error: "decision must be 'merge' or 'reject'" });
      }
      // Canonical ordering so (a,b) and (b,a) are one decision.
      const [a, b] = aNorm <= bNorm ? [aNorm, bNorm] : [bNorm, aNorm];
      await db.execute(sql`
        INSERT INTO search.speaker_decisions (a_norm, b_norm, decision, decided_by)
        VALUES (${a}, ${b}, ${decision}, ${adminUsername(req) || null})
        ON CONFLICT (a_norm, b_norm) DO UPDATE
          SET decision = EXCLUDED.decision,
              decided_by = EXCLUDED.decided_by,
              decided_at = now()
      `);
      // Drop it from the queue immediately; the next rebuild applies the merge.
      await db.execute(sql`
        DELETE FROM search.speaker_suggestions WHERE a_norm = ${a} AND b_norm = ${b}
      `);
      res.json({ ok: true, decision });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Undo — decisions are permanent until explicitly removed, so there has to be
  // a way back from a wrong merge.
  app.post("/api/admin/speakers/undo", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { aNorm, bNorm } = req.body || {};
      if (!aNorm || !bNorm) return res.status(400).json({ error: "aNorm and bNorm are required" });
      const [a, b] = aNorm <= bNorm ? [aNorm, bNorm] : [bNorm, aNorm];
      const r: any = await db.execute(sql`
        DELETE FROM search.speaker_decisions WHERE a_norm = ${a} AND b_norm = ${b}
      `);
      res.json({ ok: true, removed: r.rowCount || 0 });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/admin/speakers/decisions", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql`
        SELECT a_norm, b_norm, decision, decided_by, decided_at
        FROM search.speaker_decisions ORDER BY decided_at DESC LIMIT 200
      `);
      res.json(r.rows || []);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.post("/api/admin/speakers/rebuild", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const { rebuildSpeakers } = await import("./search/speakers");
      const r = await rebuildSpeakers();
      res.json({
        authors: r.authors, speakers: r.speakers,
        merged: r.merged, suggestions: r.suggestions.length,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
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

  // --- TorahDownloads Integration ---

  // Admin: Sync TorahDownloads speakers
  app.post("/api/admin/td/sync-speakers", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const result = await syncTorahDownloadsSpeakers();
      res.json(result);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Toggle all TorahDownloads-only feeds active/inactive
  app.post("/api/admin/td/toggle", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) required" });
      const allFeeds = await storage.getAllFeeds();
      const tdOnlyFeeds = allFeeds.filter(f => (f as any).torahdownloadsSpeakerId != null && f.rssUrl.startsWith("td://"));
      console.log(`TD toggle: enabled=${enabled}, found ${tdOnlyFeeds.length} TD-only feeds`);
      let updated = 0;
      for (const feed of tdOnlyFeeds) {
        if (feed.isActive !== enabled) {
          await storage.updateFeed(feed.id, { isActive: enabled });
          updated++;
        }
      }
      console.log(`TD toggle: updated ${updated} feeds`);
      res.json({ updated, enabled, totalFound: tdOnlyFeeds.length });
    } catch (e: any) {
      console.error("TD toggle error:", e);
      publicError(res, e);
    }
  });

  // Admin: Get TorahDownloads status
  app.get("/api/admin/td/status", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const allFeeds = await storage.getAllFeeds();
      const tdFeeds = allFeeds.filter(f => (f as any).torahdownloadsSpeakerId != null);
      const tdOnlyFeeds = tdFeeds.filter(f => f.rssUrl.startsWith("td://"));
      const activeCount = tdOnlyFeeds.filter(f => f.isActive).length;
      const enabled = activeCount > 0;
      res.json({
        enabled,
        totalTDFeeds: tdOnlyFeeds.length,
        activeTDFeeds: activeCount,
        mergedFeeds: tdFeeds.length - tdOnlyFeeds.length,
      });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: Link/unlink feed to TorahDownloads speaker
  app.put("/api/admin/feeds/:id/td-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { torahdownloadsSpeakerId } = req.body;
      if (!torahdownloadsSpeakerId) return res.status(400).json({ error: "torahdownloadsSpeakerId required" });
      await storage.setTorahDownloadsSpeakerId(req.params.id, torahdownloadsSpeakerId);
      const feed = await storage.getFeedById(req.params.id);
      res.json(feed);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  app.delete("/api/admin/feeds/:id/td-link", adminAuth as any, async (req: Request, res: Response) => {
    try {
      await storage.setTorahDownloadsSpeakerId(req.params.id, null);
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
      if ((source as any).torahdownloadsSpeakerId && !(target as any).torahdownloadsSpeakerId) {
        await storage.setTorahDownloadsSpeakerId(targetId, (source as any).torahdownloadsSpeakerId);
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
          if (f.rssUrl && !isCustomSchemeUrl(f.rssUrl) && !Object.values(OU_PLATFORMS).some(c => f.rssUrl.startsWith(c.urlScheme))) {
            platforms.push("RSS");
          }
          if (f.tatSpeakerId) platforms.push("Torah Anytime");
          if (f.alldafAuthorId) platforms.push("AllDaf");
          if (f.allmishnahAuthorId) platforms.push("AllMishnah");
          if (f.allparshaAuthorId) platforms.push("AllParsha");
          if (f.allhalachaAuthorId) platforms.push("AllHalacha");
          if ((f as any).kolhalashonRavId) platforms.push("Kol Halashon");
          if ((f as any).torahdownloadsSpeakerId) platforms.push("TorahDownloads");
          if ((f as any).youtubePlaylistId) platforms.push("YouTube");
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
            torahdownloadsSpeakerId: (f as any).torahdownloadsSpeakerId,
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

  // Reject push-registration breadcrumbs at the server boundary so
  // stale APKs (running pre-May-5 JS bundles that lack the client-side
  // isPushNoise filter) can't keep polluting the admin error feed.
  // Real push ERRORS still get through — they don't match this regex
  // because they don't carry the "[push]" prefix the registration
  // breadcrumbs use.
  const PUSH_NOISE_RE = /\[push\]|\[fcm\]|\[expo-push\]|expo push token|fcm token|push token|notification permissions|push registration|FCM token fetch|Permission granted, trying FCM|Push token unchanged/i;
  function isPushNoiseReport(r: { level?: string; source?: string; message?: string }): boolean {
    if ((r.level || "error") === "error") return false; // never drop real errors
    if (r.source === "push" || r.source === "notifications") return true;
    return !!r.message && PUSH_NOISE_RE.test(r.message);
  }

  // Error Reports - public endpoint (no auth needed, devices send errors here)
  app.post("/api/error-reports", async (req: Request, res: Response) => {
    try {
      const { deviceId, level, message, stack, source, platform, appVersion, metadata } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });
      if (isPushNoiseReport({ level, source, message })) {
        return res.json({ ok: true, filtered: true });
      }
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
      // Dual-write into the new issues pipeline. Wrapped in try/catch so a
      // bug here can't break the legacy ingest path that every device uses.
      try {
        let parsedMeta: any = null;
        if (metadata) { try { parsedMeta = JSON.parse(metadata); } catch {} }
        await iss.ingestEvent({
          message: message as string,
          stack: stack || null,
          source: source || null,
          severity: (level === "error" ? "nonfatal" : level === "warn" ? "warn" : "nonfatal"),
          deviceId: deviceId || null,
          platform: platform || null,
          appVersion: appVersion || null,
          metadata: parsedMeta,
        });
      } catch (dwErr: any) {
        console.error("issues dual-write failed:", dwErr?.message || dwErr);
      }
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
      let filtered = 0;
      for (const r of limited) {
        if (!r.message) continue;
        if (isPushNoiseReport(r)) { filtered++; continue; }
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
        try {
          let parsedMeta: any = null;
          if (r.metadata) { try { parsedMeta = JSON.parse(r.metadata); } catch {} }
          await iss.ingestEvent({
            message: r.message,
            stack: r.stack || null,
            source: r.source || null,
            severity: (r.level === "error" ? "nonfatal" : r.level === "warn" ? "warn" : "nonfatal"),
            deviceId: r.deviceId || null,
            platform: r.platform || null,
            appVersion: r.appVersion || null,
            metadata: parsedMeta,
          });
        } catch (dwErr: any) {
          console.error("issues dual-write failed:", dwErr?.message || dwErr);
        }
        results.push(report.id);
      }
      res.json({ ok: true, count: results.length, filtered });
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
      const clientIp = getClientIp(req);
      const existing = await storage.getDeviceProfile(deviceId);
      let country: string | null = existing?.country ?? null;
      let city: string | null = existing?.city ?? null;

      // Use ip-api.com free tier for geo lookup (no API key needed, 45 req/min
      // limit). This fires on every app launch, so only pay for it when the
      // answer can actually change: a device we have never geolocated, or one
      // whose IP moved. Without that guard a burst of registrations (see the
      // Aug 2026 web flood — ~380/hour) blows through the free tier and every
      // real launch during it gets no location at all.
      const needsGeo = !existing || !country || existing.ipAddress !== clientIp;
      if (needsGeo && clientIp && clientIp !== "127.0.0.1" && clientIp !== "::1") {
        try {
          const geoRes = await fetch(`http://ip-api.com/json/${clientIp}?fields=country,city`, { signal: AbortSignal.timeout(3000) });
          if (geoRes.ok) {
            const geo = await geoRes.json() as any;
            country = geo.country || country;
            city = geo.city || city;
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
      const clientIp = getClientIp(req) || "unknown";
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

  // YTC unlock tracking — fire-and-forget POST from lib/ytc/unlock.ts
  // when the user enters the correct access code. We rate-limit by IP
  // to a few unlocks/min so a misbehaving client can't spam the table,
  // and the endpoint NEVER returns an error to the client (the unlock
  // itself succeeds either way).
  const _ytcUnlockRateLimit = new Map<string, number>();
  app.post("/api/track/ytc-unlock", async (req: Request, res: Response) => {
    try {
      const clientIp = getClientIp(req) || "unknown";
      const now = Date.now();
      const lastHit = _ytcUnlockRateLimit.get(clientIp) || 0;
      // Same device shouldn't unlock more than once per ~10s. Anything
      // faster is a misconfigured client; silently skip.
      if (now - lastHit < 10_000) return res.json({ ok: true });
      _ytcUnlockRateLimit.set(clientIp, now);
      if (_ytcUnlockRateLimit.size > 1000) {
        for (const [ip, ts] of _ytcUnlockRateLimit) { if (now - ts > 60000) _ytcUnlockRateLimit.delete(ip); }
      }

      const ua = (req.headers["user-agent"] || "").substring(0, 500);
      await storage.recordYtcUnlock({
        deviceId: (req.body?.deviceId ? String(req.body.deviceId).substring(0, 200) : null),
        platform: (req.body?.platform ? String(req.body.platform).substring(0, 32) : null),
        appVersion: (req.body?.appVersion ? String(req.body.appVersion).substring(0, 32) : null),
        userAgent: ua,
        ipAddress: clientIp,
      });
      res.json({ ok: true });
    } catch {
      // Never fail the unlock itself — analytics is best-effort.
      res.json({ ok: true });
    }
  });

  // Admin: YTC Unlock Stats — drives the YTC tile on the admin
  // dashboard ("how many users unlocked the YTC section?").
  app.get("/api/admin/analytics/ytc-unlocks", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const data = await storage.getYtcUnlockStats();
      res.json(data);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // TEMP diagnostic / fix: re-derive publishedAt for OU episodes whose
  // publishDate is more than 24h in the future. OU's API occasionally
  // returns wildly wrong dates; createdAt is reliable.
  app.post("/api/admin/diagnostics/fix-future-pubdate", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const batchSize = Math.min(parseInt((req.query.batch as string) || "500", 10), 1000);
      const candidates = await storage.getFutureDatedOuEpisodes(batchSize);
      if (candidates.length === 0) {
        const counts = await storage.countFutureDatedOuEpisodes();
        return res.json({ processed: 0, updated: 0, moreRemaining: false, counts });
      }

      // Group by guidPrefix → call appropriate platform's fetchById
      const byPlatform: Record<string, typeof candidates> = {};
      for (const c of candidates) {
        const platform = c.guidPrefix.replace(/-$/, "");
        (byPlatform[platform] ||= []).push(c);
      }

      const updates: { episodeId: string; publishedAt: Date }[] = [];
      for (const [platform, group] of Object.entries(byPlatform)) {
        const dateMap = await fetchPostDetailsBatch(platform as any, group.map(g => g.postId));
        for (const c of group) {
          const d = dateMap.get(c.postId);
          // Use createdAt (reliable) instead of publishDate (broken).
          const dateStr = d?.createdAt;
          if (dateStr) updates.push({ episodeId: c.episodeId, publishedAt: new Date(dateStr) });
        }
      }
      // Force-update — existing publishedAt is wrong, must overwrite.
      const updated = await storage.forceSetPublishedAtByEpisodeIds(updates);
      const remaining = await storage.getFutureDatedOuEpisodes(1);
      res.json({ processed: candidates.length, updated, moreRemaining: remaining.length > 0 });
    } catch (e: any) { publicError(res, e); }
  });

  // Admin: expose runtime config so deploys can be verified at a glance.
  app.get("/api/admin/diagnostics/config", adminAuth as any, async (_req: Request, res: Response) => {
    res.json({
      cronTickMin: 30,           // FEED_REFRESH_INTERVAL is 30 min as of d388733
      staleIntervalsMin: { rss: 30, tat: 120, ou: 120, kh: 240 },
      maxEpisodesPerFetch: 5000,
      khMaxShiurim: 5000,
      pushBackfillThreshold: 5,
      tatEnabled: !!(await storage.isTatGloballyEnabled()),
      buildSha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      uptime: process.uptime(),
    });
  });

  // TEMP diagnostic: counts orphan rows across the catalog. Useful for
  // understanding cleanup needs (devices that uninstalled, mute prefs for
  // unsubscribed users, etc.). Most FKs cascade on feed delete, but
  // device_id is just text — anything keyed by it can orphan.
  app.get("/api/admin/diagnostics/orphans", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const data = await storage.countOrphanRows();
      res.json(data);
    } catch (e: any) { publicError(res, e); }
  });

  // Delete all orphaned rows (subs/listens/positions/push tokens/notif prefs
  // where device_id is no longer in device_profiles). Idempotent — safe to
  // re-run, will just return zeros once there's nothing to clean.
  app.post("/api/admin/diagnostics/orphans/cleanup", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const data = await storage.cleanupOrphanRows();
      res.json(data);
    } catch (e: any) { publicError(res, e); }
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

  // Backfill: clear sourceNetwork on existing merged feeds. Single SQL UPDATE.
  // The earlier per-feed-loop version hit Cloudflare 524s on a 5,500-feed
  // sweep — too many round-trips. This runs as one statement.
  app.post("/api/admin/diagnostics/clear-merged-source-tags", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const cleared = await storage.bulkClearMergedSourceNetwork();
      res.json({ cleared });
    } catch (e: any) { publicError(res, e); }
  });

  // Cleanup: collapse intra-feed duplicate episodes. Two rows are duplicates
  // when they share the same normalized title (with audio/video markers
  // stripped) AND the same publish-day. Keeps the longest-duration / longest-
  // title row, deletes the rest. Optional ?feedId=... scopes to one feed
  // for safe trial runs; without it, sweeps the whole catalog.
  app.post("/api/admin/diagnostics/dedup-episodes", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feedId = typeof req.query.feedId === "string" ? req.query.feedId : undefined;
      const result = await storage.bulkDedupIntraFeedEpisodes(feedId);
      res.json(result);
    } catch (e: any) { publicError(res, e); }
  });

  // Diagnostic: probe a single TD shiur's CDN HEAD and return the full
  // request/response details (URL constructed, status, headers parsed).
  // Used to debug "0% hit rate from production while curl-probes return 200".
  app.get("/api/admin/diagnostics/td-cdn-probe", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const shiurId = parseInt((req.query.shiurId as string) || "1030997", 10);
      const result = await fetchShiurUploadDateDebug(shiurId);
      const staleCount = await storage.countStaleTdEpisodes();
      res.json({
        ...result,
        staleTdEpisodeCount: staleCount,
        env: {
          KH_PROXY_URL_set: !!process.env.KH_PROXY_URL,
          KH_PROXY_URL_value: process.env.KH_PROXY_URL || null,
          KH_PROXY_KEY_set: !!process.env.KH_PROXY_KEY,
        },
      });
    } catch (e: any) { publicError(res, e); }
  });

  // TorahDownloads pubdate backfill. The original parser scraped the navbar
  // date (today) on every shiur, so the existing td-* episodes all share
  // whatever day they were ingested at 12:00 UTC. Pull the real date from
  // the CDN's Last-Modified header (HEAD per shiur — torahcdn.net is
  // separate from torahdownloads.com so it's not subject to the 2 RPS site
  // throttle, but we still pace the calls to be polite). Force-overwrites
  // the bogus today timestamp.
  app.post("/api/admin/diagnostics/backfill-td-pubdate", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const batchSize = Math.min(parseInt((req.query.batch as string) || "200", 10), 1000);
      const candidates = await storage.getStaleTdEpisodeIds(batchSize);
      if (candidates.length === 0) return res.json({ processed: 0, updated: 0, moreRemaining: false });

      const updates: { episodeId: string; publishedAt: Date }[] = [];
      // shiurIds whose CDN file is gone (4xx). We null out their publishedAt
      // so they stop matching the 12:00:00 stale fingerprint on the next
      // pass — otherwise the backfill loops forever on the same broken IDs.
      const stuckShiurIds: number[] = [];
      let cdnHits = 0, cdnMisses = 0;
      const missDetails: { shiurId: number; status: number | null; error: string | null }[] = [];
      const verbose = req.query.verbose === "true";
      for (const c of candidates) {
        const dbg = await fetchShiurUploadDateDebug(c.shiurId);
        if (dbg.resolvedDate) {
          updates.push({ episodeId: c.episodeId, publishedAt: new Date(dbg.resolvedDate) });
          cdnHits++;
        } else {
          cdnMisses++;
          // 4xx from CDN = upstream gone forever; promote to null so this row
          // stops cycling. 5xx / network errors stay as candidates for retry.
          if (dbg.status && dbg.status >= 400 && dbg.status < 500) {
            stuckShiurIds.push(c.shiurId);
          }
          if (verbose && missDetails.length < 10) {
            missDetails.push({ shiurId: c.shiurId, status: dbg.status, error: dbg.error });
          }
        }
        // tiny pace; CDN tolerates this fine but we don't want to hammer
        await new Promise(r => setTimeout(r, 50));
      }
      const updated = await storage.forceSetPublishedAtByEpisodeIds(updates);
      const nulled = await storage.nullPublishedAtForShiurIds(stuckShiurIds);

      const remaining = await storage.getStaleTdEpisodeIds(1);
      res.json({
        processed: candidates.length,
        cdnHits,
        cdnMisses,
        updated,
        nulledStuck: nulled,
        moreRemaining: remaining.length > 0,
        ...(verbose ? { missDetails, sampleCandidates: candidates.slice(0, 5).map(c => c.shiurId) } : {}),
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
      const isRss = !isCustomSchemeUrl(feed.rssUrl)
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

  // Bulk-delete push-related noise from the error feed. The app no longer
  // forwards push info breadcrumbs (registration steps, FCM token logs)
  // going forward, but the ~tens of thousands of historical entries clutter
  // the admin UI. This endpoint deletes all rows where source is "push" or
  // "notifications" and level is not "error" (real push errors stay).
  app.delete("/api/admin/error-reports/push-noise", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const count = await storage.deletePushNoiseFromErrorReports();
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
  //
  // Preferred path is a 302 to R2. The redirect still reaches us, so the
  // download is counted, but the 51MB body is served from the CDN edge and
  // never enters this process's memory — the old base64 path allocated the
  // entire APK per concurrent download.
  app.get("/api/apk/download", async (req: Request, res: Response) => {
    try {
      const apk = await storage.getActiveApk();
      if (!apk) return res.status(404).json({ error: "No APK available" });

      // Count before serving, and never let a stats failure block a download.
      void storage.recordApkDownload(apk.id).catch(() => {});

      if (apk.r2Key) {
        // Content-Type and Content-Disposition are stored on the object, so the
        // filename and install behaviour survive the redirect.
        return res.redirect(302, publicUrl(apk.r2Key));
      }

      // LEGACY fallbacks, for an APK uploaded before the R2 migration.
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

      // Straight to R2. Storing base64 in Postgres cost ~1.3x the binary size
      // in the database and loaded the whole build into memory on every
      // download; R2 does neither.
      let r2Key: string | null = null;
      let fileData: string | null = null;
      if (isR2Configured()) {
        const safeName = String(file.originalname || "shiurpod.apk").replace(/[^A-Za-z0-9._-]/g, "-");
        r2Key = `apk/${Date.now()}-${safeName}`;
        await putObject(r2Key, fileBuffer, "application/vnd.android.package-archive", {
          downloadFilename: safeName,
          // A given build never changes, so it can be cached hard.
          cacheControl: "public, max-age=31536000, immutable",
        });
        const head = await headObject(r2Key);
        if (!head.exists) throw new Error("APK upload to R2 could not be verified");
      } else {
        // No R2 configured — fall back to the legacy column rather than losing
        // the upload entirely.
        fileData = fileBuffer.toString("base64");
      }

      const apk = await storage.createApkUpload({
        filename: file.filename,
        originalName: file.originalname,
        version,
        fileSize: file.size,
        fileData,
        r2Key,
      } as any);

      try { fs.unlinkSync(filePath); } catch (_) {}

      res.json({ ok: true, apk: { ...apk, fileData: undefined } });
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // Admin: list all APKs
  app.get("/api/admin/apk/stats", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      res.json(await storage.getApkDownloadStats());
    } catch (e: any) { publicError(res, e); }
  });

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

        // Handle TorahDownloads feeds
        const forceTdId = extractTorahDownloadsSpeakerId(feed as any);
        if (forceTdId) {
          const tdResult = await refreshTorahDownloadsFeedEpisodes({ id: feed.id, title: feed.title, torahdownloadsSpeakerId: forceTdId }, feed);
          res.json({ status: "ok", method: "td", newEpisodes: tdResult.newEpisodes, durationMs: Date.now() - start });
          return;
        }

        // Handle YouTube feeds — queues for review, never adds episodes here.
        const forceYtId = extractYouTubePlaylistId(feed as any);
        if (forceYtId) {
          const ytResult = await refreshYouTubeFeedEpisodes({ id: feed.id, title: feed.title, youtubePlaylistId: forceYtId }, feed);
          res.json({ status: "ok", method: "yt", newEpisodes: 0, queuedForReview: ytResult.queued, durationMs: Date.now() - start });
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
      // YTC: surface the admin-managed unlock code as a typed key the app
      // already merges into RemoteConfig. The underlying app_config row is
      // keyed `ytc_unlock_code`. An empty/missing value means the feature
      // is disabled (kill switch).
      const ytcCode = typeof config.ytc_unlock_code === "string" ? config.ytc_unlock_code : null;
      const exposed: Record<string, any> = { ...config, ytcUnlockCode: ytcCode || null };
      delete (exposed as any).ytc_unlock_code;

      // Audio proxy rules are ALWAYS served, even when no app_config row
      // exists. This is what lets a new source play on already-installed
      // builds: the app only knows the rules baked into its bundle, so an
      // app shipped before YouTube existed has no yt:// rule and would hand
      // the raw placeholder to the player. Serving the rules from here
      // retrofits them over the air.
      //
      // The array REPLACES the client's baked-in defaults wholesale (see
      // setAudioProxyRules in lib/audio-url.ts), so it must always be
      // COMPLETE — every rule the app needs, not just the new one. An admin
      // override is used as the base and any missing default is appended.
      const DEFAULT_AUDIO_PROXY_RULES = [
        { match: "https?://srv\\.kolhalashon\\.com/api/files/(?:GetMp3FileToPlay|getLocationOfFileToVideo)/(\\d+)", replace: "/api/audio/kh/$1" },
        { match: "^yt://audio/([A-Za-z0-9_-]{11})$", replace: "/api/audio/yt/$1" },
        // Dotted S3 bucket -> path-style; the wildcard cert on
        // *.s3.amazonaws.com does not cover a host with more dots to its left,
        // so virtual-hosted TLS fails the handshake.
        {
          match: "^https?://([^/]+\\.[^/]+)\\.(s3(?:[.-][a-z0-9-]+)*\\.amazonaws\\.com)/(.*)$",
          replace: "https://$2/$1/$3",
        },
        // Cleartext -> TLS. Android has refused http:// since targetSdk 28 and
        // our manifest does not opt back in, so these never leave the phone.
        // server/audio-url.ts does the same rewrite at ingest; this retrofits
        // it onto rows already stored and onto installed builds. Keep last —
        // it matches every http:// URL.
        { match: "^http://(.*)$", replace: "https://$1" },
      ];
      const storedRules = Array.isArray(exposed.audioProxyRules) ? exposed.audioProxyRules : [];
      const merged = [...storedRules];
      for (const def of DEFAULT_AUDIO_PROXY_RULES) {
        const present = merged.some((r: any) => typeof r?.match === "string" && r.match === def.match);
        if (!present) merged.push(def);
      }
      exposed.audioProxyRules = merged;

      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(exposed);
    } catch (e: any) {
      publicError(res, e);
    }
  });

  // YTC: admin-managed unlock code. The current value is masked in GET
  // (only the last 4 chars are returned in a `mask` field) — full value
  // is recoverable from the appConfig row directly if needed. PUT sets a
  // new value; empty string or null disables the feature within ~5 min
  // (the /api/config Cache-Control window).
  app.get("/api/admin/config/ytc-unlock-code", adminAuth as any, async (_req: Request, res: Response) => {
    try {
      const value = await storage.getConfig("ytc_unlock_code");
      const str = typeof value === "string" ? value : "";
      const mask = str.length === 0
        ? ""
        : str.length <= 4 ? str : `${"•".repeat(Math.max(0, str.length - 4))}${str.slice(-4)}`;
      res.json({ value: str, mask, set: str.length > 0 });
    } catch (e: any) { publicError(res, e); }
  });

  app.put("/api/admin/config/ytc-unlock-code", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const raw = req.body?.value;
      const value = typeof raw === "string" ? raw.trim() : "";
      await storage.setConfig(
        "ytc_unlock_code",
        value,
        "YTC Alumni access code (empty = feature disabled)",
      );
      res.json({ ok: true, set: value.length > 0 });
    } catch (e: any) { publicError(res, e); }
  });

  registerV1Routes(app);

  // Contributor program. Registered here rather than in index.ts because it
  // needs adminAuth, which is defined in this scope. Creator routes use their
  // own Bearer middleware — a creator token can never reach an admin route.
  registerContributorRoutes(app, adminAuth as any);

  const httpServer = createServer(app);
  return httpServer;
}
