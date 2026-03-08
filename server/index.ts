import dns from "dns";
dns.setDefaultResultOrder('ipv4first');

import express from "express";
import type { Request, Response, NextFunction } from "express";
import compression from "compression";
import { registerRoutes } from "./routes";
import { seedIfEmpty } from "./seed";
import { parseFeed, preResolveHostnames } from "./rss";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import { startRefreshCycle, recordFeedResult, endRefreshCycle } from "./feed-vitals";
import { refreshTATFeedEpisodes, syncTATSpeakers } from "./torahanytime";
import { refreshAllDafFeedEpisodes } from "./alldaf";
import * as fs from "fs";
import * as path from "path";
import pLimit from "p-limit";

const app = express();
const log = console.log;

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

function setupCors(app: express.Application) {
  app.use((req, res, next) => {
    const origins = new Set<string>();

    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }

    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }

    // Additional allowed origins (comma-separated), e.g. for Railway
    if (process.env.ALLOWED_ORIGINS) {
      process.env.ALLOWED_ORIGINS.split(",").forEach((o) => {
        origins.add(o.trim());
      });
    }

    const origin = req.header("origin");

    // Allow localhost origins for Expo web development (any port)
    const isLocalhost =
      origin?.startsWith("http://localhost:") ||
      origin?.startsWith("http://127.0.0.1:");

    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.header("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }

    next();
  });
}

function setupBodyParsing(app: express.Application) {
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false }));
}

function setupRequestLogging(app: express.Application) {
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      if (!path.startsWith("/api")) return;

      const duration = Date.now() - start;

      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    });

    next();
  });
}

