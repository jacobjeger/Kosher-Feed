import { db } from "./db";
import { isApiOnlyUrl } from "./alldaf";
import { feeds, categories, episodes, subscriptions, adminUsers, episodeListens, favorites, playbackPositions, adminNotifications, errorReports, feedback, pushTokens, contactMessages, apkUploads, feedCategories, maggidShiurim, sponsors, notificationPreferences, announcements, announcementDismissals, queueItems, notificationTaps, feedMergeHistory, appConfig, deviceProfiles, conversations, conversationMessages, pageViews } from "@shared/schema";
import type { Feed, InsertFeed, Category, InsertCategory, Episode, Subscription, Favorite, PlaybackPosition, AdminNotification, ErrorReport, Feedback, PushToken, ContactMessage, ApkUpload, FeedCategory, MaggidShiur, InsertMaggidShiur, Sponsor, NotificationPreference, Announcement, AnnouncementDismissal, NotificationTap, AppConfig, DeviceProfile, Conversation, ConversationMessage, PageView } from "@shared/schema";
import { eq, and, desc, asc, inArray, sql, count, ilike } from "drizzle-orm";
import bcrypt from "bcrypt";

export async function getAllCategories(): Promise<Category[]> {
  return db.select().from(categories).orderBy(categories.name);
}

export async function createCategory(data: InsertCategory): Promise<Category> {
  const [cat] = await db.insert(categories).values(data).returning();
  return cat;
}

export async function deleteCategory(id: string): Promise<void> {
  await db.delete(categories).where(eq(categories.id, id));
}

export async function getAllFeeds(): Promise<Feed[]> {
  // Exclude admin-disabled TAT feeds from the default "all feeds" list.
  // When TAT is toggled off, those feeds are soft-deleted (is_active=false)
  // and shouldn't appear in admin analytics / feeds list / vitals. Code
  // that explicitly needs them (the TAT toggle itself) uses
  // getAllFeedsIncludingDisabledTAT() below.
  return db.select().from(feeds)
    .where(sql`NOT (${feeds.rssUrl} LIKE 'tat://%' AND ${feeds.isActive} = false)`)
    .orderBy(desc(feeds.createdAt));
}

/** Includes soft-disabled TAT feeds — only use from the TAT toggle/sync paths. */
export async function getAllFeedsIncludingDisabledTAT(): Promise<Feed[]> {
  return db.select().from(feeds).orderBy(desc(feeds.createdAt));
}

export async function getActiveFeedCount(): Promise<number> {
  const [result] = await db.select({ count: count() }).from(feeds).where(eq(feeds.isActive, true));
  return Number(result.count);
}

export async function getTotalEpisodeCount(): Promise<number> {
  const [result] = await db.select({ count: count() }).from(episodes);
  return Number(result.count);
}

export async function getFeedById(feedId: string): Promise<Feed | undefined> {
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);
  return feed;
}

export async function getActiveFeeds(): Promise<Feed[]> {
  return db.select().from(feeds).where(and(eq(feeds.isActive, true), eq(feeds.showInBrowse, true))).orderBy(feeds.title).limit(1000);
}

// All active feeds including those hidden from browse — used for sync/refresh
export async function getAllActiveFeedsForSync(): Promise<Feed[]> {
  return db.select().from(feeds).where(eq(feeds.isActive, true)).orderBy(feeds.title);
}

export async function activateFeedIfInactive(feedId: string): Promise<void> {
  await db.update(feeds).set({ isActive: true }).where(and(eq(feeds.id, feedId), eq(feeds.isActive, false)));
}

export async function getInactiveKHFeedsForSlowSync(batchSize: number): Promise<Feed[]> {
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72 hours
  return db.select().from(feeds)
    .where(and(
      eq(feeds.isActive, false),
      sql`${feeds.rssUrl} LIKE 'kh://%'`,
      sql`(${feeds.lastFetchedAt} IS NULL OR ${feeds.lastFetchedAt} < ${cutoff})`,
    ))
    .orderBy(feeds.lastFetchedAt) // oldest first
    .limit(batchSize);
}

export async function getFeedsByCategory(categoryId: string): Promise<Feed[]> {
  return db.select().from(feeds).where(and(eq(feeds.categoryId, categoryId), eq(feeds.isActive, true))).orderBy(feeds.title);
}

export async function createFeed(data: InsertFeed): Promise<Feed> {
  const [feed] = await db.insert(feeds).values(data).returning();
  return feed;
}

export async function updateFeed(id: string, data: Partial<InsertFeed & { isActive: boolean; lastFetchedAt: Date; etag: string | null; lastModifiedHeader: string | null; sourceNetwork: string | null; tatSpeakerId: number | null; showInBrowse: boolean }>): Promise<Feed> {
  const [feed] = await db.update(feeds).set(data).where(eq(feeds.id, id)).returning();
  return feed;
}

export async function deleteFeed(id: string): Promise<void> {
  await db.delete(feeds).where(eq(feeds.id, id));
}

/**
 * Bulk enable/disable every TAT-only feed in a single SQL statement.
 * The per-feed loop version was timing out on ~1000+ feeds.
 */
export async function bulkToggleTATFeeds(enabled: boolean): Promise<number> {
  const result = await db.update(feeds)
    .set({ isActive: enabled })
    .where(and(
      sql`${feeds.rssUrl} LIKE 'tat://%'`,
      sql`${feeds.tatSpeakerId} IS NOT NULL`,
      sql`${feeds.isActive} <> ${enabled}`,
    ))
    .returning({ id: feeds.id });
  return result.length;
}

export async function mergeFeeds(sourceId: string, targetId: string): Promise<{ episodesMoved: number; subscriptionsMoved: number }> {
  // Move episodes from source to target (skip duplicates by guid) — batch update
  const sourceEps = await db.select().from(episodes).where(eq(episodes.feedId, sourceId));
  const targetEps = await db.select().from(episodes).where(eq(episodes.feedId, targetId));
  const targetGuids = new Set(targetEps.map(e => e.guid).filter(Boolean));

  const idsToMove = sourceEps
    .filter(ep => !ep.guid || !targetGuids.has(ep.guid))
    .map(ep => ep.id);
  if (idsToMove.length > 0) {
    await db.update(episodes).set({ feedId: targetId }).where(inArray(episodes.id, idsToMove));
  }
  const episodesMoved = idsToMove.length;

  // Move subscriptions from source to target (skip duplicates by deviceId) — batch operations
  const sourceSubs = await db.select().from(subscriptions).where(eq(subscriptions.feedId, sourceId));
  const targetSubs = await db.select().from(subscriptions).where(eq(subscriptions.feedId, targetId));
  const targetDevices = new Set(targetSubs.map(s => s.deviceId));

  const subsToMove = sourceSubs.filter(s => !targetDevices.has(s.deviceId));
  const subsToDelete = sourceSubs.filter(s => targetDevices.has(s.deviceId));

  if (subsToMove.length > 0) {
    await db.update(subscriptions).set({ feedId: targetId }).where(inArray(subscriptions.id, subsToMove.map(s => s.id)));
  }
  if (subsToDelete.length > 0) {
    await db.delete(subscriptions).where(inArray(subscriptions.id, subsToDelete.map(s => s.id)));
  }

  // Deactivate the source feed instead of deleting it (preserve for recovery)
  await db.update(feeds).set({ isActive: false, showInBrowse: false }).where(eq(feeds.id, sourceId));

  return { episodesMoved, subscriptionsMoved: subsToMove.length };
}

export async function getEpisodeById(episodeId: string): Promise<Episode | undefined> {
  const result = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  return result[0];
}

export async function getEpisodesByIds(episodeIds: string[]): Promise<Episode[]> {
  if (episodeIds.length === 0) return [];
  return db.select().from(episodes).where(inArray(episodes.id, episodeIds));
}

// Used by the incremental-ingest path to early-exit RSS/TAT/OU/KH refreshes.
// Returns the most-recent N guids stored for the feed, ordered newest-first.
// 50 default is enough headroom that a few out-of-order republishes don't
// trip the "20 consecutive known" stop signal.
export async function getRecentEpisodeGuids(feedId: string, limit: number = 50): Promise<Set<string>> {
  const rows = await db
    .select({ guid: episodes.guid })
    .from(episodes)
    .where(eq(episodes.feedId, feedId))
    .orderBy(desc(episodes.publishedAt), desc(episodes.createdAt))
    .limit(limit);
  return new Set(rows.map(r => r.guid));
}

// Returns RSS-source feeds that have at least one episode with null publishedAt.
// We only sweep RSS feeds because non-RSS sources (TAT/OU/KH) don't expose
// publish dates the same way — OU specifically has no date field at all.
export async function getRssFeedsWithNullPublishedAt(): Promise<{ id: string; title: string; rssUrl: string; nullCount: number }[]> {
  const rows = await db.execute(sql`
    SELECT f.id, f.title, f.rss_url AS "rssUrl", COUNT(e.id) AS "nullCount"
    FROM feeds f
    JOIN episodes e ON e.feed_id = f.id
    WHERE f.is_active = true
      AND e.published_at IS NULL
      AND f.rss_url NOT LIKE 'tat://%'
      AND f.rss_url NOT LIKE 'kh://%'
      AND f.rss_url NOT LIKE 'alldaf://%'
      AND f.rss_url NOT LIKE 'allmishnah://%'
      AND f.rss_url NOT LIKE 'allparsha://%'
      AND f.rss_url NOT LIKE 'allhalacha://%'
    GROUP BY f.id, f.title, f.rss_url
    ORDER BY COUNT(e.id) DESC
  `);
  return (rows.rows as any[]).map(r => ({
    id: r.id,
    title: r.title,
    rssUrl: r.rssUrl,
    nullCount: Number(r.nullCount),
  }));
}

// Bulk-update publishedAt where currently null, given a list of (guid, publishedAt)
// pairs from a freshly-parsed source. Returns count of rows updated.
export async function backfillPublishedAtFromGuids(feedId: string, items: { guid: string; publishedAt: Date }[]): Promise<number> {
  if (items.length === 0) return 0;
  let updated = 0;
  // Process in chunks of 200 to keep individual queries small
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);
    for (const it of chunk) {
      const result = await db.update(episodes)
        .set({ publishedAt: it.publishedAt })
        .where(and(
          eq(episodes.feedId, feedId),
          eq(episodes.guid, it.guid),
          sql`${episodes.publishedAt} IS NULL`,
        ))
        .returning({ id: episodes.id });
      updated += result.length;
    }
  }
  return updated;
}

// True when at least one pure tat:// feed is active. Mirrors the convention
// in the cron speaker-sync ("admin has disabled TAT" = all TAT feeds inactive).
// Cached for 60s to avoid hitting this on every per-feed refresh in a bulk loop.
let _tatEnabledCache: { value: boolean; at: number } | null = null;
export async function isTatGloballyEnabled(): Promise<boolean> {
  if (_tatEnabledCache && Date.now() - _tatEnabledCache.at < 60_000) return _tatEnabledCache.value;
  const [{ count: c }] = await db.select({ count: count() }).from(feeds)
    .where(and(
      eq(feeds.isActive, true),
      sql`${feeds.rssUrl} LIKE 'tat://%'`,
    ));
  const value = Number(c) > 0;
  _tatEnabledCache = { value, at: Date.now() };
  return value;
}

// Variant for TAT — pulls platform-specific lecture ids (numeric) so the TAT
// pagination loop can use a numeric Set lookup.
export async function getRecentTatLectureIds(feedId: string, limit: number = 50): Promise<Set<number>> {
  const rows = await db
    .select({ id: episodes.tatLectureId })
    .from(episodes)
    .where(and(eq(episodes.feedId, feedId), sql`${episodes.tatLectureId} IS NOT NULL`))
    .orderBy(desc(episodes.publishedAt), desc(episodes.createdAt))
    .limit(limit);
  return new Set(rows.map(r => r.id).filter((x): x is number => x !== null));
}

// Variant for OU platforms — extracts the numeric post id from
// `{prefix}{id}` guids (e.g. "alldaf-12345"). Each OU platform has its own
// guid prefix so we filter by that to avoid mixing platforms on merged feeds.
export async function getRecentOuPostIds(feedId: string, guidPrefix: string, limit: number = 50): Promise<Set<number>> {
  const rows = await db
    .select({ guid: episodes.guid })
    .from(episodes)
    .where(and(eq(episodes.feedId, feedId), sql`${episodes.guid} LIKE ${guidPrefix + "%"}`))
    .orderBy(desc(episodes.publishedAt), desc(episodes.createdAt))
    .limit(limit);
  const ids = new Set<number>();
  for (const r of rows) {
    const tail = r.guid.slice(guidPrefix.length);
    const n = Number(tail);
    if (Number.isFinite(n)) ids.add(n);
  }
  return ids;
}

// Variant for KH — extracts the numeric file id from `kh-{id}` guids.
export async function getRecentKhFileIds(feedId: string, limit: number = 50): Promise<Set<number>> {
  const rows = await db
    .select({ id: episodes.kolhalashonFileId })
    .from(episodes)
    .where(and(eq(episodes.feedId, feedId), sql`${episodes.kolhalashonFileId} IS NOT NULL`))
    .orderBy(desc(episodes.publishedAt), desc(episodes.createdAt))
    .limit(limit);
  return new Set(rows.map(r => r.id).filter((x): x is number => x !== null));
}

export async function getEpisodesByFeed(feedId: string): Promise<Episode[]> {
  return db.select().from(episodes).where(eq(episodes.feedId, feedId)).orderBy(desc(episodes.publishedAt));
}

export async function getEpisodesByFeedPaginated(feedId: string, page: number = 1, pageLimit: number = 50, sort: string = 'newest'): Promise<Episode[]> {
  const offset = (page - 1) * pageLimit;
  // Deterministic order: real publish date first; fall back to ingestion time
  // and finally a stable id tiebreaker so Postgres can't reshuffle ties between
  // queries. NULLS LAST keeps episodes with unknown dates below dated ones.
  const ascSort = sort === 'oldest';
  const orderClauses = ascSort
    ? [sql`${episodes.publishedAt} ASC NULLS LAST`, asc(episodes.createdAt), asc(episodes.id)]
    : [sql`${episodes.publishedAt} DESC NULLS LAST`, desc(episodes.createdAt), desc(episodes.id)];
  return db.select().from(episodes).where(eq(episodes.feedId, feedId)).orderBy(...orderClauses).limit(pageLimit).offset(offset);
}

