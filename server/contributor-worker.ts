import {
  claimMediaJobs,
  requeueStalledMedia,
  markMediaFailed,
  markMediaReady,
  promoteDueEpisodes,
  showsNeedingFeedRebuild,
  getShow,
  MAX_MEDIA_ATTEMPTS,
} from "./contributor/store";
import { processEpisodeUpload, mediaToolingStatus } from "./contributor-media";
import { buildAndCacheFeed } from "./contributor/feed-route";
import { reconcileShowCatalog } from "./contributor/catalog";
import { canonicalBaseUrl } from "./public-url";
import type { ContributorEpisode } from "@shared/schema";

// Drains the contributor upload queue: raw file -> validated MP3 -> feed.
//
// Mirrors server/youtube-worker.ts, which already runs this shape in
// production. Uploading is cheap (a presigned PUT straight to R2, the server
// never touches the bytes), so the expensive work is deliberately deferred here
// and rate-limited.

const TICK_MS = 20_000;
// One at a time: ffmpeg is CPU-bound and this shares a container with the web
// server. Two concurrent transcodes make every API request slow.
const BATCH = 1;
// A row stuck in 'processing' this long means the process died mid-transcode.
const STALL_MS = 30 * 60 * 1000;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

// EXPO_PUBLIC_API_URL is NOT usable here — on Railway it is set to the vendor
// host (kosher-feed-production.up.railway.app), and this value gets written
// into feeds that subscribers keep for years.
function publicBase(): string {
  return canonicalBaseUrl();
}

async function processOne(ep: ContributorEpisode): Promise<void> {
  const attempts = (ep.mediaAttempts || 0) + 1;
  const started = Date.now();

  try {
    const show = await getShow(ep.showId);
    if (!show) throw new Error("show no longer exists");

    const media = await processEpisodeUpload(ep as any, show as any);
    await markMediaReady(ep.id, media);

    console.log(
      `Contributor media: ${ep.id} ready — ${Math.round(media.sourceBytes / 1048576)}MB in -> ` +
        `${Math.round(media.byteSize / 1024)}KB out, ${media.durationSeconds}s, ` +
        `${Math.round((Date.now() - started) / 1000)}s`,
    );

    // Rebuild immediately: an episode that is 'ready' but absent from the feed
    // is invisible to every subscriber until something else happens to trigger
    // a rebuild.
    await buildAndCacheFeed(ep.showId, publicBase()).catch((e) =>
      console.error(`Contributor feed rebuild failed for ${ep.showId}: ${e?.message?.slice(0, 160)}`),
    );
    await reconcileShowCatalog(ep.showId).catch((e) =>
      console.error(`Contributor catalog reconcile failed for ${ep.showId}: ${e?.message?.slice(0, 160)}`),
    );
  } catch (e: any) {
    const msg = e?.message || String(e);
    const terminal = attempts >= MAX_MEDIA_ATTEMPTS;
    console.error(
      `Contributor media: ${ep.id} attempt ${attempts}/${MAX_MEDIA_ATTEMPTS} failed — ${msg.slice(0, 200)}` +
        (terminal ? " (giving up)" : ""),
    );
    // The creator sees this string in the dashboard, so it must say what went
    // wrong rather than leaving the episode stuck with no explanation.
    await markMediaFailed(ep.id, msg, attempts);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const requeued = await requeueStalledMedia(STALL_MS);
    if (requeued > 0) console.log(`Contributor media: re-queued ${requeued} stalled job(s)`);

    const jobs = await claimMediaJobs(BATCH);
    for (const job of jobs) await processOne(job);

    // Scheduled -> published once the pubDate passes, then rebuild those feeds.
    const promoted = await promoteDueEpisodes();
    if (promoted.length > 0) {
      console.log(`Contributor: published ${promoted.length} scheduled episode(s)`);
      for (const showId of promoted) {
        await buildAndCacheFeed(showId, publicBase()).catch(() => {});
        await reconcileShowCatalog(showId).catch(() => {});
      }
    }

    // Catch feeds left stale by an edit path that forgot to rebuild. Cheap when
    // there is nothing to do, and the alternative is a subscriber-visible bug
    // that nobody notices for weeks.
    const stale = await showsNeedingFeedRebuild();
    for (const showId of stale.slice(0, 5)) {
      await buildAndCacheFeed(showId, publicBase()).catch(() => {});
    }
    if (stale.length > 0) console.log(`Contributor: rebuilt ${Math.min(stale.length, 5)} stale feed(s)`);
  } catch (e: any) {
    console.error(`Contributor media worker error: ${e?.message?.slice(0, 200)}`);
  } finally {
    running = false;
  }
}

export function startContributorMediaWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);

  setTimeout(async () => {
    const tooling = await mediaToolingStatus();
    if (!tooling.ok) {
      // Loud, because the queue will accept uploads and then fail every one of
      // them — the symptom looks like broken uploads, not a missing binary.
      console.error(
        `Contributor media worker: TOOLING MISSING — ffmpeg=${tooling.ffmpeg || "none"} ffprobe=${tooling.ffprobe || "none"}`,
      );
    } else {
      console.log(`Contributor media worker: started (${tooling.ffmpeg})`);
    }
    void tick();
  }, 6_000);
}

/** Let an upload nudge the worker instead of waiting up to a full tick. */
export function nudgeContributorMediaWorker(): void {
  setTimeout(() => { void tick(); }, 250);
}