function getAppName(): string {
  try {
    const appJsonPath = path.resolve(process.cwd(), "app.json");
    const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function serveExpoManifest(platform: string, res: Response) {
  const manifestPath = path.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json",
  );

  if (!fs.existsSync(manifestPath)) {
    return res
      .status(404)
      .json({ error: `Manifest not found for platform: ${platform}` });
  }

  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res.send(manifest);
}

function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName,
}: {
  req: Request;
  res: Response;
  landingPageTemplate: string;
  appName: string;
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;

  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

function configureExpoAndLanding(app: express.Application) {
  const templatePath = path.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html",
  );
  const landingPageTemplate = fs.readFileSync(templatePath, "utf-8");
  const appName = getAppName();
  log("Serving static Expo files with dynamic manifest routing");

  const expoDevTarget = "http://localhost:8081";

  const proxyToExpo = async (req: Request, res: Response) => {
    try {
      const url = `${expoDevTarget}${req.originalUrl}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        res.status(resp.status).send(await resp.text());
        return;
      }
      const ct = resp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const cl = resp.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);
      const cc = resp.headers.get("cache-control");
      if (cc) res.setHeader("Cache-Control", cc);

      const reader = resp.body?.getReader();
      if (!reader) { res.status(502).end(); return; }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        res.status(502).send("Expo dev server not available");
      }
    }
  };

  const loadingHtml = '<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#94a3b8;"><div style="text-align:center;"><h2 style="color:#f8fafc;">Web App Loading...</h2><p>The Expo dev server is starting up. Please refresh in a few seconds.</p></div></body></html>';

  const staticBuildPath = path.resolve(process.cwd(), "static-build");
  const staticIndexPath = path.join(staticBuildPath, "index.html");
  const webappBuildPath = path.join(staticBuildPath, "webapp");
  const webappIndexPath = path.join(webappBuildPath, "index.html");

  const isProduction = process.env.NODE_ENV === "production";

  const serveStaticWebApp = (res: Response) => {
    const routerFix = `<script>if(window.location.pathname.startsWith('/webapp')){history.replaceState(null,'','/' + window.location.pathname.slice('/webapp'.length).replace(/^\\//, '') + window.location.search + window.location.hash);}</script>`;
    if (fs.existsSync(webappIndexPath)) {
      let html = fs.readFileSync(webappIndexPath, "utf-8");
      html = html.replace('</head>', `${routerFix}</head>`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
      return true;
    }
    if (fs.existsSync(staticIndexPath)) {
      let html = fs.readFileSync(staticIndexPath, "utf-8");
      html = html.replace('</head>', `${routerFix}</head>`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
      return true;
    }
    return false;
  };

  const serveExpoWebApp = async (_req: Request, res: Response) => {
    if (isProduction) {
      if (!serveStaticWebApp(res)) {
        res.status(502).send(loadingHtml);
      }
      return;
    }
    try {
      const resp = await fetch(expoDevTarget);
      if (!resp.ok) throw new Error("Expo dev server not ready");
      let html = await resp.text();
      const routerFix = `<script>if(window.location.pathname.startsWith('/webapp')){history.replaceState(null,'','/' + window.location.pathname.slice('/webapp'.length).replace(/^\\//, '') + window.location.search + window.location.hash);}</script>`;
      html = html.replace('</head>', `${routerFix}</head>`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch {
      if (!serveStaticWebApp(res)) {
        res.status(502).send(loadingHtml);
      }
    }
  };

  app.get("/webapp", serveExpoWebApp as any);
  app.get("/webapp/*path", serveExpoWebApp as any);

  app.use("/webapp", express.static(webappBuildPath) as any);

  if (isProduction) {
    const webappExpoPath = path.join(webappBuildPath, "_expo");
    if (fs.existsSync(webappExpoPath)) {
      app.use("/_expo", express.static(webappExpoPath) as any);
    }
    const webappAssetsPath = path.join(webappBuildPath, "assets");
    if (fs.existsSync(webappAssetsPath)) {
      app.use("/assets", express.static(webappAssetsPath) as any);
    }
  } else {
    app.use("/node_modules", proxyToExpo as any);
    app.use("/_expo", proxyToExpo as any);
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/share/")) {
      return next();
    }

    if (req.path === "/admin" || req.path === "/privacy" || req.path === "/terms" || req.path === "/support") {
      return next();
    }

    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      if (req.path === "/" || req.path === "/manifest") {
        return serveExpoManifest(platform, res);
      }
    }

    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName,
      });
    }

    next();
  });

  app.get("/admin", (_req: Request, res: Response) => {
    const adminPath = path.resolve(process.cwd(), "server", "templates", "admin.html");
    res.sendFile(adminPath);
  });

  app.get("/privacy", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(process.cwd(), "server", "templates", "privacy.html"));
  });

  app.get("/terms", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(process.cwd(), "server", "templates", "terms.html"));
  });

  app.get("/support", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(process.cwd(), "server", "templates", "support.html"));
  });

  app.use("/assets", (req: Request, res: Response, next: NextFunction) => {
    const localPath = path.resolve(process.cwd(), "assets", req.path);
    if (fs.existsSync(localPath)) {
      return express.static(path.resolve(process.cwd(), "assets"))(req, res, next);
    }
    return proxyToExpo(req, res);
  });
  app.use(express.static(path.resolve(process.cwd(), "static-build")));

  const clientRoutes = ["/podcast", "/maggid-shiur", "/player", "/queue", "/storage", "/stats", "/debug-logs", "/legal", "/onboarding", "/settings"];
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/share/") || req.path.startsWith("/admin")) return next();
    const isClientRoute = clientRoutes.some(r => req.path.startsWith(r)) || req.path === "/(tabs)";
    if (!isClientRoute) return next();

    if (isProduction) {
      if (!serveStaticWebApp(res)) {
        return next();
      }
    } else {
      proxyToExpo(req, res);
    }
  });

  log("Expo routing: Checking expo-platform header on / and /manifest");
}

function setupErrorHandler(app: express.Application) {
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const error = err as {
      status?: number;
      statusCode?: number;
      message?: string;
    };

    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });
}

const FEED_REFRESH_INTERVAL = 60 * 60 * 1000;
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms)),
  ]);
}

export interface RefreshResult {
  newEpisodes: number;
  method: 'stream' | 'proxy' | 'cached';
  durationMs: number;
  episodesFound: number;
}