export async function getEpisodeCountByFeed(feedId: string): Promise<number> {
  const result = await db.select({ value: count() }).from(episodes).where(eq(episodes.feedId, feedId));
  return result[0]?.value || 0;
}

export async function getLatestEpisodes(limit: number = 50): Promise<Episode[]> {
  const rows = await db.select({ episode: episodes })
    .from(episodes)
    .innerJoin(feeds, eq(episodes.feedId, feeds.id))
    .where(eq(feeds.isActive, true))
    .orderBy(desc(episodes.publishedAt))
    .limit(limit);
  return rows.map(r => r.episode);
}

export async function episodeExistsByGuid(feedId: string, guid: string): Promise<boolean> {
  const [row] = await db.select({ id: episodes.id }).from(episodes)
    .where(and(eq(episodes.feedId, feedId), eq(episodes.guid, guid)))
    .limit(1);
  return !!row;
}

export async function upsertEpisodes(feedId: string, episodeData: Partial<Episode>[]): Promise<Episode[]> {
  if (episodeData.length === 0) return [];
  const inserted: Episode[] = [];
  const CHUNK = 50;
  for (let i = 0; i < episodeData.length; i += CHUNK) {
    const chunk = episodeData.slice(i, i + CHUNK);
    try {
      const results = await db.insert(episodes).values(
        chunk.map(ep => ({
          feedId: ep.feedId || feedId,
          title: ep.title!,
          description: ep.description,
          audioUrl: ep.audioUrl!,
          duration: ep.duration,
          publishedAt: ep.publishedAt as any,
          guid: ep.guid!,
          imageUrl: ep.imageUrl,
        }))
      ).onConflictDoNothing().returning();
      inserted.push(...results);
    } catch (e) {
      // Fallback to individual inserts if batch fails
      for (const ep of chunk) {
        try {
          const [result] = await db.insert(episodes).values({
            feedId: ep.feedId || feedId,
            title: ep.title!,
            description: ep.description,
            audioUrl: ep.audioUrl!,
            duration: ep.duration,
            publishedAt: ep.publishedAt as any,
            guid: ep.guid!,
            imageUrl: ep.imageUrl,
          }).onConflictDoNothing().returning();
          if (result) inserted.push(result);
        } catch (_) {}
      }
    }
  }
  return inserted;
}

export async function upsertTATEpisodes(feedId: string, episodeData: any[]): Promise<Episode[]> {
  if (episodeData.length === 0) return [];
  const inserted: Episode[] = [];
  const CHUNK = 50;
  for (let i = 0; i < episodeData.length; i += CHUNK) {
    const chunk = episodeData.slice(i, i + CHUNK);
    try {
      const results = await db.insert(episodes).values(
        chunk.map(ep => ({
          feedId: ep.feedId,
          title: ep.title,
          description: ep.description,
          audioUrl: ep.audioUrl,
          duration: ep.duration,
          publishedAt: ep.publishedAt,
          guid: ep.guid,
          imageUrl: ep.imageUrl,
          tatLectureId: ep.tatLectureId,
          noDownload: ep.noDownload || false,
        }))
      ).onConflictDoNothing().returning();
      inserted.push(...results);
    } catch (e) {
      for (const ep of chunk) {
        try {
          const [result] = await db.insert(episodes).values({
            feedId: ep.feedId, title: ep.title, description: ep.description,
            audioUrl: ep.audioUrl, duration: ep.duration, publishedAt: ep.publishedAt,
            guid: ep.guid, imageUrl: ep.imageUrl, tatLectureId: ep.tatLectureId,
            noDownload: ep.noDownload || false,
          }).onConflictDoNothing().returning();
          if (result) inserted.push(result);
        } catch (_) {}
      }
    }
  }
  return inserted;
}

// Generic upsert for OU Torah platform episodes (AllDaf, AllMishnah, AllParsha)
export async function upsertOUEpisodes(feedId: string, episodeData: any[]): Promise<Episode[]> {
  if (episodeData.length === 0) return [];
  const inserted: Episode[] = [];
  const CHUNK = 50;
  for (let i = 0; i < episodeData.length; i += CHUNK) {
    const chunk = episodeData.slice(i, i + CHUNK);
    try {
      const results = await db.insert(episodes).values(
        chunk.map(ep => ({
          feedId: ep.feedId, title: ep.title, description: ep.description,
          audioUrl: ep.audioUrl, duration: ep.duration, publishedAt: ep.publishedAt,
          guid: ep.guid, imageUrl: ep.imageUrl, noDownload: ep.noDownload || false,
        }))
      ).onConflictDoNothing().returning();
      inserted.push(...results);
    } catch (e) {
      for (const ep of chunk) {
        try {
          const [result] = await db.insert(episodes).values({
            feedId: ep.feedId, title: ep.title, description: ep.description,
            audioUrl: ep.audioUrl, duration: ep.duration, publishedAt: ep.publishedAt,
            guid: ep.guid, imageUrl: ep.imageUrl, noDownload: ep.noDownload || false,
          }).onConflictDoNothing().returning();
          if (result) inserted.push(result);
        } catch (_) {}
      }
    }
  }
  return inserted;
}

// Backward-compatible alias
export const upsertAllDafEpisodes = upsertOUEpisodes;

export async function setOUAuthorId(feedId: string, field: string, authorId: number | null): Promise<void> {
  await db.update(feeds).set({ [field]: authorId } as any).where(eq(feeds.id, feedId));
}

// Backward-compatible alias
export async function setAlldafAuthorId(feedId: string, authorId: number): Promise<void> {
  return setOUAuthorId(feedId, "alldafAuthorId", authorId);
}

// Kol Halashon episode upsert
export async function upsertKHEpisodes(feedId: string, episodeData: any[]): Promise<Episode[]> {
  if (episodeData.length === 0) return [];
  const inserted: Episode[] = [];
  const CHUNK = 50;
  for (let i = 0; i < episodeData.length; i += CHUNK) {
    const chunk = episodeData.slice(i, i + CHUNK);
    try {
      const results = await db.insert(episodes).values(
        chunk.map(ep => ({
          feedId: ep.feedId, title: ep.title, description: ep.description,
          audioUrl: ep.audioUrl, duration: ep.duration, publishedAt: ep.publishedAt,
          guid: ep.guid, imageUrl: ep.imageUrl,
          kolhalashonFileId: ep.kolhalashonFileId, noDownload: ep.noDownload || false,
        }))
      ).onConflictDoNothing().returning();
      inserted.push(...results);
    } catch (e) {
      for (const ep of chunk) {
        try {
          const [result] = await db.insert(episodes).values({
            feedId: ep.feedId, title: ep.title, description: ep.description,
            audioUrl: ep.audioUrl, duration: ep.duration, publishedAt: ep.publishedAt,
            guid: ep.guid, imageUrl: ep.imageUrl,
            kolhalashonFileId: ep.kolhalashonFileId, noDownload: ep.noDownload || false,
          }).onConflictDoNothing().returning();
          if (result) inserted.push(result);
        } catch (_) {}
      }
    }
  }
  return inserted;
}

export async function setKHRavId(feedId: string, ravId: number | null): Promise<void> {
  await db.update(feeds).set({ kolhalashonRavId: ravId } as any).where(eq(feeds.id, feedId));
}

export async function getTATFeeds(): Promise<Feed[]> {
  return db.select().from(feeds).where(
    and(
      sql`${feeds.tatSpeakerId} IS NOT NULL`,
      eq(feeds.isActive, true),
    )
  );
}

export async function deleteEpisodesByFeed(feedId: string): Promise<void> {
  await db.delete(episodes).where(eq(episodes.feedId, feedId));
}

export async function getSubscriptions(deviceId: string): Promise<Subscription[]> {
  return db.select().from(subscriptions).where(eq(subscriptions.deviceId, deviceId));
}

export async function addSubscription(deviceId: string, feedId: string): Promise<Subscription> {
  const [sub] = await db.insert(subscriptions).values({ deviceId, feedId }).onConflictDoNothing().returning();
  return sub;
}

export async function removeSubscription(deviceId: string, feedId: string): Promise<void> {
  await db.delete(subscriptions).where(and(eq(subscriptions.deviceId, deviceId), eq(subscriptions.feedId, feedId)));
}

export async function getSubscribedFeeds(deviceId: string): Promise<Feed[]> {
  const subs = await getSubscriptions(deviceId);
  if (subs.length === 0) return [];
  const feedIds = subs.map(s => s.feedId);
  return db.select().from(feeds).where(inArray(feeds.id, feedIds));
}

export async function getEpisodesForSubscribedFeeds(deviceId: string, limit: number = 100): Promise<Episode[]> {
  const subs = await getSubscriptions(deviceId);
  if (subs.length === 0) return [];
  const feedIds = subs.map(s => s.feedId);
  return db.select().from(episodes).where(inArray(episodes.feedId, feedIds)).orderBy(desc(episodes.publishedAt)).limit(limit);
}

export async function verifyAdmin(username: string, password: string): Promise<boolean> {
  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.username, username));
  if (!admin) return false;
  return bcrypt.compare(password, admin.passwordHash);
}

export async function createAdmin(username: string, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  await db.insert(adminUsers).values({ username, passwordHash: hash }).onConflictDoNothing();
}

export async function resetAllAdmins(username: string, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  await db.delete(adminUsers);
  await db.insert(adminUsers).values({ username, passwordHash: hash });
}

export async function adminExists(): Promise<boolean> {
  const admins = await db.select().from(adminUsers).limit(1);
  return admins.length > 0;
}

export async function recordListen(episodeId: string, deviceId: string): Promise<void> {
  await db.insert(episodeListens).values({ episodeId, deviceId });
}

export async function getTrendingEpisodes(limit: number = 20): Promise<(Episode & { listenCount: number })[]> {
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const result = await db
    .select({
      id: episodes.id,
      feedId: episodes.feedId,
      title: episodes.title,
      description: episodes.description,
      audioUrl: episodes.audioUrl,
      duration: episodes.duration,
      publishedAt: episodes.publishedAt,
      guid: episodes.guid,
      imageUrl: episodes.imageUrl,
      createdAt: episodes.createdAt,
      adminNotes: episodes.adminNotes,
      sourceSheetUrl: episodes.sourceSheetUrl,
      listenCount: count(episodeListens.id),
    })
    .from(episodes)
    .innerJoin(episodeListens, eq(episodes.id, episodeListens.episodeId))
    .innerJoin(feeds, eq(episodes.feedId, feeds.id))
    .where(and(
      sql`${episodeListens.listenedAt} > ${fortyEightHoursAgo}`,
      eq(feeds.isActive, true),
    ))
    .groupBy(episodes.id)
    .orderBy(desc(count(episodeListens.id)), desc(episodes.publishedAt))
    .limit(limit);

  return result.map(r => ({ ...r, listenCount: Number(r.listenCount) }));
}

