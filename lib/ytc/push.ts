// YTC: FCM topic subscription manager. Mirrors the website's send-side
// conventions verbatim:
//
//   Topics:
//     all_users (always on, no toggle)
//     announcements / new_shiurim / simchas / events
//     rebbe_<sanitize(name)>   per-rebbe channel
//     platform_android         auto, used in FCM `condition` filters
//
//   Sanitize regex (must match website verbatim):
//     /[^a-z0-9]/g  applied to lowercased name
//
// Configuration gate: react-native-firebase routes
// messaging().subscribeToTopic() through whichever Firebase project the
// build's google-services.json points at. ShiurPod's existing
// google-services.json is for the `shiurpod` project, NOT YTC's
// `toras-chaim-shiurim`. Without a correct google-services.json
// containing an Android app entry for `com.shiurpod.app` registered
// with toras-chaim-shiurim, our subscribe calls would publish to the
// WRONG project's topic namespace. We guard against this at runtime by
// checking the messaging app's projectId; if it doesn't match, all
// subscribe/unsubscribe calls become no-ops and the UI shows "push
// pending Firebase config from YTC dev."
//
// To enable push in production:
//   1. YTC dev registers ShiurPod (com.shiurpod.app, prod keystore SHA-1)
//      in the toras-chaim-shiurim Firebase project's Android app entry.
//   2. They send back a google-services.json that contains BOTH apps.
//   3. We replace android/app/google-services.json + the project root one.
//   4. New APK build picks up the right config; isYtcPushConfigured()
//      flips true; subscribe calls actually land.

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { addLog } from "@/lib/error-logger";
import { isReactNativeFirebaseAvailable } from "@/lib/ytc/push-availability";

// Lazy require so the bundle doesn't barf if the native module isn't
// linked (e.g., on web or during a bad build). All call sites
// fault-tolerantly skip on import failure.
type FBMessagingMod = typeof import("@react-native-firebase/messaging");
let _messagingMod: FBMessagingMod | null = null;
async function getMessaging() {
  if (_messagingMod) return _messagingMod;
  // Hard gate: don't even attempt require() when the native side isn't
  // there. require() loads the package's JS which may cause side-effect
  // throws despite our try/catch (top-level NativeEventEmitter setup,
  // async unhandled rejections, etc). The native-module check is
  // synchronous and safe.
  if (!isReactNativeFirebaseAvailable()) return null;
  try {
    _messagingMod = require("@react-native-firebase/messaging");
    return _messagingMod;
  } catch (e: any) {
    addLog("warn", `RN Firebase messaging unavailable: ${e?.message || e}`, undefined, "ytc-push");
    return null;
  }
}

// react-native-firebase v22 migrated from the namespaced
// `messaging().subscribeToTopic(t)` to the Firebase Web modular API
// `subscribeToTopic(getMessaging(), t)`. The old form still works but
// logs a deprecation warning every call. This helper resolves the
// modular bag once per call (cheap — just property reads), and falls
// back to the namespaced shim if the package version doesn't yet
// export the modular helpers.
async function getModular() {
  const mod = await getMessaging();
  if (!mod) return null;
  const m: any = mod;
  const def: any = m.default ?? m;
  // Modular exports — present on v22+.
  const getMessagingFn = m.getMessaging ?? def.getMessaging;
  const subscribeToTopic = m.subscribeToTopic ?? def.subscribeToTopic;
  const unsubscribeFromTopic = m.unsubscribeFromTopic ?? def.unsubscribeFromTopic;
  const requestPermission = m.requestPermission ?? def.requestPermission;
  // Namespaced fallback — call as `def()` to get the messaging instance
  // and use its methods. Used when modular helpers aren't found.
  if (getMessagingFn && subscribeToTopic && unsubscribeFromTopic && requestPermission) {
    let instance: any = null;
    try { instance = getMessagingFn(); } catch {}
    return {
      modular: true as const,
      instance,
      subscribeToTopic,
      unsubscribeFromTopic,
      requestPermission,
      // App reference used by isYtcPushConfigured to read projectId.
      app: instance?.app ?? null,
    };
  }
  // Last-resort namespaced API.
  let instance: any = null;
  try { instance = def(); } catch {}
  return {
    modular: false as const,
    instance,
    subscribeToTopic: (_inst: any, t: string) => instance.subscribeToTopic(t),
    unsubscribeFromTopic: (_inst: any, t: string) => instance.unsubscribeFromTopic(t),
    requestPermission: (_inst: any) => instance.requestPermission(),
    app: instance?.app ?? null,
  };
}

