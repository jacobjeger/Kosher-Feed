import { db } from "./db";
import { feeds } from "@shared/schema";
import * as storage from "./storage";
import { parseFeed } from "./rss";
import { sql } from "drizzle-orm";

async function ensureTablesExist() {
  try {
    await db.execute(sql`SELECT 1 FROM feeds LIMIT 1`);
  } catch (e: any) {
    if (e.message?.includes('relation "feeds" does not exist')) {
      console.log("Tables missing, creating schema...");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS categories (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          slug TEXT NOT NULL UNIQUE,
          created_at TIMESTAMP DEFAULT now() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feeds (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          rss_url TEXT NOT NULL UNIQUE,
          image_url TEXT,
          description TEXT,
          author TEXT,
          category_id VARCHAR REFERENCES categories(id),
          is_active BOOLEAN DEFAULT true NOT NULL,
          last_fetched_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT now() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS episodes (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          feed_id VARCHAR NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          audio_url TEXT NOT NULL,
          duration TEXT,
          published_at TIMESTAMP,
          guid TEXT NOT NULL,
          image_url TEXT,
          created_at TIMESTAMP DEFAULT now() NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS episodes_guid_feed_idx ON episodes(guid, feed_id);
        CREATE TABLE IF NOT EXISTS subscriptions (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          device_id TEXT NOT NULL,
          feed_id VARCHAR NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT now() NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_device_feed_idx ON subscriptions(device_id, feed_id);
        CREATE TABLE IF NOT EXISTS episode_listens (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          episode_id VARCHAR NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL,
          listened_at TIMESTAMP DEFAULT now() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_users (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT now() NOT NULL
        );
      `);
      console.log("Schema created successfully");
    } else {
      throw e;
    }
  }
}

const SEED_FEEDS = [
  { title: "Lakewood Daf Yomi", rssUrl: "http://app.daf-yomi.net/podcasts/DafYomi.xml" },
  { title: "Lakewood Daf Yomi #DafBySruly Reid Bites", rssUrl: "http://app.daf-yomi.net/podcasts/ReidBites.xml" },
  { title: "Parasha in 5", rssUrl: "https://www.rabbiorlofsky.com/parasha-in-5?format=rss" },
  { title: "Rabbi Daniel Glatstein Podcast", rssUrl: "https://rss.jewishpodcasts.fm:443/rss/222" },
  { title: "Rabbi Daniel Kalish Shiurim - Waterbury Mesivta", rssUrl: "https://anchor.fm/s/561de0ec/podcast/rss" },
  { title: "Rav Gershon Ribner", rssUrl: "https://rebgershonribner.com/rss" },
  { title: "Ten Minute Halacha", rssUrl: "https://feeds.redcircle.com/085dd9de-5df3-409a-b961-02101409d6c3" },
  { title: "YUTORAH: R' Bentzion Shafier -- Recent Shiurim", rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=80475&organizationId=301" },
  { title: "Rabbi Yoni Fischer Shiurim - Fischer's Yeshiva", rssUrl: "https://feeds.castos.com/5rzw" },
];

export async function seedIfEmpty() {
  try {
    await ensureTablesExist();
    const existing = await db.select().from(feeds).limit(1);
    if (existing.length > 0) {
      console.log("Database already has feeds, skipping seed");
      return;
    }

    console.log("Database is empty, seeding with default feeds...");

    for (const seedFeed of SEED_FEEDS) {
      try {
        const feed = await storage.createFeed({
          title: seedFeed.title,
          rssUrl: seedFeed.rssUrl,
        });

        const parsed = await parseFeed(feed.id, feed.rssUrl);
        const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
        await storage.upsertEpisodes(feed.id, episodeData);

        await storage.updateFeed(feed.id, {
          lastFetchedAt: new Date(),
          title: parsed.title || feed.title,
          imageUrl: parsed.imageUrl,
          description: parsed.description,
          author: parsed.author,
        });

        console.log(`  Seeded: ${parsed.title || feed.title} (${episodeData.length} episodes)`);
      } catch (e) {
        console.error(`  Failed to seed ${seedFeed.title}:`, e);
      }
    }

    console.log("Seed complete!");
  } catch (e) {
    console.error("Seed check failed:", e);
  }
}
