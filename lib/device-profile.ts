import { Platform, Dimensions } from "react-native";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl } from "@/lib/query-client";
import { addLog } from "@/lib/error-logger";

let _profileSynced = false;
let _cachedProfile: Record<string, any> | null = null;

/** Collect device info and return as an object */
export async function getDeviceInfo(): Promise<Record<string, any>> {
  if (_cachedProfile) return _cachedProfile;

  const info: Record<string, any> = {
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    screenWidth: Math.round(Dimensions.get("window").width),
    screenHeight: Math.round(Dimensions.get("window").height),
  };

  // expo-constants for app version
  try {
    const Constants = require("expo-constants").default;
    info.appVersion = Constants.expoConfig?.version || Constants.manifest?.version || null;
  } catch {}

  // expo-device for model/brand
  if (Platform.OS !== "web") {
    try {
      const Device = require("expo-device");
      info.deviceModel = Device.modelName || null;
      info.deviceBrand = Device.brand || null;
    } catch {}
  }

  // expo-localization for locale/timezone
  try {
    const Localization = require("expo-localization");
    info.locale = Localization.locale || null;
    info.timezone = Localization.timezone || null;
  } catch {}

  _cachedProfile = info;
  return info;
}

/** Sync device profile to server (call on app startup) */
export async function syncDeviceProfile(): Promise<void> {
  if (_profileSynced) return;
  _profileSynced = true;

  try {
    const [deviceId, info] = await Promise.all([
      getDeviceId(),
      getDeviceInfo(),
    ]);

    const baseUrl = getApiUrl();
    const res = await fetch(`${baseUrl}/api/device-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, ...info }),
    });

    if (!res.ok) {
      addLog("warn", `Device profile sync failed: HTTP ${res.status}`, undefined, "device-profile");
    }
  } catch (e) {
    addLog("warn", `Device profile sync error: ${(e as any)?.message}`, undefined, "device-profile");
  }
}
