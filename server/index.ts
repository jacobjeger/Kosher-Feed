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
import { sendNewEpisodePushes, PUSH_BACKFILL_THRESHOLD } from "./push";
import { startRefreshCycle, recordFeedResult, endRefreshCycle } from "./feed-vitals";
import { refreshTATFeedEpisodes, syncTATSpeakers, fetchAllSpeakers } from "./torahanytime";
import { refreshOUFeedEpisodes, syncOUPlatformAuthors, fetchAuthorById, OU_PLATFORMS, isApiOnlyUrl, type OUPlatformKey } from "./alldaf";
import { refreshKHFeedEpisodes, syncKHSpeakers } from "./kolhalashon";
import { isMergedFeed, filterCrossSourceDuplicates, dedupWithinBatch } from "./episode-dedup";
import { refreshTorahDownloadsFeedEpisodes, syncTorahDownloadsSpeakers } from "./torahdownloads";
import { refreshYouTubeFeedEpisodes, extractYouTubePlaylistId } from "./youtube";
import { startYouTubeMediaWorker } from "./youtube-worker";
import { bootstrapSearch } from "./search/bootstrap";
import { startPopularityRefresh } from "./search/popularity";
import { autoCategorizeFeeds } from "./auto-categorize";
import { extractKhRavId, extractTatSpeakerId, extractTorahDownloadsSpeakerId } from "./feed-utils";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
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

// Speaker slug: drop a trailing "Shiurim"/"Shiur"/"Podcast" from the author
// so URLs read /rabbi-daniel-kalish, not /rabbi-daniel-kalish-shiurim.
// Falls back to the plain slug if stripping would leave nothing.
function toSpeakerSlug(author: string): string {
  const stripped = author.replace(/[\s-]+(shiurim|shiur|podcast|daily)\s*$/i, "").trim();
  return slugify(stripped) || slugify(author);
}

