// End-to-end verification of the contributor program.
//
//   npx tsx scripts/verify-contributor-e2e.ts
//
// Covers the plan's verification checklist:
//   * publish -> appears in the podcast feed AND in the app catalog
//   * unpublish -> gone from BOTH (the thing RSS self-ingestion cannot do)
//   * search_tsv populated, i.e. a contributor episode is actually findable
//   * trigger-owned columns were never written by hand
//   * catalog duration uses the HH:MM:SS convention, not raw seconds
//   * feeds.episode_count is not left stale
//   * a cp:// feed is never treated as fetchable RSS

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import ffmpegPath from "ffmpeg-static";
import { db } from "../server/db";
import {
  contributors, contributorShows, contributorEpisodes, feeds, episodes,
} from "@shared/schema";
import { putObject, deleteObject, headObject, publicUrl, isR2Configured } from "../server/r2";
import { renderShowFeed } from "../server/contributor-feed";
import { reconcileShowCatalog, catalogGuid, formatCatalogDuration } from "../server/contributor/catalog";
import { isCustomSchemeUrl, isContributorFeedUrl, contributorFeedUrl } from "../server/feed-schemes";

const EMAIL = "e2e-verify@shiurpod.com";
const SLUG = "e2e-verify-show";
const BASE = "https://shiurpod.com";

let failures = 0;
const pass = (n: string, d = "") => console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ""}`);
const fail = (n: string, d: string) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${n} — ${d}`); };
const check = (n: string, ok: boolean, d = "") => (ok ? pass(n, d) : fail(n, d || "failed"));

