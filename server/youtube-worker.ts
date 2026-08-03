import * as storage from "./storage";
import { downloadYouTubeAudio, mediaExists, mediaPathFor, ytdlpPath } from "./youtube-media";
import { sendNewEpisodePushes, PUSH_BACKFILL_THRESHOLD } from "./push";
import fsp from "node:fs/promises";

// Drains the YouTube media queue: approved video -> stored MP3 -> episode.
//
// Approval is deliberately cheap (a status flip), so a bulk "approve 300
// videos" click returns instantly and the actual fetching happens here at a
// controlled rate. Episodes only appear once their audio is on disk.

const TICK_MS = 20_000;
// One at a time. Downloads are bandwidth- and CPU-heavy (ffmpeg transcode),
// and hammering YouTube with parallel fetches is exactly what gets a host
// throttled — the thing this whole design exists to avoid.
const BATCH = 1;
// A row left "downloading" this long means the process died mid-fetch.
const STALL_MS = 30 * 60 * 1000;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function processOne(row: Awaited<ReturnType<typeof storage.claimYouTubeMediaJobs>>[number]): Promise<void> {
  const attempts = (row.mediaAttempts || 0) + 1;

  try {
    // A previous run may have written the file but died before recording it.
    // Reuse it rather than re-downloading.
    let media;
    if (await mediaExists(row.videoId)) {
      const st = await fsp.stat(mediaPathFor(row.videoId));
      media = { path: mediaPathFor(row.videoId), bytes: st.size, durationSec: row.mediaDurationSec ?? null };
      console.log(`YouTube media: ${row.videoId} already on disk (${Math.round(st.size / 1048576)}MB), reusing`);
    } else {
      const started = Date.now();
      media = await downloadYouTubeAudio(row.videoId);
      console.log(
        `YouTube media: stored ${row.videoId} — ${Math.round(media.bytes / 1048576)}MB in ${Math.round((Date.now() - started) / 1000)}s`,
      );
    }

    const episode = await storage.createEpisodeForStoredYouTubeMedia(row, media);

    if (episode) {
      // Reveal the feed once it has its first real episode.
      try {
        const feed = await storage.getFeedById(row.feedId);
        if (feed && !feed.showInBrowse) {
          await storage.updateFeed(row.feedId, { showInBrowse: true } as any);
        }
        // The worker processes one video at a time, so this fires per episode.
        // Guard on the feed's total so a back-catalogue import doesn't spam
        // every subscriber with hundreds of notifications.
        const readyCount = await storage.countEpisodesByFeed(row.feedId).catch(() => 0);
        if (feed && readyCount <= PUSH_BACKFILL_THRESHOLD) {
          sendNewEpisodePushes(
            row.feedId,
            { title: episode.title, id: episode.id, publishedAt: (episode as any).publishedAt },
            feed.title,
          ).catch(() => {});
        }
      } catch {}
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error(`YouTube media: ${row.videoId} attempt ${attempts} failed — ${msg.slice(0, 200)}`);
    await storage.markYouTubeMediaFailed(row.id, msg, attempts);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const requeued = await storage.requeueStalledYouTubeMedia(STALL_MS);
    if (requeued > 0) console.log(`YouTube media: re-queued ${requeued} stalled download(s)`);

    const jobs = await storage.claimYouTubeMediaJobs(BATCH);
    for (const job of jobs) {
      await processOne(job);
    }
  } catch (e: any) {
    console.error(`YouTube media worker error: ${e?.message?.slice(0, 200)}`);
  } finally {
    running = false;
  }
}

export function startYouTubeMediaWorker(): void {
  if (timer) return;
  console.log(`YouTube media worker: started (yt-dlp at ${ytdlpPath()})`);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  // Kick immediately so a restart resumes pending work without waiting a tick.
  setTimeout(() => { void tick(); }, 5_000);
}

// Let the admin "approve" path nudge the worker instead of waiting for the
// next tick — approving one video should feel immediate.
export function nudgeYouTubeMediaWorker(): void {
  setTimeout(() => { void tick(); }, 250);
}
