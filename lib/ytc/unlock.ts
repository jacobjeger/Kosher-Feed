// YTC: persistent "this device has unlocked YTC" flag + helpers.
//
// Admin-managed: the canonical unlock code is stored server-side in the
// app_config table and returned by /api/config as `ytcUnlockCode`. The
// caller passes the user's input AND the current server code to
// tryUnlock(); we don't store the code on disk. There is NO fallback —
// if the server returns null/empty, no code can ever be valid.
//
// Quarantine: this module imports nothing from Firebase or any other
// YTC code. It's safe to evaluate from the regular settings screen
// without dragging the YTC bundle into cold start. The Firebase signOut
// inside lock() uses dynamic import so that module load only happens
// when the user actually locks (after a YTC session existed).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { getDeviceId } from "@/lib/device-id";

const UNLOCK_KEY = "@shiurpod_ytc_unlocked";

// ShiurPod's own backend URL — distinct from YTC's
// alumni.ytchaim.com. The unlock event is reported HERE (not to YTC)
// because the ShiurPod admin dashboard is what surfaces "how many
// users have unlocked YTC?" to me / the team.
const SHIURPOD_BASE = process.env.EXPO_PUBLIC_API_URL || "https://shiurpod.com";

const APP_VERSION =
  (Constants.expoConfig?.version as string | undefined) ??
  ((Constants as any).manifest?.version as string | undefined) ??
  "unknown";

/** POST a one-shot YTC-unlock event to ShiurPod's backend. Fire-and-
 *  forget — never await; the unlock UX never blocks on this.
 *
 *  IMPORTANT: uses the canonical ShiurPod deviceId
 *  (lib/device-id.getDeviceId — AsyncStorage key
 *  `@kosher_podcast_device_id`, hardware-stable on Android via
 *  Application.androidId hash, Keychain-backed on iOS). That's the
 *  same id every other ShiurPod analytics path writes (device_profiles,
 *  episode_listens, subscriptions, etc), so the admin dashboard can
 *  JOIN ytc_unlocks → device_profiles to render device model, OS
 *  version, locale, country, etc — and tell whether the device was
 *  a brand-new ShiurPod install or an existing user. */
function reportUnlockToShiurpod(): void {
  (async () => {
    try {
      const deviceId = await getDeviceId();
      await fetch(`${SHIURPOD_BASE}/api/track/ytc-unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          platform: Platform.OS,
          appVersion: APP_VERSION,
        }),
      }).catch(() => {});
    } catch {}
  })();
}

// In-memory pub-sub so the settings UI / tab bar can react to lock /
// unlock without an app reload. Light-weight; no React context needed.
type Listener = () => void;
const listeners = new Set<Listener>();
function emit() { listeners.forEach((fn) => { try { fn(); } catch {} }); }
export function onUnlockChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export async function isUnlocked(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(UNLOCK_KEY)) === "1";
  } catch {
    return false;
  }
}

/**
 * Validate the entered code against the server-supplied expected value
 * (from useRemoteConfig().config.ytcUnlockCode). Both are trimmed and
 * compared case-sensitively. Empty/null expected → always rejects (the
 * feature is disabled by the admin).
 *
 * Side effect: as soon as the unlock succeeds we kick off YTC's public
 * Firestore reads (carousel, announcements, events, featured/recent
 * shiurim, collections, alumni photos, rebbeim, full shiurim list).
 * They flow through the cache layer in lib/ytc/firebase.ts so when
 * the user navigates into /ytc after sign-in the screens hit
 * cache instantly — no perceptible Firestore wait. This is the user's
 * own suggested optimization: pre-warm the moment they enter the
 * access code, not after they've already drilled in.
 *
 * The pre-warm runs in the background (Promise not awaited). Failures
 * are silent — sign-in still works, screens just hit a cold cache.
 */
export async function tryUnlock(entered: string, expected: string | null | undefined): Promise<boolean> {
  if (!expected || !entered) return false;
  if (entered.trim() !== expected.trim()) return false;
  await AsyncStorage.setItem(UNLOCK_KEY, "1");
  emit();
  prewarmYtcDataIfPossible();
  // Fire-and-forget admin-dashboard tracking. See helper comment.
  reportUnlockToShiurpod();
  return true;
}

/** Kick off YTC's CRITICAL public-collection fetchers so the cache is
 *  warm by the time the user opens /ytc. Re-callable; cache layer
 *  dedupes duplicates.
 *
 *  fetchShiurim() was removed from this fan-out (2026-06-18). On Schok F1
 *  hardware it was the single dominant cause of "app feels frozen after
 *  splash hides" — 800+ Firestore docs → JSON.parse from disk cache or
 *  JSON.stringify+AsyncStorage.setItem on refresh, all synchronous on
 *  the JS thread. The 3 remaining fetches are each ≤20 docs and finish
 *  in <100ms even on slow CPUs. The Shiurim tab triggers its own
 *  fetchShiurim() on mount and renders a skeleton while it loads, so
 *  the user-visible cost is moved from cold-start (always paid) to the
 *  first time they enter the Shiurim tab (often skipped entirely). */
export function prewarmYtcDataIfPossible(): void {
  (async () => {
    try {
      const f = await import("@/lib/ytc/firebase");
      await Promise.all([
        f.fetchCarouselImages(),    // home hero backdrop
        f.fetchAnnouncements(),     // home top section
        f.fetchMostRecentShiur(),   // home + CTA target
      ]);
    } catch {}
  })();
}

/**
 * Clear the unlock flag and sign the user out of Firebase if a session
 * exists. Lazy-imports the Firebase service so this module stays free
 * of Firebase references for non-YTC users.
 */
export async function lock(): Promise<void> {
  await AsyncStorage.removeItem(UNLOCK_KEY);
  try {
    // Lazy import keeps lib/ytc/firebase.ts (and the entire Firebase JS
    // SDK it transitively pulls in) out of the cold-start bundle. This
    // module only loads when the user actually locks an existing session.
    const { firebaseSignOutIfInitialized, invalidateYtcCache } = await import("@/lib/ytc/firebase");
    await firebaseSignOutIfInitialized();
    await invalidateYtcCache();
    // Drop in-session analytics dedupe state so a future re-unlock starts fresh.
    const { resetYtcAnalyticsSession } = await import("@/lib/ytc/analytics");
    resetYtcAnalyticsSession();
    // Tear down YTC topic subscriptions so a locked device stops
    // receiving YTC pushes.
    const { teardownYtcPush } = await import("@/lib/ytc/push");
    await teardownYtcPush();
  } catch {}
  emit();
}

/**
 * Reactive hook for any UI surface that needs to know whether YTC is
 * unlocked on this device (settings screen, tab bar). Re-renders when
 * tryUnlock / lock fire.
 */
export function useYtcUnlocked(): boolean {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    let mounted = true;
    isUnlocked().then((v) => { if (mounted) setUnlocked(v); });
    const off = onUnlockChanged(() => {
      isUnlocked().then((v) => { if (mounted) setUnlocked(v); });
    });
    return () => { mounted = false; off(); };
  }, []);
  return unlocked;
}
