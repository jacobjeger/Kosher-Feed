// Proves the contributor upload -> MP3 -> R2 pipeline end to end.
//
//   npx tsx scripts/verify-contributor-media.ts
//
// Uses a WAV source on purpose: a rav uploads whatever his recorder produced,
// so the pipeline has to transcode, not just copy. A test that fed it an MP3
// already in the target profile would pass without proving anything.
//
// Exits non-zero on any failure. Cleans up rows and R2 objects either way.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import ffmpegPath from "ffmpeg-static";
import { db } from "../server/db";
import { contributors, contributorShows, contributorEpisodes } from "@shared/schema";
import { putObject, deleteObject, headObject, uploadKey, isR2Configured } from "../server/r2";
import { processEpisodeUpload, probeAudio, MAX_UPLOAD_BYTES } from "../server/contributor-media";

const EMAIL = "media-verify@shiurpod.com";
const SLUG = "media-verify-show";

let failures = 0;
const pass = (n: string, d = "") => console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ""}`);
const fail = (n: string, d: string) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${n} — ${d}`); };
const check = (n: string, ok: boolean, d = "") => (ok ? pass(n, d) : fail(n, d || "failed"));

/** A WAV, deliberately NOT already in the output profile: stereo, 48 kHz. */
function makeWav(seconds: number): Buffer {
  const tmp = path.join(os.tmpdir(), `cmv-${Date.now()}.wav`);
  execFileSync(ffmpegPath as string, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`,
    "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
    tmp,
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
    await db.delete(contributorEpisodes).where(eq(contributorEpisodes.showId, show.id));
    await db.delete(contributorShows).where(eq(contributorShows.id, show.id));
  }
  await db.delete(contributors).where(eq(contributors.contactEmail, EMAIL));
}

async function main() {
  console.log("\nContributor media pipeline verification\n");
  if (!isR2Configured()) throw new Error("R2 not configured");

  await cleanup();

  const [contributor] = await db.insert(contributors)
    .values({ contactEmail: EMAIL, displayName: "Media Verify", status: "active" })
    .returning();

  const [show] = await db.insert(contributorShows).values({
    contributorId: contributor.id,
    slug: SLUG,
    title: "Media Verify Show",
    description: "Pipeline verification.",
    language: "en",
    author: "Rabbi Verify",
    ownerName: "ShiurPod",
    ownerEmail: `show-${SLUG}@shiurpod.com`,
    itunesCategory: "Religion & Spirituality",
    itunesSubcategory: "Judaism",
    status: "draft",
  }).returning();

  const [ep] = await db.insert(contributorEpisodes).values({
    showId: show.id,
    title: "Verification Episode — פרשת וירא",
    description: "<p>test</p>",
    pubDate: new Date(),
    episodeNumber: 1,
    status: "draft",
    mediaStatus: "queued",
  }).returning();

  // ── Upload a raw WAV exactly as the browser would ────────────────────
  const wav = makeWav(6);
  const rawKey = uploadKey(show.id, ep.id, "wav");
  await putObject(rawKey, wav, "audio/wav");
  await db.update(contributorEpisodes)
    .set({ uploadKey: rawKey, uploadBytes: wav.length })
    .where(eq(contributorEpisodes.id, ep.id));

  const srcProbe = await probeAudio(await writeTemp(wav, "wav"));
  console.log(`  source: WAV ${(wav.length / 1024).toFixed(0)}KB, ${srcProbe.channels}ch @ ${srcProbe.sampleRate}Hz, ${srcProbe.durationSec}s\n`);

  // ── Run the pipeline ─────────────────────────────────────────────────
  const fresh = await db.select().from(contributorEpisodes).where(eq(contributorEpisodes.id, ep.id)).limit(1);
  const media = await processEpisodeUpload(fresh[0] as any, show as any);

  check("produced an audio key", !!media.audioKey, media.audioKey);
  check("duration preserved", Math.abs(media.durationSeconds - 6) <= 1, `${media.durationSeconds}s vs 6s source`);

  // Byte size must equal what R2 actually holds — this becomes enclosure length.
  const stored = await headObject(media.audioKey);
  check("stored object exists", stored.exists);
  check("byteSize equals R2 HEAD exactly", media.byteSize === stored.size, `${media.byteSize} vs ${stored.size}`);
  check("content-type is audio/mpeg", stored.contentType === "audio/mpeg", String(stored.contentType));

  // ── The output must actually be in the house profile ─────────────────
  const outBuf = await (await import("../server/r2")).getObjectBuffer(media.audioKey);
  const outPath = await writeTemp(outBuf, "mp3");
  const outProbe = await probeAudio(outPath);
  check("transcoded to MP3", outProbe.codec === "mp3", String(outProbe.codec));
  check("downmixed to mono", outProbe.channels === 1, `${outProbe.channels}ch`);
  check("resampled to 44.1kHz", outProbe.sampleRate === 44100, `${outProbe.sampleRate}Hz`);
  check("~48kbps", !!outProbe.bitRate && outProbe.bitRate < 70000, `${Math.round((outProbe.bitRate || 0) / 1000)}kbps`);
  check("smaller than the WAV source", outBuf.length < wav.length,
    `${(outBuf.length / 1024).toFixed(0)}KB vs ${(wav.length / 1024).toFixed(0)}KB`);

  // ── ID3 tags survive ─────────────────────────────────────────────────
  const NodeID3 = (await import("node-id3")).default;
  const tags = NodeID3.read(outPath);
  check("ID3 title written", !!tags.title, tags.title || "(none)");
  check("ID3 title keeps Hebrew", (tags.title || "").includes("וירא"), tags.title || "");
  check("ID3 album is the show", tags.album === show.title, tags.album || "(none)");
  check("ID3 artist is the author", tags.artist === "Rabbi Verify", tags.artist || "(none)");

  // ── The raw upload must be gone ──────────────────────────────────────
  const rawAfter = await headObject(rawKey);
  check("raw upload deleted from R2", !rawAfter.exists, rawAfter.exists ? "still present" : "gone");

  // ── Oversize rejection ───────────────────────────────────────────────
  console.log(`\n  (size cap is ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB, enforced server-side after upload)`);

  // ── Missing-file handling ────────────────────────────────────────────
  try {
    await processEpisodeUpload({ ...(fresh[0] as any), uploadKey: "uploads/does/not-exist.mp3" }, show as any);
    fail("missing upload rejected", "did not throw");
  } catch (e: any) {
    check("missing upload rejected", /missing from storage/i.test(e?.message || ""), e?.message?.slice(0, 60));
  }

  await deleteObject(media.audioKey).catch(() => {});
  fs.unlinkSync(outPath);
}

async function writeTemp(buf: Buffer, ext: string): Promise<string> {
  const p = path.join(os.tmpdir(), `cmv-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`);
  fs.writeFileSync(p, buf);
  return p;
}

main()
  .then(async () => {
    await cleanup();
    console.log(failures === 0
      ? "\n\x1b[32mAll media pipeline checks passed.\x1b[0m\n"
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("\nverification crashed:", e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