export async function getAnalytics() {
  // Exclude admin-disabled TAT feeds from all counts — they're soft-deleted
  // and shouldn't inflate admin stats.
  const notDisabledTat = sql`NOT (${feeds.rssUrl} LIKE 'tat://%' AND ${feeds.isActive} = false)`;
  const [feedCount] = await db.select({ count: count() }).from(feeds).where(notDisabledTat);
  const [activeFeedCount] = await db.select({ count: count() }).from(feeds).where(and(eq(feeds.isActive, true), notDisabledTat));
  const [episodeCount] = await db.select({ count: count() }).from(episodes)
    .where(sql`${episodes.feedId} IN (SELECT id FROM ${feeds} WHERE NOT (${feeds.rssUrl} LIKE 'tat://%' AND ${feeds.isActive} = false))`);
  const [categoryCount] = await db.select({ count: count() }).from(categories);
  const [listenCount] = await db.select({ count: count() }).from(episodeListens);

  const uniqueSubscribers = await db
    .selectDistinct({ deviceId: subscriptions.deviceId })
    .from(subscriptions);

  const [subscriptionCount] = await db.select({ count: count() }).from(subscriptions);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [recentListens] = await db
    .select({ count: count() })
    .from(episodeListens)
    .where(sql`${episodeListens.listenedAt} > ${sevenDaysAgo}`);

  const feedStats = await db
    .select({
      feedId: feeds.id,
      title: feeds.title,
      imageUrl: feeds.imageUrl,
      author: feeds.author,
      isActive: feeds.isActive,
      episodeCount: count(episodes.id),
    })
    .from(feeds)
    .leftJoin(episodes, eq(feeds.id, episodes.feedId))
    .where(notDisabledTat)
    .groupBy(feeds.id)
    .orderBy(desc(count(episodes.id)));

  const feedListenStats = await db
    .select({
      feedId: episodes.feedId,
      listenCount: count(episodeListens.id),
    })
    .from(episodeListens)
    .innerJoin(episodes, eq(episodeListens.episodeId, episodes.id))
    .groupBy(episodes.feedId);

  const listenMap = new Map(feedListenStats.map(s => [s.feedId, Number(s.listenCount)]));

  const feedSubscriptionStats = await db
    .select({
      feedId: subscriptions.feedId,
      subscriberCount: count(subscriptions.id),
    })
    .from(subscriptions)
    .groupBy(subscriptions.feedId);

  const subMap = new Map(feedSubscriptionStats.map(s => [s.feedId, Number(s.subscriberCount)]));

  const enrichedFeedStats = feedStats.map(f => ({
    ...f,
    episodeCount: Number(f.episodeCount),
    listenCount: listenMap.get(f.feedId) || 0,
    subscriberCount: subMap.get(f.feedId) || 0,
  }));

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const dailyListens = await db
    .select({
      day: sql<string>`DATE(${episodeListens.listenedAt})`,
      count: count(),
    })
    .from(episodeListens)
    .where(sql`${episodeListens.listenedAt} > ${thirtyDaysAgo}`)
    .groupBy(sql`DATE(${episodeListens.listenedAt})`)
    .orderBy(sql`DATE(${episodeListens.listenedAt})`);

  // Daily Active Users — distinct deviceId per day from listen events, 30-day window
  const dailyActiveDevices = await db
    .select({
      day: sql<string>`DATE(${episodeListens.listenedAt})`,
      count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})`,
    })
    .from(episodeListens)
    .where(sql`${episodeListens.listenedAt} > ${thirtyDaysAgo}`)
    .groupBy(sql`DATE(${episodeListens.listenedAt})`)
    .orderBy(sql`DATE(${episodeListens.listenedAt})`);

  // Active-user totals across rolling windows + app-open and growth metrics.
  const [
    [dauTodayRow], [dauWeekRow], [dauMonthRow],
    [appOpens24Row], [appOpens7Row], [appOpens30Row],
    [newUsers24Row], [newUsers7Row], [newUsers30Row],
    [listenTime7Row], [listenTime30Row], [listenTimeAllRow],
    [completedAllRow], [completedRecentRow],
  ] = await Promise.all([
    db.select({ count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})` }).from(episodeListens).where(sql`${episodeListens.listenedAt} > ${oneDayAgo}`),
    db.select({ count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})` }).from(episodeListens).where(sql`${episodeListens.listenedAt} > ${sevenDaysAgo}`),
    db.select({ count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})` }).from(episodeListens).where(sql`${episodeListens.listenedAt} > ${thirtyDaysAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.lastSeenAt} > ${oneDayAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.lastSeenAt} > ${sevenDaysAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.lastSeenAt} > ${thirtyDaysAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.createdAt} > ${oneDayAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.createdAt} > ${sevenDaysAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.createdAt} > ${thirtyDaysAgo}`),
    db.select({ total: sql<number>`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)` }).from(episodeListens).where(sql`${episodeListens.listenedAt} > ${sevenDaysAgo}`),
    db.select({ total: sql<number>`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)` }).from(episodeListens).where(sql`${episodeListens.listenedAt} > ${thirtyDaysAgo}`),
    db.select({ total: sql<number>`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)` }).from(episodeListens),
    db.select({ count: count() }).from(playbackPositions).where(eq(playbackPositions.completed, true)),
    db.select({ count: count() }).from(playbackPositions).where(and(eq(playbackPositions.completed, true), sql`${playbackPositions.updatedAt} > ${sevenDaysAgo}`)),
  ]);

  const topEpisodes = await db
    .select({
      episodeId: episodeListens.episodeId,
      title: episodes.title,
      feedId: episodes.feedId,
      listenCount: count(episodeListens.id),
    })
    .from(episodeListens)
    .innerJoin(episodes, eq(episodeListens.episodeId, episodes.id))
    .groupBy(episodeListens.episodeId, episodes.title, episodes.feedId)
    .orderBy(desc(count(episodeListens.id)))
    .limit(10);

  return {
    totalFeeds: Number(feedCount.count),
    activeFeeds: Number(activeFeedCount.count),
    totalEpisodes: Number(episodeCount.count),
    totalCategories: Number(categoryCount.count),
    totalListens: Number(listenCount.count),
    recentListens: Number(recentListens.count),
    uniqueDevices: uniqueSubscribers.length,
    totalSubscriptions: Number(subscriptionCount.count),
    feedStats: enrichedFeedStats,
    dailyListens: dailyListens.map(d => ({ day: d.day, count: Number(d.count) })),
    dailyActiveDevices: dailyActiveDevices.map(d => ({ day: d.day, count: Number(d.count) })),
    dauToday: Number(dauTodayRow?.count || 0),
    dauLast7: Number(dauWeekRow?.count || 0),
    dauLast30: Number(dauMonthRow?.count || 0),
    appOpensToday: Number(appOpens24Row?.count || 0),
    appOpensLast7: Number(appOpens7Row?.count || 0),
    appOpensLast30: Number(appOpens30Row?.count || 0),
    newUsersToday: Number(newUsers24Row?.count || 0),
    newUsersLast7: Number(newUsers7Row?.count || 0),
    newUsersLast30: Number(newUsers30Row?.count || 0),
    listeningTimeMsLast7: Number(listenTime7Row?.total || 0),
    listeningTimeMsLast30: Number(listenTime30Row?.total || 0),
    listeningTimeMsTotal: Number(listenTimeAllRow?.total || 0),
    completedEpisodesTotal: Number(completedAllRow?.count || 0),
    completedEpisodesLast7: Number(completedRecentRow?.count || 0),
    topEpisodes: topEpisodes.map(e => ({ ...e, listenCount: Number(e.listenCount) })),
  };
}

export async function addFavorite(episodeId: string, deviceId: string): Promise<Favorite | undefined> {
  const [fav] = await db.insert(favorites).values({ episodeId, deviceId }).onConflictDoNothing().returning();
  return fav;
}

export async function removeFavorite(episodeId: string, deviceId: string): Promise<void> {
  await db.delete(favorites).where(and(eq(favorites.episodeId, episodeId), eq(favorites.deviceId, deviceId)));
}

export async function getFavorites(deviceId: string): Promise<Favorite[]> {
  return db.select().from(favorites).where(eq(favorites.deviceId, deviceId)).orderBy(desc(favorites.createdAt));
}

export async function isFavorite(episodeId: string, deviceId: string): Promise<boolean> {
  const result = await db.select().from(favorites).where(and(eq(favorites.episodeId, episodeId), eq(favorites.deviceId, deviceId))).limit(1);
  return result.length > 0;
}

export async function syncPlaybackPosition(episodeId: string, feedId: string, deviceId: string, positionMs: number, durationMs: number, completed: boolean): Promise<PlaybackPosition> {
  const [pos] = await db.insert(playbackPositions).values({ episodeId, feedId, deviceId, positionMs, durationMs, completed }).onConflictDoUpdate({
    target: [playbackPositions.episodeId, playbackPositions.deviceId],
    set: { positionMs, durationMs, completed, updatedAt: new Date() },
  }).returning();
  return pos;
}

export async function getPlaybackPositions(deviceId: string, limit: number = 500): Promise<PlaybackPosition[]> {
  return db.select().from(playbackPositions).where(eq(playbackPositions.deviceId, deviceId)).orderBy(desc(playbackPositions.updatedAt)).limit(limit);
}

export async function getPlaybackPosition(episodeId: string, deviceId: string): Promise<PlaybackPosition | undefined> {
  const [pos] = await db.select().from(playbackPositions).where(and(eq(playbackPositions.episodeId, episodeId), eq(playbackPositions.deviceId, deviceId))).limit(1);
  return pos;
}

export async function getCompletedEpisodes(deviceId: string, limit: number = 500): Promise<PlaybackPosition[]> {
  return db.select().from(playbackPositions).where(and(eq(playbackPositions.deviceId, deviceId), eq(playbackPositions.completed, true))).orderBy(desc(playbackPositions.updatedAt)).limit(limit);
}

export async function getRecentlyPlayed(deviceId: string, limit: number = 15) {
  return db.select({
    episodeId: playbackPositions.episodeId,
    feedId: playbackPositions.feedId,
    positionMs: playbackPositions.positionMs,
    durationMs: playbackPositions.durationMs,
    completed: playbackPositions.completed,
    updatedAt: playbackPositions.updatedAt,
    episodeTitle: episodes.title,
    audioUrl: episodes.audioUrl,
    episodeImageUrl: episodes.imageUrl,
    duration: episodes.duration,
    feedTitle: feeds.title,
    feedAuthor: feeds.author,
    feedImageUrl: feeds.imageUrl,
  })
    .from(playbackPositions)
    .innerJoin(episodes, eq(playbackPositions.episodeId, episodes.id))
    .innerJoin(feeds, eq(playbackPositions.feedId, feeds.id))
    .where(and(eq(playbackPositions.deviceId, deviceId), eq(playbackPositions.completed, false)))
    .orderBy(desc(playbackPositions.updatedAt))
    .limit(limit);
}

export async function getListeningStats(deviceId: string) {
  const positions = await db.select().from(playbackPositions).where(eq(playbackPositions.deviceId, deviceId));

  const totalListeningTimeMs = positions.reduce((sum, p) => sum + (p.positionMs || 0), 0);
  const totalListeningTime = Math.floor(totalListeningTimeMs / 1000);
  const episodesPlayed = positions.length;

  const listenDays = new Set<string>();
  for (const p of positions) {
    if (p.updatedAt) {
      listenDays.add(new Date(p.updatedAt).toISOString().split("T")[0]);
    }
  }
  const sortedDays = [...listenDays].sort().reverse();
  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 0;
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  let checkDate = sortedDays[0] === today || sortedDays[0] === yesterday ? sortedDays[0] : null;

  if (checkDate) {
    for (const day of sortedDays) {
      if (day === checkDate) {
        streak++;
        const prev = new Date(new Date(checkDate).getTime() - 86400000).toISOString().split("T")[0];
        checkDate = prev;
      } else {
        break;
      }
    }
    currentStreak = streak;
  }
  streak = 0;
  let prevDay: string | null = null;
  for (const day of [...listenDays].sort()) {
    if (!prevDay || new Date(day).getTime() - new Date(prevDay).getTime() === 86400000) {
      streak++;
    } else {
      streak = 1;
    }
    if (streak > longestStreak) longestStreak = streak;
    prevDay = day;
  }

  // Batch: get feedId for all episodes in one query instead of N+1
  const episodeIds = [...new Set(positions.map(p => p.episodeId))];
  const episodeFeedRows = episodeIds.length > 0
    ? await db.select({ id: episodes.id, feedId: episodes.feedId }).from(episodes).where(inArray(episodes.id, episodeIds))
    : [];
  const episodeFeedMap = new Map(episodeFeedRows.map(r => [r.id, r.feedId]));

  const feedTimeMap = new Map<string, { feedId: string; time: number }>();
  for (const p of positions) {
    const fid = episodeFeedMap.get(p.episodeId);
    if (fid) {
      const existing = feedTimeMap.get(fid) || { feedId: fid, time: 0 };
      existing.time += (p.positionMs || 0) / 1000;
      feedTimeMap.set(fid, existing);
    }
  }

  // Batch: get feed titles for top feeds in one query
  const topFeedIds = [...feedTimeMap.values()].sort((a, b) => b.time - a.time).slice(0, 10);
  const topFeedIdList = topFeedIds.map(f => f.feedId);
  const feedTitleRows = topFeedIdList.length > 0
    ? await db.select({ id: feeds.id, title: feeds.title }).from(feeds).where(inArray(feeds.id, topFeedIdList))
    : [];
  const feedTitleMap = new Map(feedTitleRows.map(r => [r.id, r.title]));
  const topFeeds = topFeedIds
    .filter(f => feedTitleMap.has(f.feedId))
    .map(f => ({ feedId: f.feedId, title: feedTitleMap.get(f.feedId)!, listenTime: Math.floor(f.time) }));

  // This week vs last week
  const now = new Date();
  const thisWeekStart = new Date(now.getTime() - 7 * 86400000);
  const lastWeekStart = new Date(now.getTime() - 14 * 86400000);
  let thisWeekMs = 0;
  let lastWeekMs = 0;
  for (const p of positions) {
    if (!p.updatedAt) continue;
    const t = new Date(p.updatedAt).getTime();
    if (t >= thisWeekStart.getTime()) thisWeekMs += (p.positionMs || 0);
    else if (t >= lastWeekStart.getTime()) lastWeekMs += (p.positionMs || 0);
  }

  // Daily chart (last 7 days)
  const dailyChart: { day: string; totalMs: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dayStr = d.toISOString().split("T")[0];
    let dayTotal = 0;
    for (const p of positions) {
      if (p.updatedAt && new Date(p.updatedAt).toISOString().split("T")[0] === dayStr) {
        dayTotal += (p.positionMs || 0);
      }
    }
    dailyChart.push({ day: dayStr, totalMs: dayTotal });
  }

  // Completion rate
  const completedCount = positions.filter(p => p.completed).length;
  const completionRate = {
    completed: completedCount,
    total: episodesPlayed,
    rate: episodesPlayed > 0 ? Math.round((completedCount / episodesPlayed) * 100) : 0,
  };

  // Average daily listening time
  const uniqueDays = listenDays.size;
  const avgDailyTimeSeconds = uniqueDays > 0 ? Math.floor(totalListeningTimeMs / 1000 / uniqueDays) : 0;

  // Top category — batch query instead of N+1
  let topCategory: { name: string; timeSeconds: number } | null = null;
  const allFeedIds = [...feedTimeMap.keys()];
  const allFeedCats = allFeedIds.length > 0
    ? await db.select({ feedId: feedCategories.feedId, categoryId: feedCategories.categoryId }).from(feedCategories).where(inArray(feedCategories.feedId, allFeedIds))
    : [];
  const categoryTimeMap = new Map<string, number>();
  for (const fc of allFeedCats) {
    const data = feedTimeMap.get(fc.feedId);
    if (data) {
      categoryTimeMap.set(fc.categoryId, (categoryTimeMap.get(fc.categoryId) || 0) + data.time);
    }
  }
  if (categoryTimeMap.size > 0) {
    const topCatEntry = [...categoryTimeMap.entries()].sort((a, b) => b[1] - a[1])[0];
    const [catRow] = await db.select({ name: categories.name }).from(categories).where(eq(categories.id, topCatEntry[0])).limit(1);
    if (catRow) {
      topCategory = { name: catRow.name, timeSeconds: Math.floor(topCatEntry[1]) };
    }
  }

  return {
    totalListeningTime,
    episodesPlayed,
    currentStreak,
    longestStreak,
    topFeeds,
    thisWeekMs,
    lastWeekMs,
    dailyChart,
    completionRate,
    avgDailyTimeSeconds,
    topCategory,
  };
}

