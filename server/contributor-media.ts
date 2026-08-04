import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import NodeID3 from "node-id3";
import { getObjectBuffer, putObject, deleteObject, headObject, audioKey } from "./r2";
import type { ContributorShow, ContributorEpisode } from "@shared/schema";

const execFileAsync = promisify(execFile);

// Upload -> validated, normalised MP3 on R2.
//
// The shape mirrors server/youtube-media.ts, which already solves this problem
// under load. Two deliberate differences:
//
//   * Output is 48 kbps mono 44.1 kHz, not YouTube's 64 kbps. A rav uploading
//     his own recording is usually speech from a single microphone; 48 kbps
//     mono is transparent for that and roughly halves storage against the 10 GB
//     R2 free tier.
//   * Audio lands on R2, not the Railway volume. Enclosure URLs must be public
//     and Range-capable forever; the volume is neither.

// The spec asks for a 500 MB cap. It CANNOT be enforced on the presigned PUT
// itself — only a POST policy can bind content-length-range, and we issue a
// simple PUT. So the browser checks before uploading (a courtesy), and this is
// the control: anything oversized is rejected and deleted here.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// Below this, the "audio" is a truncated upload or an empty container.
const MIN_AUDIO_BYTES = 1024;
// Apple rejects an episode with no duration; a stream ffprobe reads as 0 is broken.
const MIN_DURATION_SEC = 1;

const MP3_BITRATE = "48k";
const MP3_CHANNELS = "1";
const MP3_SAMPLE_RATE = "44100";

function ffmpegBin(): string {
  const p = ffmpegPath as unknown as string;
  if (!p) throw new Error("ffmpeg-static did not resolve a binary path");
  return p;
}

function ffprobeBin(): string {
  const p = (ffprobeStatic as any)?.path;
  if (!p) throw new Error("ffprobe-static did not resolve a binary path");
  return p;
}

/**
 * Scratch space for transcoding.
 *
 * Prefers the Railway volume: a 500 MB source plus its output can exhaust the
 * container's ephemeral disk, and that failure shows up as unrelated crashes
 * elsewhere in the process rather than as a transcode error.
 */
