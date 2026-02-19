import { db } from "./db";
import { feeds, categories, episodes, subscriptions, adminUsers, episodeListens, favorites, playbackPositions, adminNotifications, errorReports, feedback, pushTokens, contactMessages, apkUploads, feedCategories, maggidShiurim, sponsors } from "@shared/schema";
import type { Feed, InsertFeed, Category, InsertCategory, Episode, Subscription, Favorite, PlaybackPosition, AdminNotification, ErrorReport, Feedback, PushToken, ContactMessage, ApkUpload, FeedCategory, MaggidShiur, InsertMaggidShiur, Sponsor } from "@shared/schema";
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
  return db.select().from(feeds).orderBy(desc(feeds.createdAt));
}

export async function getFeedById(feedId: string): Promise<Feed | undefined> {
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);
  return feed;
}

export async function getActiveFeeds(): Promise<Feed[]> {
  return db.select().from(feeds).where(eq(feeds.isActive, true)).orderBy(feeds.title);
}

export async function getFeedsByCategory(categoryId: string): Promise<Feed[]> {
  return db.select().from(feeds).where(and(eq(feeds.categoryId, categoryId), eq(feeds.isActive, true))).orderBy(feeds.title);
}

export async function createFeed(data: InsertFeed): Promise<Feed> {
  const [feed] = await db.insert(feeds).values(data).returning();
  return feed;
}

export async function updateFeed(id: string, data: Partial<InsertFeed & { isActive: boolean; lastFetchedAt: Date }>): Promise<Feed> {
  const [feed] = await db.update(feeds).set(data).where(eq(feeds.id, id)).returning();
  return feed;
}

export async function deleteFeed(id: string): Promise<void> {
  await db.delete(feeds).where(eq(feeds.id, id));
}

export async function getEpisodeById(episodeId: string): Promise<Episode | undefined> {
  const result = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  return result[0];
}

export async function getEpisodesByFeed(feedId: string): Promise<Episode[]> {
  return db.select().from(episodes).where(eq(episodes.feedId, feedId)).orderBy(desc(episodes.publishedAt));
}

export async function getEpisodesByFeedPaginated(feedId: string, page: number = 1, pageLimit: number = 50, sort: string = 'newest'): Promise<Episode[]> {
  const offset = (page - 1) * pageLimit;
  const orderFn = sort === 'oldest' ? asc(episodes.publishedAt) : desc(episodes.publishedAt);
  return db.select().from(episodes).where(eq(episodes.feedId, feedId)).orderBy(orderFn).limit(pageLimit).offset(offset);
}

export async function getEpisodeCountByFeed(feedId: string): Promise<number> {
  const result = await db.select({ value: count() }).from(episodes).where(eq(episodes.feedId, feedId));
  return result[0]?.value || 0;
}

export async function getLatestEpisodes(limit: number = 50): Promise<Episode[]> {
  return db.select().from(episodes).orderBy(desc(episodes.publishedAt)).limit(limit);
}

export async function upsertEpisodes(feedId: string, episodeData: Omit<Episode, "id" | "createdAt">[]): Promise<Episode[]> {
  if (episodeData.length === 0) return [];
  const inserted: Episode[] = [];
  for (const ep of episodeData) {
    try {
      const [result] = await db.insert(episodes).values({
        feedId: ep.feedId,
        title: ep.title,
        description: ep.description,
        audioUrl: ep.audioUrl,
        duration: ep.duration,
        publishedAt: ep.publishedAt,
        guid: ep.guid,
        imageUrl: ep.imageUrl,
      }).onConflictDoNothing().returning();
      if (result) inserted.push(result);
    } catch (e) {
      // skip duplicates
    }
  }
  return inserted;
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
    .where(sql`${episodeListens.listenedAt} > ${fortyEightHoursAgo}`)
    .groupBy(episodes.id)
    .orderBy(desc(count(episodeListens.id)), desc(episodes.publishedAt))
    .limit(limit);

  return result.map(r => ({ ...r, listenCount: Number(r.listenCount) }));
}

