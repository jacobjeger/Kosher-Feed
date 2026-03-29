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
