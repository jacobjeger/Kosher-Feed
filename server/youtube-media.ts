import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

// YouTube media pipeline: fetch a video's audio ONCE and keep an MP3.
//
// Why store instead of stream: googlevideo hands untrusted sessions
// short-lived, effectively single-use URLs and 403s open-ended reads. Playback
// makes many reads per track, so proxying YouTube live fails within seconds.
// Downloading needs exactly one pass, which is reliable. Every approved shiur
// therefore becomes a normal MP3 on our own disk, and playback never touches
// YouTube again.
//
// Why yt-dlp rather than doing it in-process: it already solves stream-URL
// deciphering, the throttling `n` parameter, PO tokens and client fallback,
// and it's maintained against YouTube's changes continuously. This runs once
// per approved video in the background, so shelling out costs us nothing.

const DEFAULT_MEDIA_DIR = process.env.MEDIA_DIR || "/data/media";
// 64kbps mono is transparent for speech and about a third the size of
// YouTube's ~128kbps stereo — smaller offline downloads for listeners too.
const AUDIO_BITRATE = process.env.YT_AUDIO_BITRATE || "64K";
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000; // an 8-hour shiur still fits

export function mediaDir(): string {
  return DEFAULT_MEDIA_DIR;
}

export function mediaPathFor(videoId: string): string {
  return path.join(mediaDir(), `${videoId}.mp3`);
}

// yt-dlp lives wherever the build put it. scripts/fetch-ytdlp.sh drops a
// standalone binary in ./bin so this works on any builder without a system
// package; YTDLP_PATH overrides for local dev.
export function ytdlpPath(): string {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const local = path.resolve(process.cwd(), "bin/yt-dlp");
  if (fs.existsSync(local)) return local;
  return "yt-dlp"; // fall back to PATH
}

function ffmpegDir(): string | null {
  const bin = ffmpegStatic as unknown as string | null;
  if (!bin) return null;
  return path.dirname(bin);
}

export async function ensureMediaDir(): Promise<void> {
  await fsp.mkdir(mediaDir(), { recursive: true });
}

export interface DownloadResult {
  path: string;
  bytes: number;
  durationSec: number | null;
}

function runYtdlp(args: string[], onLog?: (line: string) => void): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 60000)}m`));
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout.on("data", (d) => onLog?.(String(d).trim()));
    child.stderr.on("data", (d) => {
      const s = String(d);
      // Keep only the tail — yt-dlp is chatty and we just want the failure.
      stderr = (stderr + s).slice(-4000);
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stderr }); });
  });
}

// Probe the finished file so the episode carries a real duration rather than
// whatever the playlist metadata claimed.
async function probeDurationSec(file: string): Promise<number | null> {
  const bin = ffmpegStatic as unknown as string | null;
  if (!bin) return null;
  return new Promise((resolve) => {
    const child = spawn(bin, ["-hide_banner", "-i", file, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let out = "";
    child.stderr.on("data", (d) => { out = (out + String(d)).slice(-8000); });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (!m) return resolve(null);
      resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    });
  });
}

// Fetch one video's audio and write {videoId}.mp3 into MEDIA_DIR.
//
// Writes through a temp name and renames on success, so a crashed or killed
// download can never leave a truncated file that later looks "ready".
export async function downloadYouTubeAudio(
  videoId: string,
  onLog?: (line: string) => void,
): Promise<DownloadResult> {
  await ensureMediaDir();

  const finalPath = mediaPathFor(videoId);
  const tmpBase = path.join(mediaDir(), `.tmp-${videoId}`);

  // Clear any debris from a previous failed attempt.
  for (const f of await fsp.readdir(mediaDir()).catch(() => [] as string[])) {
    if (f.startsWith(`.tmp-${videoId}`)) {
      await fsp.rm(path.join(mediaDir(), f), { force: true }).catch(() => {});
    }
  }

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-color",
    "--retries", "5",
    "--fragment-retries", "5",
    "--socket-timeout", "30",
    "-f", "bestaudio",
    "-x", "--audio-format", "mp3",
    "--audio-quality", AUDIO_BITRATE,
    // Speech is mono — halves the size with no audible loss for a shiur.
    "--postprocessor-args", "ExtractAudio:-ac 1",
    "-o", `${tmpBase}.%(ext)s`,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  const ffDir = ffmpegDir();
  if (ffDir) args.splice(0, 0, "--ffmpeg-location", ffDir);

  const { code, stderr } = await runYtdlp(args, onLog);
  const tmpMp3 = `${tmpBase}.mp3`;

  if (code !== 0 || !fs.existsSync(tmpMp3)) {
    await fsp.rm(tmpMp3, { force: true }).catch(() => {});
    const reason = stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 500)
      || `yt-dlp exited ${code}`;
    throw new Error(reason);
  }

  const stat = await fsp.stat(tmpMp3);
  if (stat.size < 10_000) {
    await fsp.rm(tmpMp3, { force: true }).catch(() => {});
    throw new Error(`Downloaded file suspiciously small (${stat.size} bytes)`);
  }

  const durationSec = await probeDurationSec(tmpMp3);
  await fsp.rename(tmpMp3, finalPath);

  return { path: finalPath, bytes: stat.size, durationSec };
}

export async function deleteYouTubeAudio(videoId: string): Promise<void> {
  await fsp.rm(mediaPathFor(videoId), { force: true }).catch(() => {});
}

export async function mediaExists(videoId: string): Promise<boolean> {
  try {
    const st = await fsp.stat(mediaPathFor(videoId));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export interface MediaUsage {
  files: number;
  bytes: number;
  dir: string;
  available: boolean;
}

export async function mediaUsage(): Promise<MediaUsage> {
  const dir = mediaDir();
  try {
    const names = await fsp.readdir(dir);
    let bytes = 0;
    let files = 0;
    for (const n of names) {
      if (!n.endsWith(".mp3")) continue;
      const st = await fsp.stat(path.join(dir, n)).catch(() => null);
      if (st?.isFile()) { bytes += st.size; files++; }
    }
    return { files, bytes, dir, available: true };
  } catch {
    return { files: 0, bytes: 0, dir, available: false };
  }
}

// Cheap self-check for the admin panel: is the toolchain actually present?
export async function mediaToolingStatus(): Promise<{
  ytdlp: string | null;
  ytdlpPath: string;
  ffmpeg: boolean;
  dirWritable: boolean;
  dir: string;
}> {
  const ff = !!(ffmpegStatic as unknown as string | null);
  let version: string | null = null;
  try {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const c = spawn(ytdlpPath(), ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => { out += String(d); });
      c.stderr.on("data", (d) => { err += String(d); });
      c.on("error", reject);
      c.on("close", (code) => { version = out.trim() || null; resolve({ code: code ?? -1, stderr: err }); });
    });
    if (code !== 0) version = null;
  } catch {
    version = null;
  }

  let dirWritable = false;
  try {
    await ensureMediaDir();
    const probe = path.join(mediaDir(), ".write-probe");
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe, { force: true });
    dirWritable = true;
  } catch {}

  return { ytdlp: version, ytdlpPath: ytdlpPath(), ffmpeg: ff, dirWritable, dir: mediaDir() };
}
