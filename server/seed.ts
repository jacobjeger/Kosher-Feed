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
  { rssUrl: "https://anchor.fm/s/f968acf0/podcast/rss" },
  { rssUrl: "https://feeds.transistor.fm/parsha-lessons-for-life" },
  { rssUrl: "http://feeds.ou.org/TheDafInHalacha" },
  { rssUrl: "https://media.rss.com/ohr-shlomo-shiurim-podcast-network/feed.xml" },
  { rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=80153&organizationId=301" },
  { rssUrl: "https://feed.podbean.com/shulchanaruchharav/feed.xml" },
  { rssUrl: "https://feed.podbean.com/TheSundayShiur/feed.xml" },
  { rssUrl: "https://anchor.fm/s/465a75bc/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/a90738d0/podcast/rss" },
  { rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=80714&organizationID=301&numberOfRssResults=10" },
  { rssUrl: "https://feed.podbean.com/mordyshteibel/feed.xml" },
  { rssUrl: "https://feeds.captivate.fm/sfas-emes/" },
  { rssUrl: "https://media.rss.com/aliyayomi/feed.xml" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/199" },
  { rssUrl: "https://anchor.fm/s/10d13339c/podcast/rss" },
  { rssUrl: "http://feeds.feedburner.com/DafYomiShiurByRabbiShalomRosner" },
  { rssUrl: "https://rss.buzzsprout.com/2070212.rss" },
  { rssUrl: "https://feeds.transistor.fm/rabbi-soloveitchik-on-the-parsha" },
  { rssUrl: "https://anchor.fm/s/561de0ec/podcast/rss" },
  { rssUrl: "https://feeds.transistor.fm/the-yeshiva-shmuz" },
  { rssUrl: "https://feeds.castos.com/5rzw" },
  { rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=81012&organizationID=301&numberOfRssResults=10" },
  { rssUrl: "https://feeds.transistor.fm/chofetz-chaim-yomi" },
  { rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=80485&organizationId=301" },
  { rssUrl: "http://www.joelpadowitz.com/itunes/sukkah.xml" },
  { rssUrl: "https://rss.jewishpodcasts.fm/rss/228" },
  { rssUrl: "https://anchor.fm/s/e65a00b4/podcast/rss" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/173" },
  { rssUrl: "https://media.rss.com/rabbiyedid/feed.xml" },
  { rssUrl: "https://rss.buzzsprout.com/1568611.rss" },
  { rssUrl: "http://www.ohrreuvenapp.com/rss/nach" },
  { rssUrl: "https://rss.buzzsprout.com/2436161.rss" },
  { rssUrl: "https://feeds.feedburner.com/parshaperspectivesfortoday-feedpodcast" },
  { rssUrl: "https://anchor.fm/s/5cfcf6b4/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/12ccccf4/podcast/rss" },
  { rssUrl: "https://feeds.soundcloud.com/users/soundcloud:users:58624303/sounds.rss" },
  { rssUrl: "https://anchor.fm/s/100b7798c/podcast/rss" },
  { rssUrl: "https://feeds.transistor.fm/mishna-berura-shiur-with-the-dirshu-program" },
  { rssUrl: "https://www.rabbiorlofsky.com/parasha-in-5?format=rss" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/gedolei-torah-podcast/feed/podcast/" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/nefesh-hachaim-podcast/feed/podcast/" },
  { rssUrl: "https://anchor.fm/s/f9ad5f44/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/12958564/podcast/rss" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/journey-to-our-past-podcast/feed/podcast/" },
  { rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=83164&organizationID=301&numberOfRssResults=10" },
  { rssUrl: "http://feeds.feedburner.com/TheOusMishnaBrurahYomi" },
  { rssUrl: "https://feeds.acast.com/public/shows/5b3e57602373c3620fc5353f" },
  { rssUrl: "https://anchor.fm/s/5b25177c/podcast/rss" },
  { rssUrl: "http://rabbiwolbe.com/feed/torah101/" },
  { rssUrl: "https://feeds.captivate.fm/tzurba-hilchot-shabbat/" },
  { rssUrl: "https://feed.podbean.com/cjrzv/feed.xml" },
  { rssUrl: "https://rss.libsyn.com/shows/178346/destinations/1221947.xml" },
  { rssUrl: "https://anchor.fm/s/1007a1c2c/podcast/rss" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/tanya-podcast/feed/podcast/" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/maharal-tiferes-yisroel-podcast/feed/podcast/" },
  { rssUrl: "https://feeds.transistor.fm/ywcollection" },
  { rssUrl: "https://feeds.soundcloud.com/users/soundcloud:users:194082181/sounds.rss" },
  { rssUrl: "https://feeds.captivate.fm/tyhashem/" },
  { rssUrl: "https://anchor.fm/s/102d9ce7c/podcast/rss" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/222" },
  { rssUrl: "https://feeds.feedburner.com/outorah/dafyomilebowitz" },
  { rssUrl: "http://feeds.feedburner.com/LivingWithEmunah-FeedPodcast" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/491" },
  { rssUrl: "https://anchor.fm/s/5e71b624/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/8d44dbe8/podcast/rss" },
  { rssUrl: "https://portal.theyeshiva.net/api/itunes/podcasts/32" },
  { rssUrl: "https://anchor.fm/s/4d63c48/podcast/rss" },
  { rssUrl: "https://rss.buzzsprout.com/815188.rss" },
  { rssUrl: "https://rabbifreundlich.podomatic.com/rss2.xml" },
  { rssUrl: "https://feeds.redcircle.com/647b8862-bec8-4886-a04e-f180221caba8" },
  { rssUrl: "http://feeds.feedburner.com/ShasIlluminated-RabbiDanielKalish?format=xml" },
  { rssUrl: "https://feed.podbean.com/TorasShimon/feed.xml" },
  { rssUrl: "https://feeds.feedburner.com/outorah/resnikparsha" },
  { rssUrl: "https://feeds.captivate.fm/sipurei-maasios/" },
  { rssUrl: "https://feeds.captivate.fm/the-world-of-rav-kook/" },
  { rssUrl: "https://feeds.feedburner.com/outorah/quickdafresnik" },
  { rssUrl: "https://anchor.fm/s/1e51ba58/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/12bdd99c/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/e6d45fa8/podcast/rss" },
  { rssUrl: "https://feeds.redcircle.com/47b73986-2e6d-4648-ac32-e27c9c848dd0" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/619" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/parsha-shiur-podcast/feed/podcast/" },
  { rssUrl: "https://media.rss.com/soul-of-a-nation/feed.xml" },
  { rssUrl: "https://anchor.fm/s/1028b3500/podcast/rss" },
  { rssUrl: "https://rss.buzzsprout.com/2075186.rss" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/da-mah-shetashiv-podcast/feed/podcast/" },
  { rssUrl: "https://rss.jewishpodcasts.fm/rss/501" },
  { rssUrl: "https://anchor.fm/s/174ac524/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/48b76054/podcast/rss" },
  { rssUrl: "http://www.ohrreuvenapp.com/rss/parsha" },
  { rssUrl: "https://portal.theyeshiva.net/api/itunes/podcasts/33" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/132" },
  { rssUrl: "https://media.rss.com/ccjl/feed.xml" },
  { rssUrl: "https://rss.buzzsprout.com/2437980.rss" },
  { rssUrl: "https://anchor.fm/s/4a8db4a0/podcast/rss" },
  { rssUrl: "https://feeds.redcircle.com/8ec56547-31a9-4daa-8e33-4eae19237845" },
  { rssUrl: "https://www.journeysintorah.com/feed/podcast/" },
  { rssUrl: "https://feeds.transistor.fm/the-inner-depths-of-the-parsha" },
  { rssUrl: "https://anchor.fm/s/9636a3e4/podcast/rss" },
  { rssUrl: "https://feeds.captivate.fm/chumash/" },
  { rssUrl: "https://feeds.transistor.fm/ravmota" },
  { rssUrl: "https://rss.buzzsprout.com/1907835.rss" },
  { rssUrl: "https://anchor.fm/s/ae9ef184/podcast/rss" },
  { rssUrl: "https://feed.podbean.com/rabbishmuelherzfeld/feed.xml" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/277" },
  { rssUrl: "https://media.rss.com/rabbi-light-shiurim/feed.xml" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/268" },
  { rssUrl: "https://media.rss.com/halacha-in-a-year/feed.xml" },
  { rssUrl: "https://anchor.fm/s/55ec7304/podcast/rss" },
  { rssUrl: "https://feeds.captivate.fm/sefer-hatanya/" },
  { rssUrl: "http://feeds.feedburner.com/6-minute-siddur-snippets" },
  { rssUrl: "https://anchor.fm/s/38c2aa0/podcast/rss" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/596" },
  { rssUrl: "http://feeds.feedburner.com/ElefantDY14" },
  { rssUrl: "https://feeds.transistor.fm/rav-ahron-lopiansky-tisha-bav-kinnos" },
  { rssUrl: "https://feeds.transistor.fm/daf-yomi" },
  { rssUrl: "https://podcast.shim.fish/rss.php?podcast_id=4" },
  { rssUrl: "https://anchor.fm/s/fdbb201c/podcast/rss" },
  { rssUrl: "https://feeds.megaphone.fm/takeone" },
  { rssUrl: "https://anchor.fm/s/fb4d084/podcast/rss" },
  { rssUrl: "https://rss.buzzsprout.com/2377702.rss" },
  { rssUrl: "https://feeds.buzzsprout.com/1558367.rss" },
  { rssUrl: "https://feeds.captivate.fm/carpool-halacha/" },
  { rssUrl: "https://thinktorah.org/feed/podcast/" },
  { rssUrl: "https://feeds.feedburner.com/outorah/resnikmishnahyomi" },
  { rssUrl: "https://feeds.captivate.fm/likutei-halachos/" },
  { rssUrl: "https://feeds.captivate.fm/parsha-shiur/" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/483" },
  { rssUrl: "http://app.daf-yomi.net/podcasts/ReidBites.xml" },
  { rssUrl: "https://feeds.buzzsprout.com/1606570.rss" },
  { rssUrl: "https://anchor.fm/s/1ca6b1a4/podcast/rss" },
  { rssUrl: "http://app.daf-yomi.net/podcasts/DafYomi.xml" },
  { rssUrl: "https://rss.jewishpodcasts.fm/rss/164" },
  { rssUrl: "https://anchor.fm/s/7ad0550/podcast/rss" },
  { rssUrl: "https://feeds.transistor.fm/uplifted-by-the-parsha" },
  { rssUrl: "https://feed.podbean.com/mishnahbrurah/feed.xml" },
  { rssUrl: "https://anchor.fm/s/127f25a8/podcast/rss" },
  { rssUrl: "https://rss.buzzsprout.com/1566434.rss" },
  { rssUrl: "https://anchor.fm/s/dab36318/podcast/rss" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/250" },
  { rssUrl: "https://api.itorah.com/api/v2/Podcast/Living%20Emunah" },
  { rssUrl: "https://feeds.soundcloud.com/users/soundcloud:users:241975575/sounds.rss" },
  { rssUrl: "https://anchor.fm/s/12542ce0/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/29767270/podcast/rss" },
  { rssUrl: "http://feeds.feedburner.com/ou/history-daf-yomi" },
  { rssUrl: "https://feeds.transistor.fm/shiurim-from-the-bais-medrash-of-ygw-tiferes-gedaliah" },
  { rssUrl: "https://feeds.redcircle.com/f64e5c14-fec5-4b13-98c7-35aae6e9d2fb" },
  { rssUrl: "https://rss.buzzsprout.com/1898925.rss" },
  { rssUrl: "https://anchor.fm/s/82ade030/podcast/rss" },
  { rssUrl: "https://feeds.captivate.fm/the-613/" },
  { rssUrl: "https://anchor.fm/s/e03a7eac/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/10a494b10/podcast/rss" },
  { rssUrl: "https://feeds.transistor.fm/the-hashkafa-shmooze" },
  { rssUrl: "https://feeds.acast.com/public/shows/6719492630187dfb6cd9f481" },
  { rssUrl: "https://api.itorah.com/api/Podcast/gemara" },
  { rssUrl: "https://rss.buzzsprout.com/2071820.rss" },
  { rssUrl: "https://media.rss.com/nachyomi/feed.xml" },
  { rssUrl: "http://www.puresoulband.com/podcast/dailydaf.rss" },
  { rssUrl: "http://feeds.feedburner.com/RabbiRosnersLomdusOnTheDaf" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/182" },
  { rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=80273&organizationId=301" },
  { rssUrl: "https://feeds.redcircle.com/db95200c-31e2-4cc0-ae38-fa8e84680a3b" },
  { rssUrl: "https://anchor.fm/s/9a75298/podcast/rss" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/featured-shiurim-podcast/feed/podcast/" },
  { rssUrl: "https://feeds.transistor.fm/mishnah-berura-dirshu-cycle" },
  { rssUrl: "https://anchor.fm/s/b6ca22d4/podcast/rss" },
  { rssUrl: "https://feeds.feedburner.com/outorah/yerushalmi_rosner" },
  { rssUrl: "https://rss.jewishpodcasts.fm/rss/502" },
  { rssUrl: "http://feeds.feedburner.com/TheOuMishnaYomit" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/151" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/even-shleima-podcast/feed/podcast/" },
  { rssUrl: "https://anchor.fm/s/1036d2474/podcast/rss" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/663" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/558" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/vaad-on-tefillah-podcast/feed/podcast/" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/moreh-nevuchim-podcast/feed/podcast/" },
  { rssUrl: "https://anchor.fm/s/cf0ffaf8/podcast/rss" },
  { rssUrl: "https://media.rss.com/epilogues/feed.xml" },
  { rssUrl: "https://www.torahrecordings.com/show/chumash-rashi/apple_feed/" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/253" },
  { rssUrl: "http://feeds.ou.org/Rabbi_Shalom_RosnersParsha" },
  { rssUrl: "http://www.ohrreuvenapp.com/rss/recents" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/perek-chelek-podcast/feed/podcast/" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/431" },
  { rssUrl: "https://feeds.acast.com/public/shows/68beeecdb494ca82a27f183f" },
  { rssUrl: "https://feeds.captivate.fm/sefer-hamitzvos/" },
  { rssUrl: "https://rss.libsyn.com/shows/200396/destinations/1426997.xml" },
  { rssUrl: "https://feeds.castos.com/zdw44" },
  { rssUrl: "https://feeds.captivate.fm/likutei-moharan-mordys-shtiebel/" },
  { rssUrl: "https://shiurim.eshelpublications.com/category/podcasts/gevuros-hashem-podcast/feed/podcast/" },
  { rssUrl: "https://anchor.fm/s/3a46da2c/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/12be3694/podcast/rss" },
  { rssUrl: "https://anchor.fm/s/14f0d444/podcast/rss" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/313" },
  { rssUrl: "https://feeds.captivate.fm/bein-hametzarim/" },
  { rssUrl: "https://api.itorah.com/api/Podcast/weeklyinspire" },
  { rssUrl: "https://rebgershonribner.com/rss" },
  { rssUrl: "https://rss.jewishpodcasts.fm:443/rss/228" },
  { rssUrl: "https://feeds.redcircle.com/085dd9de-5df3-409a-b961-02101409d6c3" },
  { rssUrl: "https://www.yutorah.org/rss/RecentAudioShiurim?teacherID=80475&organizationId=301" },
];

export async function seedIfEmpty() {
  try {
    await ensureTablesExist();
    const existing = await db.select().from(feeds).limit(1);
    if (existing.length > 0) {
      console.log("Database already has feeds, skipping seed");
      return;
    }

    console.log(`Database is empty, seeding ${SEED_FEEDS.length} feeds...`);

    let seeded = 0;
    let failed = 0;
    for (const seedFeed of SEED_FEEDS) {
      try {
        const feed = await storage.createFeed({
          title: seedFeed.rssUrl,
          rssUrl: seedFeed.rssUrl,
        });

        const parsed = await parseFeed(feed.id, feed.rssUrl);
        if (!parsed) {
          console.log(`  Skipped (unparseable): ${seedFeed.rssUrl}`);
          continue;
        }
        const episodeData = parsed.episodes.map(ep => ({ ...ep, feedId: feed.id }));
        await storage.upsertEpisodes(feed.id, episodeData);

        await storage.updateFeed(feed.id, {
          lastFetchedAt: new Date(),
          title: parsed.title || feed.rssUrl,
          imageUrl: parsed.imageUrl,
          description: parsed.description,
          author: parsed.author,
        });

        seeded++;
        console.log(`  Seeded: ${parsed.title} (${episodeData.length} episodes)`);
      } catch (e: any) {
        if (e.message?.includes("unique") || e.message?.includes("duplicate")) {
          continue; // duplicate RSS URL, skip
        }
        failed++;
        console.error(`  Failed to seed ${seedFeed.rssUrl}:`, e.message || e);
      }
    }

    console.log(`Seed complete! ${seeded} seeded, ${failed} failed out of ${SEED_FEEDS.length}`);
  } catch (e) {
    console.error("Seed check failed:", e);
  }
}
