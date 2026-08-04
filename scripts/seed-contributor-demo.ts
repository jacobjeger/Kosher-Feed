// Seeds one contributor show with two real episodes, so the feed can be run
// through an external podcast validator before any creator UI exists.
//
//   npx tsx scripts/seed-contributor-demo.ts           # create
//   npx tsx scripts/seed-contributor-demo.ts --cleanup # remove it all
//
// The audio is genuinely generated and genuinely uploaded to R2 — a validator
// issues a real HEAD against the enclosure URL and checks the byte length, so
// fake rows pointing at nonexistent objects would pass locally and fail there.
//
// The show is created with status 'live', which makes /feed/{slug}.xml public.
// It is deliberately named so nobody mistakes it for a real rav, and --cleanup
// removes both the rows and the R2 objects.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import ffmpegPath from "ffmpeg-static";
import { db } from "../server/db";
import {
  contributors,
  contributorShows,
  contributorEpisodes,
} from "@shared/schema";
import { putObject, deleteObject, headObject, publicUrl, isR2Configured } from "../server/r2";
import { renderShowFeed, validateFeed } from "../server/contributor-feed";

const SLUG = "demo-validation-show";
const CONTRIB_EMAIL = "demo-validation@shiurpod.com";
const BASE = process.env.PUBLIC_BASE_URL || "https://shiurpod.com";

/** A real, decodable MP3 — a quiet sine tone. Validators fetch these for real. */
function makeMp3(seconds: number): Buffer {
  const tmp = path.join(os.tmpdir(), `seed-${Date.now()}-${seconds}.mp3`);
  execFileSync(
    ffmpegPath as string,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`,
      "-ac", "1", "-ar", "44100", "-b:a", "48k",
      tmp,
    ],
    { stdio: "pipe" },
  );
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}

async function cleanup() {
  const [show] = await db.select().from(contributorShows).where(eq(contributorShows.slug, SLUG)).limit(1);
  if (show) {
    const eps = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
    for (const ep of eps) {
      if (ep.audioKey) await deleteObject(ep.audioKey).catch(() => {});
    }
    if (show.artworkKey) await deleteObject(show.artworkKey).catch(() => {});
    await db.delete(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
    await db.delete(contributorShows).where(eq(contributorShows.id, show.id));
    console.log(`removed show ${show.id} and ${eps.length} episode(s) + R2 objects`);
  } else {
    console.log("nothing to clean up");
  }
  await db.delete(contributors).where(eq(contributors.contactEmail, CONTRIB_EMAIL));
  console.log("cleanup done");
}

async function main() {
  if (process.argv.includes("--cleanup")) return cleanup();

  if (!isR2Configured()) throw new Error("R2 not configured — set R2_* env vars");

  // Idempotent: start from a clean slate so re-running doesn't duplicate.
  await cleanup();

  const [contributor] = await db
    .insert(contributors)
    .values({
      contactEmail: CONTRIB_EMAIL,
      displayName: "Demo Validation Account",
      status: "active",
    })
    .returning();

  const [show] = await db
    .insert(contributorShows)
    .values({
      contributorId: contributor.id,
      slug: SLUG,
      title: "ShiurPod Feed Validation (Demo)",
      description:
        "A technical demonstration feed used to validate ShiurPod's podcast output. Not a real shiur series.",
      language: "en",
      author: "ShiurPod",
      ownerName: "ShiurPod",
      // RULE: owner_email is always show-{slug}@shiurpod.com — never a real
      // person's address. This is where Apple/Spotify send the claim code.
      ownerEmail: `show-${SLUG}@shiurpod.com`,
      itunesCategory: "Religion & Spirituality",
      itunesSubcategory: "Judaism",
      itunesType: "episodic",
      explicit: false,
      reviewRequired: true,
      status: "live",
    })
    .returning();

  console.log(`show ${show.id} (${SLUG})`);

  // Artwork: 1400x1400 minimum for Apple. Generate a real square JPEG.
  const sharp = (await import("sharp")).default;
  const art = await sharp({
    create: { width: 1500, height: 1500, channels: 3, background: { r: 20, g: 30, b: 60 } },
  })
    .jpeg({ quality: 88 })
    .toBuffer();
  const artKey = `artwork/show/${show.id}.jpg`;
  await putObject(artKey, art, "image/jpeg");
  await db
    .update(contributorShows)
    .set({ artworkKey: artKey, artworkWidth: 1500, artworkHeight: 1500 })
    .where(eq(contributorShows.id, show.id));
  console.log(`  artwork -> ${publicUrl(artKey)} (${art.length} bytes)`);

  const specs = [
    { title: "Demo Episode One — Hebrew: פרשת בראשית", secs: 5, daysAgo: 7, n: 1 },
    { title: "Demo Episode Two — Yiddish: אַ גוטן שבת", secs: 8, daysAgo: 2, n: 2 },
  ];

  for (const s of specs) {
    const [ep] = await db
      .insert(contributorEpisodes)
      .values({
        showId: show.id,
        title: s.title,
        description: "<p>Generated audio for feed validation. Not a real shiur.</p>",
        pubDate: new Date(Date.now() - s.daysAgo * 86400_000),
        episodeNumber: s.n,
        explicit: false,
        status: "published",
        publishedAt: new Date(Date.now() - s.daysAgo * 86400_000),
        mediaStatus: "processing",
      })
      .returning();

    const mp3 = makeMp3(s.secs);
    const key = `audio/${show.id}/${ep.id}.mp3`;
    await putObject(key, mp3, "audio/mpeg");

    // RULE 1: byte size comes from the STORED object, never from what we think
    // we uploaded. Apple rejects feeds whose enclosure length is wrong.
    const head = await headObject(key);
    if (!head.exists) throw new Error(`upload verification failed for ${key}`);

    await db
      .update(contributorEpisodes)
      .set({
        audioKey: key,
        byteSize: head.size,
        durationSeconds: s.secs,
        mediaStatus: "ready",
        mediaUpdatedAt: new Date(),
      })
      .where(eq(contributorEpisodes.id, ep.id));

    console.log(`  episode ${s.n}: ${head.size} bytes (HEAD-verified) -> ${publicUrl(key)}`);
  }

  // Render and validate before caching.
  const [freshShow] = await db.select().from(contributorShows).where(eq(contributorShows.id, show.id)).limit(1);
  const eps = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
  const issues = validateFeed(freshShow as any, eps as any);
  const errors = issues.filter((i) => i.level === "error");

  console.log("\nvalidation:");
  if (issues.length === 0) console.log("  no issues");
  for (const i of issues) console.log(`  [${i.level}] ${i.message}`);

  const rendered = renderShowFeed(freshShow as any, eps as any, BASE);
  await db
    .update(contributorShows)
    .set({ feedXml: rendered.xml, feedEtag: rendered.etag, feedBuiltAt: new Date() })
    .where(eq(contributorShows.id, show.id));

  console.log(`\nfeed cached: ${rendered.episodeCount} episode(s), etag ${rendered.etag}`);
  console.log(`URL: ${BASE}/feed/${SLUG}.xml`);
  if (errors.length > 0) {
    console.error(`\n${errors.length} blocking error(s) — do not submit this feed`);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("seed failed:", e);
    process.exit(1);
  });
