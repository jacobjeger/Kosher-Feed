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
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const slim = req.query.slim === "1";
      const eps = await storage.getEpisodesByFeedPaginated(req.params.id, page, limit);
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

  const httpServer = createServer(app);
  return httpServer;
}