function renderSeoPage(opts: { title: string; description: string; canonicalUrl: string; baseUrl: string; heading: string; subheading: string; contentHtml: string; jsonLd: string; imageUrl?: string | null; ogType?: string }): string {
  const ogImage = opts.imageUrl || `${opts.baseUrl}/assets/images/icon.png`;
  const ogType = opts.ogType || "website";
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
  <meta property="og:type" content="${escHtml(ogType)}">
  <meta property="og:image" content="${escHtml(ogImage)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(opts.title)}">
  <meta name="twitter:description" content="${escHtml(opts.description)}">
  <meta name="twitter:image" content="${escHtml(ogImage)}">
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
    <p>&copy; ${new Date().getFullYear()} <a href="${escHtml(opts.baseUrl)}">ShiurPod</a> · <a href="${escHtml(opts.baseUrl)}/privacy">Privacy</a> · <a href="${escHtml(opts.baseUrl)}/terms">Terms</a></p>
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
    { column: "torahdownloads_speaker_id", type: "INTEGER" },
    { column: "torahdownloads_shiur_id", type: "INTEGER", table: "episodes" },
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

async function serveLandingPage({
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
  res.setHeader("Cache-Control", "no-cache");
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

  // baseUrl:"/app" (app.json) means the SPA runs under /app natively, so the
  // old prefix-strip routerFix is gone — serve the exported index.html as-is.
  const serveStaticWebApp = (res: Response) => {
    for (const p of [webappIndexPath, staticIndexPath]) {
      if (fs.existsSync(p)) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        // Always revalidate index.html so a new web deploy (new hashed bundle)
        // is picked up immediately instead of Safari serving a stale shell
        // that references an old/crashing bundle. The bundle files themselves
        // are content-hashed, so they stay cacheable.
        res.setHeader("Cache-Control", "no-cache");
        res.send(fs.readFileSync(p, "utf-8"));
        return true;
      }
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
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(await resp.text());
    } catch {
      if (!serveStaticWebApp(res)) {
        res.status(502).send(loadingHtml);
      }
    }
  };

  // 301 old /webapp links → /app (users have shared /webapp/... URLs).
  app.get(["/webapp", "/webapp/*path"], (req: Request, res: Response) => {
    res.redirect(301, req.originalUrl.replace(/^\/webapp/, "/app") || "/app");
  });

  // Serve the SPA under /app. With baseUrl:"/app", the export references
  // /app/_expo, /app/assets, /app/favicon.ico — all served by the static
  // mount from webappBuildPath (which lays them out at that root). Static is
  // registered FIRST so asset files win; the index.html handlers below catch
  // the exact /app and any /app/* client route (SPA routing).
  if (isProduction) {
    app.use("/app", express.static(webappBuildPath) as any);
  } else {
    // Dev: Metro serves under the same baseUrl — forward the asset paths.
    app.use("/app/node_modules", proxyToExpo as any);
    app.use("/app/_expo", proxyToExpo as any);
    app.use("/app/assets", proxyToExpo as any);
  }
  app.get("/app", serveExpoWebApp as any);
  app.get("/app/*path", serveExpoWebApp as any);

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

  // SEO: complete index of all maggidei shiur (linked from the landing
  // footer) — the crawlable path into every speaker page.
  app.get("/speakers", async (req: Request, res: Response) => {
    try {
      const groups = await storage.getActiveFeedsGroupedByAuthor();
      const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
      const host = req.header("x-forwarded-host") || req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const seen = new Set<string>();
      const items: string[] = [];
      for (const g of [...groups].sort((a, b) => (a.author || "").localeCompare(b.author || ""))) {
        if (!g.author) continue;
        const slug = toSpeakerSlug(g.author);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        const count = g.feeds?.length || 0;
        items.push(`<li class="feed-card"><a href="${baseUrl}/${slug}">${escHtml(g.author)}</a>${count ? `<span class="feed-author">${count} show${count > 1 ? "s" : ""}</span>` : ""}</li>`);
      }
      const jsonLd = JSON.stringify({
        "@context": "https://schema.org", "@type": "CollectionPage",
        name: "Maggidei Shiur - Torah Speakers", url: `${baseUrl}/speakers`,
        isPartOf: { "@type": "WebSite", name: "ShiurPod", url: baseUrl },
        numberOfItems: items.length,
      });
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(renderSeoPage({
        title: "All Maggidei Shiur - Torah Speakers | ShiurPod",
        description: `Browse ${items.length} maggidei shiur on ShiurPod — Torah shiurim and lectures from your favorite speakers.`,
        canonicalUrl: `${baseUrl}/speakers`, baseUrl,
        heading: "Maggidei Shiur", subheading: `${items.length} speakers`,
        contentHtml: `<ul class="feed-list">${items.join("")}</ul>`,
        jsonLd,
      }));
    } catch { res.status(500).send("Server error"); }
  });

  // SEO: legacy /speaker/{slug} → 301 to the pretty top-level /{slug}.
  app.get("/speaker/:author", (req: Request, res: Response) => {
    res.redirect(301, "/" + req.params.author);
  });

  // SEO: Sitemap
  app.get("/sitemap.xml", async (_req: Request, res: Response) => {
    try {
      const protocol = _req.header("x-forwarded-proto") || _req.protocol || "https";
      const host = _req.header("x-forwarded-host") || _req.get("host");
      const baseUrl = `${protocol}://${host}`;
      const cats = await storage.getAllCategories();
      const allFeeds = await storage.getActiveFeeds();
      // Dedupe speaker slugs so each pretty URL appears once (collisions).
      const speakerSlugs = [...new Set(allFeeds.filter(f => f.author).map(f => toSpeakerSlug(f.author!)).filter(Boolean))];

      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      xml += `  <url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;
      for (const cat of cats) {
        xml += `  <url><loc>${baseUrl}/category/${cat.slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>\n`;
      }
      for (const slug of speakerSlugs) {
        xml += `  <url><loc>${baseUrl}/${slug}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
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

  // ── Deep linking: iOS Universal Links + Android App Links ─────────────
  // Lets a shared episode/speaker URL open the app (if installed) instead
  // of the browser. Requires matching native config (app.json
  // ios.associatedDomains + android.intentFilters) shipped in a native
  // build. Served at both /.well-known/* and the legacy root path.
  const aasa = {
    applinks: {
      apps: [],
      details: [{
        appID: "6NHBUTFG94.com.shiurpod.app",
        // Open speaker + episode pages in-app; exclude infra + the webapp itself.
        paths: ["NOT /api/*", "NOT /app/*", "NOT /webapp/*", "NOT /admin", "NOT /assets/*", "NOT /_expo/*", "NOT /.well-known/*", "/*"],
      }],
    },
  };
  const serveAasa = (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(JSON.stringify(aasa));
  };
  app.get("/.well-known/apple-app-site-association", serveAasa as any);
  app.get("/apple-app-site-association", serveAasa as any);

  app.get("/.well-known/assetlinks.json", (_req: Request, res: Response) => {
    // Play App Signing cert SHA-256 — set ANDROID_SHA256_CERT_FINGERPRINT
    // (from Play Console → App integrity → App signing) so Android verifies
    // the link. Multiple fingerprints comma-separated (e.g. upload + Play).
    const fps = (process.env.ANDROID_SHA256_CERT_FINGERPRINT || "").split(",").map(s => s.trim()).filter(Boolean);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(JSON.stringify(fps.length ? [{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "com.shiurpod.app", sha256_cert_fingerprints: fps },
    }] : []));
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

  // ── SEO: rich top-level speaker + episode pages ──────────────────────
  //   /{slug}                       → speaker page
  //   /{slug}/{title-slug}-{uuid}   → episode page
  // Registered after static-file serving + all explicit routes, before the
  // SPA fallback: real files win, reserved paths + unknown slugs fall
  // through (next()). The ".includes('.')" guard rejects asset requests.
  const SEO_RESERVED = new Set(["app", "api", "webapp", "admin", "privacy", "terms", "support", "category", "speaker", "speakers", "sitemap.xml", "robots.txt", "favicon.ico", "favicon.png", "apple-touch-icon.png", "apple-touch-icon-precomposed.png", "assets", "_expo", "node_modules", "share", "manifest", "podcast", "maggid-shiur", "player", "queue", "storage", "stats", "debug-logs", "legal", "onboarding", "settings", "(tabs)"]);
  const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const seoBaseUrl = (req: Request) => {
    const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
    const host = req.header("x-forwarded-host") || req.get("host");
    return `${protocol}://${host}`;
  };
  const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const episodeUrl = (baseUrl: string, slug: string, ep: { id: string; title: string }) =>
    `${baseUrl}/${slug}/${slugify(ep.title)}-${ep.id}`;
  // 60s in-memory cache of the grouped-speakers list so unknown-slug
  // requests (bots hitting random paths) don't each hit the DB.
  let _groupsCache: { at: number; data: Awaited<ReturnType<typeof storage.getActiveFeedsGroupedByAuthor>> } | null = null;
  const getGroupsCached = async () => {
    if (_groupsCache && Date.now() - _groupsCache.at < 60_000) return _groupsCache.data;
    const data = await storage.getActiveFeedsGroupedByAuthor();
    _groupsCache = { at: Date.now(), data };
    return data;
  };
  // Resolve a speaker slug → its feed group. Collision (two authors → same
  // slug) resolves to the group with the most feeds (deterministic).
  const resolveSpeakerGroup = async (slug: string) => {
    const groups = await getGroupsCached();
    let best: (typeof groups)[number] | null = null;
    for (const g of groups) {
      if (!g.author) continue;
      // Match the clean slug or the raw slug (so old /…-shiurim links still resolve).
      if (toSpeakerSlug(g.author) !== slug && slugify(g.author) !== slug) continue;
      if (!best || (g.feeds?.length || 0) > (best.feeds?.length || 0)) best = g;
    }
    return best;
  };

  // Episode page (2-segment) — registered before the 1-segment speaker route.
  app.get("/:speakerSlug/:episodeSlug", async (req: Request, res: Response, next: NextFunction) => {
    const speakerSlug = String(req.params.speakerSlug);
    const episodeSlug = String(req.params.episodeSlug);
    if (speakerSlug.includes(".") || SEO_RESERVED.has(speakerSlug)) return next();
    const m = episodeSlug.match(UUID_RE);
    if (!m) return next();
    try {
      const ep = await storage.getEpisodeById(m[1]);
      if (!ep) return next();
      const group = await resolveSpeakerGroup(speakerSlug);
      const feed = group?.feeds.find(f => f.id === ep.feedId);
      const baseUrl = seoBaseUrl(req);
      const speakerName = group?.author || feed?.author || "ShiurPod";
      const cleanSpeakerSlug = group ? toSpeakerSlug(group.author) : slugify(speakerName);
      const canonicalUrl = episodeUrl(baseUrl, cleanSpeakerSlug, ep);
      const img = ep.imageUrl || feed?.imageUrl || group?.imageUrl || null;
      const descRaw = ep.description ? stripHtml(ep.description) : `Listen to "${ep.title}" by ${speakerName} on ShiurPod.`;
      const desc = descRaw.substring(0, 300);
      const dateStr = ep.publishedAt ? new Date(ep.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
      const appLink = `${baseUrl}/app/player?e=${encodeURIComponent(ep.id)}`;
      const jsonLd = JSON.stringify({
        "@context": "https://schema.org", "@type": "PodcastEpisode",
        name: ep.title, url: canonicalUrl,
        ...(ep.publishedAt ? { datePublished: new Date(ep.publishedAt).toISOString() } : {}),
        description: desc,
        ...(img ? { image: img } : {}),
        partOfSeries: { "@type": "PodcastSeries", name: `${speakerName} Shiurim`, url: `${baseUrl}/${cleanSpeakerSlug}` },
        // Stored YouTube audio is recorded as a server-relative path. That's
        // fine for the <audio> tag below (same origin) but structured data is
        // consumed off-site, so it needs an absolute URL.
        associatedMedia: {
          "@type": "AudioObject",
          contentUrl: ep.audioUrl?.startsWith("/") ? `${baseUrl}${ep.audioUrl}` : ep.audioUrl,
        },
      });
      const content =
        (img ? `<div style="text-align:center;margin-bottom:20px"><img src="${escHtml(img)}" alt="${escHtml(ep.title)}" style="width:220px;height:220px;border-radius:16px;object-fit:cover"></div>` : "") +
        (group ? `<p style="text-align:center;margin-bottom:8px"><a href="${escHtml(`${baseUrl}/${cleanSpeakerSlug}`)}" style="color:#3b82f6;text-decoration:none;font-weight:600">${escHtml(speakerName)}</a></p>` : "") +
        (dateStr ? `<p style="text-align:center;color:#64748b;font-size:13px;margin-bottom:16px">${escHtml(dateStr)}${ep.duration ? ` · ${escHtml(ep.duration)}` : ""}</p>` : "") +
        `<audio controls preload="none" src="${escHtml(ep.audioUrl)}" style="width:100%;max-width:640px;display:block;margin:0 auto 24px"></audio>` +
        `<div style="text-align:center;margin-bottom:28px"><a class="nav-cta" href="${escHtml(appLink)}">Open in app</a></div>` +
        (ep.description ? `<div style="color:#94a3b8;max-width:640px;margin:0 auto;line-height:1.7">${escHtml(stripHtml(ep.description).substring(0, 1500))}</div>` : "");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(renderSeoPage({
        title: `${ep.title} - ${speakerName} | ShiurPod`,
        description: desc.substring(0, 160), canonicalUrl, baseUrl,
        heading: ep.title, subheading: speakerName,
        contentHtml: content, jsonLd, imageUrl: img, ogType: "music.song",
      }));
    } catch { return next(); }
  });

  // Speaker page (1-segment).
  app.get("/:speakerSlug", async (req: Request, res: Response, next: NextFunction) => {
    const slug = String(req.params.speakerSlug);
    if (slug.includes(".") || SEO_RESERVED.has(slug)) return next();
    try {
      const group = await resolveSpeakerGroup(slug);
      if (!group) return next();
      const baseUrl = seoBaseUrl(req);
      const name = group.author;
      const cleanSlug = toSpeakerSlug(name);
      const canonicalUrl = `${baseUrl}/${cleanSlug}`;
      const img = group.imageUrl || group.feeds.find(f => f.imageUrl)?.imageUrl || null;
      const bio = (group.bio && stripHtml(group.bio)) || `Listen to Torah shiurim by ${name} on ShiurPod. Stream online or download for offline learning.`;
      const feedIds = group.feeds.map(f => f.id).join(",");
      const appLink = `${baseUrl}/app/maggid-shiur/${encodeURIComponent(name)}?feedIds=${encodeURIComponent(feedIds)}`;
      const epLists = await Promise.all(group.feeds.slice(0, 6).map(f =>
        storage.getEpisodesByFeedPaginated(f.id, 1, 10, "newest").catch(() => [])
      ));
      const episodes = epLists.flat()
        .sort((a, b) => (b.publishedAt ? new Date(b.publishedAt).getTime() : 0) - (a.publishedAt ? new Date(a.publishedAt).getTime() : 0))
        .slice(0, 25);
      // Total shiurim across all the speaker's shows (not just the recent list).
      const totalShiurim = (await Promise.all(group.feeds.map(f => storage.getEpisodeCountByFeed(f.id).catch(() => 0)))).reduce((a, b) => a + b, 0);
      const epHtml = episodes.map(e => {
        const date = e.publishedAt ? new Date(e.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
        return `<li class="feed-card"><a href="${escHtml(episodeUrl(baseUrl, cleanSlug, e))}">${escHtml(e.title)}</a>${date ? `<span class="feed-author">${escHtml(date)}</span>` : ""}</li>`;
      }).join("");
      const showsHtml = group.feeds.map(f => `<li class="feed-card"><a href="${escHtml(appLink)}">${escHtml(f.title)}</a>${f.description ? `<p>${escHtml(stripHtml(f.description).substring(0, 160))}</p>` : ""}</li>`).join("");
      const jsonLd = JSON.stringify([
        { "@context": "https://schema.org", "@type": "ProfilePage", name: `${name} - Torah Shiurim`, url: canonicalUrl, mainEntity: { "@type": "Person", name, ...(img ? { image: img } : {}), description: bio } },
        { "@context": "https://schema.org", "@type": "ItemList", itemListElement: episodes.map((e, i) => ({ "@type": "ListItem", position: i + 1, name: e.title, url: episodeUrl(baseUrl, cleanSlug, e) })) },
      ]);
      const content =
        (img ? `<div style="text-align:center;margin-bottom:20px"><img src="${escHtml(img)}" alt="${escHtml(name)}" style="width:180px;height:180px;border-radius:16px;object-fit:cover"></div>` : "") +
        `<p style="color:#94a3b8;max-width:640px;margin:0 auto 20px;text-align:center;line-height:1.6">${escHtml(bio)}</p>` +
        `<div style="text-align:center;margin-bottom:32px"><a class="nav-cta" href="${escHtml(appLink)}">Open in app</a></div>` +
        (epHtml ? `<h2 style="font-size:20px;margin:24px 0 12px">Recent shiurim</h2><ul class="feed-list">${epHtml}</ul>` : "") +
        `<h2 style="font-size:20px;margin:32px 0 12px">Shows</h2><ul class="feed-list">${showsHtml}</ul>`;
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(renderSeoPage({
        title: `${name} - Torah Shiurim & Lectures | ShiurPod`,
        description: bio.substring(0, 160), canonicalUrl, baseUrl,
        heading: name, subheading: `${group.feeds.length} show${group.feeds.length > 1 ? "s" : ""}${totalShiurim ? ` · ${totalShiurim.toLocaleString()} shiurim` : ""}`,
        contentHtml: content, jsonLd, imageUrl: img, ogType: "profile",
      }));
    } catch { return next(); }
  });

  // The app now lives under /app; 301 old bare client-route links
  // (shiurpod.com/podcast/… etc, from the previous strip-to-root scheme)
  // to their /app equivalents so shared/bookmarked links keep working.
  const clientRoutes = ["/podcast", "/maggid-shiur", "/player", "/queue", "/storage", "/stats", "/debug-logs", "/legal", "/onboarding", "/settings"];
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const isClientRoute = clientRoutes.some(r => req.path.startsWith(r)) || req.path === "/(tabs)";
    if (!isClientRoute) return next();
    res.redirect(301, "/app" + req.originalUrl);
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

// Cron tick frequency. Drives all auto-refresh checks. Per-source staleness
// thresholds (STALE_INTERVALS below) decide which feeds actually re-fetch
// each tick — KH/TAT/OU stay on their longer cadences regardless.
const FEED_REFRESH_INTERVAL = 30 * 60 * 1000;
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

export async function refreshOneFeed(feed: { id: string; title: string; rssUrl: string; etag?: string | null; lastModifiedHeader?: string | null; tatSpeakerId?: number | null; alldafAuthorId?: number | null; allmishnahAuthorId?: number | null; allparshaAuthorId?: number | null; allhalachaAuthorId?: number | null; kolhalashonRavId?: number | null; torahdownloadsSpeakerId?: number | null; youtubePlaylistId?: string | null }): Promise<RefreshResult> {
  const start = Date.now();

  // Detect every source this feed pulls from. A feed can have multiple
  // simultaneously (e.g. an RSS podcast that's also linked to a TAT speaker
  // and an AllHalacha author). The previous logic returned early at the
  // first URL-scheme match, which silently dropped sources for any feed
  // whose base URL was non-RSS — e.g. a feed with rssUrl=allhalacha://...
  // also linked to a TAT speakerId would only pull AllHalacha and never
  // touch TAT. Now: always check every source independently and refresh
  // each one that has a non-null id, regardless of URL scheme.
  const isTatUrl = feed.rssUrl.startsWith("tat://");
  const isKhUrl = feed.rssUrl.startsWith("kh://");
  const isTdUrl = feed.rssUrl.startsWith("td://");
  const isYtUrl = feed.rssUrl.startsWith("yt://");
  const isOUUrl = Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme));
  const effectiveTatSpeakerId = extractTatSpeakerId(feed);
  const effectiveKhRavId = extractKhRavId(feed);
  const effectiveTdSpeakerId = extractTorahDownloadsSpeakerId(feed);
  const effectiveYtPlaylistId = extractYouTubePlaylistId(feed);

  let totalNew = 0;

  if (effectiveTatSpeakerId) {
    try {
      const r = await refreshTATFeedEpisodes({ id: feed.id, title: feed.title, tatSpeakerId: effectiveTatSpeakerId }, feed);
      totalNew += r.newEpisodes;
    } catch (e: any) {
      console.log(`TAT refresh failed for ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    }
  }

  // OU platforms: a feed may carry multiple OU platform IDs (e.g. AllDaf +
  // AllParsha both linked to the same speaker). Iterate every one that's
  // non-null instead of relying on detectOUPlatform's first-match return —
  // otherwise extra platforms are silently dropped on every cron tick.
  for (const cfg of Object.values(OU_PLATFORMS)) {
    const authorId = (feed as any)[cfg.feedIdField];
    // Fallback for feeds whose URL is the API scheme but the column wasn't
    // populated (legacy data path) — match the URL exactly once.
    const urlAuthorId = (!authorId && feed.rssUrl.startsWith(cfg.urlScheme))
      ? parseInt(feed.rssUrl.replace(cfg.urlScheme, ""), 10) || null
      : null;
    const effectiveAuthorId = authorId || urlAuthorId;
    if (!effectiveAuthorId) continue;
    try {
      const r = await refreshOUFeedEpisodes(cfg.key, { id: feed.id, title: feed.title, authorId: effectiveAuthorId }, feed);
      totalNew += r.newEpisodes;
    } catch (e: any) {
      console.log(`${cfg.label} refresh failed for ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    }
  }

  if (effectiveKhRavId) {
    try {
      const r = await refreshKHFeedEpisodes({ id: feed.id, title: feed.title, kolhalashonRavId: effectiveKhRavId }, feed);
      totalNew += r.newEpisodes;
    } catch (e: any) {
      console.log(`KH refresh failed for ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    }
  }

  if (effectiveTdSpeakerId) {
    try {
      const r = await refreshTorahDownloadsFeedEpisodes({ id: feed.id, title: feed.title, torahdownloadsSpeakerId: effectiveTdSpeakerId }, feed);
      totalNew += r.newEpisodes;
    } catch (e: any) {
      console.log(`TorahDownloads refresh failed for ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    }
  }

  // YouTube ingest only fills the review queue — it never creates episodes, so
  // totalNew stays untouched here. Approval (admin action) is what produces
  // episodes and fires pushes.
  if (effectiveYtPlaylistId) {
    try {
      await refreshYouTubeFeedEpisodes(
        { id: feed.id, title: feed.title, youtubePlaylistId: effectiveYtPlaylistId },
        feed,
      );
    } catch (e: any) {
      console.log(`YouTube refresh failed for ${feed.title}: ${(e as Error).message?.slice(0, 100)}`);
    }
  }

  // Skip RSS parsing when the URL is an API-only scheme — it'd just 404 or
  // worse, drop into axios with a non-HTTP URL and throw. RSS-base feeds
  // still parse their RSS even if a non-RSS source already ran above.
  if (isTatUrl || isOUUrl || isKhUrl || isTdUrl || isYtUrl) {
    return {
      newEpisodes: totalNew,
      method: 'stream',
      durationMs: Date.now() - start,
      episodesFound: totalNew,
    };
  }

  // RSS refresh — incremental: walk newest-first, stop after 20 consecutive
  // already-known guids. Saves bandwidth + parse time on big archives.
  const knownGuids = await storage.getRecentEpisodeGuids(feed.id, 50);
  const parsed = await parseFeed(
    feed.id,
    feed.rssUrl,
    {
      etag: feed.etag,
      lastModified: feed.lastModifiedHeader,
    },
    { knownGuids, stopAfterConsecutive: 20 },
  );

  if (parsed === null) {
    await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });
    return { newEpisodes: totalNew, method: 'cached', durationMs: Date.now() - start, episodesFound: totalNew };
  }

  let episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));

  // Within-batch dedup. Some RSS feeds (e.g. Libsyn-hosted podcasts) emit
  // two <item>s per shiur — one for audio and one for video — with titles
  // differing only by an ".audio" suffix and identical publishedAt. Both
  // would land in episodeData side-by-side, so the cross-source dedup
  // below (which compares NEW vs EXISTING) wouldn't catch them. Collapse
  // them here BEFORE the cross-source pass.
  episodeData = dedupWithinBatch(episodeData);

  // Cross-source dedup for merged RSS feeds. RSS runs LAST in the fan-out
  // above, so by now the DB has any TAT / OU / KH / TD episodes already
  // ingested this cycle (or in prior cycles). Filter the RSS batch against
  // those so the same shiur doesn't appear twice when an RSS podcast also
  // happens to be on TAT — match on date (within 24h) AND title (case-
  // insensitive equality after trim) so a "same name and same date" rule
  // applies, plus duration as a fallback when titles are slightly mangled.
  if (isMergedFeed(feed as any)) {
    const existingEpisodes = await storage.getEpisodesByFeed(feed.id);
    episodeData = filterCrossSourceDuplicates(episodeData, existingEpisodes, "");
  }

  const inserted = await storage.upsertEpisodes(feed.id, episodeData);

  const updateData: any = { lastFetchedAt: new Date() };
  if (parsed.responseHeaders?.etag) {
    updateData.etag = parsed.responseHeaders.etag;
  }
  if (parsed.responseHeaders?.lastModified) {
    updateData.lastModifiedHeader = parsed.responseHeaders.lastModified;
  }
  await storage.updateFeed(feed.id, updateData);

  if (inserted.length > 0 && inserted.length <= PUSH_BACKFILL_THRESHOLD) {
    for (const ep of inserted.slice(0, 3)) {
      sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id, publishedAt: (ep as any).publishedAt }, feed.title).catch(() => {});
    }
  }

  return {
    newEpisodes: inserted.length + totalNew,
    method: parsed.fetchMethod || 'stream',
    durationMs: parsed.fetchDurationMs || (Date.now() - start),
    episodesFound: parsed.episodes.length + totalNew,
  };
}

let isAutoRefreshing = false;

// Feed type classification for concurrency and stale intervals
function getFeedType(feed: { rssUrl: string }): 'rss' | 'tat' | 'ou' | 'kh' | 'td' | 'yt' {
  if (feed.rssUrl.startsWith("kh://")) return 'kh';
  if (feed.rssUrl.startsWith("tat://")) return 'tat';
  if (feed.rssUrl.startsWith("td://")) return 'td';
  if (feed.rssUrl.startsWith("yt://")) return 'yt';
  if (Object.values(OU_PLATFORMS).some(c => feed.rssUrl.startsWith(c.urlScheme))) return 'ou';
  return 'rss';
}

// Tiered stale intervals: RSS 30m, TAT/OU 2h, KH/TD 4h.
// RSS is cheap (304-short-circuit when nothing changed) so we can poll
// frequently for fresh user-visible content. The others have heavier per-
// fetch cost (or stricter rate limits) so they stay at the longer cadence.
// TD is HTML-scraped at 2 RPS, so 4h matches its cost profile.
const STALE_INTERVALS: Record<string, number> = {
  rss: 30 * 60 * 1000,       // 30 minutes
  tat: 2 * 60 * 60 * 1000,   // 2 hours
  ou:  2 * 60 * 60 * 1000,   // 2 hours
  kh:  4 * 60 * 60 * 1000,   // 4 hours
  td:  4 * 60 * 60 * 1000,   // 4 hours
  // YouTube costs API quota per crawl (10k units/day, shared across every
  // playlist) and nothing it finds is user-visible until a human approves it,
  // so there's no freshness benefit to polling harder.
  yt:  6 * 60 * 60 * 1000,   // 6 hours
};

// Concurrency per feed type (keep total across all types ≤ pool max to avoid DB exhaustion).
// TD is held to 1 because the adapter enforces a process-global 2 RPS throttle
// to torahdownloads.com — running multiple TD refreshes in parallel just
// serializes them on the throttle anyway, and we'd rather hold the DB slot.
const CONCURRENCY: Record<string, number> = {
  rss: 3,
  tat: 4,
  ou:  3,
  kh:  5,
  td:  1,
  // Held low so a burst of playlist crawls can't drain the daily API quota in
  // one cycle.
  yt:  2,
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
    const feedsByType: Record<string, typeof staleFeeds> = { rss: [], tat: [], ou: [], kh: [], td: [], yt: [] };
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
      ...processPool(feedsByType.td, CONCURRENCY.td),
      ...processPool(feedsByType.yt, CONCURRENCY.yt),
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

  // TAT — only sync if admin has TAT enabled. "Enabled" = at least one
  // TAT-only feed is currently is_active=true. If admin has toggled TAT
  // off, all TAT-only feeds are is_active=false, and we skip the sync so
  // the full speaker list doesn't get recreated + re-activated on every
  // deploy.
  try {
    const allFeeds = await storage.getAllFeedsIncludingDisabledTAT();
    const hasActiveTAT = allFeeds.some(f => f.tatSpeakerId && f.rssUrl.startsWith("tat://") && f.isActive);
    if (hasActiveTAT) {
      const tatResult = await syncTATSpeakers();
      log(`TAT speaker sync: ${tatResult.created} created, ${tatResult.linked} linked`);
    } else {
      log("TAT speaker sync: skipped (admin has disabled TAT)");
    }
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

  // TorahDownloads
  try {
    const tdResult = await syncTorahDownloadsSpeakers();
    log(`TorahDownloads speaker sync: ${tdResult.created} created, ${tdResult.linked} linked`);
  } catch (e: any) {
    log(`TorahDownloads speaker sync error: ${e.message}`);
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
  // Turns approved YouTube videos into stored MP3s, then into episodes.
  startYouTubeMediaWorker();
  // Keeps feeds.popularity / episodes.popularity current so search ranking
  // never has to join an aggregate at query time.
  startPopularityRefresh();

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
  // Search schema: cheap objects only (functions, columns, triggers, lexicon).
  // Index builds and the backfill stay in scripts/search-bootstrap.ts so a
  // deploy never blocks on them; this only verifies and reports.
  await bootstrapSearch().catch((e) =>
    console.error(`Search bootstrap error: ${e?.message?.slice(0, 160)}`),
  );

  setupCors(app);
  app.use(compression());

  // Rate limiting — general (200 req/min per IP) and strict for write endpoints (30 req/min)
  //
  // ipKeyGenerator wrapping is required by express-rate-limit v7+ when the
  // custom keyGenerator returns an IP — for IPv6 it groups by /64 prefix so
  // a client can't bypass the limit by walking through the low 64 bits.
  // Without it, the library logs ERR_ERL_KEY_GEN_IPV6 on every startup and
  // (more importantly) IPv6 clients can effectively bypass the cap.
  const clientIp = (req: any): string =>
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    // Authenticated admin operations are exempt — they're behind Basic auth and
    // a bulk sync can legitimately exceed 200 req/min. But NOT the login
    // endpoint: exempting it left an unauthenticated, unthrottled, bcrypt-backed
    // endpoint open to unlimited password guessing. It gets writeLimiter below.
    skip: (req) => req.path.startsWith("/api/admin") && req.path !== "/api/admin/login",
  });
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    message: { error: "Too many requests, please try again later" },
  });
  // Login gets its own, much stricter bucket rather than sharing writeLimiter
  // with feedback/contact. A human typing a password wrong needs a handful of
  // tries; nothing legitimate needs 30 a minute. Measured on the deployed fix:
  // at 30/min a 150-request burst still let 146 through before 429s appeared,
  // because concurrent requests race the counter. A 15-minute window shrinks
  // that leak by an order of magnitude and makes sustained guessing useless.
  //
  // Caveat worth knowing: this is an in-memory store, so it resets on every
  // deploy and is per-instance. It raises the cost of online guessing; it is
  // not a lockout. A persistent store or an account-level lockout would be the
  // stronger fix if this endpoint ever gets seriously targeted.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    skipSuccessfulRequests: true, // only failed attempts count against you
    message: { error: "Too many login attempts, please try again later" },
  });

  app.use("/api/", generalLimiter);
  app.use("/api/admin/login", loginLimiter);
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