export async function getWeeklyPopularEpisodes(limit: number = 20) {
  // Kept function name for compatibility; now returns the MONTHLY most-listened
  // episodes (previously last 7 days). Users want the "Popular Shiurim" home
  // section to reflect the last 30 days of listens.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await db
    .select({
      episodeId: episodeListens.episodeId,
      title: episodes.title,
      feedId: episodes.feedId,
      description: episodes.description,
      audioUrl: episodes.audioUrl,
      duration: episodes.duration,
      publishedAt: episodes.publishedAt,
      imageUrl: episodes.imageUrl,
      listenCount: count(episodeListens.id),
    })
    .from(episodeListens)
    .innerJoin(episodes, eq(episodeListens.episodeId, episodes.id))
    .where(sql`${episodeListens.listenedAt} > ${thirtyDaysAgo}`)
    .groupBy(episodeListens.episodeId, episodes.id)
    .orderBy(desc(count(episodeListens.id)))
    .limit(limit);

  return result.map(r => ({ ...r, listenCount: Number(r.listenCount) }));
}

export async function getFeedListenerCount(feedId: string): Promise<number> {
  const feedEpisodes = await db.select({ id: episodes.id }).from(episodes).where(eq(episodes.feedId, feedId));
  if (feedEpisodes.length === 0) return 0;
  const episodeIds = feedEpisodes.map(e => e.id);
  const result = await db.selectDistinct({ deviceId: episodeListens.deviceId }).from(episodeListens).where(inArray(episodeListens.episodeId, episodeIds));
  return result.length;
}

export async function searchEpisodes(query: string, limit: number = 20): Promise<Episode[]> {
  return db.select().from(episodes).where(ilike(episodes.title, `%${query}%`)).orderBy(desc(episodes.publishedAt)).limit(limit);
}

export async function getNewEpisodesForSubscribedFeeds(deviceId: string, limit: number = 50, since?: Date): Promise<Episode[]> {
  const subs = await getSubscriptions(deviceId);
  if (subs.length === 0) return [];
  const feedIds = subs.map(s => s.feedId);
  let query = db.select().from(episodes).where(
    since
      ? and(inArray(episodes.feedId, feedIds), sql`${episodes.publishedAt} > ${since}`)
      : inArray(episodes.feedId, feedIds)
  ).orderBy(desc(episodes.publishedAt)).limit(limit);
  return query;
}

export async function getFeaturedFeeds(): Promise<Feed[]> {
  return db.select().from(feeds).where(and(eq(feeds.isFeatured, true), eq(feeds.isActive, true))).orderBy(feeds.title).limit(50);
}

export async function getFeedCategoryIds(feedId: string): Promise<string[]> {
  const rows = await db.select({ categoryId: feedCategories.categoryId }).from(feedCategories).where(eq(feedCategories.feedId, feedId));
  return rows.map(r => r.categoryId);
}

export async function getAllFeedCategoryMappings(): Promise<{ feedId: string; categoryId: string }[]> {
  return db.select({ feedId: feedCategories.feedId, categoryId: feedCategories.categoryId }).from(feedCategories);
}

export async function setFeedCategories(feedId: string, categoryIds: string[]): Promise<void> {
  await db.delete(feedCategories).where(eq(feedCategories.feedId, feedId));
  if (categoryIds.length > 0) {
    await db.insert(feedCategories).values(categoryIds.map(categoryId => ({ feedId, categoryId })));
  }
}

export async function ensureCanonicalCategories(cats: { name: string; slug: string }[]): Promise<Map<string, string>> {
  const existing = await getAllCategories();
  const slugToId = new Map<string, string>();
  const nameToRow = new Map<string, Category>();
  for (const c of existing) {
    slugToId.set(c.slug, c.id);
    nameToRow.set(c.name, c);
  }
  for (const cat of cats) {
    if (slugToId.has(cat.slug)) continue;
    // If a category with this name already exists under a different slug, update its slug
    const byName = nameToRow.get(cat.name);
    if (byName) {
      await db.update(categories).set({ slug: cat.slug }).where(eq(categories.id, byName.id));
      slugToId.set(cat.slug, byName.id);
    } else {
      const created = await createCategory(cat);
      slugToId.set(cat.slug, created.id);
    }
  }
  return slugToId;
}

export async function getFeedIdsWithManualCategories(): Promise<Set<string>> {
  const rows = await db.select({ feedId: feedCategories.feedId }).from(feedCategories)
    .where(eq(feedCategories.autoAssigned, false));
  return new Set(rows.map(r => r.feedId));
}

export async function setAutoFeedCategories(feedId: string, categoryIds: string[]): Promise<void> {
  // Delete only auto-assigned rows for this feed
  await db.delete(feedCategories).where(and(eq(feedCategories.feedId, feedId), eq(feedCategories.autoAssigned, true)));
  if (categoryIds.length > 0) {
    await db.insert(feedCategories).values(categoryIds.map(categoryId => ({
      feedId,
      categoryId,
      autoAssigned: true,
    }))).onConflictDoNothing();
  }
}

export async function getFeedsByCategories(categoryId: string): Promise<Feed[]> {
  const rows = await db.select({ feedId: feedCategories.feedId }).from(feedCategories).where(eq(feedCategories.categoryId, categoryId));
  if (rows.length === 0) return [];
  const feedIds = rows.map(r => r.feedId);
  return db.select().from(feeds).where(and(inArray(feeds.id, feedIds), eq(feeds.isActive, true), eq(feeds.showInBrowse, true))).orderBy(feeds.title);
}

export async function getActiveFeedsGroupedByAuthor(): Promise<{ author: string; feeds: Feed[]; imageUrl?: string | null; bio?: string | null; profileId?: string }[]> {
  const allActive = await db.select().from(feeds).where(and(eq(feeds.isActive, true), eq(feeds.showInBrowse, true))).orderBy(feeds.author, feeds.title).limit(2000);
  const profiles = await db.select().from(maggidShiurim).limit(500);
  const profileMap = new Map<string, MaggidShiur>();
  for (const p of profiles) profileMap.set(p.name.toLowerCase(), p);

  const grouped = new Map<string, Feed[]>();
  for (const feed of allActive) {
    const author = feed.author?.trim();
    if (!author) continue;
    if (!grouped.has(author)) grouped.set(author, []);
    grouped.get(author)!.push(feed);
  }
  const result: { author: string; feeds: Feed[]; imageUrl?: string | null; bio?: string | null; profileId?: string }[] = [];
  for (const [author, authorFeeds] of grouped) {
    if (authorFeeds.length >= 1) {
      const profile = profileMap.get(author.toLowerCase());
      result.push({
        author: profile?.name || author,
        feeds: authorFeeds,
        imageUrl: profile?.imageUrl || null,
        bio: profile?.bio || null,
        profileId: profile?.id,
      });
    }
  }
  result.sort((a, b) => b.feeds.length - a.feeds.length || a.author.localeCompare(b.author));
  return result;
}

export async function getAllMaggidShiurim(): Promise<MaggidShiur[]> {
  return db.select().from(maggidShiurim).orderBy(maggidShiurim.name);
}

export async function getMaggidShiurByName(name: string): Promise<MaggidShiur | undefined> {
  const [result] = await db.select().from(maggidShiurim).where(eq(maggidShiurim.name, name)).limit(1);
  return result;
}

export async function createMaggidShiur(data: InsertMaggidShiur): Promise<MaggidShiur> {
  const [result] = await db.insert(maggidShiurim).values(data).returning();
  return result;
}

export async function updateMaggidShiur(id: string, data: Partial<InsertMaggidShiur>): Promise<MaggidShiur> {
  const [result] = await db.update(maggidShiurim).set(data).where(eq(maggidShiurim.id, id)).returning();
  return result;
}

export async function deleteMaggidShiur(id: string): Promise<void> {
  await db.delete(maggidShiurim).where(eq(maggidShiurim.id, id));
}

export async function setFeedFeatured(feedId: string, featured: boolean): Promise<Feed> {
  const [feed] = await db.update(feeds).set({ isFeatured: featured }).where(eq(feeds.id, feedId)).returning();
  return feed;
}

export async function createAdminNotification(title: string, message: string): Promise<AdminNotification> {
  const [notif] = await db.insert(adminNotifications).values({ title, message }).returning();
  return notif;
}

export async function getAdminNotifications(): Promise<AdminNotification[]> {
  return db.select().from(adminNotifications).orderBy(desc(adminNotifications.createdAt));
}

export async function markNotificationSent(id: string): Promise<void> {
  await db.update(adminNotifications).set({ sentAt: new Date() }).where(eq(adminNotifications.id, id));
}

export async function recordListenWithDuration(episodeId: string, deviceId: string, durationMs: number): Promise<void> {
  // Progress pings fire every ~60s while playing. We must NOT insert a new row each
  // time — that would inflate listen counts ~10x for a typical session. Instead,
  // accumulate onto the most recent listen for this (episode, device) within a
  // 4-hour session window. Fall back to insert if no recent row exists.
  if (durationMs <= 0) return;
  const sessionStart = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ id: episodeListens.id, durationListenedMs: episodeListens.durationListenedMs })
    .from(episodeListens)
    .where(and(
      eq(episodeListens.episodeId, episodeId),
      eq(episodeListens.deviceId, deviceId),
      sql`${episodeListens.listenedAt} > ${sessionStart}`,
    ))
    .orderBy(desc(episodeListens.listenedAt))
    .limit(1);

  if (recent) {
    await db.update(episodeListens)
      .set({ durationListenedMs: (recent.durationListenedMs || 0) + durationMs })
      .where(eq(episodeListens.id, recent.id));
  } else {
    await db.insert(episodeListens).values({ episodeId, deviceId, durationListenedMs: durationMs });
  }
}

export async function getEnhancedAnalytics() {
  const baseAnalytics = await getAnalytics();

  const [listeningTimeResult] = await db
    .select({ total: sql<string>`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)` })
    .from(episodeListens);
  const totalListeningTimeMs = Number(listeningTimeResult.total);

  const [completedResult] = await db
    .select({ count: count() })
    .from(playbackPositions)
    .where(eq(playbackPositions.completed, true));
  const completedEpisodes = Number(completedResult.count);

  const topListeners = await db
    .select({
      deviceId: episodeListens.deviceId,
      listenCount: count(episodeListens.id),
    })
    .from(episodeListens)
    .groupBy(episodeListens.deviceId)
    .orderBy(desc(count(episodeListens.id)))
    .limit(10);

  return {
    ...baseAnalytics,
    totalListeningTimeMs,
    completedEpisodes,
    topListeners: topListeners.map(l => ({ deviceId: l.deviceId, listenCount: Number(l.listenCount) })),
  };
}

export async function getListenerAnalytics() {
  const hourlyListens = await db
    .select({
      hour: sql<number>`EXTRACT(HOUR FROM ${episodeListens.listenedAt})::int`,
      count: count(),
    })
    .from(episodeListens)
    .groupBy(sql`EXTRACT(HOUR FROM ${episodeListens.listenedAt})`)
    .orderBy(sql`EXTRACT(HOUR FROM ${episodeListens.listenedAt})`);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [newListenersThisWeek] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})` })
    .from(episodeListens)
    .where(sql`${episodeListens.listenedAt} > ${sevenDaysAgo} AND ${episodeListens.deviceId} NOT IN (SELECT DISTINCT ${episodeListens.deviceId} FROM ${episodeListens} WHERE ${episodeListens.listenedAt} <= ${sevenDaysAgo})`);

  const [returningListenersThisWeek] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})` })
    .from(episodeListens)
    .where(sql`${episodeListens.listenedAt} > ${sevenDaysAgo} AND ${episodeListens.deviceId} IN (SELECT DISTINCT ${episodeListens.deviceId} FROM ${episodeListens} WHERE ${episodeListens.listenedAt} <= ${sevenDaysAgo})`);

  const [totalDevicesEver] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})` })
    .from(episodeListens);

  const [activeDevices30d] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${episodeListens.deviceId})` })
    .from(episodeListens)
    .where(sql`${episodeListens.listenedAt} > ${thirtyDaysAgo}`);

  const completionRate = await db
    .select({
      total: count(),
      completed: sql<number>`COUNT(CASE WHEN ${playbackPositions.completed} = true THEN 1 END)`,
    })
    .from(playbackPositions);

  const topDevices = await db
    .select({
      deviceId: episodeListens.deviceId,
      listenCount: count(episodeListens.id),
      totalMs: sql<string>`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)`,
    })
    .from(episodeListens)
    .groupBy(episodeListens.deviceId)
    .orderBy(desc(sql`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)`))
    .limit(15);

  return {
    hourlyListens: hourlyListens.map(h => ({ hour: Number(h.hour), count: Number(h.count) })),
    newListeners: Number(newListenersThisWeek.count),
    returningListeners: Number(returningListenersThisWeek.count),
    totalDevicesEver: Number(totalDevicesEver.count),
    activeDevices30d: Number(activeDevices30d.count),
    completionRate: completionRate[0] ? {
      total: Number(completionRate[0].total),
      completed: Number(completionRate[0].completed),
      rate: completionRate[0].total > 0 ? Math.round((Number(completionRate[0].completed) / Number(completionRate[0].total)) * 100) : 0,
    } : { total: 0, completed: 0, rate: 0 },
    topDevices: topDevices.map(d => ({
      deviceId: d.deviceId,
      listenCount: Number(d.listenCount),
      totalMinutes: Math.round(Number(d.totalMs) / 60000),
    })),
  };
}

// Error Reports
export async function createErrorReport(data: {
  deviceId: string | null;
  level: string;
  message: string;
  stack: string | null;
  source: string | null;
  platform: string | null;
  appVersion: string | null;
  metadata?: string | null;
}): Promise<ErrorReport> {
  const [report] = await db.insert(errorReports).values(data).returning();
  return report;
}

export async function getErrorReports(opts: {
  page: number;
  limit: number;
  level?: string;
  resolved?: boolean;
  source?: string;
  search?: string;
}): Promise<{ reports: ErrorReport[]; total: number; page: number; totalPages: number }> {
  const conditions = [];
  if (opts.level) conditions.push(eq(errorReports.level, opts.level));
  if (opts.resolved !== undefined) conditions.push(eq(errorReports.resolved, opts.resolved));
  if (opts.source) conditions.push(eq(errorReports.source, opts.source));
  if (opts.search) conditions.push(ilike(errorReports.message, `%${opts.search}%`));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(errorReports).where(where);
  const reports = await db.select().from(errorReports)
    .where(where)
    .orderBy(desc(errorReports.createdAt))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);

  return {
    reports,
    total: Number(total),
    page: opts.page,
    totalPages: Math.ceil(Number(total) / opts.limit),
  };
}

