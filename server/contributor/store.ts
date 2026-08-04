import { sql, eq, and } from "drizzle-orm";
import { db } from "../db";
import { contributorShows, contributorEpisodes } from "@shared/schema";
import type { ContributorEpisode } from "@shared/schema";

// Queue operations for the contributor media pipeline.
//
// Kept out of server/storage.ts on purpose — that file is already ~3000 lines
// and every contributor query is cohesive with the rest of server/contributor/.

/**
 * Claim queued transcode jobs.
 *
 * FOR UPDATE SKIP LOCKED so two replicas can run the worker without either
 * blocking on the other or, worse, both transcoding the same upload.
 */
export async function claimMediaJobs(limit: number): Promise<ContributorEpisode[]> {
  const res: any = await db.execute(sql`
    UPDATE contributor_episodes
       SET media_status = 'processing', media_updated_at = now()
     WHERE id IN (
       SELECT id FROM contributor_episodes
        WHERE media_status = 'queued' AND upload_key IS NOT NULL
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);

  // db.execute() returns raw driver rows, where timestamps arrive as strings.
  // Drizzle calls .toISOString() on whatever it is handed on a later insert or
  // update, so these must be real Dates — otherwise the failure is
  // "value.toISOString is not a function", thrown AFTER the transcode has
  // already burned several minutes of CPU. This exact bug bit the YouTube path.
  const toDate = (v: any): Date | null => {
    if (!v) return null;
    return v instanceof Date ? v : new Date(v);
  };

  return (res.rows || []).map((r: any) => ({
    ...r,
    showId: r.show_id,
    audioKey: r.audio_key,
    byteSize: r.byte_size,
    durationSeconds: r.duration_seconds,
    uploadKey: r.upload_key,
    uploadBytes: r.upload_bytes,
    mediaStatus: r.media_status,
    mediaError: r.media_error,
    mediaAttempts: r.media_attempts,
    episodeNumber: r.episode_number,
    pubDate: toDate(r.pub_date),
    publishedAt: toDate(r.published_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    mediaUpdatedAt: toDate(r.media_updated_at),
  })) as ContributorEpisode[];
}

/** Re-queue jobs whose worker died mid-transcode. */
export async function requeueStalledMedia(stallMs: number): Promise<number> {
  const res: any = await db.execute(sql`
    UPDATE contributor_episodes
       SET media_status = 'queued'
     WHERE media_status = 'processing'
       AND media_updated_at < now() - (${Math.round(stallMs / 1000)} || ' seconds')::interval
    RETURNING id
  `);
  return (res.rows || []).length;
}

export const MAX_MEDIA_ATTEMPTS = 4;

/**
 * Record a failure. After MAX_MEDIA_ATTEMPTS it becomes terminal, so a file
 * ffmpeg simply cannot decode stops burning CPU on every tick.
 */
export async function markMediaFailed(
  episodeId: string,
  message: string,
  attempts: number,
): Promise<void> {
  const terminal = attempts >= MAX_MEDIA_ATTEMPTS;
  await db
    .update(contributorEpisodes)
    .set({
      mediaStatus: terminal ? "failed" : "queued",
      mediaError: message.slice(0, 500),
      mediaAttempts: attempts,
      mediaUpdatedAt: new Date(),
    })
    .where(eq(contributorEpisodes.id, episodeId));
}

export async function markMediaReady(
  episodeId: string,
  media: { audioKey: string; byteSize: number; durationSeconds: number },
): Promise<void> {
  await db
    .update(contributorEpisodes)
    .set({
      audioKey: media.audioKey,
      byteSize: media.byteSize,
      durationSeconds: media.durationSeconds,
      mediaStatus: "ready",
      mediaError: null,
      uploadKey: null, // the raw upload has been deleted from R2
      mediaUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(contributorEpisodes.id, episodeId));
}

/**
 * Flip scheduled episodes to published once their pubDate passes.
 *
 * The feed already hides future-dated episodes (publicEpisodes filters on
 * pubDate), so this is not what makes scheduling correct — it exists so the
 * creator dashboard and the catalog agree with the feed instead of showing an
 * episode as "scheduled" for hours after it went live.
 */
export async function promoteDueEpisodes(): Promise<string[]> {
  const res: any = await db.execute(sql`
    UPDATE contributor_episodes
       SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
     WHERE status = 'scheduled'
       AND media_status = 'ready'
       AND pub_date <= now()
    RETURNING show_id
  `);
  return Array.from(new Set((res.rows || []).map((r: any) => r.show_id as string)));
}

/** Shows whose cached feed XML no longer reflects their episodes. */
export async function showsNeedingFeedRebuild(): Promise<string[]> {
  const res: any = await db.execute(sql`
    SELECT DISTINCT s.id
      FROM contributor_shows s
      JOIN contributor_episodes e ON e.show_id = s.id
     WHERE s.status = 'live'
       AND (s.feed_built_at IS NULL OR e.updated_at > s.feed_built_at)
  `);
  return (res.rows || []).map((r: any) => r.id as string);
}

export async function getShow(showId: string) {
  const [row] = await db.select().from(contributorShows).where(eq(contributorShows.id, showId)).limit(1);
  return row || null;
}

export async function getEpisode(episodeId: string) {
  const [row] = await db
    .select()
    .from(contributorEpisodes)
    .where(eq(contributorEpisodes.id, episodeId))
    .limit(1);
  return row || null;
}

/** Queue an uploaded file for transcoding. */
export async function enqueueUpload(
  episodeId: string,
  uploadKey: string,
  uploadBytes: number,
): Promise<void> {
  await db
    .update(contributorEpisodes)
    .set({
      uploadKey,
      uploadBytes,
      mediaStatus: "queued",
      mediaError: null,
      mediaAttempts: 0,
      mediaUpdatedAt: new Date(),
    })
    .where(eq(contributorEpisodes.id, episodeId));
}

export async function mediaQueueCounts(): Promise<Record<string, number>> {
  const res: any = await db.execute(sql`
    SELECT media_status AS s, count(*)::int AS n
      FROM contributor_episodes
     WHERE media_status IS NOT NULL
     GROUP BY media_status
  `);
  const out: Record<string, number> = {};
  for (const r of res.rows || []) out[r.s] = Number(r.n);
  return out;
}
