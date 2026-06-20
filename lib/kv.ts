// Storage wrapper backed by react-native-mmkv.
//
// Drop-in replacement for the AsyncStorage subset we actually use across
// the codebase. Same async API (everything returns Promises) so call
// sites don't change shape, but the underlying read/write is synchronous
// MMKV (mmap + native C++) instead of AsyncStorage's async Java bridge.
//
// On Schok F1 class hardware, AsyncStorage.getItem on a hot path costs
// 100-300ms per call. MMKV.getString is <1ms. We have ~117 AsyncStorage
// call sites across 29 files; the hottest (applySmartRewind, queue
// hydration, push token cache, settings load, downloads list) ran on
// every play / resume / app foreground. The shim makes that disappear
// without a sweeping refactor.
//
// Migration strategy: on first launch after the new APK installs, the
// init() function copies every relevant AsyncStorage key into MMKV and
// sets MMKV_MIGRATED_FLAG. Subsequent launches skip the migration. If a
// regression forces us to roll back, the original AsyncStorage data is
// still there.
//
// Web: MMKV doesn't exist; fall back to AsyncStorage directly. This
// keeps next/expo-router web routes working without an extra branch at
// every call site.
//
// Caveats:
//  - MMKV stores strings/numbers/booleans. We only ever store strings
//    in our codebase (everything is JSON-stringified first), so this
//    matches our existing shape exactly.
//  - getAllKeys / multiRemove / clear are supported for parity with
//    AsyncStorage. We use them sparingly (cache invalidation, sign-out).
//  - SecureStore data (e.g. user credentials) is NOT touched — that
//    stays in expo-secure-store. This shim is for app-state only.

import AsyncStorageRaw from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

const MMKV_MIGRATED_FLAG = "__shiurpod_mmkv_migrated_v1";

// Lazy MMKV instance — created on first access so the native module
// isn't required at module-eval time (keeps web bundles clean).
let _mmkv: any = null;

function getMMKV(): any | null {
  if (Platform.OS === "web") return null;
  if (_mmkv) return _mmkv;
  try {
    const { MMKV } = require("react-native-mmkv");
    _mmkv = new MMKV({ id: "shiurpod-default" });
    return _mmkv;
  } catch (e) {
    // Native module not present (e.g. running in a pre-rebuild OTA
    // session) — fall back to AsyncStorage by returning null.
    return null;
  }
}

let _migrationPromise: Promise<void> | null = null;

/**
 * Idempotent. Copies every AsyncStorage key into MMKV on first launch
 * after the new APK installs. Subsequent calls are no-ops.
 * Safe to call multiple times concurrently — the promise is cached.
 *
 * Returns when the migration is done (or skipped). Call sites that
 * NEED the migrated data should await this; callers that just want
 * to read/write data can ignore it — kv.getItem will block until
 * the migration finishes since it always awaits init() internally.
 */
export async function initKV(): Promise<void> {
  if (_migrationPromise) return _migrationPromise;
  _migrationPromise = (async () => {
    const mmkv = getMMKV();
    if (!mmkv) return; // Web / pre-rebuild — AsyncStorage stays primary

    // Check whether we've already migrated.
    if (mmkv.getBoolean(MMKV_MIGRATED_FLAG)) return;

    try {
      const keys = await AsyncStorageRaw.getAllKeys();
      // Skip the MMKV-internal flag and anything that doesn't look like
      // app state (some libraries write under their own prefixes).
      const ours = keys.filter(
        (k) => k.startsWith("@kosher_") || k.startsWith("@shiurpod_") || k.startsWith("@ytc_") || k.startsWith("EXPO_") || k.startsWith("__")
      );
      if (ours.length === 0) {
        mmkv.set(MMKV_MIGRATED_FLAG, true);
        return;
      }
      const pairs = await AsyncStorageRaw.multiGet(ours);
      let migrated = 0;
      for (const [key, value] of pairs) {
        if (value !== null && value !== undefined) {
          mmkv.set(key, value);
          migrated += 1;
        }
      }
      mmkv.set(MMKV_MIGRATED_FLAG, true);
      // eslint-disable-next-line no-console
      console.log(`[kv] migrated ${migrated} keys from AsyncStorage → MMKV`);
    } catch (e) {
      // If migration fails, leave the flag unset so we'll retry next
      // launch. AsyncStorage stays primary in the meantime (because the
      // getItem fallback below reads from MMKV first, then AsyncStorage).
      // eslint-disable-next-line no-console
      console.warn("[kv] migration failed:", e);
    }
  })();
  return _migrationPromise;
}

export async function getItem(key: string): Promise<string | null> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.getItem(key);
  const v = mmkv.getString(key);
  if (v !== undefined) return v;
  // Fall back to AsyncStorage in case the migration missed something
  // (covers libraries that write after init completed).
  const fallback = await AsyncStorageRaw.getItem(key);
  if (fallback != null) mmkv.set(key, fallback);
  return fallback;
}

export async function setItem(key: string, value: string): Promise<void> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.setItem(key, value);
  mmkv.set(key, value);
  // Mirror to AsyncStorage during the 1-release-cycle transition so a
  // rollback can still find data. Fire-and-forget; failure doesn't break
  // anything since MMKV is the source of truth.
  AsyncStorageRaw.setItem(key, value).catch(() => {});
}

export async function removeItem(key: string): Promise<void> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.removeItem(key);
  mmkv.delete(key);
  AsyncStorageRaw.removeItem(key).catch(() => {});
}

export async function multiGet(keys: readonly string[]): Promise<readonly [string, string | null][]> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.multiGet(keys);
  const result: [string, string | null][] = [];
  for (const k of keys) {
    const v = mmkv.getString(k);
    result.push([k, v !== undefined ? v : null]);
  }
  return result;
}

export async function multiSet(pairs: readonly [string, string][]): Promise<void> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.multiSet(pairs);
  for (const [k, v] of pairs) mmkv.set(k, v);
  AsyncStorageRaw.multiSet(pairs).catch(() => {});
}

export async function multiRemove(keys: readonly string[]): Promise<void> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.multiRemove(keys);
  for (const k of keys) mmkv.delete(k);
  AsyncStorageRaw.multiRemove(keys).catch(() => {});
}

export async function getAllKeys(): Promise<readonly string[]> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.getAllKeys();
  return mmkv.getAllKeys();
}

export async function clear(): Promise<void> {
  await initKV();
  const mmkv = getMMKV();
  if (!mmkv) return AsyncStorageRaw.clear();
  mmkv.clearAll();
  AsyncStorageRaw.clear().catch(() => {});
}

// Convenience default-export shaped like AsyncStorage so call sites can
// do `import KV from "@/lib/kv";` and use `KV.getItem(...)` — exactly
// the existing AsyncStorage call shape, just point at this file.
const KV = { getItem, setItem, removeItem, multiGet, multiSet, multiRemove, getAllKeys, clear };
export default KV;
