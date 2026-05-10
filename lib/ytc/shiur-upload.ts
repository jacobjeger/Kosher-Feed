// YTC: shiur upload domain logic.
//
// Mirrors the website's app/upload-shiur/page.tsx flow + lib/b2-upload.ts:
//   1. Ask the website for a presigned B2 PUT URL (one round-trip, GET).
//   2. PUT the local file body directly to B2 via S3-compatible API.
//      Bypasses Vercel's 4.5MB body limit, which would clip every audio.
//   3. If B2 isn't configured (server returns 503 with useFirebase:true),
//      fall back to Firebase Storage at the same path. Mirrors
//      uploadToB2's fallback in github.com/abbrach1/YTC-ALUMNI-MAIN-WEBSITE.
//
// After files are uploaded, submitShiur writes a `shiurim` doc with the
// canonical website shape and fire-and-forget POSTs /api/notify-new-shiur
// so subscribers get emailed.
import { getYtcFirebase } from "@/lib/ytc/firebase";

// Use the legacy module — uploadAsync / createUploadTask were not ported
// to the v19 top-level API yet. Top-level deprecated functions throw at
// runtime in SDK 54, so the explicit /legacy import is intentional.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FileSystem = require("expo-file-system/legacy");

const YTC_API_BASE = "https://alumni.ytchaim.com";

export type ShiurFileKind = "audio" | "pdf";

interface PresignResponse {
  uploadUrl: string;
  downloadUrl: string;
  contentType: string;
  fileName: string;
}

/**
 * Upload a local file (audio or PDF) for a shiur and return its public URL.
 * Tries B2 via the website's presigned-URL endpoint first; falls back to
 * Firebase Storage if B2 isn't configured.
 */
export async function uploadShiurFile(
  localUri: string,
  fileName: string,
  mime: string,
  kind: ShiurFileKind,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const folder = kind === "audio" ? "shiurim/audio" : "shiurim/pdf";

  // 1. Ask the website for a presigned URL.
  let presign: PresignResponse | null = null;
  let useFirebase = false;
  try {
    const params = new URLSearchParams({
      fileName,
      contentType: mime,
      folder,
    });
    const res = await fetch(`${YTC_API_BASE}/api/upload-b2?${params.toString()}`);
    if (res.status === 503) {
      useFirebase = true;
    } else if (!res.ok) {
      throw new Error(`presign failed: HTTP ${res.status}`);
    } else {
      presign = (await res.json()) as PresignResponse;
    }
  } catch (e) {
    // Network error reaching the presign endpoint. Try Firebase as last resort.
    console.warn("YTC upload-b2 presign failed; falling back to Firebase:", e);
    useFirebase = true;
  }

  if (presign && !useFirebase) {
    // 2. Upload directly to B2 via PUT to the presigned S3 URL.
    try {
      await putFileBinary(presign.uploadUrl, localUri, presign.contentType, onProgress);
      onProgress?.(100);
      return presign.downloadUrl;
    } catch (e) {
      console.warn("YTC B2 PUT failed; falling back to Firebase:", e);
      // fall through
    }
  }

  // 3. Firebase Storage fallback.
  return uploadToFirebase(localUri, fileName, folder, onProgress);
}

/**
 * Streaming PUT of a local file to a presigned URL using
 * expo-file-system's createUploadTask, which gives us byte-level progress.
 */
async function putFileBinary(
  uploadUrl: string,
  localUri: string,
  contentType: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const task = FileSystem.createUploadTask(
    uploadUrl,
    localUri,
    {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": contentType },
    },
    (data: { totalBytesSent: number; totalBytesExpectedToSend: number }) => {
      if (onProgress && data.totalBytesExpectedToSend > 0) {
        const pct = Math.min(99, Math.round(
          (data.totalBytesSent / data.totalBytesExpectedToSend) * 100,
        ));
        onProgress(pct);
      }
    },
  );
  const result = await task.uploadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    throw new Error(`B2 PUT failed: HTTP ${result?.status ?? "?"}`);
  }
}

async function uploadToFirebase(
  localUri: string,
  fileName: string,
  folder: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const { app } = await getYtcFirebase();
  const { getStorage, ref, uploadBytesResumable, getDownloadURL } = await import(
    "firebase/storage"
  );
  const storage = getStorage(app);
  // RN's fetch() resolves a local file: URI into a Blob the SDK uploads —
  // same pattern as lib/ytc/firebase.ts:uploadSimchaImage.
  const res = await fetch(localUri);
  const blob = await res.blob();
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${folder}/${Date.now()}-${safe}`;
  const r = ref(storage, path);
  const task = uploadBytesResumable(r, blob);
  return new Promise<string>((resolve, reject) => {
    task.on(
      "state_changed",
      (snap) => {
        if (onProgress && snap.totalBytes > 0) {
          onProgress(Math.min(99, Math.round((snap.bytesTransferred / snap.totalBytes) * 100)));
        }
      },
      (err) => reject(err),
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          onProgress?.(100);
          resolve(url);
        } catch (e) { reject(e); }
      },
    );
  });
}

export interface SubmitShiurInput {
  title: string;
  rebbe: string;
  date: string; // YYYY-MM-DD
  tags: string[];
  description: string;
  series: string | null;
  audioUrl: string | null;
  pdfUrl: string | null;
  uploadedBy: string; // user.email
  uploaderName: string;
}

/**
 * Write the shiur doc and notify subscribers. Returns the new doc id.
 *
 * Doc shape matches the website (app/upload-shiur/page.tsx) so admin tools
 * and the email-notification renderer don't need branching for app vs web
 * uploads.
 */
export async function submitShiur(input: SubmitShiurInput): Promise<string> {
  const { db } = await getYtcFirebase();
  const { collection, addDoc } = await import("firebase/firestore");
  const docRef = await addDoc(collection(db, "shiurim"), {
    title: input.title,
    rebbe: input.rebbe,
    date: input.date,
    tags: input.tags,
    description: input.description,
    series: input.series,
    audioUrl: input.audioUrl,
    pdfUrl: input.pdfUrl,
    uploadedBy: input.uploadedBy,
    uploaderName: input.uploaderName,
    uploadedAt: new Date().toISOString(),
  });

  // Fire-and-forget. The user's upload succeeded regardless of whether
  // the email goes out, so swallow errors.
  fetch(`${YTC_API_BASE}/api/notify-new-shiur`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shiurId: docRef.id,
      title: input.title,
      rebbe: input.rebbe,
      date: input.date,
      tags: input.tags,
      description: input.description,
      audioUrl: input.audioUrl,
      pdfUrl: input.pdfUrl,
    }),
  }).catch((e) => {
    console.warn("YTC notify-new-shiur failed (non-fatal):", e);
  });

  return docRef.id;
}
