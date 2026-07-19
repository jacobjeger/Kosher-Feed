import { Platform } from "react-native";

/**
 * OTA update checker for EAS Updates.
 * Checks for available updates on app launch, downloads silently, and applies on next restart.
 *
 * NOTE: One fresh `eas build` is required before OTA updates will work on existing installs.
 * The build must include expo-updates and the runtime version config.
 */
export async function checkForUpdate() {
  // expo-updates only works in standalone builds, not in dev client or web
  if (__DEV__ || Platform.OS === "web") {
    if (__DEV__) console.log("[Updates] Skipping update check in dev mode");
    return;
  }

  try {
    const Updates = await import("expo-updates");

    console.log("[Updates] Checking for available update...");
    const check = await Updates.checkForUpdateAsync();

    if (!check.isAvailable) {
      console.log("[Updates] App is up to date");
      return;
    }

    console.log("[Updates] Update available, downloading...");
    const result = await Updates.fetchUpdateAsync();
    console.log("[Updates] Update downloaded:", result.isNew ? "new" : "cached");

    // The update will be applied on next app restart.
    // We don't force-restart — let the user naturally close/reopen the app.
  } catch (e: any) {
    // Non-fatal — don't crash the app if update check fails
    console.log("[Updates] Update check failed:", e.message);
  }
}

/**
 * First-launch OTA gate. On a fresh install the embedded (build-time)
 * bundle runs first and — with fallbackToCacheTimeout:0 — the latest OTA
 * would only apply on the SECOND launch, leaving a first-time user's first
 * real use on the stale build. This checks + fetches the latest update and
 * reloads into it (behind the splash) so the first use is on the current
 * bundle.
 *
 * Bounded by `timeoutMs`: on slow/no network we give up and let the app
 * launch on the embedded bundle (the update then applies next launch — the
 * pre-existing behavior), so a bad connection never hangs the splash.
 *
 * Returns true if it kicked off a reload (the caller should stop further
 * startup work — the app is about to restart). The caller MUST persist its
 * "first launch handled" flag BEFORE calling this so a reload can't loop
 * back into the gate.
 */
export async function applyFirstLaunchUpdate(timeoutMs = 10000): Promise<boolean> {
  if (__DEV__ || Platform.OS === "web") return false;
  try {
    const Updates = await import("expo-updates");
    if (!Updates.isEnabled) return false;

    const withTimeout = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);

    const check = await withTimeout(Updates.checkForUpdateAsync());
    if (!check.isAvailable) return false;

    console.log("[Updates] First-launch: update available, fetching before first use");
    await withTimeout(Updates.fetchUpdateAsync());
    await Updates.reloadAsync();
    return true;
  } catch (e: any) {
    // Fall through to launch on the embedded bundle; the normal deferred
    // checkForUpdate() still downloads it for the next launch.
    console.log("[Updates] First-launch update skipped:", e?.message);
    return false;
  }
}