const YTC_PROJECT_ID = "toras-chaim-shiurim";

// Master kill-switch — true ONLY for builds where we know
// google-services.json + react-native-firebase native are wired up.
//
// We resolve this from a build-time env var so it can be true for
// EAS Build (preview/production profiles set EXPO_PUBLIC_YTC_PUSH=1
// in their env block) and false for EAS Update OTAs (the env var
// isn't set when running `eas update`, so the bundled code reads
// undefined → false). This keeps the existing OTA channel safe to
// push to users who are still on an old APK without the native
// module / wrong-project google-services.json — they'd otherwise
// see a notification UI that does nothing.
//
// EXPO_PUBLIC_* env vars are statically inlined into the JS bundle
// by Metro at bundle time, so this constant compiles down to
// `const YTC_PUSH_FEATURE_ENABLED = false;` in OTA bundles.
export const YTC_PUSH_FEATURE_ENABLED = process.env.EXPO_PUBLIC_YTC_PUSH === "1";

const DEFAULT_TOPICS = ["announcements", "new_shiurim", "simchas", "events"] as const;
export type DefaultTopic = (typeof DEFAULT_TOPICS)[number];

const PREFS_KEY = "@ytc_push_prefs:v1";
const REBBE_KEY = "@ytc_push_rebbeim:v1";
const INIT_FLAG_KEY = "@ytc_push_did_initial_subscribe:v1";

interface MasterPrefs {
  announcements: boolean;
  new_shiurim: boolean;
  simchas: boolean;
  events: boolean;
}
const PREFS_DEFAULTS: MasterPrefs = {
  announcements: true, new_shiurim: true, simchas: true, events: true,
};

export function sanitizeRebbeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

export function rebbeTopic(name: string): string {
  return `rebbe_${sanitizeRebbeName(name)}`;
}

/** Check whether the build's Firebase config is the YTC project. False
 *  means we'd subscribe to wrong-project topics — caller must skip. */
export async function isYtcPushConfigured(): Promise<boolean> {
  if (!YTC_PUSH_FEATURE_ENABLED) return false;
  if (Platform.OS !== "android") return false;
  const m = await getModular();
  if (!m) return false;
  try {
    const projectId = m.app?.options?.projectId;
    return projectId === YTC_PROJECT_ID;
  } catch (e: any) {
    addLog("warn", `isYtcPushConfigured check failed: ${e?.message || e}`, undefined, "ytc-push");
    return false;
  }
}

async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= max; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (attempt >= max) break;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastErr;
}

async function rawSubscribe(topic: string): Promise<void> {
  const m = await getModular();
  if (!m) return;
  await withRetry(() => m.subscribeToTopic(m.instance, topic));
  addLog("info", `YTC push: subscribed to ${topic}`, undefined, "ytc-push");
}

async function rawUnsubscribe(topic: string): Promise<void> {
  const m = await getModular();
  if (!m) return;
  await withRetry(() => m.unsubscribeFromTopic(m.instance, topic));
  addLog("info", `YTC push: unsubscribed from ${topic}`, undefined, "ytc-push");
}

async function safeSubscribe(topic: string): Promise<void> {
  if (!(await isYtcPushConfigured())) return;
  try { await rawSubscribe(topic); }
  catch (e: any) { addLog("warn", `YTC push subscribe ${topic} failed: ${e?.message || e}`, undefined, "ytc-push"); }
}

async function safeUnsubscribe(topic: string): Promise<void> {
  if (!(await isYtcPushConfigured())) return;
  try { await rawUnsubscribe(topic); }
  catch (e: any) { addLog("warn", `YTC push unsubscribe ${topic} failed: ${e?.message || e}`, undefined, "ytc-push"); }
}

// ─── Master toggles ─────────────────────────────────────────────────────────

export async function getMasterPrefs(): Promise<MasterPrefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (!raw) return { ...PREFS_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<MasterPrefs>;
    return { ...PREFS_DEFAULTS, ...parsed };
  } catch { return { ...PREFS_DEFAULTS }; }
}