export async function getGroupedErrorReports(limit: number = 30): Promise<{ messageHash: string; message: string; count: number; lastSeen: string; firstSeen: string; source: string | null; platforms: string; appVersions: string; deviceCount: number }[]> {
  const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db.select({
    messageHash: sql<string>`md5(LEFT(${errorReports.message}, 200))`,
    message: sql<string>`LEFT(${errorReports.message}, 200)`,
    count: count(),
    lastSeen: sql<string>`MAX(${errorReports.createdAt})`,
    firstSeen: sql<string>`MIN(${errorReports.createdAt})`,
    source: sql<string>`MODE() WITHIN GROUP (ORDER BY ${errorReports.source})`,
    platforms: sql<string>`string_agg(DISTINCT ${errorReports.platform}, ', ')`,
    appVersions: sql<string>`string_agg(DISTINCT ${errorReports.appVersion}, ', ')`,
    deviceCount: sql<number>`COUNT(DISTINCT ${errorReports.deviceId})`,
  }).from(errorReports)
    .where(and(eq(errorReports.resolved, false), sql`${errorReports.createdAt} > ${d30}`))
    .groupBy(sql`md5(LEFT(${errorReports.message}, 200))`, sql`LEFT(${errorReports.message}, 200)`)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map(r => ({ ...r, count: Number(r.count), deviceCount: Number(r.deviceCount) }));
}

export async function getErrorOccurrences(messageHash: string, limit: number = 20): Promise<ErrorReport[]> {
  return db.select().from(errorReports)
    .where(sql`md5(LEFT(${errorReports.message}, 200)) = ${messageHash}`)
    .orderBy(desc(errorReports.createdAt))
    .limit(limit);
}

export async function resolveErrorReport(id: string): Promise<ErrorReport> {
  const [report] = await db.update(errorReports)
    .set({ resolved: true })
    .where(eq(errorReports.id, id))
    .returning();
  return report;
}

/**
 * Mark ALL error reports matching a given messageHash as resolved. Used from
 * the admin "grouped errors" view so a fix can be marked resolved in one click,
 * and any new occurrences (with the same hash but unresolved) make it obvious
 * the fix didn't stick.
 */
export async function resolveErrorGroup(messageHash: string): Promise<number> {
  const result = await db.update(errorReports)
    .set({ resolved: true })
    .where(sql`md5(LEFT(${errorReports.message}, 200)) = ${messageHash}`)
    .returning({ id: errorReports.id });
  return result.length;
}

/**
 * Un-resolve (reopen) a group. Useful if the bug regresses and you want to
 * see new occurrences surface again.
 */
export async function reopenErrorGroup(messageHash: string): Promise<number> {
  const result = await db.update(errorReports)
    .set({ resolved: false })
    .where(sql`md5(LEFT(${errorReports.message}, 200)) = ${messageHash}`)
    .returning({ id: errorReports.id });
  return result.length;
}

export async function deleteResolvedErrorReports(): Promise<number> {
  const result = await db.delete(errorReports).where(eq(errorReports.resolved, true)).returning();
  return result.length;
}

/**
 * Delete error reports older than N days. Runs daily to keep the table from
 * growing without bound — older reports aren't useful for ongoing triage.
 */
export async function deleteOldErrorReports(olderThanDays: number = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await db.delete(errorReports)
    .where(sql`${errorReports.createdAt} < ${cutoff}`)
    .returning({ id: errorReports.id });
  return result.length;
}

export async function getErrorHealth(): Promise<{
  lastHour: number;
  last24h: number;
  last7d: number;
  topErrors: { message: string; source: string | null; count: number; firstSeen: Date; lastSeen: Date }[];
  bySource: { source: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
}> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [[h1], [h24], [h7d]] = await Promise.all([
    db.select({ count: count() }).from(errorReports).where(sql`${errorReports.createdAt} > ${oneHourAgo}`),
    db.select({ count: count() }).from(errorReports).where(sql`${errorReports.createdAt} > ${oneDayAgo}`),
    db.select({ count: count() }).from(errorReports).where(sql`${errorReports.createdAt} > ${sevenDaysAgo}`),
  ]);

  const topErrors = await db.select({
    message: sql<string>`LEFT(${errorReports.message}, 120)`,
    source: errorReports.source,
    count: count(),
    firstSeen: sql<Date>`MIN(${errorReports.createdAt})`,
    lastSeen: sql<Date>`MAX(${errorReports.createdAt})`,
  })
    .from(errorReports)
    .where(sql`${errorReports.createdAt} > ${sevenDaysAgo}`)
    .groupBy(sql`LEFT(${errorReports.message}, 120)`, errorReports.source)
    .orderBy(desc(count()))
    .limit(10);

  const bySource = await db.select({
    source: sql<string>`COALESCE(${errorReports.source}, 'unknown')`,
    count: count(),
  })
    .from(errorReports)
    .where(sql`${errorReports.createdAt} > ${sevenDaysAgo}`)
    .groupBy(sql`COALESCE(${errorReports.source}, 'unknown')`)
    .orderBy(desc(count()));

  const byPlatform = await db.select({
    platform: sql<string>`COALESCE(${errorReports.platform}, 'unknown')`,
    count: count(),
  })
    .from(errorReports)
    .where(sql`${errorReports.createdAt} > ${sevenDaysAgo}`)
    .groupBy(sql`COALESCE(${errorReports.platform}, 'unknown')`)
    .orderBy(desc(count()));

  return {
    lastHour: Number(h1.count),
    last24h: Number(h24.count),
    last7d: Number(h7d.count),
    topErrors: topErrors.map(e => ({ ...e, count: Number(e.count) })),
    bySource: bySource.map(s => ({ ...s, count: Number(s.count) })),
    byPlatform: byPlatform.map(p => ({ ...p, count: Number(p.count) })),
  };
}

export async function createFeedback(data: {
  deviceId: string | null;
  type: string;
  subject: string;
  message: string;
  contactInfo: string | null;
  deviceLogs: string | null;
}): Promise<Feedback> {
  const [fb] = await db.insert(feedback).values(data).returning();
  return fb;
}

export async function getFeedbackList(opts: {
  page: number;
  limit: number;
  type?: string;
  status?: string;
}): Promise<{ items: Feedback[]; total: number; page: number; totalPages: number }> {
  const conditions = [];
  if (opts.type) conditions.push(eq(feedback.type, opts.type));
  if (opts.status) conditions.push(eq(feedback.status, opts.status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(feedback).where(where);
  const items = await db.select().from(feedback)
    .where(where)
    .orderBy(desc(feedback.createdAt))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);

  return {
    items,
    total: Number(total),
    page: opts.page,
    totalPages: Math.ceil(Number(total) / opts.limit),
  };
}

export async function updateFeedbackStatus(id: string, status: string, adminNotes?: string): Promise<Feedback> {
  const set: any = { status };
  if (adminNotes !== undefined) set.adminNotes = adminNotes;
  const [fb] = await db.update(feedback).set(set).where(eq(feedback.id, id)).returning();
  return fb;
}

export async function deleteFeedback(id: string): Promise<void> {
  await db.delete(feedback).where(eq(feedback.id, id));
}

export async function registerPushToken(deviceId: string, token: string, platform: string, provider: string = "expo"): Promise<PushToken> {
  const [result] = await db.insert(pushTokens).values({ deviceId, token, platform, provider }).onConflictDoUpdate({
    target: [pushTokens.token],
    set: { deviceId, platform, provider, updatedAt: new Date() },
  }).returning();
  return result;
}

export async function getAllPushTokens(): Promise<PushToken[]> {
  return db.select().from(pushTokens).orderBy(desc(pushTokens.updatedAt));
}

export async function getPushHealthStats(): Promise<{
  totalDevices: number;
  devicesWithTokens: number;
  coveragePct: number;
  byProvider: { provider: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
  tokenFreshness: { fresh24h: number; freshWeek: number; olderThanWeek: number };
  deadReachConvs: { conversationId: string; deviceId: string; adminReplyCount: number; lastReplyAt: string; deviceModel: string | null; deviceBrand: string | null }[];
}> {
  const [totals] = await db.select({
    totalDevices: sql<number>`(SELECT COUNT(DISTINCT device_id) FROM ${deviceProfiles})`,
    devicesWithTokens: sql<number>`(SELECT COUNT(DISTINCT device_id) FROM ${pushTokens})`,
  }).from(sql`(SELECT 1) dummy`);

  const byProvider = await db.select({
    provider: pushTokens.provider,
    count: count(),
  }).from(pushTokens).groupBy(pushTokens.provider);

  const byPlatform = await db.select({
    platform: pushTokens.platform,
    count: count(),
  }).from(pushTokens).groupBy(pushTokens.platform);

  const now = Date.now();
  const [freshness] = await db.select({
    fresh24h: sql<number>`COUNT(*) FILTER (WHERE ${pushTokens.updatedAt} > ${new Date(now - 24 * 60 * 60 * 1000)})`,
    freshWeek: sql<number>`COUNT(*) FILTER (WHERE ${pushTokens.updatedAt} > ${new Date(now - 7 * 24 * 60 * 60 * 1000)} AND ${pushTokens.updatedAt} <= ${new Date(now - 24 * 60 * 60 * 1000)})`,
    olderThanWeek: sql<number>`COUNT(*) FILTER (WHERE ${pushTokens.updatedAt} <= ${new Date(now - 7 * 24 * 60 * 60 * 1000)})`,
  }).from(pushTokens);

  // Dead-reach: conversations where admin replied but the recipient device has no push token
  const deadReach = await db.execute<{
    conversation_id: string;
    device_id: string;
    admin_reply_count: number;
    last_reply_at: string;
    device_model: string | null;
    device_brand: string | null;
  }>(sql`
    SELECT
      c.id AS conversation_id,
      c.device_id,
      (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = c.id AND sender = 'admin') AS admin_reply_count,
      (SELECT MAX(created_at) FROM conversation_messages WHERE conversation_id = c.id AND sender = 'admin') AS last_reply_at,
      dp.device_model,
      dp.device_brand
    FROM conversations c
    LEFT JOIN device_profiles dp ON dp.device_id = c.device_id
    WHERE c.device_id NOT IN (SELECT device_id FROM push_tokens)
      AND EXISTS (SELECT 1 FROM conversation_messages WHERE conversation_id = c.id AND sender = 'admin')
    ORDER BY last_reply_at DESC
    LIMIT 20
  `);

  const totalDevices = Number(totals.totalDevices);
  const devicesWithTokens = Number(totals.devicesWithTokens);

  return {
    totalDevices,
    devicesWithTokens,
    coveragePct: totalDevices > 0 ? Math.round((devicesWithTokens / totalDevices) * 100) : 0,
    byProvider: byProvider.map(r => ({ provider: r.provider, count: Number(r.count) })),
    byPlatform: byPlatform.map(r => ({ platform: r.platform, count: Number(r.count) })),
    tokenFreshness: {
      fresh24h: Number(freshness.fresh24h),
      freshWeek: Number(freshness.freshWeek),
      olderThanWeek: Number(freshness.olderThanWeek),
    },
    deadReachConvs: (deadReach.rows || deadReach || []).map((r: any) => ({
      conversationId: r.conversation_id,
      deviceId: r.device_id,
      adminReplyCount: Number(r.admin_reply_count),
      lastReplyAt: r.last_reply_at,
      deviceModel: r.device_model,
      deviceBrand: r.device_brand,
    })),
  };
}

export async function getPushTokensForDevices(deviceIds: string[]): Promise<PushToken[]> {
  if (deviceIds.length === 0) return [];
  return db.select().from(pushTokens).where(inArray(pushTokens.deviceId, deviceIds));
}

export async function getSubscribersForFeed(feedId: string): Promise<PushToken[]> {
  const subs = await db.select({ deviceId: subscriptions.deviceId }).from(subscriptions).where(eq(subscriptions.feedId, feedId));
  if (subs.length === 0) return [];
  const deviceIds = subs.map(s => s.deviceId);

  // Exclude muted devices
  const mutedRows = await db.select({ deviceId: notificationPreferences.deviceId })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.feedId, feedId), eq(notificationPreferences.muted, true)));
  const mutedSet = new Set(mutedRows.map(r => r.deviceId));
  const activeDeviceIds = deviceIds.filter(id => !mutedSet.has(id));

  if (activeDeviceIds.length === 0) return [];
  return db.select().from(pushTokens).where(inArray(pushTokens.deviceId, activeDeviceIds));
}

export async function muteNotificationsForFeed(deviceId: string, feedId: string): Promise<NotificationPreference> {
  const [pref] = await db.insert(notificationPreferences)
    .values({ deviceId, feedId, muted: true })
    .onConflictDoUpdate({
      target: [notificationPreferences.deviceId, notificationPreferences.feedId],
      set: { muted: true },
    })
    .returning();
  return pref;
}

export async function unmuteNotificationsForFeed(deviceId: string, feedId: string): Promise<void> {
  await db.delete(notificationPreferences)
    .where(and(eq(notificationPreferences.deviceId, deviceId), eq(notificationPreferences.feedId, feedId)));
}

export async function getNotificationPreference(deviceId: string, feedId: string): Promise<NotificationPreference | undefined> {
  const [pref] = await db.select().from(notificationPreferences)
    .where(and(eq(notificationPreferences.deviceId, deviceId), eq(notificationPreferences.feedId, feedId)))
    .limit(1);
  return pref;
}

export async function removePushToken(token: string): Promise<void> {
  await db.delete(pushTokens).where(eq(pushTokens.token, token));
}

export async function removePushTokenById(id: string): Promise<void> {
  await db.delete(pushTokens).where(eq(pushTokens.id, id));
}

export async function createContactMessage(name: string, email: string | null, message: string): Promise<ContactMessage> {
  const [msg] = await db.insert(contactMessages).values({ name, email, message }).returning();
  return msg;
}

export async function getAllContactMessages(): Promise<ContactMessage[]> {
  return db.select().from(contactMessages).orderBy(desc(contactMessages.createdAt));
}

