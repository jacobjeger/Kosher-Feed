import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { feeds, episodes, contributorShows, contributorEpisodes } from "@shared/schema";
import type { ContributorShow, ContributorEpisode } from "@shared/schema";
import { publicUrl } from "../r2";
import { contributorFeedUrl } from "../feed-schemes";

// Mirrors contributor shows into the main catalog so they appear in the app,
// in browse, and in search.
//
// This is a DIRECT WRITE, not RSS self-ingestion, for reasons the spec's own
// requirements force:
//
//   * Unpublishing must remove an episode from the catalog. Removing an item
//     from a feed is invisible to a pull-based ingester — it only ever adds.
//   * upsertEpisodes is insert-only (there is no onConflictDoUpdate anywhere),
//     so edits would never propagate.
//   * parseFeed runs descriptions through stripHtml, destroying the CDATA HTML
//     a creator wrote.
//   * Publish latency would be up to 30 minutes.
//
// TWO RULES, both load-bearing:
//
//   1. NEVER write title_fold, search_tsv or popularity. Database triggers own
//      those columns; writing them directly desynchronises search ranking in a
//      way that is invisible until someone notices results are wrong. Inserting
//      without them fires the triggers, so contributor episodes become
//      searchable for free.
//   2. NEVER add a column to feeds or episodes for this. The episodes table has
//      1.65M rows; the contributor badge is derived from
//      contributor_shows.feed_id instead.

/** Prefix that marks a catalog episode as contributor-owned. */
export const CATALOG_GUID_PREFIX = "cp-";

export function catalogGuid(contributorEpisodeId: string): string {
  return `${CATALOG_GUID_PREFIX}${contributorEpisodeId}`;
}

/**
 * episodes.duration is TEXT in "HH:MM:SS", not a number of seconds.
 *
 * Verified against production rows ("00:42:55"). Writing an integer here
 * typechecks against nothing useful and renders as a wrong duration in the app
 * on every contributor episode.
 */