export async function refreshOneFeed(feed: { id: string; title: string; rssUrl: string; etag?: string | null; lastModifiedHeader?: string | null; tatSpeakerId?: number | null; alldafAuthorId?: number | null }): Promise<RefreshResult> {
  const start = Date.now();

  // TAT feed: refresh from TorahAnytime API
  const isTatUrl = feed.rssUrl.startsWith("tat://");
  const effectiveTatSpeakerId = feed.tatSpeakerId ?? (isTatUrl ? parseInt(feed.rssUrl.replace("tat://speaker/", ""), 10) || null : null);

  if (effectiveTatSpeakerId && isTatUrl) {
    const result = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveTatSpeakerId });
    return { newEpisodes: result.newEpisodes, method: 'stream', durationMs: Date.now() - start, episodesFound: result.newEpisodes };
  }

  // AllDaf feed: refresh from AllDaf API
  const isAlldafUrl = feed.rssUrl.startsWith("alldaf://");
  const effectiveAlldafAuthorId = feed.alldafAuthorId ?? (isAlldafUrl ? parseInt(feed.rssUrl.replace("alldaf://author/", ""), 10) || null : null);

  if (effectiveAlldafAuthorId && isAlldafUrl) {
    const result = await refreshAllDafFeedEpisodes({ id: feed.id, title: feed.title, alldafAuthorId: effectiveAlldafAuthorId });
    return { newEpisodes: result.newEpisodes, method: 'stream', durationMs: Date.now() - start, episodesFound: result.newEpisodes };
  }

  // Merged feed (has both RSS + TAT): refresh both
  if (effectiveTatSpeakerId) {
    await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveTatSpeakerId }).catch(e => {
      console.log(`TAT refresh failed for merged feed ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    });
  }

  // Merged feed (has both RSS + AllDaf): refresh both
  if (effectiveAlldafAuthorId) {
    await refreshAllDafFeedEpisodes({ id: feed.id, title: feed.title, alldafAuthorId: effectiveAlldafAuthorId }).catch(e => {
      console.log(`AllDaf refresh failed for merged feed ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    });
  }

  // Skip RSS parsing for TAT-only or AllDaf-only URLs
  if (isTatUrl || isAlldafUrl) {
    return { newEpisodes: 0, method: 'stream', durationMs: Date.now() - start, episodesFound: 0 };
  }

  // RSS refresh
  const parsed = await parseFeed(feed.id, feed.rssUrl, {
    etag: feed.etag,
    lastModified: feed.lastModifiedHeader,
  });

  if (parsed === null) {
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: 0, method: 'cached', durationMs: Date.now() - start, episodesFound: 0 };
  }

  const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
  const inserted = await storage.upsertEpisodes(feed.id, episodeData);

  const updateData: any = { lastFetchedAt: new Date() };
  if (parsed.responseHeaders?.etag) {
    updateData.etag = parsed.responseHeaders.etag;
  }
  if (parsed.responseHeaders?.lastModified) {
    updateData.lastModifiedHeader = parsed.responseHeaders.lastModified;
  }
  await storage.updateFeed(feed.id, updateData);

  if (inserted.length > 0) {
    for (const ep of inserted.slice(0, 3)) {
      sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
    }
  }

  return {
    newEpisodes: inserted.length,
    method: parsed.fetchMethod || 'stream',
    durationMs: parsed.fetchDurationMs || (Date.now() - start),
    episodesFound: parsed.episodes.length,
  };
}

let isAutoRefreshing = false;