function scratchDir(): string {
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const base = vol && fs.existsSync(vol) ? path.join(vol, "tmp") : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export interface ProbedAudio {
  durationSec: number;
  codec: string | null;
  channels: number | null;
  sampleRate: number | null;
  bitRate: number | null;
}

/**
 * Probe with ffprobe rather than scraping ffmpeg's stderr.
 *
 * The YouTube path parses duration out of stderr, which is fine when the value
 * only drives a progress log. Here it becomes <itunes:duration> in a published
 * feed, so it comes from a parser with a documented output format.
 */
export async function probeAudio(filePath: string): Promise<ProbedAudio> {
  const { stdout } = await execFileAsync(
    ffprobeBin(),
    [
      "-v", "error",
      "-show_entries", "format=duration,bit_rate",
      "-show_entries", "stream=codec_type,codec_name,channels,sample_rate",
      "-of", "json",
      filePath,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout || "{}");
  const audioStream = (parsed.streams || []).find((s: any) => s.codec_type === "audio");
  if (!audioStream) throw new Error("no audio stream found — is this really an audio file?");

  const durationSec = Math.round(Number(parsed.format?.duration || 0));
  return {
    durationSec,
    codec: audioStream.codec_name || null,
    channels: audioStream.channels != null ? Number(audioStream.channels) : null,
    sampleRate: audioStream.sample_rate != null ? Number(audioStream.sample_rate) : null,
    bitRate: parsed.format?.bit_rate != null ? Number(parsed.format.bit_rate) : null,
  };
}

/** Transcode anything ffmpeg can decode into the house MP3 profile. */
export async function transcodeToMp3(input: string, output: string): Promise<void> {
  await execFileAsync(
    ffmpegBin(),
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", input,
      "-vn",                        // drop cover art / video streams
      "-map", "0:a:0",              // first audio stream only
      "-c:a", "libmp3lame",
      "-b:a", MP3_BITRATE,
      "-ac", MP3_CHANNELS,
      "-ar", MP3_SAMPLE_RATE,
      "-write_xing", "1",           // VBR header: without it players mis-seek
      "-id3v2_version", "3",        // v2.3 — v2.4 is poorly supported by podcast apps
      output,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60 * 1000 },
  );
}

export interface Id3Tags {
  title: string;
  artist: string;
  album: string;
  year?: string;
  trackNumber?: string;
  comment?: string;
}

/**
 * Write ID3v2 tags.
 *
 * These are what a car stereo or a downloaded-file player shows when it has no
 * feed to consult, which is exactly the offline case this app is built for.
 */
export function writeId3(filePath: string, tags: Id3Tags): void {
  const result = NodeID3.write(
    {
      title: tags.title,
      artist: tags.artist,
      album: tags.album,
      year: tags.year,
      trackNumber: tags.trackNumber,
      comment: tags.comment ? { language: "eng", text: tags.comment } : undefined,
    } as any,
    filePath,
  );
  if (result !== true && result instanceof Error) throw result;
}

export interface ProcessedMedia {
  audioKey: string;
  byteSize: number;
  durationSeconds: number;
  sourceBytes: number;
}

/**
 * The full pipeline for one episode: raw upload -> published MP3 on R2.
 *
 * Throws on any validation failure. The caller records the message against the
 * row so the creator sees why, rather than watching an episode sit in
 * "processing" forever.
 */
export async function processEpisodeUpload(
  episode: Pick<ContributorEpisode, "id" | "showId" | "title" | "uploadKey" | "episodeNumber" | "pubDate">,
  show: Pick<ContributorShow, "title" | "author">,
): Promise<ProcessedMedia> {
  if (!episode.uploadKey) throw new Error("episode has no uploaded file");

  // Enforce the size cap against what actually landed in the bucket, not
  // against what the browser claimed it was sending.
  const srcHead = await headObject(episode.uploadKey);
  if (!srcHead.exists) throw new Error("uploaded file is missing from storage");
  if (srcHead.size > MAX_UPLOAD_BYTES) {
    await deleteObject(episode.uploadKey).catch(() => {});
    throw new Error(
      `upload is ${Math.round(srcHead.size / 1048576)}MB, over the ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB limit`,
    );
  }
  if (srcHead.size < MIN_AUDIO_BYTES) {
    throw new Error("uploaded file is too small to be audio");
  }

  const dir = scratchDir();
  const stamp = `${episode.id}-${Date.now()}`;
  const srcPath = path.join(dir, `${stamp}.src`);
  const outPath = path.join(dir, `${stamp}.mp3`);

  try {
    const buf = await getObjectBuffer(episode.uploadKey);
    await fsp.writeFile(srcPath, buf);

    const probe = await probeAudio(srcPath);
    if (probe.durationSec < MIN_DURATION_SEC) {
      throw new Error("audio has no measurable duration — the file may be corrupt");
    }

    await transcodeToMp3(srcPath, outPath);

    const outStat = await fsp.stat(outPath);
    if (outStat.size < MIN_AUDIO_BYTES) throw new Error("transcode produced an empty file");

    writeId3(outPath, {
      title: episode.title,
      artist: show.author || show.title,
      album: show.title,
      year: (episode.pubDate ? new Date(episode.pubDate) : new Date()).getUTCFullYear().toString(),
      trackNumber: episode.episodeNumber != null ? String(episode.episodeNumber) : undefined,
    });

    // Re-probe the OUTPUT. Duration in the feed must describe the file
    // subscribers actually download, and tagging rewrites the header.
    const outProbe = await probeAudio(outPath);

    const key = audioKey(episode.showId, episode.id);
    await putObject(key, await fsp.readFile(outPath), "audio/mpeg");

    // RULE 1: enclosure length comes from the stored object. Apple rejects
    // feeds whose length is wrong, and "what we just wrote" is not the same
    // claim as "what the bucket holds".
    const stored = await headObject(key);
    if (!stored.exists || stored.size <= 0) throw new Error("stored audio could not be verified");

    // The original is never served and never kept.
    await deleteObject(episode.uploadKey).catch(() => {});

    return {
      audioKey: key,
      byteSize: stored.size,
      durationSeconds: outProbe.durationSec || probe.durationSec,
      sourceBytes: srcHead.size,
    };
  } finally {
    await fsp.unlink(srcPath).catch(() => {});
    await fsp.unlink(outPath).catch(() => {});
  }
}

/** Reports whether the transcode toolchain is usable — surfaced in admin. */
export async function mediaToolingStatus(): Promise<{
  ffmpeg: string | null;
  ffprobe: string | null;
  ok: boolean;
}> {
  const version = async (bin: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(bin, ["-version"], { maxBuffer: 1024 * 1024 });
      return (stdout.split("\n")[0] || "").trim().slice(0, 80);
    } catch {
      return null;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([
    version(ffmpegBin()).catch(() => null),
    version(ffprobeBin()).catch(() => null),
  ]);
  return { ffmpeg, ffprobe, ok: !!ffmpeg && !!ffprobe };
}