export async function getAnalytics() {
  const [feedCount] = await db.select({ count: count() }).from(feeds);
  const [activeFeedCount] = await db.select({ count: count() }).from(feeds).where(eq(feeds.isActive, true));
  const [episodeCount] = await db.select({ count: count() }).from(episodes);
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

  const dailyListens = await db
    .select({
      day: sql<string>`DATE(${episodeListens.listenedAt})`,
      count: count(),
    })
    .from(episodeListens)
    .where(sql`${episodeListens.listenedAt} > ${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)}`)
    .groupBy(sql`DATE(${episodeListens.listenedAt})`)
    .orderBy(sql`DATE(${episodeListens.listenedAt})`);

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

export async function getPlaybackPositions(deviceId: string): Promise<PlaybackPosition[]> {
  return db.select().from(playbackPositions).where(eq(playbackPositions.deviceId, deviceId)).orderBy(desc(playbackPositions.updatedAt));
}

export async function getPlaybackPosition(episodeId: string, deviceId: string): Promise<PlaybackPosition | undefined> {
  const [pos] = await db.select().from(playbackPositions).where(and(eq(playbackPositions.episodeId, episodeId), eq(playbackPositions.deviceId, deviceId))).limit(1);
  return pos;
}

export async function getCompletedEpisodes(deviceId: string): Promise<PlaybackPosition[]> {
  return db.select().from(playbackPositions).where(and(eq(playbackPositions.deviceId, deviceId), eq(playbackPositions.completed, true))).orderBy(desc(playbackPositions.updatedAt));
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

  const feedTimeMap = new Map<string, { feedId: string; time: number }>();
  for (const p of positions) {
    const ep = await db.select({ feedId: episodes.feedId }).from(episodes).where(eq(episodes.id, p.episodeId)).limit(1);
    if (ep.length > 0) {
      const fid = ep[0].feedId;
      const existing = feedTimeMap.get(fid) || { feedId: fid, time: 0 };
      existing.time += (p.positionMs || 0) / 1000;
      feedTimeMap.set(fid, existing);
    }
  }
  const topFeedIds = [...feedTimeMap.values()].sort((a, b) => b.time - a.time).slice(0, 10);
  const topFeeds = [];
  for (const f of topFeedIds) {
    const [feed] = await db.select({ title: feeds.title }).from(feeds).where(eq(feeds.id, f.feedId)).limit(1);
    if (feed) {
      topFeeds.push({ feedId: f.feedId, title: feed.title, listenTime: Math.floor(f.time) });
    }
  }

  return {
    totalListeningTime,
    episodesPlayed,
    currentStreak,
    longestStreak,
    topFeeds,
  };
}

export async function getWeeklyPopularEpisodes(limit: number = 20) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
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
    .where(sql`${episodeListens.listenedAt} > ${sevenDaysAgo}`)
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
  return db.select().from(feeds).where(and(eq(feeds.isFeatured, true), eq(feeds.isActive, true))).orderBy(feeds.title);
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

export async function getFeedsByCategories(categoryId: string): Promise<Feed[]> {
  const rows = await db.select({ feedId: feedCategories.feedId }).from(feedCategories).where(eq(feedCategories.categoryId, categoryId));
  if (rows.length === 0) return [];
  const feedIds = rows.map(r => r.feedId);
  return db.select().from(feeds).where(and(inArray(feeds.id, feedIds), eq(feeds.isActive, true))).orderBy(feeds.title);
}

export async function getActiveFeedsGroupedByAuthor(): Promise<{ author: string; feeds: Feed[]; imageUrl?: string | null; bio?: string | null; profileId?: string }[]> {
  const allActive = await db.select().from(feeds).where(eq(feeds.isActive, true)).orderBy(feeds.author, feeds.title);
  const profiles = await db.select().from(maggidShiurim);
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
  await db.insert(episodeListens).values({ episodeId, deviceId, durationListenedMs: durationMs });
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
}): Promise<ErrorReport> {
  const [report] = await db.insert(errorReports).values(data).returning();
  return report;
}

export async function getErrorReports(opts: {
  page: number;
  limit: number;
  level?: string;
  resolved?: boolean;
}): Promise<{ reports: ErrorReport[]; total: number; page: number; totalPages: number }> {
  const conditions = [];
  if (opts.level) conditions.push(eq(errorReports.level, opts.level));
  if (opts.resolved !== undefined) conditions.push(eq(errorReports.resolved, opts.resolved));

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

export async function resolveErrorReport(id: string): Promise<ErrorReport> {
  const [report] = await db.update(errorReports)
    .set({ resolved: true })
    .where(eq(errorReports.id, id))
    .returning();
  return report;
}

export async function deleteResolvedErrorReports(): Promise<number> {
  const result = await db.delete(errorReports).where(eq(errorReports.resolved, true)).returning();
  return result.length;
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

export async function registerPushToken(deviceId: string, token: string, platform: string): Promise<PushToken> {
  const [result] = await db.insert(pushTokens).values({ deviceId, token, platform }).onConflictDoUpdate({
    target: [pushTokens.token],
    set: { deviceId, platform, updatedAt: new Date() },
  }).returning();
  return result;
}

export async function getPushTokensForDevices(deviceIds: string[]): Promise<PushToken[]> {
  if (deviceIds.length === 0) return [];
  return db.select().from(pushTokens).where(inArray(pushTokens.deviceId, deviceIds));
}

export async function getSubscribersForFeed(feedId: string): Promise<PushToken[]> {
  const subs = await db.select({ deviceId: subscriptions.deviceId }).from(subscriptions).where(eq(subscriptions.feedId, feedId));
  if (subs.length === 0) return [];
  const deviceIds = subs.map(s => s.deviceId);
  return db.select().from(pushTokens).where(inArray(pushTokens.deviceId, deviceIds));
}

export async function removePushToken(token: string): Promise<void> {
  await db.delete(pushTokens).where(eq(pushTokens.token, token));
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