export async function markContactMessageRead(id: string): Promise<void> {
  await db.update(contactMessages).set({ isRead: true, status: "read" }).where(eq(contactMessages.id, id));
}

export async function updateContactMessageStatus(id: string, status: string): Promise<void> {
  await db.update(contactMessages).set({ status }).where(eq(contactMessages.id, id));
}

export async function getAdminUser(username: string) {
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.username, username));
  return user || null;
}

export async function deleteContactMessage(id: string): Promise<void> {
  await db.delete(contactMessages).where(eq(contactMessages.id, id));
}

export async function changeAdminPassword(username: string, oldPassword: string, newPassword: string): Promise<boolean> {
  const valid = await verifyAdmin(username, oldPassword);
  if (!valid) return false;
  const hash = await bcrypt.hash(newPassword, 10);
  await db.update(adminUsers).set({ passwordHash: hash }).where(eq(adminUsers.username, username));
  return true;
}

export async function createApkUpload(data: { filename: string; originalName: string; version?: string; fileSize: number; fileData?: string }): Promise<ApkUpload> {
  await db.update(apkUploads).set({ isActive: false }).where(eq(apkUploads.isActive, true));
  const [upload] = await db.insert(apkUploads).values(data).returning();
  return upload;
}

export async function getActiveApk(): Promise<ApkUpload | null> {
  const [apk] = await db.select().from(apkUploads).where(eq(apkUploads.isActive, true)).orderBy(desc(apkUploads.createdAt)).limit(1);
  return apk || null;
}

export async function getAllApkUploads() {
  return db.select({
    id: apkUploads.id,
    filename: apkUploads.filename,
    originalName: apkUploads.originalName,
    version: apkUploads.version,
    fileSize: apkUploads.fileSize,
    isActive: apkUploads.isActive,
    createdAt: apkUploads.createdAt,
  }).from(apkUploads).orderBy(desc(apkUploads.createdAt));
}

export async function setActiveApk(id: string): Promise<void> {
  await db.update(apkUploads).set({ isActive: false }).where(eq(apkUploads.isActive, true));
  await db.update(apkUploads).set({ isActive: true }).where(eq(apkUploads.id, id));
}

export async function deleteApkUpload(id: string): Promise<string | null> {
  const [apk] = await db.select().from(apkUploads).where(eq(apkUploads.id, id));
  if (!apk) return null;
  await db.delete(apkUploads).where(eq(apkUploads.id, id));
  return apk.filename;
}

export async function getActiveSponsor(): Promise<Sponsor | undefined> {
  const [sponsor] = await db.select().from(sponsors).where(eq(sponsors.isActive, true)).orderBy(desc(sponsors.createdAt)).limit(1);
  return sponsor;
}

export async function getAllSponsors(): Promise<Sponsor[]> {
  return db.select().from(sponsors).orderBy(desc(sponsors.createdAt));
}

export async function createSponsor(data: { name: string; text?: string; logoUrl?: string; linkUrl?: string }): Promise<Sponsor> {
  const [sponsor] = await db.insert(sponsors).values(data).returning();
  return sponsor;
}

export async function updateSponsor(id: string, data: Partial<{ name: string; text: string; logoUrl: string; linkUrl: string; isActive: boolean }>): Promise<Sponsor> {
  const [sponsor] = await db.update(sponsors).set(data).where(eq(sponsors.id, id)).returning();
  return sponsor;
}

export async function deleteSponsor(id: string): Promise<void> {
  await db.delete(sponsors).where(eq(sponsors.id, id));
}

export async function getRecommendations(deviceId: string, limit: number = 10): Promise<Feed[]> {
  // Get feeds the user is subscribed to
  const subs = await db.select({ feedId: subscriptions.feedId }).from(subscriptions).where(eq(subscriptions.deviceId, deviceId));
  if (subs.length === 0) return [];
  const subscribedIds = subs.map(s => s.feedId);

  // Get categories of subscribed feeds
  const subCats = await db.select({ categoryId: feedCategories.categoryId })
    .from(feedCategories)
    .where(inArray(feedCategories.feedId, subscribedIds));

  // Also check direct categoryId on feeds
  const directCats = await db.select({ categoryId: feeds.categoryId })
    .from(feeds)
    .where(and(inArray(feeds.id, subscribedIds), sql`${feeds.categoryId} IS NOT NULL`));

  const categoryIds = [...new Set([
    ...subCats.map(c => c.categoryId),
    ...directCats.filter(c => c.categoryId).map(c => c.categoryId!),
  ])];
  if (categoryIds.length === 0) return [];

  // Find other feeds in same categories, not already subscribed
  const relatedViaJoin = await db.select({ feedId: feedCategories.feedId })
    .from(feedCategories)
    .where(and(
      inArray(feedCategories.categoryId, categoryIds),
      sql`${feedCategories.feedId} NOT IN (${sql.join(subscribedIds.map(id => sql`${id}`), sql`, `)})`
    ));

  const relatedViaDirect = await db.select({ id: feeds.id })
    .from(feeds)
    .where(and(
      inArray(feeds.categoryId, categoryIds),
      eq(feeds.isActive, true),
      sql`${feeds.id} NOT IN (${sql.join(subscribedIds.map(id => sql`${id}`), sql`, `)})`
    ));

  const candidateIds = [...new Set([
    ...relatedViaJoin.map(r => r.feedId),
    ...relatedViaDirect.map(r => r.id),
  ])];
  if (candidateIds.length === 0) return [];

  // Rank by listen count
  const ranked = await db.select({
    feedId: episodes.feedId,
    count: count(),
  })
    .from(episodeListens)
    .innerJoin(episodes, eq(episodeListens.episodeId, episodes.id))
    .where(inArray(episodes.feedId, candidateIds))
    .groupBy(episodes.feedId)
    .orderBy(desc(count()))
    .limit(limit);

  const rankedFeedIds = ranked.map(r => r.feedId);
  // Fill remaining slots with unranked candidates
  const remaining = candidateIds.filter(id => !rankedFeedIds.includes(id));
  const finalIds = [...new Set([...rankedFeedIds, ...remaining])].slice(0, limit);

  if (finalIds.length === 0) return [];
  const result = await db.select().from(feeds).where(and(inArray(feeds.id, finalIds), eq(feeds.isActive, true)));
  // Preserve rank order
  const feedMap = new Map(result.map(f => [f.id, f]));
  return finalIds.map(id => feedMap.get(id)).filter(Boolean) as Feed[];
}

// Announcements
export async function getAllAnnouncements(): Promise<Announcement[]> {
  return db.select().from(announcements).orderBy(desc(announcements.createdAt));
}

export async function getAnnouncementsForDevice(deviceId: string): Promise<Announcement[]> {
  const active = await db.select().from(announcements).where(eq(announcements.isActive, true));
  if (active.length === 0) return [];

  // Get dismissals for this device
  const dismissed = await db.select({ announcementId: announcementDismissals.announcementId })
    .from(announcementDismissals)
    .where(eq(announcementDismissals.deviceId, deviceId));
  const dismissedIds = new Set(dismissed.map(d => d.announcementId));

  // Get device subscriptions for targeting
  const subs = await db.select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .where(eq(subscriptions.deviceId, deviceId));
  const subscribedFeedIds = new Set(subs.map(s => s.feedId));

  return active.filter(ann => {
    // Filter by frequency + dismissal
    if (ann.frequency === "once" && dismissedIds.has(ann.id)) return false;
    if (ann.frequency === "until_dismissed" && dismissedIds.has(ann.id)) return false;
    // "every_open" always shows (dismissal is per-session, handled client-side)

    // Filter by targeting
    if (ann.targetType === "all") return true;
    if (ann.targetType === "feed_subscribers" && ann.targetValue) {
      return subscribedFeedIds.has(ann.targetValue);
    }
    if (ann.targetType === "device" && ann.targetValue) {
      return ann.targetValue === deviceId;
    }
    return true;
  });
}

export async function createAnnouncement(data: {
  title: string;
  body: string;
  imageUrl?: string;
  actionLabel?: string;
  actionUrl?: string;
  targetType?: string;
  targetValue?: string;
  frequency?: string;
}): Promise<Announcement> {
  const [ann] = await db.insert(announcements).values(data).returning();
  return ann;
}

export async function updateAnnouncement(id: string, data: Partial<{
  title: string;
  body: string;
  imageUrl: string;
  actionLabel: string;
  actionUrl: string;
  targetType: string;
  targetValue: string;
  frequency: string;
  isActive: boolean;
}>): Promise<Announcement> {
  const [ann] = await db.update(announcements).set(data).where(eq(announcements.id, id)).returning();
  return ann;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await db.delete(announcements).where(eq(announcements.id, id));
}

export async function dismissAnnouncement(announcementId: string, deviceId: string): Promise<void> {
  await db.insert(announcementDismissals)
    .values({ announcementId, deviceId })
    .onConflictDoNothing();
}

export async function getAnnouncementDismissCounts(announcementIds: string[]): Promise<Map<string, number>> {
  if (announcementIds.length === 0) return new Map();
  const rows = await db.select({ announcementId: announcementDismissals.announcementId, count: count() })
    .from(announcementDismissals)
    .where(inArray(announcementDismissals.announcementId, announcementIds))
    .groupBy(announcementDismissals.announcementId);
  return new Map(rows.map(r => [r.announcementId, Number(r.count)]));
}

export async function getAnnouncementDismissCount(announcementId: string): Promise<number> {
  const [result] = await db.select({ count: count() })
    .from(announcementDismissals)
    .where(eq(announcementDismissals.announcementId, announcementId));
  return result?.count ?? 0;
}

export async function getQueueForDevice(deviceId: string) {
  return db.select()
    .from(queueItems)
    .where(eq(queueItems.deviceId, deviceId))
    .orderBy(asc(queueItems.position));
}

export async function saveQueue(deviceId: string, items: { episodeId: string; feedId: string; position: number }[]) {
  await db.delete(queueItems).where(eq(queueItems.deviceId, deviceId));
  if (items.length === 0) return;

  // Drop items whose episode or feed no longer exists server-side. Without
  // this, a single stale ref from the client's local queue fails the whole
  // bulk insert with an FK violation.
  const episodeIds = [...new Set(items.map(i => i.episodeId))];
  const feedIds = [...new Set(items.map(i => i.feedId))];
  const [okEps, okFeeds] = await Promise.all([
    db.select({ id: episodes.id }).from(episodes).where(inArray(episodes.id, episodeIds)),
    db.select({ id: feeds.id }).from(feeds).where(inArray(feeds.id, feedIds)),
  ]);
  const epSet = new Set(okEps.map(r => r.id));
  const feedSet = new Set(okFeeds.map(r => r.id));
  const valid = items.filter(i => epSet.has(i.episodeId) && feedSet.has(i.feedId));

  if (valid.length > 0) {
    await db.insert(queueItems).values(
      valid.map(item => ({
        deviceId,
        episodeId: item.episodeId,
        feedId: item.feedId,
        position: item.position,
      }))
    );
  }
}

export async function recordNotificationTap(data: {
  deviceId: string;
  notificationType?: string;
  episodeId?: string;
  feedId?: string;
}): Promise<void> {
  await db.insert(notificationTaps).values({
    deviceId: data.deviceId,
    notificationType: data.notificationType || null,
    episodeId: data.episodeId || null,
    feedId: data.feedId || null,
  });
}

export async function getNotificationTapStats(days: number = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const taps = await db.select()
    .from(notificationTaps)
    .where(sql`${notificationTaps.tappedAt} >= ${since}`)
    .orderBy(desc(notificationTaps.tappedAt));

  const total = taps.length;
  const byType: Record<string, number> = {};
  for (const tap of taps) {
    const t = tap.notificationType || "unknown";
    byType[t] = (byType[t] || 0) + 1;
  }

  return { total, byType, recentTaps: taps.slice(0, 50) };
}

// ---- New functions for admin stats, KH management, source breakdown ----

export async function getAllFeedStats(): Promise<Map<string, { episodeCount: number; subscriberCount: number; listenCount: number }>> {
  const epCounts = await db
    .select({ feedId: episodes.feedId, cnt: count(episodes.id) })
    .from(episodes)
    .groupBy(episodes.feedId);

  const subCounts = await db
    .select({ feedId: subscriptions.feedId, cnt: count(subscriptions.id) })
    .from(subscriptions)
    .groupBy(subscriptions.feedId);

  const listenCounts = await db
    .select({ feedId: episodes.feedId, cnt: count(episodeListens.id) })
    .from(episodeListens)
    .innerJoin(episodes, eq(episodeListens.episodeId, episodes.id))
    .groupBy(episodes.feedId);

  const result = new Map<string, { episodeCount: number; subscriberCount: number; listenCount: number }>();

  for (const row of epCounts) {
    if (!result.has(row.feedId)) result.set(row.feedId, { episodeCount: 0, subscriberCount: 0, listenCount: 0 });
    result.get(row.feedId)!.episodeCount = Number(row.cnt);
  }
  for (const row of subCounts) {
    if (!result.has(row.feedId)) result.set(row.feedId, { episodeCount: 0, subscriberCount: 0, listenCount: 0 });
    result.get(row.feedId)!.subscriberCount = Number(row.cnt);
  }
  for (const row of listenCounts) {
    if (!result.has(row.feedId)) result.set(row.feedId, { episodeCount: 0, subscriberCount: 0, listenCount: 0 });
    result.get(row.feedId)!.listenCount = Number(row.cnt);
  }

  return result;
}

export async function getKHSpeakerStats() {
  const allFeeds = await db.select().from(feeds).where(sql`${feeds.kolhalashonRavId} IS NOT NULL`);
  const stats = await getAllFeedStats();

  return allFeeds.map(f => {
    const s = stats.get(f.id) || { episodeCount: 0, subscriberCount: 0, listenCount: 0 };
    const platforms: string[] = [];
    if (f.rssUrl && !isApiOnlyUrl(f.rssUrl)) {
      platforms.push("RSS");
    }
    if (f.tatSpeakerId) platforms.push("Torah Anytime");
    if (f.alldafAuthorId) platforms.push("AllDaf");
    if (f.allmishnahAuthorId) platforms.push("AllMishnah");
    if (f.allparshaAuthorId) platforms.push("AllParsha");
    if (f.allhalachaAuthorId) platforms.push("AllHalacha");
    if (f.kolhalashonRavId) platforms.push("Kol Halashon");

    return {
      id: f.id,
      title: f.title,
      author: f.author,
      imageUrl: f.imageUrl,
      kolhalashonRavId: f.kolhalashonRavId,
      isActive: f.isActive,
      showInBrowse: f.showInBrowse,
      episodeCount: s.episodeCount,
      subscriberCount: s.subscriberCount,
      listenCount: s.listenCount,
      isMerged: platforms.length > 1,
      platforms,
    };
  }).sort((a, b) => b.listenCount - a.listenCount);
}

