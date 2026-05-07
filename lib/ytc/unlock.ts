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
import { useEffect, useState } from "react";

const UNLOCK_KEY = "@shiurpod_ytc_unlocked";

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
 */
export async function tryUnlock(entered: string, expected: string | null | undefined): Promise<boolean> {
  if (!expected || !entered) return false;
  if (entered.trim() !== expected.trim()) return false;
  await AsyncStorage.setItem(UNLOCK_KEY, "1");
  emit();
  return true;
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