export async function setMasterPref(topic: DefaultTopic, enabled: boolean): Promise<void> {
  const cur = await getMasterPrefs();
  const next = { ...cur, [topic]: enabled };
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next));
  if (enabled) await safeSubscribe(topic);
  else await safeUnsubscribe(topic);
}

// ─── Per-rebbe toggles ──────────────────────────────────────────────────────

export async function getSubscribedRebbeim(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(REBBE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

async function persistSubscribedRebbeim(arr: string[]): Promise<void> {
  try { await AsyncStorage.setItem(REBBE_KEY, JSON.stringify(arr)); } catch {}
}

export async function isRebbeSubscribed(name: string): Promise<boolean> {
  const arr = await getSubscribedRebbeim();
  return arr.includes(rebbeTopic(name));
}

export async function subscribeToRebbe(name: string): Promise<void> {
  const t = rebbeTopic(name);
  const arr = await getSubscribedRebbeim();
  if (arr.includes(t)) return;
  await safeSubscribe(t);
  await persistSubscribedRebbeim([...arr, t]);
}

export async function unsubscribeFromRebbe(name: string): Promise<void> {
  const t = rebbeTopic(name);
  const arr = await getSubscribedRebbeim();
  if (!arr.includes(t)) return;
  await safeUnsubscribe(t);
  await persistSubscribedRebbeim(arr.filter((x) => x !== t));
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/** Subscribe to the default topic set on first YTC unlock. Idempotent
 *  via the AsyncStorage flag, so repeat unlocks don't re-subscribe.
 *  Reapplies the user's saved rebbe choices. Also subscribes to
 *  platform_android (no UI toggle — it's a delivery filter). */
export async function bootstrapYtcPush(): Promise<void> {
  if (Platform.OS !== "android") return;
  if (!(await isYtcPushConfigured())) return;

  const did = await AsyncStorage.getItem(INIT_FLAG_KEY);
  if (!did) {
    await safeSubscribe("all_users");
    await safeSubscribe("platform_android");
    const prefs = await getMasterPrefs();
    if (prefs.announcements) await safeSubscribe("announcements");
    if (prefs.new_shiurim) await safeSubscribe("new_shiurim");
    if (prefs.simchas) await safeSubscribe("simchas");
    if (prefs.events) await safeSubscribe("events");
    try { await AsyncStorage.setItem(INIT_FLAG_KEY, "1"); } catch {}
  } else {
    // Already initialized — just refresh per-rebbe topics in case they
    // were cleared by an FCM token refresh on the server side.
    const arr = await getSubscribedRebbeim();
    for (const t of arr) {
      try { await rawSubscribe(t); } catch {}
    }
  }
}

/** Clear all subscriptions on YTC lock / sign-out. Best-effort — drops
 *  the local prefs cache too so a future re-unlock starts fresh. */
export async function teardownYtcPush(): Promise<void> {
  if (Platform.OS !== "android") return;
  if (!(await isYtcPushConfigured())) {
    // Still wipe local state so a future re-unlock starts fresh.
    try { await AsyncStorage.multiRemove([PREFS_KEY, REBBE_KEY, INIT_FLAG_KEY]); } catch {}
    return;
  }
  try {
    await safeUnsubscribe("all_users");
    await safeUnsubscribe("platform_android");
    for (const t of DEFAULT_TOPICS) await safeUnsubscribe(t);
    const arr = await getSubscribedRebbeim();
    for (const t of arr) await safeUnsubscribe(t);
  } catch {}
  try { await AsyncStorage.multiRemove([PREFS_KEY, REBBE_KEY, INIT_FLAG_KEY]); } catch {}
}

// ─── Permission ─────────────────────────────────────────────────────────────

export async function requestNotificationPermission(): Promise<"granted" | "denied" | "unknown"> {
  if (Platform.OS !== "android") return "unknown";
  const m = await getModular();
  if (!m) return "unknown";
  try {
    const status = await m.requestPermission(m.instance);
    if (status === 1 /* AUTHORIZED */ || status === 2 /* PROVISIONAL */) return "granted";
    return "denied";
  } catch { return "unknown"; }
}
