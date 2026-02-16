import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as storage from "./storage";
import { parseFeed } from "./rss";
import { insertFeedSchema, insertCategorySchema } from "@shared/schema";

function requireAdmin(req: Request, res: Response): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export async function registerRoutes(app: Express): Promise<Server> {
  await storage.createAdmin("admin", "admin123").catch(() => {});

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

  // Feeds
  app.get("/api/feeds", async (_req: Request, res: Response) => {
    try {
      const feedList = await storage.getActiveFeeds();
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(feedList);
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

  app.get("/api/feeds/category/:categoryId", async (req: Request, res: Response) => {
    try {
      const feedList = await storage.getFeedsByCategory(req.params.categoryId);
      res.json(feedList);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ping", (_req: Request, res: Response) => {
    res.json({ ok: true, ts: Date.now() });
  });

  app.get("/api/feeds/:id/episodes", async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const paginated = req.query.paginated === "1";
      const slim = req.query.slim === "1";
      const sort = (req.query.sort as string) || 'newest';
      const eps = await storage.getEpisodesByFeedPaginated(req.params.id, page, limit, sort);
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
      res.json(feedList);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/feeds", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { rssUrl, categoryId } = req.body;
      if (!rssUrl) return res.status(400).json({ error: "rssUrl is required" });

      const parsed = await parseFeed("temp", rssUrl);

      const feed = await storage.createFeed({
        title: parsed.title,
        rssUrl,
        imageUrl: parsed.imageUrl || null,
        description: parsed.description || null,
        author: parsed.author || null,
        categoryId: categoryId || null,
      });

      const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
      await storage.upsertEpisodes(feed.id, episodeData);

      res.json(feed);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put("/api/admin/feeds/:id", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const feed = await storage.updateFeed(req.params.id, req.body);
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

      const parsed = await parseFeed(feed.id, feed.rssUrl);
      const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
      const inserted = await storage.upsertEpisodes(feed.id, episodeData);

      await storage.updateFeed(feed.id, {
        lastFetchedAt: new Date(),
        title: parsed.title,
        imageUrl: parsed.imageUrl || feed.imageUrl,
        description: parsed.description || feed.description,
        author: parsed.author || feed.author,
      });

      res.json({ newEpisodes: inserted.length });
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
          const parsed = await parseFeed(feed.id, feed.rssUrl);
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          const inserted = await storage.upsertEpisodes(feed.id, episodeData);
          totalNew += inserted.length;
          await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
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

  // Admin: Bulk Feed Import
  app.post("/api/admin/feeds/bulk-import", adminAuth as any, async (req: Request, res: Response) => {
    try {
      const { feeds: feedUrls, categoryId } = req.body;
      if (!Array.isArray(feedUrls) || feedUrls.length === 0) return res.status(400).json({ error: "feeds array required" });
      const results: { url: string; success: boolean; title?: string; error?: string }[] = [];
      for (const rssUrl of feedUrls) {
        try {
          const parsed = await parseFeed("temp", rssUrl);
          const feed = await storage.createFeed({
            title: parsed.title,
            rssUrl,
            imageUrl: parsed.imageUrl || null,
            description: parsed.description || null,
            author: parsed.author || null,
            categoryId: categoryId || null,
          });
          const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
          await storage.upsertEpisodes(feed.id, episodeData);
          results.push({ url: rssUrl, success: true, title: parsed.title });
        } catch (e: any) {
          results.push({ url: rssUrl, success: false, error: e.message });
        }
      }
      res.json({ results });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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

  const httpServer = createServer(app);
  return httpServer;
}
