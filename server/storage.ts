import { db } from "./db";
import { feeds, categories, episodes, subscriptions, adminUsers, episodeListens } from "@shared/schema";
import type { Feed, InsertFeed, Category, InsertCategory, Episode, Subscription } from "@shared/schema";
import { eq, and, desc, inArray, sql, count } from "drizzle-orm";
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

export async function getEpisodesByFeed(feedId: string): Promise<Episode[]> {
  return db.select().from(episodes).where(eq(episodes.feedId, feedId)).orderBy(desc(episodes.publishedAt));
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

export async function adminExists(): Promise<boolean> {
  const admins = await db.select().from(adminUsers).limit(1);
  return admins.length > 0;
}

export async function recordListen(episodeId: string, deviceId: string): Promise<void> {
  await db.insert(episodeListens).values({ episodeId, deviceId });
}

export async function getTrendingEpisodes(limit: number = 20): Promise<(Episode & { listenCount: number })[]> {
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
      listenCount: count(episodeListens.id),
    })
    .from(episodes)
    .leftJoin(episodeListens, eq(episodes.id, episodeListens.episodeId))
    .groupBy(episodes.id)
    .orderBy(desc(count(episodeListens.id)), desc(episodes.publishedAt))
    .limit(limit);

  return result.map(r => ({ ...r, listenCount: Number(r.listenCount) }));
}