export function formatCatalogDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const s = Math.round(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/**
 * Create or update the catalog feed row for a show.
 *
 * Idempotent: safe to call on every publish.
 */
export async function syncShowToCatalog(show: ContributorShow): Promise<string> {
  const rssUrl = contributorFeedUrl(show.id);
  const imageUrl = show.artworkKey ? publicUrl(show.artworkKey) : null;

  if (show.feedId) {
    const [existing] = await db.select().from(feeds).where(eq(feeds.id, show.feedId)).limit(1);
    if (existing) {
      await db
        .update(feeds)
        .set({
          title: show.title,
          description: show.description,
          author: show.author,
          imageUrl,
          rssUrl,
          isActive: show.status === "live",
          // Hidden from browse until it has at least one episode — an empty
          // show on the home screen looks broken.
          categoryId: show.categoryId ?? existing.categoryId,
        })
        .where(eq(feeds.id, show.feedId));
      return show.feedId;
    }
  }

  // A feed may already exist from an earlier run that failed before feedId was
  // recorded. Match on the scheme URL, which is unique per show.
  const [byUrl] = await db.select().from(feeds).where(eq(feeds.rssUrl, rssUrl)).limit(1);
  if (byUrl) {
    await db.update(contributorShows).set({ feedId: byUrl.id }).where(eq(contributorShows.id, show.id));
    return byUrl.id;
  }

  const [created] = await db
    .insert(feeds)
    .values({
      title: show.title,
      rssUrl,
      description: show.description,
      author: show.author,
      imageUrl,
      categoryId: show.categoryId ?? null,
      isActive: show.status === "live",
      showInBrowse: false, // flipped on once the first episode lands
      sourceNetwork: "ShiurPod Contributors",
      // title_fold / search_tsv / popularity deliberately absent — triggers own them.
    })
    .returning();

  await db.update(contributorShows).set({ feedId: created.id }).where(eq(contributorShows.id, show.id));
  return created.id;
}

/**
 * Publish one episode into the catalog.
 *
 * Uses a stable guid (cp-{id}) so republishing updates rather than duplicating.
 */
export async function publishEpisodeToCatalog(
  show: ContributorShow,
  ep: ContributorEpisode,
): Promise<string | null> {
  if (!ep.audioKey || !ep.byteSize) return null;

  const feedId = show.feedId || (await syncShowToCatalog(show));
  const guid = catalogGuid(ep.id);
  const audioUrl = publicUrl(ep.audioKey);

  const [existing] = await db
    .select({ id: episodes.id })
    .from(episodes)
    .where(and(eq(episodes.feedId, feedId), eq(episodes.guid, guid)))
    .limit(1);

  if (existing) {
    await db
      .update(episodes)
      .set({
        title: ep.title,
        description: ep.description,
        audioUrl,
        duration: formatCatalogDuration(ep.durationSeconds),
        publishedAt: ep.pubDate ?? new Date(),
        imageUrl: ep.artworkKey ? publicUrl(ep.artworkKey) : null,
      })
      .where(eq(episodes.id, existing.id));
    await db
      .update(contributorEpisodes)
      .set({ catalogEpisodeId: existing.id })
      .where(eq(contributorEpisodes.id, ep.id));
    await refreshFeedEpisodeCount(feedId);
    return existing.id;
  }

  const [created] = await db
    .insert(episodes)
    .values({
      feedId,
      title: ep.title,
      description: ep.description,
      audioUrl,
      duration: formatCatalogDuration(ep.durationSeconds),
      publishedAt: ep.pubDate ?? new Date(),
      guid,
      imageUrl: ep.artworkKey ? publicUrl(ep.artworkKey) : null,
      // title_fold / search_tsv / popularity omitted on purpose.
    })
    .returning();

  await db
    .update(contributorEpisodes)
    .set({ catalogEpisodeId: created.id })
    .where(eq(contributorEpisodes.id, ep.id));

  // Reveal the show once it actually has something to listen to.
  await db.update(feeds).set({ showInBrowse: true }).where(eq(feeds.id, feedId));
  await refreshFeedEpisodeCount(feedId);

  return created.id;
}

/** Remove one episode from the catalog. This is what RSS ingestion cannot do. */
export async function removeEpisodeFromCatalog(ep: ContributorEpisode): Promise<void> {
  const guid = catalogGuid(ep.id);
  if (ep.catalogEpisodeId) {
    await db.delete(episodes).where(eq(episodes.id, ep.catalogEpisodeId));
  } else {
    await db.delete(episodes).where(eq(episodes.guid, guid));
  }
  await db
    .update(contributorEpisodes)
    .set({ catalogEpisodeId: null })
    .where(eq(contributorEpisodes.id, ep.id));

  const [show] = await db
    .select()
    .from(contributorShows)
    .where(eq(contributorShows.id, ep.showId))
    .limit(1);
  if (show?.feedId) await refreshFeedEpisodeCount(show.feedId);
}

/** Take a whole show out of the catalog — suspension, or a show going back to draft. */
export async function removeShowFromCatalog(show: ContributorShow): Promise<void> {
  if (!show.feedId) return;
  await db.delete(episodes).where(eq(episodes.feedId, show.feedId));
  await db
    .update(feeds)
    .set({ isActive: false, showInBrowse: false, episodeCount: 0 })
    .where(eq(feeds.id, show.feedId));
  await db
    .update(contributorEpisodes)
    .set({ catalogEpisodeId: null })
    .where(eq(contributorEpisodes.showId, show.id));
}

/**
 * Keep feeds.episode_count honest.
 *
 * The popularity job normally maintains it, but that runs on a schedule — a
 * direct write that skipped this would leave a visibly wrong count on the show
 * card until the job next ran.
 */
export async function refreshFeedEpisodeCount(feedId: string): Promise<void> {
  await db.execute(sql`
    UPDATE feeds
       SET episode_count = (SELECT count(*)::int FROM episodes WHERE feed_id = ${feedId})
     WHERE id = ${feedId}
  `);
}

/**
 * Reconcile a show's whole catalog presence with its current episodes.
 *
 * Called on publish, unpublish, review decisions and status changes, so the
 * catalog cannot drift from the feed regardless of which path was taken.
 */
export async function reconcileShowCatalog(showId: string): Promise<{
  published: number;
  removed: number;
}> {
  const [show] = await db.select().from(contributorShows).where(eq(contributorShows.id, showId)).limit(1);
  if (!show) return { published: 0, removed: 0 };

  if (show.status !== "live") {
    await removeShowFromCatalog(show as ContributorShow);
    return { published: 0, removed: 1 };
  }

  await syncShowToCatalog(show as ContributorShow);
  const fresh = (await db.select().from(contributorShows).where(eq(contributorShows.id, showId)).limit(1))[0];

  const eps = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.showId, showId));

  let published = 0;
  let removed = 0;
  const now = Date.now();

  for (const ep of eps) {
    // Mirror the feed's own visibility rule exactly: published, media ready,
    // and not future-dated. Any divergence here means the app and the podcast
    // feed disagree about what exists.
    const visible =
      ep.status === "published" &&
      ep.mediaStatus === "ready" &&
      !!ep.audioKey &&
      !!ep.byteSize &&
      (!ep.pubDate || ep.pubDate.getTime() <= now);

    if (visible) {
      await publishEpisodeToCatalog(fresh as ContributorShow, ep as ContributorEpisode);
      published++;
    } else if (ep.catalogEpisodeId) {
      await removeEpisodeFromCatalog(ep as ContributorEpisode);
      removed++;
    }
  }

  return { published, removed };
}
