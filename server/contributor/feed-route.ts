import type { Application, Request, Response, NextFunction } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { contributorShows, contributorEpisodes } from "@shared/schema";
import type { ContributorShow } from "@shared/schema";
import { renderShowFeed } from "../contributor-feed";

// The public podcast feed: GET /feed/{slug}.xml
//
// This URL is permanent. Once a rav submits it to Apple or Spotify, their
// crawlers fetch it on a schedule forever and subscribers' apps resolve
// episodes through it. It can never be renamed, which is why
// contributor_shows.slug is immutable and why "feed" is in SEO_RESERVED.
//
// Serving is cache-first: feed_xml is rendered once at publish time and stored
// on the row. Apple polls hard, so re-rendering per request would mean scanning
// a show's whole episode list on every poll for output that only changes when
// the creator publishes something.

// Express 5 (path-to-regexp v8) does not treat ":slug.xml" the way it reads —
// the dot is a path separator to the matcher, not a literal suffix on the
// param. Match a single segment and strip the extension by hand instead.
const FEED_PATH = "/feed/:file";

export interface BuiltFeed {
  xml: string;
  etag: string;
  lastBuildDate: Date;
  episodeCount: number;
}

/**
 * Render a show's feed from its episodes and cache it on the row.
 *
 * Call this whenever published content changes — publish, unpublish, edit,
 * transcode-complete, artwork change. Anything that does not call it leaves
 * subscribers on stale XML.
 */
export async function buildAndCacheFeed(
  showId: string,
  baseUrl: string,
): Promise<BuiltFeed | null> {
  const [show] = await db.select().from(contributorShows).where(eq(contributorShows.id, showId)).limit(1);
  if (!show) return null;

  const episodes = await db
    .select()
    .from(contributorEpisodes)
    .where(eq(contributorEpisodes.showId, showId))
    .orderBy(desc(contributorEpisodes.pubDate));

  const rendered = renderShowFeed(show as ContributorShow, episodes as any, baseUrl);

  await db
    .update(contributorShows)
    .set({
      feedXml: rendered.xml,
      feedEtag: rendered.etag,
      feedBuiltAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(contributorShows.id, showId));

  return rendered;
}

/** Public base URL, honouring the proxy headers Railway sets. */
function baseUrlOf(req: Request): string {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.EXPO_PUBLIC_API_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  const protocol = req.header("x-forwarded-proto") || req.protocol || "https";
  const host = req.header("x-forwarded-host") || req.get("host");
  return `${protocol}://${host}`;
}

export function registerContributorFeedRoute(app: Application): void {
  app.get(FEED_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = String(req.params.file || "");
      if (!file.toLowerCase().endsWith(".xml")) return next();
      const slug = file.slice(0, -4);
      if (!slug || !/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug)) return next();

      const [show] = await db
        .select()
        .from(contributorShows)
        .where(and(eq(contributorShows.slug, slug), eq(contributorShows.status, "live")))
        .limit(1);

      // A suspended or draft show must 404 rather than 403: the feed URL is
      // public, and a distinguishable response would confirm the slug exists.
      if (!show) return next();

      let xml = show.feedXml;
      let etag = show.feedEtag;
      let built = show.feedBuiltAt;

      // Cache miss — first request after a deploy that cleared it, or a show
      // published before this route existed.
      if (!xml || !etag) {
        const rendered = await buildAndCacheFeed(show.id, baseUrlOf(req));
        if (!rendered) return next();
        xml = rendered.xml;
        etag = rendered.etag;
        built = rendered.lastBuildDate;
      }

      const quoted = `"${etag}"`;
      res.setHeader("ETag", quoted);
      res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
      // Apple and Spotify poll aggressively; an hour of edge caching is well
      // inside their tolerance and keeps the DB out of the hot path.
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (built) res.setHeader("Last-Modified", built.toUTCString());

      // Conditional GET. Every serious podcast client sends If-None-Match, and
      // honouring it is the difference between serving a 300 KB body and 0 bytes
      // on the overwhelming majority of polls.
      const inm = req.header("if-none-match");
      if (inm && (inm === quoted || inm === etag || inm.split(/,\s*/).includes(quoted))) {
        return res.status(304).end();
      }

      res.status(200).send(xml);
    } catch (e: any) {
      console.error(`Contributor feed error: ${e?.message?.slice(0, 200)}`);
      next();
    }
  });
}
