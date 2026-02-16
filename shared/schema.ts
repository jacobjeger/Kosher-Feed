import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const categories = pgTable("categories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const feeds = pgTable("feeds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  rssUrl: text("rss_url").notNull().unique(),
  imageUrl: text("image_url"),
  description: text("description"),
  author: text("author"),
  categoryId: varchar("category_id").references(() => categories.id),
  isActive: boolean("is_active").default(true).notNull(),
  lastFetchedAt: timestamp("last_fetched_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  isFeatured: boolean("is_featured").default(false).notNull(),
  scheduledPublishAt: timestamp("scheduled_publish_at"),
});

export const episodes = pgTable("episodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  audioUrl: text("audio_url").notNull(),
  duration: text("duration"),
  publishedAt: timestamp("published_at"),
  guid: text("guid").notNull(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  adminNotes: text("admin_notes"),
  sourceSheetUrl: text("source_sheet_url"),
}, (table) => [
  uniqueIndex("episodes_guid_feed_idx").on(table.guid, table.feedId),
]);

export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("subscriptions_device_feed_idx").on(table.deviceId, table.feedId),
]);

export const episodeListens = pgTable("episode_listens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  listenedAt: timestamp("listened_at").defaultNow().notNull(),
  durationListenedMs: integer("duration_listened_ms").default(0),
});

export const adminUsers = pgTable("admin_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const favorites = pgTable("favorites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("favorites_episode_device_idx").on(table.episodeId, table.deviceId),
]);

export const playbackPositions = pgTable("playback_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "cascade" }).notNull(),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  positionMs: integer("position_ms").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  completed: boolean("completed").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("playback_positions_episode_device_idx").on(table.episodeId, table.deviceId),
]);

export const adminNotifications = pgTable("admin_notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  message: text("message").notNull(),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertFeedSchema = createInsertSchema(feeds).pick({
  title: true,
  rssUrl: true,
  imageUrl: true,
  description: true,
  author: true,
  categoryId: true,
});

export const insertCategorySchema = createInsertSchema(categories).pick({
  name: true,
  slug: true,
});

export const insertSubscriptionSchema = z.object({
  deviceId: z.string(),
  feedId: z.string(),
});

export const insertFavoriteSchema = z.object({
  episodeId: z.string(),
  deviceId: z.string(),
});

export type Feed = typeof feeds.$inferSelect;
export type InsertFeed = z.infer<typeof insertFeedSchema>;
export type Category = typeof categories.$inferSelect;
export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type Episode = typeof episodes.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type AdminUser = typeof adminUsers.$inferSelect;
export type Favorite = typeof favorites.$inferSelect;
export type PlaybackPosition = typeof playbackPositions.$inferSelect;
export type AdminNotification = typeof adminNotifications.$inferSelect;