function makeMp3(seconds: number): Buffer {
  const tmp = path.join(os.tmpdir(), `e2e-${Date.now()}.mp3`);
  execFileSync(ffmpegPath as string, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=280:duration=${seconds}`,
    "-ac", "1", "-ar", "44100", "-b:a", "48k", tmp,
  ]);
  const b = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return b;
}

async function cleanup() {
  const [show] = await db.select().from(contributorShows).where(eq(contributorShows.slug, SLUG)).limit(1);
  if (show) {
    const eps = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
    for (const e of eps) {
      if (e.audioKey) await deleteObject(e.audioKey).catch(() => {});
      if (e.uploadKey) await deleteObject(e.uploadKey).catch(() => {});
    }
    if (show.feedId) {
      await db.delete(episodes).where(eq(episodes.feedId, show.feedId));
      await db.delete(feeds).where(eq(feeds.id, show.feedId));
    }
    await db.delete(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
    await db.delete(contributorShows).where(eq(contributorShows.id, show.id));
  }
  await db.delete(contributors).where(eq(contributors.contactEmail, EMAIL));
}

async function main() {
  console.log("\nContributor end-to-end verification\n");
  if (!isR2Configured()) throw new Error("R2 not configured");
  await cleanup();

  // ── Scheme guards (Phase 6 risk #1) ──────────────────────────────────
  const cpUrl = contributorFeedUrl("some-show-id");
  check("cp:// counts as a custom scheme", isCustomSchemeUrl(cpUrl), cpUrl);
  check("cp:// identified as contributor", isContributorFeedUrl(cpUrl));
  check("http URLs still fetchable", !isCustomSchemeUrl("https://example.com/rss.xml"));

  // ── Duration convention ──────────────────────────────────────────────
  check("duration formats as HH:MM:SS", formatCatalogDuration(2575) === "00:42:55", String(formatCatalogDuration(2575)));
  check("duration handles > 1 hour", formatCatalogDuration(3661) === "01:01:01", String(formatCatalogDuration(3661)));
  check("zero duration is null", formatCatalogDuration(0) === null);

  // ── Build a live show ────────────────────────────────────────────────
  const [contributor] = await db.insert(contributors)
    .values({ contactEmail: EMAIL, displayName: "E2E Verify", status: "active" }).returning();

  const [show] = await db.insert(contributorShows).values({
    contributorId: contributor.id,
    slug: SLUG,
    title: "E2E Verify Show",
    description: "End-to-end verification of the contributor pipeline.",
    language: "en",
    author: "Rabbi E2E",
    ownerName: "ShiurPod",
    ownerEmail: `show-${SLUG}@shiurpod.com`,
    itunesCategory: "Religion & Spirituality",
    itunesSubcategory: "Judaism",
    reviewRequired: false,
    status: "live",
  }).returning();

  const [ep] = await db.insert(contributorEpisodes).values({
    showId: show.id,
    title: "E2E Episode — פרשת שמות",
    description: "<p>Verification episode.</p>",
    pubDate: new Date(Date.now() - 3600_000),
    episodeNumber: 1,
    status: "published",
    publishedAt: new Date(Date.now() - 3600_000),
    mediaStatus: "ready",
  }).returning();

  const mp3 = makeMp3(7);
  const key = `audio/${show.id}/${ep.id}.mp3`;
  await putObject(key, mp3, "audio/mpeg");
  const head = await headObject(key);
  await db.update(contributorEpisodes)
    .set({ audioKey: key, byteSize: head.size, durationSeconds: 7 })
    .where(eq(contributorEpisodes.id, ep.id));

  console.log("");

  // ── PUBLISH ──────────────────────────────────────────────────────────
  const r1 = await reconcileShowCatalog(show.id);
  check("reconcile published to catalog", r1.published === 1, `published=${r1.published}`);

  const freshShow = (await db.select().from(contributorShows).where(eq(contributorShows.id, show.id)).limit(1))[0];
  check("show linked to a catalog feed", !!freshShow.feedId, String(freshShow.feedId));

  const [catFeed] = await db.select().from(feeds).where(eq(feeds.id, freshShow.feedId!)).limit(1);
  check("catalog feed uses cp:// scheme", catFeed.rssUrl === contributorFeedUrl(show.id), catFeed.rssUrl);
  check("catalog feed is active", catFeed.isActive === true);
  check("show revealed in browse", catFeed.showInBrowse === true);

  const catEps = await db.select().from(episodes).where(eq(episodes.feedId, freshShow.feedId!));
  check("episode is in the catalog", catEps.length === 1, `${catEps.length} row(s)`);

  const catEp = catEps[0];
  check("catalog guid is cp-prefixed", catEp?.guid === catalogGuid(ep.id), String(catEp?.guid));
  check("catalog audioUrl is the R2 domain", (catEp?.audioUrl || "").startsWith("https://audio.shiurpod.com/"), String(catEp?.audioUrl));
  check("catalog duration is HH:MM:SS", catEp?.duration === "00:00:07", String(catEp?.duration));
  check("Hebrew title survived into the catalog", (catEp?.title || "").includes("שמות"), String(catEp?.title));

  // ── Triggers ran (search) ────────────────────────────────────────────
  const tsv: any = await db.execute(sql`
    SELECT search_tsv IS NOT NULL AS has_tsv, title_fold, popularity
      FROM episodes WHERE id = ${catEp.id}
  `);
  const row = tsv.rows?.[0];
  check("search_tsv populated by trigger", row?.has_tsv === true, "episode is findable");
  check("title_fold populated by trigger", !!row?.title_fold, String(row?.title_fold).slice(0, 40));

  const ftsv: any = await db.execute(sql`
    SELECT search_tsv IS NOT NULL AS has_tsv FROM feeds WHERE id = ${freshShow.feedId}
  `);
  check("feed search_tsv populated by trigger", ftsv.rows?.[0]?.has_tsv === true);

  // ── episode_count not stale (risk #4) ────────────────────────────────
  const cnt: any = await db.execute(sql`SELECT episode_count FROM feeds WHERE id = ${freshShow.feedId}`);
  check("feeds.episode_count is current", Number(cnt.rows?.[0]?.episode_count) === 1, `${cnt.rows?.[0]?.episode_count}`);

  // ── Feed XML agrees with the catalog ─────────────────────────────────
  const epsNow = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
  const rendered = renderShowFeed(freshShow as any, epsNow as any, BASE);
  check("episode appears in the podcast feed", rendered.episodeCount === 1, `${rendered.episodeCount}`);
  check("enclosure length matches R2 exactly", rendered.xml.includes(`length="${head.size}"`), `${head.size}`);
  check("enclosure points at the R2 domain", rendered.xml.includes("https://audio.shiurpod.com/"));

  // ── Range request on the real object ─────────────────────────────────
  await new Promise((r) => setTimeout(r, 1200));
  const rangeRes = await fetch(publicUrl(key), { headers: { Range: "bytes=0-99" } });
  check("contributor MP3 serves Range 206", rangeRes.status === 206, `http ${rangeRes.status}`);

  console.log("");

  // ── UNPUBLISH — the case pull-based ingestion cannot handle ──────────
  await db.update(contributorEpisodes)
    .set({ status: "unpublished", updatedAt: new Date() })
    .where(eq(contributorEpisodes.id, ep.id));

  const r2r = await reconcileShowCatalog(show.id);
  check("reconcile removed from catalog", r2r.removed === 1, `removed=${r2r.removed}`);

  const afterEps = await db.select().from(episodes).where(eq(episodes.feedId, freshShow.feedId!));
  check("episode gone from the catalog", afterEps.length === 0, `${afterEps.length} row(s)`);

  const afterCnt: any = await db.execute(sql`SELECT episode_count FROM feeds WHERE id = ${freshShow.feedId}`);
  check("episode_count back to 0", Number(afterCnt.rows?.[0]?.episode_count) === 0, `${afterCnt.rows?.[0]?.episode_count}`);

  const epsAfter = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
  const renderedAfter = renderShowFeed(freshShow as any, epsAfter as any, BASE);
  check("episode gone from the podcast feed", renderedAfter.episodeCount === 0, `${renderedAfter.episodeCount}`);

  // ── Suspension removes the whole show ────────────────────────────────
  await db.update(contributorEpisodes).set({ status: "published" }).where(eq(contributorEpisodes.id, ep.id));
  await reconcileShowCatalog(show.id);
  await db.update(contributorShows).set({ status: "suspended" }).where(eq(contributorShows.id, show.id));
  await reconcileShowCatalog(show.id);

  const suspended = await db.select().from(episodes).where(eq(episodes.feedId, freshShow.feedId!));
  check("suspension clears the catalog", suspended.length === 0, `${suspended.length} row(s)`);
  const [suspFeed] = await db.select().from(feeds).where(eq(feeds.id, freshShow.feedId!)).limit(1);
  check("suspended feed is deactivated", suspFeed.isActive === false);

  await deleteObject(key).catch(() => {});
}

main()
  .then(async () => {
    await cleanup();
    console.log(failures === 0
      ? "\n\x1b[32mAll end-to-end checks passed.\x1b[0m\n"
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("\ne2e crashed:", e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
