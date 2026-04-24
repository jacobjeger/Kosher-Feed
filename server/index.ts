import dns from "dns";
dns.setDefaultResultOrder('ipv4first');

import express from "express";
import type { Request, Response, NextFunction } from "express";
import compression from "compression";
import { registerRoutes } from "./routes";
import { seedIfEmpty } from "./seed";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { parseFeed, preResolveHostnames } from "./rss";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";
import { startRefreshCycle, recordFeedResult, endRefreshCycle } from "./feed-vitals";
import { refreshTATFeedEpisodes, syncTATSpeakers, fetchAllSpeakers } from "./torahanytime";
import { detectOUPlatform, refreshOUFeedEpisodes, syncOUPlatformAuthors, fetchAuthorById, OU_PLATFORMS, isApiOnlyUrl, type OUPlatformKey } from "./alldaf";
import { refreshKHFeedEpisodes, syncKHSpeakers } from "./kolhalashon";
import { autoCategorizeFeeds } from "./auto-categorize";
import { extractKhRavId, extractTatSpeakerId } from "./feed-utils";
import rateLimit from "express-rate-limit";
import { sendDailyErrorDigest } from "./error-alerts";
import * as fs from "fs";
import * as path from "path";
import pLimit from "p-limit";

const app = express();
const log = console.log;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderSeoPage(opts: { title: string; description: string; canonicalUrl: string; baseUrl: string; heading: string; subheading: string; contentHtml: string; jsonLd: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(opts.title)}</title>
  <meta name="description" content="${escHtml(opts.description)}">
  <link rel="canonical" href="${escHtml(opts.canonicalUrl)}">
  <meta property="og:title" content="${escHtml(opts.title)}">
  <meta property="og:description" content="${escHtml(opts.description)}">
  <meta property="og:url" content="${escHtml(opts.canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${escHtml(opts.baseUrl)}/assets/images/icon.png">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escHtml(opts.title)}">
  <meta name="twitter:description" content="${escHtml(opts.description)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <script type="application/ld+json">${opts.jsonLd}</script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',system-ui,sans-serif;background:#0a0f1a;color:#e2e8f0;min-height:100vh}
    .nav{position:sticky;top:0;background:rgba(10,15,26,0.95);backdrop-filter:blur(12px);padding:16px 24px;border-bottom:1px solid #1e293b;display:flex;align-items:center;justify-content:space-between;z-index:10}
    .nav-brand{font-size:20px;font-weight:700;color:#fff;text-decoration:none}
    .nav-brand span{color:#3b82f6}
    .nav-cta{background:#3b82f6;color:#fff;padding:8px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px}
    .nav-cta:hover{background:#2563eb}
    .hero{text-align:center;padding:64px 24px 48px}
    .hero h1{font-size:clamp(28px,5vw,44px);font-weight:700;margin-bottom:8px}
    .hero h1 span{color:#3b82f6}
    .hero p{color:#94a3b8;font-size:18px}
    .content{max-width:900px;margin:0 auto;padding:0 24px 64px}
    .feed-list{list-style:none;display:grid;gap:12px}
    .feed-card{background:#151c2c;border:1px solid #1e293b;border-radius:12px;padding:20px}
    .feed-card a{color:#f8fafc;font-size:16px;font-weight:600;text-decoration:none}
    .feed-card a:hover{color:#3b82f6}
    .feed-author{display:block;color:#64748b;font-size:13px;margin-top:4px}
    .feed-card p{color:#94a3b8;font-size:14px;margin-top:8px;line-height:1.5}
    .footer{text-align:center;padding:32px;border-top:1px solid #1e293b;color:#64748b;font-size:13px}
    .footer a{color:#3b82f6;text-decoration:none}
    .breadcrumbs{max-width:900px;margin:0 auto;padding:24px 24px 0;font-size:13px;color:#64748b}
    .breadcrumbs a{color:#3b82f6;text-decoration:none}
  </style>
</head>
<body>
  <nav class="nav">
    <a href="${escHtml(opts.baseUrl)}" class="nav-brand">Shiur<span>Pod</span></a>
    <a href="${escHtml(opts.baseUrl)}" class="nav-cta">Open App</a>
  </nav>
  <div class="breadcrumbs"><a href="${escHtml(opts.baseUrl)}">Home</a> &rsaquo; ${escHtml(opts.heading)}</div>
  <div class="hero">
    <h1>${escHtml(opts.heading)}</h1>
    <p>${escHtml(opts.subheading)}</p>
  </div>
  <div class="content">${opts.contentHtml}</div>
  <footer class="footer">
    <p>&copy; ${new Date().getFullYear()} <a href="${escHtml(opts.baseUrl)}">ShiurPod</a> &middot; <a href="${escHtml(opts.baseUrl)}/privacy">Privacy</a> &middot; <a href="${escHtml(opts.baseUrl)}/terms">Terms</a></p>
  </footer>
  <script>(function(){try{var s=sessionStorage.getItem('_pvs')||Math.random().toString(36).slice(2);sessionStorage.setItem('_pvs',s);fetch('/api/analytics/pageview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname,referrer:document.referrer||null,sessionId:s}),keepalive:true}).catch(function(){});}catch(e){}})();</script>
</body>
</html>`;
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

async function ensureColumns() {
  // Add missing columns that drizzle-kit push hasn't run for yet
  const columnsToAdd = [
    { column: "alldaf_author_id", type: "INTEGER" },
    { column: "allmishnah_author_id", type: "INTEGER" },
    { column: "allparsha_author_id", type: "INTEGER" },
    { column: "allhalacha_author_id", type: "INTEGER" },
    { column: "kolhalashon_rav_id", type: "INTEGER" },
    { column: "kolhalashon_file_id", type: "INTEGER", table: "episodes" },
    { column: "show_in_browse", type: "BOOLEAN DEFAULT true NOT NULL" },
    { column: "auto_assigned", type: "BOOLEAN DEFAULT false NOT NULL", table: "feed_categories" },
  ];
  for (const col of columnsToAdd) {
    const table = (col as any).table || "feeds";
    try {
      await db.execute(sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.column} ${col.type}`));
    } catch (e: any) {
      // Column might already exist (older PG without IF NOT EXISTS)
      if (!e.message?.includes("already exists")) {
        console.error(`Migration: failed to add ${col.column} to ${table}:`, e.message);
      }
    }
  }
}

function setupCors(app: express.Application) {
  app.use((req, res, next) => {
    const origins = new Set<string>();

    // Allowed origins (comma-separated), e.g. for Railway
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

  // SEO: Category landing pages
  app.get("/category/:slug", async (req: Request, res: Response) => {
    try {
      const cats = await storage.getAllCategories();
      const cat = cats.find(c => c.slug === req.params.slug);
      if (!cat) return res.status(404).send("Category not found");

      const allFeeds = await storage.getActiveFeeds();
      const mappings = await storage.getAllFeedCategoryMappings();
      const feedIds = new Set(mappings.filter(m => m.categoryId === cat.id).map(m => m.feedId));
      const feeds = allFeeds.filter(f => feedIds.has(f.id) || f.categoryId === cat.id);
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const canonicalUrl = `${baseUrl}/category/${cat.slug}`;

      const feedListHtml = feeds.map(f =>
        `<li class="feed-card"><a href="${baseUrl}">${escHtml(f.title)}</a>${f.author ? `<span class="feed-author">by ${escHtml(f.author)}</span>` : ""}${f.description ? `<p>${escHtml(f.description.substring(0, 200))}</p>` : ""}</li>`
      ).join("");

      const jsonLd = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: `${cat.name} Torah Shiurim`,
        description: `Listen to curated ${cat.name} Torah lectures and shiurim on ShiurPod.`,
        url: canonicalUrl,
        isPartOf: { "@type": "WebSite", name: "ShiurPod", url: baseUrl },
        numberOfItems: feeds.length,
      });

      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(renderSeoPage({
        title: `${cat.name} Torah Shiurim | ShiurPod`,
        description: `Browse ${feeds.length} curated ${cat.name} Torah shiurim and lectures. Listen online or download for offline learning.`,
        canonicalUrl,
        baseUrl,
        heading: cat.name,
        subheading: `${feeds.length} shiurim available`,
        contentHtml: `<ul class="feed-list">${feedListHtml}</ul>`,
        jsonLd,
      }));
    } catch (e: any) {
      res.status(500).send("Server error");
    }
  });

  // SEO: Speaker landing pages
  app.get("/speaker/:author", async (req: Request, res: Response) => {
    try {
      const authorSlug = decodeURIComponent(req.params.author);
      const allFeeds = await storage.getActiveFeeds();
      const feeds = allFeeds.filter(f => f.author && slugify(f.author) === authorSlug);
      if (feeds.length === 0) return res.status(404).send("Speaker not found");

      const authorName = feeds[0].author!;
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const canonicalUrl = `${baseUrl}/speaker/${authorSlug}`;

      const feedListHtml = feeds.map(f =>
        `<li class="feed-card"><a href="${baseUrl}">${escHtml(f.title)}</a>${f.description ? `<p>${escHtml(f.description.substring(0, 200))}</p>` : ""}</li>`
      ).join("");

      const jsonLd = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        name: `${authorName} - Torah Shiurim`,
        description: `Listen to Torah lectures by ${authorName} on ShiurPod.`,
        url: canonicalUrl,
        mainEntity: {
          "@type": "Person",
          name: authorName,
        },
      });

      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(renderSeoPage({
        title: `${authorName} - Torah Shiurim | ShiurPod`,
        description: `Listen to ${feeds.length} Torah shiurim by ${authorName}. Stream online or download for offline learning on ShiurPod.`,
        canonicalUrl,
        baseUrl,
        heading: authorName,
        subheading: `${feeds.length} shiurim available`,
        contentHtml: `<ul class="feed-list">${feedListHtml}</ul>`,
        jsonLd,
      }));
    } catch (e: any) {
      res.status(500).send("Server error");
    }
  });

  // SEO: Sitemap
  app.get("/sitemap.xml", async (_req: Request, res: Response) => {
    try {
      const protocol = _req.header("x-forwarded-proto") || _req.protocol || "https";
      const host = _req.header("x-forwarded-host") || _req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const cats = await storage.getAllCategories();
      const allFeeds = await storage.getActiveFeeds();
      const authors = [...new Set(allFeeds.filter(f => f.author).map(f => f.author!))];

      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      xml += `  <url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;
      for (const cat of cats) {
        xml += `  <url><loc>${baseUrl}/category/${cat.slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>\n`;
      }
      for (const author of authors) {
        xml += `  <url><loc>${baseUrl}/speaker/${slugify(author)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
      }
      xml += `</urlset>`;

      res.setHeader("Content-Type", "application/xml");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(xml);
    } catch {
      res.status(500).send("Server error");
    }
  });

  // SEO: Robots.txt
  app.get("/robots.txt", (req: Request, res: Response) => {
    const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
    const host = req.header("x-forwarded-host") || req.get("host");
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${protocol}://${host}/sitemap.xml\n`);
  });

  // Serve favicon — real .ico (multi-size) at /favicon.ico, PNG variants at
  // /favicon.png and /apple-touch-icon.png for browsers/devices that prefer
  // those. All come from assets/images/*.
  app.get("/favicon.ico", (_req: Request, res: Response) => {
    const icoPath = path.resolve(process.cwd(), "assets", "images", "favicon.ico");
    const pngPath = path.resolve(process.cwd(), "assets", "images", "favicon.png");
    if (fs.existsSync(icoPath)) {
      res.setHeader("Content-Type", "image/x-icon");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(icoPath);
    } else if (fs.existsSync(pngPath)) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(pngPath);
    } else {
      res.status(204).end();
    }
  });

  app.get("/favicon.png", (_req: Request, res: Response) => {
    const p = path.resolve(process.cwd(), "assets", "images", "favicon.png");
    if (fs.existsSync(p)) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(p);
    } else {
      res.status(404).end();
    }
  });

  app.get("/apple-touch-icon.png", (_req: Request, res: Response) => {
    const p = path.resolve(process.cwd(), "assets", "images", "apple-touch-icon.png");
    if (fs.existsSync(p)) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(p);
    } else {
      res.status(404).end();
    }
  });
  // iOS also probes the unsuffixed name + a precomposed variant.
  app.get("/apple-touch-icon-precomposed.png", (_req: Request, res: Response) => res.redirect(301, "/apple-touch-icon.png"));

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

export async function refreshOneFeed(feed: { id: string; title: string; rssUrl: string; etag?: string | null; lastModifiedHeader?: string | null; tatSpeakerId?: number | null; alldafAuthorId?: number | null; allmishnahAuthorId?: number | null; allparshaAuthorId?: number | null; allhalachaAuthorId?: number | null; kolhalashonRavId?: number | null }): Promise<RefreshResult> {
  const start = Date.now();

  // TAT feed: refresh from TorahAnytime API
  const isTatUrl = feed.rssUrl.startsWith("tat://");
  const effectiveTatSpeakerId = extractTatSpeakerId(feed);

  if (effectiveTatSpeakerId && isTatUrl) {
    const result = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveTatSpeakerId });
    return { newEpisodes: result.newEpisodes, method: 'stream', durationMs: Date.now() - start, episodesFound: result.newEpisodes };
  }

  // OU Torah platform feed (AllDaf, AllMishnah, AllParsha, AllHalacha): API-only URL
  const ouPlatform = detectOUPlatform(feed as any);
  const isOUUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));

  if (ouPlatform && isOUUrl) {
    const result = await refreshOUFeedEpisodes(ouPlatform.platform, { id: feed.id, title: feed.title, authorId: ouPlatform.authorId }, feed);
    return { newEpisodes: result.newEpisodes, method: 'stream', durationMs: Date.now() - start, episodesFound: result.newEpisodes };
  }

  // KH feed: refresh from Kol Halashon API
  const isKhUrl = feed.rssUrl.startsWith("kh://");
  const effectiveKhRavId = extractKhRavId(feed);

  if (effectiveKhRavId && isKhUrl) {
    const result = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: effectiveKhRavId }, feed);
    return { newEpisodes: result.newEpisodes, method: 'stream', durationMs: Date.now() - start, episodesFound: result.newEpisodes };
  }

  // Merged feed (has both RSS + TAT): refresh both
  if (effectiveTatSpeakerId) {
    await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveTatSpeakerId }, feed).catch(e => {
      console.log(`TAT refresh failed for merged feed ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    });
  }

  // Merged feed (has both RSS + OU platform): refresh both
  if (ouPlatform && !isOUUrl) {
    await refreshOUFeedEpisodes(ouPlatform.platform, { id: feed.id, title: feed.title, authorId: ouPlatform.authorId }, feed).catch(e => {
      console.log(`${OU_PLATFORMS[ouPlatform.platform].label} refresh failed for merged feed ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    });
  }

  // Merged feed (has both RSS + KH): refresh both
  if (effectiveKhRavId && !isKhUrl) {
    await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: effectiveKhRavId }, feed).catch(e => {
      console.log(`KH refresh failed for merged feed ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    });
  }

  // Skip RSS parsing for TAT-only, OU-only, or KH-only URLs
  if (isTatUrl || isOUUrl || isKhUrl) {
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

// Feed type classification for concurrency and stale intervals
function getFeedType(feed: { rssUrl: string }): 'rss' | 'tat' | 'ou' | 'kh' {
  if (feed.rssUrl.startsWith("kh://")) return 'kh';
  if (feed.rssUrl.startsWith("tat://")) return 'tat';
  if (Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme))) return 'ou';
  return 'rss';
}

// Tiered stale intervals: RSS 1h, TAT/OU 2h, KH 4h
const STALE_INTERVALS: Record<string, number> = {
  rss: 60 * 60 * 1000,       // 1 hour
  tat: 2 * 60 * 60 * 1000,   // 2 hours
  ou:  2 * 60 * 60 * 1000,   // 2 hours
  kh:  4 * 60 * 60 * 1000,   // 4 hours
};

// Concurrency per feed type (keep total across all types ≤ pool max to avoid DB exhaustion)
const CONCURRENCY: Record<string, number> = {
  rss: 3,
  tat: 4,
  ou:  3,
  kh:  5,
};

async function autoRefreshFeeds() {
  if (isAutoRefreshing) {
    log(`Auto-refresh: skipping — previous cycle still running`);
    return;
  }
  isAutoRefreshing = true;
  try {
    const allFeeds = await storage.getAllActiveFeedsForSync();
    const now = new Date().toLocaleTimeString();

    // Tiered stale check per feed type
    const staleFeeds = allFeeds.filter(f => {
      const type = getFeedType(f);
      const interval = STALE_INTERVALS[type] || STALE_INTERVALS.rss;
      const cutoff = new Date(Date.now() - interval);
      return !f.lastFetchedAt || new Date(f.lastFetchedAt) < cutoff;
    });

    if (staleFeeds.length === 0) {
      log(`Auto-refresh [${now}]: all ${allFeeds.length} feed(s) are fresh, skipping`);
      isAutoRefreshing = false;
      return;
    }

    // Pre-resolve hostnames for RSS feeds only
    const rssFeeds = staleFeeds.filter(f => getFeedType(f) === 'rss');
    if (rssFeeds.length > 0) {
      await preResolveHostnames(rssFeeds.map(f => f.rssUrl));
    }

    // Group feeds by type for different concurrency levels
    const feedsByType: Record<string, typeof staleFeeds> = { rss: [], tat: [], ou: [], kh: [] };
    for (const f of staleFeeds) {
      feedsByType[getFeedType(f)].push(f);
    }

    const typeCounts = Object.entries(feedsByType).filter(([, v]) => v.length > 0).map(([k, v]) => `${k}:${v.length}`).join(', ');
    log(`Auto-refresh [${now}]: refreshing ${staleFeeds.length} stale feed(s) out of ${allFeeds.length} total [${typeCounts}]`);

    let totalNew = 0;
    let failures = 0;
    let successes = 0;
    let skipped304 = 0;
    let completed = 0;

    startRefreshCycle(staleFeeds.length);

    // Process each feed type with its own concurrency limit, all pools in parallel
    const processPool = (feeds: typeof staleFeeds, concurrency: number) => {
      const limiter = pLimit(concurrency);
      return feeds.map(feed =>
        limiter(async () => {
          const feedStart = Date.now();
          try {
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

            // Always update lastFetchedAt so failed feeds don't stay permanently stale
            try { await storage.updateFeed(feed.id, { lastFetchedAt: new Date() }); } catch {}

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
    };

    const allTasks = [
      ...processPool(feedsByType.rss, CONCURRENCY.rss),
      ...processPool(feedsByType.tat, CONCURRENCY.tat),
      ...processPool(feedsByType.ou, CONCURRENCY.ou),
      ...processPool(feedsByType.kh, CONCURRENCY.kh),
    ];

    await Promise.all(allTasks);
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

const SPEAKER_SYNC_INTERVAL = 3 * 24 * 60 * 60 * 1000; // 3 days

// Remove all women/female speaker feeds and prevent re-addition
async function removeWomenFeeds(): Promise<number> {
  log("Removing women speaker feeds...");
  const allFeeds = await storage.getAllFeeds();
  const isWomanName = (s: string) => /\b(rebbetzin|rabbanit|mrs\.?|ms\.?|miss)\b/i.test(s);

  // Get female TAT speaker IDs
  let femaleTATIds = new Set<number>();
  try {
    const speakers = await fetchAllSpeakers();
    femaleTATIds = new Set(speakers.filter(s => s.female).map(s => s.id));
  } catch (e: any) {
    log(`Warning: could not fetch TAT speakers for gender filter: ${e.message}`);
  }

  let removed = 0;
  for (const feed of allFeeds) {
    let isWoman = false;

    // TAT: check female flag from API
    if (feed.tatSpeakerId && femaleTATIds.has(feed.tatSpeakerId)) {
      isWoman = true;
    }

    // All platforms: check name patterns
    if (!isWoman && (isWomanName(feed.title) || (feed.author && isWomanName(feed.author)))) {
      isWoman = true;
    }

    if (isWoman) {
      await storage.deleteFeed(feed.id);
      removed++;
      log(`Removed woman speaker feed: "${feed.title}" (${feed.sourceNetwork || 'unknown'})`);
    }
  }
  if (removed > 0) log(`Removed ${removed} women speaker feeds`);
  return removed;
}

// Sync speakers across all platforms (TAT, KH, OU)
async function syncAllPlatformSpeakers(): Promise<void> {
  log("Starting full speaker sync across all platforms...");

  // First remove any women feeds that may have slipped through
  await removeWomenFeeds().catch(e => log(`Women feed removal error: ${e.message}`));

  // TAT
  try {
    const tatResult = await syncTATSpeakers();
    log(`TAT speaker sync: ${tatResult.created} created, ${tatResult.linked} linked`);
  } catch (e: any) {
    log(`TAT speaker sync error: ${e.message}`);
  }

  // KH
  try {
    const khResult = await syncKHSpeakers();
    log(`KH speaker sync: ${khResult.created} created, ${khResult.linked} linked`);
    await storage.recomputeKHBrowseVisibility().catch(e => log(`KH recompute error: ${e.message}`));
  } catch (e: any) {
    log(`KH speaker sync error: ${e.message}`);
  }

  // OU platforms (AllDaf, AllMishnah, AllParsha, AllHalacha)
  for (const cfg of Object.values(OU_PLATFORMS)) {
    try {
      const result = await syncOUPlatformAuthors(cfg.key);
      log(`${cfg.label} speaker sync: ${result.created} created, ${result.linked} linked`);
    } catch (e: any) {
      log(`${cfg.label} speaker sync error: ${e.message}`);
    }
  }

  // Update bios from TAT for any feeds missing descriptions
  try {
    await updateSpeakerBios();
  } catch (e: any) {
    log(`Bio update error: ${e.message}`);
  }

  // Final cleanup: remove any women feeds that the syncs may have created
  await removeWomenFeeds().catch(e => log(`Post-sync women removal error: ${e.message}`));

  // Auto-categorize feeds based on episode topics and feed metadata
  try {
    await autoCategorizeFeeds();
  } catch (e: any) {
    log(`Auto-categorize error: ${e.message}`);
  }

  log("Full speaker sync complete.");
}

// Pull speaker bios from TAT API and update feed descriptions
async function updateSpeakerBios(): Promise<number> {
  log("Updating speaker bios from TAT and OU platforms...");
  const speakers = await fetchAllSpeakers();
  const allFeeds = await storage.getAllFeeds();

  const isPlaceholder = (desc: string | null | undefined): boolean => {
    const d = desc?.trim() || "";
    return !d || d === "Shiurim on Kol Halashon" || /^\d+ shiurim on /.test(d);
  };

  // Build map of tatSpeakerId -> speaker with bio
  const speakersWithBio = new Map<number, string>();
  for (const s of speakers) {
    if (s.desc && s.desc.trim().length > 10) {
      const cleanBio = s.desc.replace(/<[^>]+>/g, "").trim();
      if (cleanBio.length > 10) {
        speakersWithBio.set(s.id, cleanBio);
      }
    }
  }

  let updated = 0;

  for (const feed of allFeeds) {
    if (!isPlaceholder(feed.description)) continue;

    // Try TAT bio first
    if (feed.tatSpeakerId) {
      const bio = speakersWithBio.get(feed.tatSpeakerId);
      if (bio) {
        await storage.updateFeed(feed.id, { description: bio } as any);
        updated++;
        continue;
      }
    }

    // Try OU bio (fetch detail for each OU-linked feed missing a bio)
    const ouFields: { field: string; platform: OUPlatformKey }[] = [
      { field: "alldafAuthorId", platform: "alldaf" },
      { field: "allmishnahAuthorId", platform: "allmishnah" },
      { field: "allparshaAuthorId", platform: "allparsha" },
      { field: "allhalachaAuthorId", platform: "allhalacha" },
    ];
    for (const { field, platform } of ouFields) {
      const authorId = (feed as any)[field];
      if (!authorId) continue;
      try {
        const detail = await fetchAuthorById(platform, authorId);
        if (detail?.bio) {
          const cleanBio = detail.bio.replace(/<[^>]+>/g, "").trim();
          if (cleanBio.length > 10) {
            await storage.updateFeed(feed.id, { description: cleanBio } as any);
            updated++;
            break;
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (updated > 0) log(`Updated ${updated} feed bios from TAT/OU`);
  return updated;
}

// Slow cycle: refresh inactive KH feeds over 72 hours
// With ~4800 inactive KH feeds / 72h = ~67 per hour, batch 50 every 30 min = 2400/day
let isSlowKHRefreshing = false;
async function slowRefreshInactiveKH() {
  if (isSlowKHRefreshing) return;
  isSlowKHRefreshing = true;
  try {
    const batch = await storage.getInactiveKHFeedsForSlowSync(50);
    if (batch.length === 0) { log("KH slow-refresh: no stale inactive feeds"); return; }
    log(`KH slow-refresh: processing ${batch.length} inactive KH feed(s)`);
    const limiter = pLimit(3);
    let ok = 0, fail = 0;
    await Promise.all(batch.map(feed => limiter(async () => {
      const feedStart = Date.now();
      try {
        const khRavId = extractKhRavId(feed);
        if (!khRavId) { await storage.updateFeed(feed.id, { lastFetchedAt: new Date() }); return; }
        const result = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: khRavId }, feed);
        ok++;
        recordFeedResult({ feedId: feed.id, feedTitle: feed.title, method: 'stream', success: true, durationMs: Date.now() - feedStart, episodesFound: result.newEpisodes, newEpisodes: result.newEpisodes, timestamp: Date.now() });
      } catch (e: any) {
        fail++;
        recordFeedResult({ feedId: feed.id, feedTitle: feed.title, method: 'stream', success: false, durationMs: Date.now() - feedStart, episodesFound: 0, newEpisodes: 0, error: (e as Error).message?.slice(0, 200), timestamp: Date.now() });
        try { await storage.updateFeed(feed.id, { lastFetchedAt: new Date() }); } catch {}
      }
    })));
    log(`KH slow-refresh complete: ${ok} ok, ${fail} failed`);
  } catch (e: any) {
    log(`KH slow-refresh error: ${(e as Error).message}`);
  } finally {
    isSlowKHRefreshing = false;
  }
}

function startAutoRefresh() {
  log(`Auto-refresh enabled: checking feeds every ${FEED_REFRESH_INTERVAL / 60000} minutes (sequential, retry on timeout)`);
  setInterval(autoRefreshFeeds, FEED_REFRESH_INTERVAL);
  setInterval(slowRefreshInactiveKH, 30 * 60 * 1000); // every 30 min
  setTimeout(async () => {
    await networkSanityCheck();
    autoRefreshFeeds();
  }, 5000);
  setTimeout(slowRefreshInactiveKH, 60000); // first run after 1 min
  startKeepAlive();

  // Daily error digest — send at 8am EST (13:00 UTC)
  function scheduleDailyDigest() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(13, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        const [health, grouped] = await Promise.all([
          storage.getErrorHealth(),
          storage.getGroupedErrorReports(10),
        ]);
        await sendDailyErrorDigest(health, grouped);
      } catch (e: any) { console.error("Daily digest failed:", e.message); }
      scheduleDailyDigest(); // reschedule for next day
    }, delay);
    log(`Daily error digest scheduled in ${Math.round(delay / 3600000)}h`);
  }
  scheduleDailyDigest();

  // Delete error reports older than 7 days — runs daily at 03:00 UTC
  function scheduleErrorCleanup() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        const deleted = await storage.deleteOldErrorReports(7);
        log(`Error report cleanup: deleted ${deleted} report(s) older than 7 days`);
      } catch (e: any) { console.error("Error cleanup failed:", e.message); }
      scheduleErrorCleanup();
    }, delay);
    log(`Error report cleanup scheduled in ${Math.round(delay / 3600000)}h`);
  }
  scheduleErrorCleanup();

  // Run once on boot so deploys immediately prune stale backlogs
  setTimeout(async () => {
    try {
      const deleted = await storage.deleteOldErrorReports(7);
      if (deleted > 0) log(`Error report cleanup (startup): deleted ${deleted} stale report(s)`);
    } catch {}
  }, 10_000);
}

(async () => {
  // Run column migrations FIRST, before any routes or queries touch the DB
  await ensureColumns();

  setupCors(app);
  app.use(compression());

  // Rate limiting — general (200 req/min per IP) and strict for write endpoints (30 req/min)
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown",
    skip: (req) => req.path.startsWith("/api/admin"), // admin has its own auth
  });
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown",
    message: { error: "Too many requests, please try again later" },
  });
  app.use("/api/", generalLimiter);
  app.use("/api/feedback", writeLimiter);
  app.use("/api/contact", writeLimiter);
  app.use("/api/error-reports", writeLimiter);
  app.use("/api/analytics/pageview", writeLimiter);

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
      // Full speaker sync on startup (after 15s delay) and then every 3 days
      setTimeout(() => {
        syncAllPlatformSpeakers().catch(e => console.error("Initial speaker sync error:", e.message));
      }, 15000);
      setInterval(() => {
        syncAllPlatformSpeakers().catch(e => console.error("Periodic speaker sync error:", e.message));
      }, SPEAKER_SYNC_INTERVAL);
      // Recompute KH browse visibility every 6 hours
      setInterval(() => {
        storage.recomputeKHBrowseVisibility().catch(e => console.error("KH recompute error:", e.message));
      }, 6 * 60 * 60 * 1000);
    },
  );
})();