async function autoRefreshFeeds() {
  if (isAutoRefreshing) {
    log(`Auto-refresh: skipping — previous cycle still running`);
    return;
  }
  isAutoRefreshing = true;
  try {
    const allFeeds = await storage.getActiveFeeds();
    const now = new Date().toLocaleTimeString();

    const staleCutoff = new Date(Date.now() - FEED_REFRESH_INTERVAL);
    const staleFeeds = allFeeds.filter(f => !f.lastFetchedAt || new Date(f.lastFetchedAt) < staleCutoff);

    if (staleFeeds.length === 0) {
      log(`Auto-refresh [${now}]: all ${allFeeds.length} feed(s) are fresh, skipping`);
      isAutoRefreshing = false;
      return;
    }

    await preResolveHostnames(staleFeeds.filter(f => !f.rssUrl.startsWith("tat://")).map(f => f.rssUrl));

    log(`Auto-refresh [${now}]: refreshing ${staleFeeds.length} stale feed(s) out of ${allFeeds.length} total (3 concurrent)...`);
    let totalNew = 0;
    let failures = 0;
    let successes = 0;
    let skipped304 = 0;
    let completed = 0;

    startRefreshCycle(staleFeeds.length);
    const limit = pLimit(3);

    const tasks = staleFeeds.map((feed) =>
      limit(async () => {
        const feedStart = Date.now();
        try {
          await new Promise(r => setTimeout(r, Math.random() * 300));
          const result = await withTimeout(refreshOneFeed(feed), 120000, feed.title);
          totalNew += result.newEpisodes;
          successes++;
          completed++;

          recordFeedResult({
            feedId: feed.id,
            feedTitle: feed.title,
            method: result.method,
            success: true,
            durationMs: result.durationMs,
            episodesFound: result.episodesFound,
            newEpisodes: result.newEpisodes,
            timestamp: Date.now(),
          });

          if (result.newEpisodes > 0) {
            log(`  [${completed}/${staleFeeds.length}] ${feed.title}: +${result.newEpisodes} new (${result.method}, ${result.durationMs}ms)`);
          } else if (result.method === 'cached') {
            skipped304++;
          }
        } catch (e) {
          failures++;
          completed++;
          const errMsg = (e as Error)?.message || String(e);
          log(`  [${completed}/${staleFeeds.length}] ${feed.title}: FAIL — ${errMsg.slice(0, 120)}`);

          recordFeedResult({
            feedId: feed.id,
            feedTitle: feed.title,
            method: 'stream',
            success: false,
            durationMs: Date.now() - feedStart,
            episodesFound: 0,
            newEpisodes: 0,
            error: errMsg.slice(0, 200),
            timestamp: Date.now(),
          });
        }
      })
    );

    await Promise.all(tasks);
    endRefreshCycle();

    log(`Auto-refresh [${now}] complete: ${successes} ok (${skipped304} cached/304), ${failures} failed, ${totalNew} new episode(s), across ${staleFeeds.length} stale feed(s)`);
  } catch (e) {
    console.error("Auto-refresh error:", e);
  } finally {
    isAutoRefreshing = false;
  }
}

let serverPort = 5000;

function startKeepAlive() {
  log(`Keep-alive: pinging localhost:${serverPort}/api/health every ${KEEP_ALIVE_INTERVAL / 60000} minutes to prevent sleep`);
  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
      log(`Keep-alive ping: ${res.status}`);
    } catch (e) {
      log(`Keep-alive ping failed: ${(e as Error).message}`);
    }
  }, KEEP_ALIVE_INTERVAL);
}

async function networkSanityCheck() {
  const axios = (await import("axios")).default;
  log(`Network sanity check: testing outbound connectivity...`);
  try {
    const start = Date.now();
    const res = await axios.get('https://www.google.com', { timeout: 10000 });
    log(`  Google.com: ${res.status} in ${Date.now() - start}ms — outbound OK`);
  } catch (e: any) {
    log(`  Google.com: FAILED — ${e.code || e.message}`);
  }

  try {
    const start = Date.now();
    const res = await axios.get('https://anchor.fm/s/561de0ec/podcast/rss', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShiurPodBot/1.0)' },
    });
    log(`  anchor.fm RSS: ${res.status} in ${Date.now() - start}ms — ${(res.data as string).length} bytes`);
  } catch (e: any) {
    log(`  anchor.fm RSS: FAILED — ${e.code || e.message}`);
  }

  try {
    const { address, family } = await dns.promises.lookup('anchor.fm');
    log(`  DNS anchor.fm: ${address} (IPv${family})`);
  } catch (e: any) {
    log(`  DNS anchor.fm: FAILED — ${e.code || e.message}`);
  }
}

function startAutoRefresh() {
  log(`Auto-refresh enabled: checking feeds every ${FEED_REFRESH_INTERVAL / 60000} minutes (sequential, retry on timeout)`);
  setInterval(autoRefreshFeeds, FEED_REFRESH_INTERVAL);
  setTimeout(async () => {
    await networkSanityCheck();
    autoRefreshFeeds();
  }, 5000);
  startKeepAlive();
}

(async () => {
  setupCors(app);
  app.use(compression());
  setupBodyParsing(app);
  setupRequestLogging(app);

  configureExpoAndLanding(app);

  const server = await registerRoutes(app);

  setupErrorHandler(app);

  serverPort = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port: serverPort,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`express server serving on port ${serverPort}`);
      seedIfEmpty().catch((e) => console.error("Seed error:", e));
      startAutoRefresh();
      // Sync TorahAnytime speakers in background after 15s
      setTimeout(() => {
        syncTATSpeakers().catch(e => console.error("TAT initial sync error:", e.message));
      }, 15000);
    },
  );
})();