export async function getSourceBreakdown() {
  // Exclude admin-disabled TAT feeds so the Sources chart doesn't still
  // report a huge "Torah Anytime" bucket after admin toggled TAT off.
  const allFeeds = await db.select().from(feeds)
    .where(sql`NOT (${feeds.rssUrl} LIKE 'tat://%' AND ${feeds.isActive} = false)`);
  const stats = await getAllFeedStats();

  const sources: Record<string, { feedCount: number; episodeCount: number }> = {
    "RSS": { feedCount: 0, episodeCount: 0 },
    "Torah Anytime": { feedCount: 0, episodeCount: 0 },
    "AllDaf": { feedCount: 0, episodeCount: 0 },
    "AllMishnah": { feedCount: 0, episodeCount: 0 },
    "AllParsha": { feedCount: 0, episodeCount: 0 },
    "AllHalacha": { feedCount: 0, episodeCount: 0 },
    "Kol Halashon": { feedCount: 0, episodeCount: 0 },
  };

  for (const f of allFeeds) {
    // Classify by primary source — check platform IDs (not just URL scheme)
    // so merged feeds are counted under their platform too
    let source = "RSS";
    if (f.kolhalashonRavId && f.rssUrl.startsWith("kh://")) source = "Kol Halashon";
    else if (f.tatSpeakerId && f.rssUrl.startsWith("tat://")) source = "Torah Anytime";
    else if (f.alldafAuthorId) source = "AllDaf";
    else if (f.allmishnahAuthorId) source = "AllMishnah";
    else if (f.allparshaAuthorId) source = "AllParsha";
    else if (f.allhalachaAuthorId) source = "AllHalacha";
    else if (f.tatSpeakerId) source = "Torah Anytime";
    else if (f.kolhalashonRavId) source = "Kol Halashon";

    if (!sources[source]) sources[source] = { feedCount: 0, episodeCount: 0 };
    sources[source].feedCount++;
    const s = stats.get(f.id);
    if (s) sources[source].episodeCount += s.episodeCount;
  }

  const sourceList = Object.entries(sources)
    .map(([name, data]) => ({ name, ...data }))
    .filter(s => s.feedCount > 0);

  return {
    sources: sourceList,
    totalFeeds: allFeeds.length,
    totalEpisodes: sourceList.reduce((sum, s) => sum + s.episodeCount, 0),
  };
}

export async function searchFeeds(query: string, limit: number = 50): Promise<Feed[]> {
  const pattern = `%${query}%`;
  // Include active feeds + inactive KH feeds (so users can discover and follow KH speakers)
  return db.select().from(feeds)
    .where(and(
      sql`(${feeds.isActive} = true OR ${feeds.rssUrl} LIKE 'kh://%')`,
      sql`(${feeds.title} ILIKE ${pattern} OR ${feeds.author} ILIKE ${pattern})`
    ))
    .orderBy(feeds.title)
    .limit(limit);
}

export async function recomputeKHBrowseVisibility(): Promise<number> {
  // Get all KH-only feeds
  const khFeeds = await db.select({ id: feeds.id }).from(feeds).where(sql`${feeds.rssUrl} LIKE 'kh://rav/%'`);
  if (khFeeds.length === 0) return 0;

  const khIds = khFeeds.map(f => f.id);

  // Get subscriber counts for KH feeds
  const subCounts = await db
    .select({ feedId: subscriptions.feedId, cnt: count(subscriptions.id) })
    .from(subscriptions)
    .where(inArray(subscriptions.feedId, khIds))
    .groupBy(subscriptions.feedId);
  const subMap = new Map(subCounts.map(s => [s.feedId, Number(s.cnt)]));

  // Get listen counts for KH feeds
  const listenCounts = await db
    .select({ feedId: episodes.feedId, cnt: count(episodeListens.id) })
    .from(episodeListens)
    .innerJoin(episodes, eq(episodeListens.episodeId, episodes.id))
    .where(inArray(episodes.feedId, khIds))
    .groupBy(episodes.feedId);
  const listenMap = new Map(listenCounts.map(s => [s.feedId, Number(s.cnt)]));

  // Rank by popularity: subscribers * 10 + listens
  const ranked = khIds.map(id => ({
    id,
    score: (subMap.get(id) || 0) * 10 + (listenMap.get(id) || 0),
  })).sort((a, b) => b.score - a.score);

  const top100Ids = new Set(ranked.slice(0, 100).map(r => r.id));
  const showIds = ranked.filter(r => top100Ids.has(r.id)).map(r => r.id);
  const hideIds = ranked.filter(r => !top100Ids.has(r.id)).map(r => r.id);

  let updated = 0;
  if (showIds.length > 0) {
    const result = await db.update(feeds).set({ showInBrowse: true }).where(and(inArray(feeds.id, showIds), eq(feeds.showInBrowse, false)));
    updated += (result as any).rowCount || 0;
  }
  if (hideIds.length > 0) {
    const result = await db.update(feeds).set({ showInBrowse: false }).where(and(inArray(feeds.id, hideIds), eq(feeds.showInBrowse, true)));
    updated += (result as any).rowCount || 0;
  }

  console.log(`KH browse visibility recomputed: ${showIds.length} shown, ${hideIds.length} hidden, ${updated} changed`);
  return updated;
}

export async function getAllMergeHistory() {
  const history = await db.select({
    id: feedMergeHistory.id,
    targetFeedId: feedMergeHistory.targetFeedId,
    sourceFeedTitle: feedMergeHistory.sourceFeedTitle,
    sourceFeedAuthor: feedMergeHistory.sourceFeedAuthor,
    sourceFeedRssUrl: feedMergeHistory.sourceFeedRssUrl,
    episodesMoved: feedMergeHistory.episodesMoved,
    subscriptionsMoved: feedMergeHistory.subscriptionsMoved,
    mergedAt: feedMergeHistory.mergedAt,
    targetFeedTitle: feeds.title,
    targetFeedAuthor: feeds.author,
  })
    .from(feedMergeHistory)
    .leftJoin(feeds, eq(feedMergeHistory.targetFeedId, feeds.id))
    .orderBy(desc(feedMergeHistory.mergedAt));
  return history;
}

