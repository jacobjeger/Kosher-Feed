// YTC: analytics writers. We POST to the YTC website's track endpoints
// rather than writing Firestore docs directly. The endpoints handle:
//   - Verified userId from Firebase ID token
//   - serverTimestamp on the event doc
//   - playCount / downloadCount FieldValue.increment(1) on shiurim/{id}
// All schema details: reference_ytc_backend memory (file paths under
// app/api/track/* in the YTC website repo).
//
// Failure handling: every call try/catched, logged via addLog, returns
// a Result-shaped object. UI never awaits these — analytics are
// fire-and-forget. A failed write does NOT block playback or
// navigation.
//
// Auth: we send a Firebase ID token as Authorization: Bearer <token>
// when the user is signed in to YTC. The website's track endpoints
// pull userId/userEmail/userName from the verified token, so we don't
// need to send those in the body. (We still send them as a fallback;
// the server prefers the token-derived values.)

import { Platform } from "react-native";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { addLog } from "@/lib/error-logger";
import { getYtcFirebase } from "@/lib/ytc/firebase";

const TRACK_BASE = "https://alumni.ytchaim.com";

// Per the project memory: YTC mini-app is Android-only in practice.
// Hardcode the platform string sent to analytics so reports match the
// backend's `platform: "android"` enum verbatim.
const PLATFORM = "android";

// Build a stable userAgent string at module init. Worst case it's
// undefined on web/dev — addLog will note that, the server stores
// `null` and moves on.
const APP_VERSION =
  (Constants.expoConfig?.version as string | undefined) ??
  ((Constants as any).manifest?.version as string | undefined) ??
  "unknown";
const USER_AGENT =
  Device.modelName
    ? `${Device.manufacturer ?? "Android"} ${Device.modelName} - ${Platform.OS} ${Platform.Version} - app v${APP_VERSION}`
    : `${Platform.OS} ${Platform.Version} - app v${APP_VERSION}`;

type TrackResult = { ok: true } | { ok: false; error: string };

/** In-memory dedupe — once-per-session per shiurId for plays. */
const _playedThisSession = new Set<string>();

/** In-memory dedupe — 30s window per (userId|webPath) for screen views. */
const _viewedAt = new Map<string, number>();
const VIEW_DEDUPE_MS = 30_000;

async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    const { auth } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return {};
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

async function getCurrentUserFields(): Promise<{
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
}> {
  try {
    const { auth } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return { userId: null, userEmail: null, userName: null };
    return {
      userId: user.uid,
      userEmail: user.email ?? null,
      userName: user.displayName ?? null,
    };
  } catch {
    return { userId: null, userEmail: null, userName: null };
  }
}

async function postTrack(path: "play" | "download" | "pageview", body: Record<string, unknown>): Promise<TrackResult> {
  const url = `${TRACK_BASE}/api/track/${path}`;
  let auth: Record<string, string> = {};
  let ids: { userId: string | null; userEmail: string | null; userName: string | null } = { userId: null, userEmail: null, userName: null };
  try {
    auth = await getAuthHeader();
    ids = await getCurrentUserFields();
    const fullBody = {
      userId: ids.userId, userEmail: ids.userEmail, userName: ids.userName,
      platform: PLATFORM,
      userAgent: USER_AGENT,
      ...body,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...auth,
      },
      body: JSON.stringify(fullBody),
    });
    if (!res.ok) {
      // Read the body so we know WHY it failed. console.error lands in
      // logcat under the ReactNativeJS tag in release Hermes builds —
      // diagnosis from `adb logcat | grep ReactNativeJS` works.
      let respText = "";
      try { respText = await res.text(); } catch {}
      // eslint-disable-next-line no-console
      console.error(
        `[ytc-analytics] track ${path} FAILED status=${res.status} body=${respText.slice(0, 300)} ` +
        `auth=${auth.Authorization ? "yes" : "no"} userId=${ids.userId ?? "null"}`,
      );
      addLog("warn", `YTC track ${path} HTTP ${res.status}: ${respText.slice(0, 200)}`, undefined, "ytc-analytics");
      return { ok: false, error: `HTTP ${res.status}` };
    }
    // Success — also log so we can confirm in logcat that calls are
    // landing. Keep terse so it doesn't flood the buffer.
    // eslint-disable-next-line no-console
    console.log(`[ytc-analytics] track ${path} ok auth=${auth.Authorization ? "yes" : "no"} userId=${ids.userId ?? "anon"}`);
    return { ok: true };
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(`[ytc-analytics] track ${path} threw:`, e?.message || e, `url=${url}`);
    addLog("warn", `YTC track ${path} error: ${e?.message || e}`, undefined, "ytc-analytics");
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Strip the `ytc:` prefix that the audio adapter adds to synthetic ids. */
function bareShiurId(idMaybePrefixed: string): string {
  return idMaybePrefixed.startsWith("ytc:") ? idMaybePrefixed.slice(4) : idMaybePrefixed;
}

/**
 * Fire a play-tracking event. Caller passes either the bare shiur id
 * (`abc123`) or the prefixed audio-adapter id (`ytc:abc123`) — we
 * normalize. Once-per-session per shiur. Never throws.
 */
export async function trackShiurPlay(shiurIdMaybePrefixed: string): Promise<TrackResult> {
  const shiurId = bareShiurId(shiurIdMaybePrefixed);
  if (_playedThisSession.has(shiurId)) return { ok: true };
  _playedThisSession.add(shiurId);
  return postTrack("play", { shiurId });
}

/**
 * Fire a download-tracking event when a download is INITIATED (not
 * completed). No dedupe — DownloadsContext already prevents
 * duplicate enqueue. Never throws.
 */
export async function trackShiurDownload(shiurIdMaybePrefixed: string): Promise<TrackResult> {
  const shiurId = bareShiurId(shiurIdMaybePrefixed);
  return postTrack("download", { shiurId });
}

/**
 * Fire a screen-view event. Caller passes web-style path
 * ("/", "/shiurim", "/contacts", etc.). Dedupes per
 * (userId|path) within a 30s window so re-renders / quick
 * back-navigation don't spam writes. Never throws.
 */
export async function trackScreenView(path: string, referrer?: string | null): Promise<TrackResult> {
  const { userId } = await getCurrentUserFields();
  const key = `${userId ?? "anon"}|${path}`;
  const now = Date.now();
  const last = _viewedAt.get(key);
  if (last && now - last < VIEW_DEDUPE_MS) return { ok: true };
  _viewedAt.set(key, now);
  return postTrack("pageview", { path, referrer: referrer ?? null });
}

/** Reset session-state dedupes. Call from lock() / sign-out. */
export function resetYtcAnalyticsSession(): void {
  _playedThisSession.clear();
  _viewedAt.clear();
}

/** Diagnostic: forces a pageview write to /diagnostic-ping with a known
 *  shape, returns the full result + status. Useful for ruling out
 *  network/auth issues from the device — call it from a screen mount
 *  or via DevTools and watch logcat. Doesn't dedupe. */
export async function pingYtcAnalytics(): Promise<TrackResult & { url: string }> {
  const url = `${TRACK_BASE}/api/track/pageview`;
  // eslint-disable-next-line no-console
  console.log(`[ytc-analytics] PING -> ${url}`);
  const result = await postTrack("pageview", { path: "/diagnostic-ping", referrer: null });
  // eslint-disable-next-line no-console
  console.log(`[ytc-analytics] PING result:`, JSON.stringify(result));
  return { ...result, url };
}
