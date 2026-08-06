import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Cloudflare R2 — the ONLY module in the codebase that imports the S3 client.
//
// That rule is the whole point: every other module goes through publicUrl() /
// presignUpload() / headObject(), so moving to different storage later is a
// one-file change rather than a search-and-replace across routes, workers and
// feed generation.
//
// Public reads go through the custom domain (audio.shiurpod.com), never the
// r2.dev URL and never a signed GET. Every enclosure URL in every published
// podcast feed points at that hostname permanently — a subscriber's podcast app
// may still be fetching it years from now — so if storage ever moves we
// repoint DNS and existing feeds keep working. A vendor hostname baked into a
// published feed cannot be taken back.
//
// The server never streams audio. Uploads go client -> R2 via a presigned PUT;
// playback goes listener -> Cloudflare edge. Our Node process handles neither.

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const BUCKET = process.env.R2_BUCKET || "shiurpod-audio";
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://audio.shiurpod.com").replace(/\/$/, "");

// Presigned PUTs are short-lived on purpose: they authorise a write to one
// specific key, so a leaked URL should stop being useful quickly.
const UPLOAD_EXPIRY_SECONDS = 60 * 60;

export function isR2Configured(): boolean {
  return !!(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET);
}

let _client: S3Client | null = null;

function client(): S3Client {
  if (!isR2Configured()) {
    throw new Error(
      "R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET",
    );
  }
  if (!_client) {
    _client = new S3Client({
      region: "auto", // R2 has no regions; "auto" is required
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
  }
  return _client;
}

// --- Key layout ------------------------------------------------------------
// Keys are derived from ids, never from user input. A client asking to upload
// supplies no key at all — the server picks it (see presignUpload). Letting a
// client choose its own key would let it overwrite another show's audio.

export function audioKey(showId: string, episodeId: string): string {
  return `audio/${showId}/${episodeId}.mp3`;
}

export function showArtworkKey(showId: string, ext = "jpg"): string {
  return `artwork/show/${showId}.${ext}`;
}

export function episodeArtworkKey(episodeId: string, ext = "jpg"): string {
  return `artwork/episode/${episodeId}.${ext}`;
}

// Raw uploads land here and are deleted once transcoded — the original is never
// served and never kept.
export function uploadKey(showId: string, episodeId: string, ext: string): string {
  const safeExt = (ext || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "bin";
  return `uploads/${showId}/${episodeId}.${safeExt}`;
}

/** Public URL on the custom domain. This is what goes in a feed enclosure. */
export function publicUrl(key: string): string {
  return `${PUBLIC_URL}/${key.replace(/^\//, "")}`;
}

// --- Operations ------------------------------------------------------------

export interface PresignedUpload {
  url: string;
  key: string;
  expiresAt: Date;
  contentType: string;
}

/**
 * A presigned PUT for one specific key chosen by the SERVER.
 *
 * Note the 500MB cap the spec asks for cannot be enforced here: a v4-presigned
 * simple PUT has no way to bind a content-length-range (only a POST policy
 * does). The size must be checked client-side and then verified with
 * headObject() after upload, rejecting and deleting anything oversized.
 */
export async function presignUpload(
  key: string,
  contentType: string,
): Promise<PresignedUpload> {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  const url = await getSignedUrl(client(), cmd, { expiresIn: UPLOAD_EXPIRY_SECONDS });
  return {
    url,
    key,
    contentType,
    expiresAt: new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000),
  };
}

export interface PutOptions {
  /** Sets Content-Disposition, so a browser downloads with a sensible filename. */
  downloadFilename?: string;
  /** Cache-Control on the object. Immutable content should say so. */
  cacheControl?: string;
}

/** Server-side write. Used for transcoded audio, artwork and APK builds. */
export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
  opts: PutOptions = {},
): Promise<void> {
  // Content-Type matters beyond correctness here: podcast clients and Apple's
  // feed validator both check it on the enclosure, and Android refuses to
  // install an APK served as octet-stream from some browsers.
  await client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Stored ON THE OBJECT rather than set per response: downloads are served
      // straight from the R2 edge, so our server is not in the path to add
      // headers later.
      ContentDisposition: opts.downloadFilename
        ? `attachment; filename="${opts.downloadFilename.replace(/["\\]/g, "")}"`
        : undefined,
      CacheControl: opts.cacheControl,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export interface ObjectHead {
  exists: boolean;
  size: number;
  contentType: string | null;
  etag: string | null;
}

/**
 * HEAD an object. This is how enclosure byte size is established — Apple
 * rejects feeds whose enclosure length is wrong, so the number must come from
 * the stored object rather than from what the uploader claimed.
 */
export async function headObject(key: string): Promise<ObjectHead> {
  try {
    const res = await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return {
      exists: true,
      size: Number(res.ContentLength || 0),
      contentType: res.ContentType || null,
      etag: res.ETag ? res.ETag.replace(/"/g, "") : null,
    };
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") {
      return { exists: false, size: 0, contentType: null, etag: null };
    }
    throw e;
  }
}

/** Read an object back. Used by the transcode worker and by verification. */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = res.Body as any;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function r2Status(): {
  configured: boolean;
  bucket: string;
  publicUrl: string;
  accountId: string;
} {
  return {
    configured: isR2Configured(),
    bucket: BUCKET,
    publicUrl: PUBLIC_URL,
    // Masked — this is an account identifier, not a secret, but there's no
    // reason to print it in full in an admin response.
    accountId: ACCOUNT_ID ? `${ACCOUNT_ID.slice(0, 6)}…` : "",
  };
}