// App Config CRUD
export async function getAllConfig(): Promise<Record<string, any>> {
  const rows = await db.select().from(appConfig);
  const result: Record<string, any> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

export async function getAllConfigEntries(): Promise<AppConfig[]> {
  return db.select().from(appConfig).orderBy(appConfig.key);
}

export async function getConfig(key: string): Promise<any> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function setConfig(key: string, value: any, description?: string): Promise<void> {
  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
  await db.insert(appConfig).values({
    key,
    value: jsonValue,
    description: description || null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: appConfig.key,
    set: {
      value: jsonValue,
      ...(description !== undefined ? { description } : {}),
      updatedAt: new Date(),
    },
  });
}

export async function deleteConfig(key: string): Promise<void> {
  await db.delete(appConfig).where(eq(appConfig.key, key));
}

// Device Profiles
export async function upsertDeviceProfile(data: {
  deviceId: string;
  platform?: string | null;
  osVersion?: string | null;
  deviceModel?: string | null;
  deviceBrand?: string | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  appVersion?: string | null;
  locale?: string | null;
  timezone?: string | null;
  country?: string | null;
  city?: string | null;
  ipAddress?: string | null;
}): Promise<DeviceProfile> {
  const [profile] = await db.insert(deviceProfiles).values({
    ...data,
    lastSeenAt: new Date(),
  }).onConflictDoUpdate({
    target: deviceProfiles.deviceId,
    set: {
      platform: data.platform ?? undefined,
      osVersion: data.osVersion ?? undefined,
      deviceModel: data.deviceModel ?? undefined,
      deviceBrand: data.deviceBrand ?? undefined,
      screenWidth: data.screenWidth ?? undefined,
      screenHeight: data.screenHeight ?? undefined,
      appVersion: data.appVersion ?? undefined,
      locale: data.locale ?? undefined,
      timezone: data.timezone ?? undefined,
      country: data.country ?? undefined,
      city: data.city ?? undefined,
      ipAddress: data.ipAddress ?? undefined,
      lastSeenAt: new Date(),
    },
  }).returning();
  return profile;
}

export async function getDeviceProfile(deviceId: string): Promise<DeviceProfile | undefined> {
  const [profile] = await db.select().from(deviceProfiles).where(eq(deviceProfiles.deviceId, deviceId)).limit(1);
  return profile;
}

export async function getDeviceUsageStats(deviceId: string): Promise<{
  totalListens: number;
  totalListeningMinutes: number;
  subscribedFeeds: number;
  totalFavorites: number;
  daysSinceFirstUse: number;
  lastListenDate: string | null;
}> {
  const [[listens], [listenTime], [subs], [favs], [firstListen]] = await Promise.all([
    db.select({ count: count() }).from(episodeListens).where(eq(episodeListens.deviceId, deviceId)),
    db.select({ total: sql<number>`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)` }).from(episodeListens).where(eq(episodeListens.deviceId, deviceId)),
    db.select({ count: count() }).from(subscriptions).where(eq(subscriptions.deviceId, deviceId)),
    db.select({ count: count() }).from(favorites).where(eq(favorites.deviceId, deviceId)),
    db.select({ earliest: sql<Date>`MIN(${episodeListens.listenedAt})`, latest: sql<Date>`MAX(${episodeListens.listenedAt})` }).from(episodeListens).where(eq(episodeListens.deviceId, deviceId)),
  ]);

  const firstDate = firstListen.earliest;
  const daysSinceFirst = firstDate ? Math.floor((Date.now() - new Date(firstDate).getTime()) / (24 * 60 * 60 * 1000)) : 0;

  return {
    totalListens: Number(listens.count),
    totalListeningMinutes: Math.round(Number(listenTime.total) / 60000),
    subscribedFeeds: Number(subs.count),
    totalFavorites: Number(favs.count),
    daysSinceFirstUse: daysSinceFirst,
    lastListenDate: firstListen.latest ? new Date(firstListen.latest).toISOString() : null,
  };
}

export async function getDeviceAnalytics(): Promise<{
  totalDevices: number;
  activeDevices7d: number;
  activeDevices30d: number;
  byModel: { model: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
  byOsVersion: { osVersion: string; count: number }[];
  byCountry: { country: string; count: number }[];
  byCity: { city: string; count: number }[];
  byAppVersion: { appVersion: string; count: number }[];
  avgListeningMinutes: number;
  avgListensPerUser: number;
  powerUsers: { deviceId: string; model: string | null; totalMinutes: number; listens: number }[];
  newUsersThisWeek: number;
  newUsersThisMonth: number;
}> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [[total], [active7], [active30], [newWeek], [newMonth]] = await Promise.all([
    db.select({ count: count() }).from(deviceProfiles),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.lastSeenAt} > ${sevenDaysAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.lastSeenAt} > ${thirtyDaysAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.createdAt} > ${sevenDaysAgo}`),
    db.select({ count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.createdAt} > ${thirtyDaysAgo}`),
  ]);

  const [byModel, byPlatform, byOsVersion, byCountry, byCity, byAppVersion] = await Promise.all([
    db.select({ model: sql<string>`COALESCE(${deviceProfiles.deviceModel}, 'Unknown')`, count: count() }).from(deviceProfiles).groupBy(sql`COALESCE(${deviceProfiles.deviceModel}, 'Unknown')`).orderBy(desc(count())).limit(15),
    db.select({ platform: sql<string>`COALESCE(${deviceProfiles.platform}, 'Unknown')`, count: count() }).from(deviceProfiles).groupBy(sql`COALESCE(${deviceProfiles.platform}, 'Unknown')`).orderBy(desc(count())),
    db.select({ osVersion: sql<string>`COALESCE(${deviceProfiles.osVersion}, 'Unknown')`, count: count() }).from(deviceProfiles).groupBy(sql`COALESCE(${deviceProfiles.osVersion}, 'Unknown')`).orderBy(desc(count())).limit(10),
    db.select({ country: sql<string>`COALESCE(${deviceProfiles.country}, 'Unknown')`, count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.country} IS NOT NULL`).groupBy(sql`COALESCE(${deviceProfiles.country}, 'Unknown')`).orderBy(desc(count())).limit(15),
    db.select({ city: sql<string>`COALESCE(${deviceProfiles.city}, 'Unknown') || ', ' || COALESCE(${deviceProfiles.country}, '')`, count: count() }).from(deviceProfiles).where(sql`${deviceProfiles.city} IS NOT NULL`).groupBy(sql`COALESCE(${deviceProfiles.city}, 'Unknown') || ', ' || COALESCE(${deviceProfiles.country}, '')`).orderBy(desc(count())).limit(20),
    db.select({ appVersion: sql<string>`COALESCE(${deviceProfiles.appVersion}, 'Unknown')`, count: count() }).from(deviceProfiles).groupBy(sql`COALESCE(${deviceProfiles.appVersion}, 'Unknown')`).orderBy(desc(count())).limit(10),
  ]);

  // Usage averages
  const [avgStats] = await db.select({
    avgMinutes: sql<number>`COALESCE(AVG(sub.total_ms) / 60000, 0)`,
    avgListens: sql<number>`COALESCE(AVG(sub.listen_count), 0)`,
  }).from(sql`(SELECT ${episodeListens.deviceId}, SUM(${episodeListens.durationListenedMs}) as total_ms, COUNT(*) as listen_count FROM ${episodeListens} GROUP BY ${episodeListens.deviceId}) sub`);

  // Power users
  const powerUsers = await db.select({
    deviceId: episodeListens.deviceId,
    totalMinutes: sql<number>`SUM(${episodeListens.durationListenedMs}) / 60000`,
    listens: count(),
  }).from(episodeListens).groupBy(episodeListens.deviceId).orderBy(desc(sql`SUM(${episodeListens.durationListenedMs})`)).limit(20);

  // Join with device profiles for model names
  const deviceIds = powerUsers.map(p => p.deviceId);
  const profiles = deviceIds.length > 0 ? await db.select().from(deviceProfiles).where(inArray(deviceProfiles.deviceId, deviceIds)) : [];
  const profileMap = new Map(profiles.map(p => [p.deviceId, p]));

  return {
    totalDevices: Number(total.count),
    activeDevices7d: Number(active7.count),
    activeDevices30d: Number(active30.count),
    byModel: byModel.map(m => ({ ...m, count: Number(m.count) })),
    byPlatform: byPlatform.map(p => ({ ...p, count: Number(p.count) })),
    byOsVersion: byOsVersion.map(o => ({ ...o, count: Number(o.count) })),
    byCountry: byCountry.map(c => ({ ...c, count: Number(c.count) })),
    byCity: byCity.map(c => ({ ...c, count: Number(c.count) })),
    byAppVersion: byAppVersion.map(a => ({ ...a, count: Number(a.count) })),
    avgListeningMinutes: Math.round(Number(avgStats.avgMinutes)),
    avgListensPerUser: Math.round(Number(avgStats.avgListens)),
    powerUsers: powerUsers.map(p => ({
      deviceId: p.deviceId,
      model: profileMap.get(p.deviceId)?.deviceModel || null,
      totalMinutes: Math.round(Number(p.totalMinutes)),
      listens: Number(p.listens),
    })),
    newUsersThisWeek: Number(newWeek.count),
    newUsersThisMonth: Number(newMonth.count),
  };
}

export async function listUsers(opts: {
  search?: string;
  sort?: "lastSeen" | "firstSeen" | "listens" | "minutes";
  limit?: number;
  offset?: number;
}): Promise<{
  total: number;
  users: Array<{
    deviceId: string;
    platform: string | null;
    deviceModel: string | null;
    appVersion: string | null;
    country: string | null;
    city: string | null;
    lastSeenAt: Date;
    createdAt: Date;
    totalListens: number;
    totalMinutes: number;
    subscribedFeeds: number;
  }>;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = (opts.search || "").trim();
  const sort = opts.sort || "lastSeen";

  // Per-device listen aggregates
  const listenAgg = await db
    .select({
      deviceId: episodeListens.deviceId,
      listens: count(),
      durationMs: sql<number>`COALESCE(SUM(${episodeListens.durationListenedMs}), 0)`,
    })
    .from(episodeListens)
    .groupBy(episodeListens.deviceId);
  const listenMap = new Map(listenAgg.map(r => [r.deviceId, { listens: Number(r.listens), durationMs: Number(r.durationMs) }]));

  // Per-device subscription counts
  const subAgg = await db
    .select({ deviceId: subscriptions.deviceId, c: count() })
    .from(subscriptions)
    .groupBy(subscriptions.deviceId);
  const subMap = new Map(subAgg.map(r => [r.deviceId, Number(r.c)]));

  // Filter device profiles by search
  const filter = search
    ? sql`(
        ${deviceProfiles.deviceId} ILIKE ${"%" + search + "%"} OR
        COALESCE(${deviceProfiles.deviceModel}, '') ILIKE ${"%" + search + "%"} OR
        COALESCE(${deviceProfiles.country}, '') ILIKE ${"%" + search + "%"} OR
        COALESCE(${deviceProfiles.city}, '') ILIKE ${"%" + search + "%"} OR
        COALESCE(${deviceProfiles.platform}, '') ILIKE ${"%" + search + "%"} OR
        COALESCE(${deviceProfiles.appVersion}, '') ILIKE ${"%" + search + "%"}
      )`
    : sql`TRUE`;

  const [{ count: totalCount }] = await db.select({ count: count() }).from(deviceProfiles).where(filter);

  // For listens/minutes sort we need to sort in JS after merging — fetch a wider window.
  // For lastSeen / firstSeen we can sort + paginate in SQL.
  const needsJsSort = sort === "listens" || sort === "minutes";
  const profilesQuery = db.select().from(deviceProfiles).where(filter);
  const profiles = needsJsSort
    ? await profilesQuery.orderBy(desc(deviceProfiles.lastSeenAt))
    : await profilesQuery.orderBy(sort === "firstSeen" ? desc(deviceProfiles.createdAt) : desc(deviceProfiles.lastSeenAt)).limit(limit).offset(offset);

  let merged = profiles.map(p => {
    const l = listenMap.get(p.deviceId) || { listens: 0, durationMs: 0 };
    return {
      deviceId: p.deviceId,
      platform: p.platform,
      deviceModel: p.deviceModel,
      appVersion: p.appVersion,
      country: p.country,
      city: p.city,
      lastSeenAt: p.lastSeenAt,
      createdAt: p.createdAt,
      totalListens: l.listens,
      totalMinutes: Math.round(l.durationMs / 60000),
      subscribedFeeds: subMap.get(p.deviceId) || 0,
    };
  });

  if (needsJsSort) {
    merged.sort((a, b) =>
      sort === "listens" ? b.totalListens - a.totalListens : b.totalMinutes - a.totalMinutes
    );
    merged = merged.slice(offset, offset + limit);
  }

  return { total: Number(totalCount), users: merged };
}

// Conversations & Messages
export async function createConversation(deviceId: string, subject: string, firstMessage: string, feedbackId?: string): Promise<Conversation> {
  const [conv] = await db.insert(conversations).values({ deviceId, subject, feedbackId: feedbackId || null }).returning();
  await db.insert(conversationMessages).values({ conversationId: conv.id, sender: "user", message: firstMessage });
  return conv;
}

export async function addMessage(conversationId: string, sender: "user" | "admin", message: string): Promise<ConversationMessage> {
  const [msg] = await db.insert(conversationMessages).values({ conversationId, sender, message }).returning();
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  return msg;
}

export async function getConversationsForDevice(deviceId: string): Promise<(Conversation & { lastMessage?: string; unreadCount: number })[]> {
  const results = await db.select({
    id: conversations.id,
    deviceId: conversations.deviceId,
    subject: conversations.subject,
    status: conversations.status,
    feedbackId: conversations.feedbackId,
    createdAt: conversations.createdAt,
    updatedAt: conversations.updatedAt,
    lastMessage: sql<string>`(SELECT ${conversationMessages.message} FROM ${conversationMessages} WHERE ${conversationMessages.conversationId} = ${conversations.id} ORDER BY ${conversationMessages.createdAt} DESC LIMIT 1)`,
    unreadCount: sql<number>`(SELECT COUNT(*) FROM ${conversationMessages} WHERE ${conversationMessages.conversationId} = ${conversations.id} AND ${conversationMessages.sender} = 'admin' AND ${conversationMessages.readAt} IS NULL)`,
  }).from(conversations)
    .where(eq(conversations.deviceId, deviceId))
    .orderBy(desc(conversations.updatedAt));
  return results.map(r => ({ ...r, unreadCount: Number(r.unreadCount) }));
}

export async function getConversationMessages(conversationId: string): Promise<ConversationMessage[]> {
  return db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId)).orderBy(asc(conversationMessages.createdAt));
}

export async function markMessagesRead(conversationId: string, sender: "user" | "admin"): Promise<void> {
  await db.update(conversationMessages).set({ readAt: new Date() }).where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.sender, sender), sql`${conversationMessages.readAt} IS NULL`));
}

export async function getConversationByFeedbackId(feedbackId: string): Promise<Conversation | null> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.feedbackId, feedbackId)).limit(1);
  return conv || null;
}

export async function getConversationById(conversationId: string): Promise<Conversation | null> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return conv || null;
}

export async function getAdminConversations(opts: { page: number; limit: number; status?: string }): Promise<{ conversations: any[]; total: number; page: number; totalPages: number }> {
  const conditions = [];
  if (opts.status) conditions.push(eq(conversations.status, opts.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(conversations).where(where);
  const convs = await db.select({
    id: conversations.id,
    deviceId: conversations.deviceId,
    subject: conversations.subject,
    status: conversations.status,
    feedbackId: conversations.feedbackId,
    createdAt: conversations.createdAt,
    updatedAt: conversations.updatedAt,
  }).from(conversations).where(where).orderBy(desc(conversations.updatedAt)).limit(opts.limit).offset((opts.page - 1) * opts.limit);

  if (convs.length === 0) {
    return { conversations: [], total: Number(total), page: opts.page, totalPages: Math.ceil(Number(total) / opts.limit) };
  }

  const convIds = convs.map(c => c.id);

  // Fetch all messages for these conversations, then derive last + unread
  // counts in memory. Much simpler than SQL array binding and the dataset
  // is small (50 convs × handful of messages each).
  const allMessages = await db.select({
    conversationId: conversationMessages.conversationId,
    message: conversationMessages.message,
    sender: conversationMessages.sender,
    createdAt: conversationMessages.createdAt,
    readAt: conversationMessages.readAt,
  })
    .from(conversationMessages)
    .where(inArray(conversationMessages.conversationId, convIds))
    .orderBy(desc(conversationMessages.createdAt));

  const lastMap = new Map<string, { message: string; sender: string }>();
  const unreadMap = new Map<string, number>();
  for (const m of allMessages) {
    // orderBy desc means first occurrence per convId is the latest
    if (!lastMap.has(m.conversationId)) {
      lastMap.set(m.conversationId, { message: m.message, sender: m.sender });
    }
    if (m.sender === "user" && m.readAt === null) {
      unreadMap.set(m.conversationId, (unreadMap.get(m.conversationId) ?? 0) + 1);
    }
  }

  // Batch fetch device profiles instead of N+1
  const deviceIds = [...new Set(convs.map(c => c.deviceId))];
  const profiles = deviceIds.length > 0 ? await db.select().from(deviceProfiles).where(inArray(deviceProfiles.deviceId, deviceIds)) : [];
  const profileMap = new Map(profiles.map(p => [p.deviceId, p]));

  const result = convs.map(c => {
    const profile = profileMap.get(c.deviceId);
    const last = lastMap.get(c.id);
    return {
      ...c,
      lastMessage: last?.message ?? null,
      lastSender: last?.sender ?? null,
      unreadCount: unreadMap.get(c.id) ?? 0,
      deviceModel: profile?.deviceModel,
      deviceBrand: profile?.deviceBrand,
    };
  });

  return { conversations: result, total: Number(total), page: opts.page, totalPages: Math.ceil(Number(total) / opts.limit) };
}

export async function closeConversation(id: string): Promise<void> {
  await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, id));
}

// Website Analytics
export async function recordPageView(data: { path: string; referrer?: string; userAgent?: string; ipAddress?: string; country?: string; city?: string; deviceType?: string; sessionId?: string }): Promise<void> {
  await db.insert(pageViews).values(data);
}

export async function getWebsiteAnalytics(): Promise<{
  views24h: number; views7d: number; views30d: number;
  uniqueVisitors24h: number; uniqueVisitors7d: number; uniqueVisitors30d: number;
  topPages: { path: string; count: number }[];
  topReferrers: { referrer: string; count: number }[];
  byDeviceType: { deviceType: string; count: number }[];
  byCountry: { country: string; count: number }[];
  dailyViews: { day: string; count: number }[];
}> {
  const now = new Date();
  const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [[v24], [v7], [v30], [u24], [u7], [u30]] = await Promise.all([
    db.select({ count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${h24}`),
    db.select({ count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${d7}`),
    db.select({ count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${d30}`),
    db.select({ count: sql<number>`COUNT(DISTINCT ${pageViews.ipAddress})` }).from(pageViews).where(sql`${pageViews.createdAt} > ${h24}`),
    db.select({ count: sql<number>`COUNT(DISTINCT ${pageViews.ipAddress})` }).from(pageViews).where(sql`${pageViews.createdAt} > ${d7}`),
    db.select({ count: sql<number>`COUNT(DISTINCT ${pageViews.ipAddress})` }).from(pageViews).where(sql`${pageViews.createdAt} > ${d30}`),
  ]);

  const [topPages, topReferrers, byDeviceType, byCountry, dailyViews] = await Promise.all([
    db.select({ path: pageViews.path, count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${d30}`).groupBy(pageViews.path).orderBy(desc(count())).limit(15),
    db.select({ referrer: sql<string>`COALESCE(${pageViews.referrer}, 'Direct')`, count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${d30}`).groupBy(sql`COALESCE(${pageViews.referrer}, 'Direct')`).orderBy(desc(count())).limit(10),
    db.select({ deviceType: sql<string>`COALESCE(${pageViews.deviceType}, 'Unknown')`, count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${d30}`).groupBy(sql`COALESCE(${pageViews.deviceType}, 'Unknown')`).orderBy(desc(count())),
    db.select({ country: sql<string>`COALESCE(${pageViews.country}, 'Unknown')`, count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${d30} AND ${pageViews.country} IS NOT NULL`).groupBy(sql`COALESCE(${pageViews.country}, 'Unknown')`).orderBy(desc(count())).limit(15),
    db.select({ day: sql<string>`DATE(${pageViews.createdAt})`, count: count() }).from(pageViews).where(sql`${pageViews.createdAt} > ${d30}`).groupBy(sql`DATE(${pageViews.createdAt})`).orderBy(sql`DATE(${pageViews.createdAt})`),
  ]);

  return {
    views24h: Number(v24.count), views7d: Number(v7.count), views30d: Number(v30.count),
    uniqueVisitors24h: Number(u24.count), uniqueVisitors7d: Number(u7.count), uniqueVisitors30d: Number(u30.count),
    topPages: topPages.map(p => ({ ...p, count: Number(p.count) })),
    topReferrers: topReferrers.map(r => ({ ...r, count: Number(r.count) })),
    byDeviceType: byDeviceType.map(d => ({ ...d, count: Number(d.count) })),
    byCountry: byCountry.map(c => ({ ...c, count: Number(c.count) })),
    dailyViews: dailyViews.map(d => ({ ...d, count: Number(d.count) })),
  };
}
