import express from "express";
import type { Request, Response, NextFunction } from "express";
import compression from "compression";
import { registerRoutes } from "./routes";
import { seedIfEmpty } from "./seed";
import { parseFeed } from "./rss";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import * as fs from "fs";
import * as path from "path";

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

const FEED_REFRESH_INTERVAL = 10 * 60 * 1000;

async function autoRefreshFeeds() {
  try {
    const allFeeds = await storage.getActiveFeeds();
    const now = new Date().toLocaleTimeString();
    log(`Auto-refresh [${now}]: checking ${allFeeds.length} feed(s)...`);
    let totalNew = 0;
    for (const feed of allFeeds) {
      try {
        const parsed = await parseFeed(feed.id, feed.rssUrl);
        const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
        const inserted = await storage.upsertEpisodes(feed.id, episodeData);
        totalNew += inserted.length;
        await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
        if (inserted.length > 0) {
          for (const ep of inserted.slice(0, 3)) {
            sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
          }
        }
      } catch (e) {
        console.error(`Auto-refresh failed for ${feed.title}:`, e);
      }
    }
    log(`Auto-refresh [${now}] complete: ${totalNew} new episode(s) found across ${allFeeds.length} feed(s)`);
  } catch (e) {
    console.error("Auto-refresh error:", e);
  }
}

function startAutoRefresh() {
  log(`Auto-refresh enabled: checking feeds every ${FEED_REFRESH_INTERVAL / 60000} minutes`);
  setInterval(autoRefreshFeeds, FEED_REFRESH_INTERVAL);
  setTimeout(autoRefreshFeeds, 30000);
}

(async () => {
  setupCors(app);
  app.use(compression());
  setupBodyParsing(app);
  setupRequestLogging(app);

  configureExpoAndLanding(app);

  const server = await registerRoutes(app);

  setupErrorHandler(app);

  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`express server serving on port ${port}`);
      seedIfEmpty().catch((e) => console.error("Seed error:", e));
      startAutoRefresh();
    },
  );
})();
