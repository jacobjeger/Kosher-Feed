import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const DEVICE_ID_KEY = "@kosher_podcast_device_id";

let cachedDeviceId: string | null = null;

/**
 * Persist deviceId to Android SharedPreferences so native services
 * (e.g. ShiurPodAutoService for Android Auto) can read it without JS bridge.
 */
async function persistToNativePrefs(deviceId: string) {
  if (Platform.OS !== "android") return;
  try {
    const FileSystem = require("expo-file-system");
    const dir = FileSystem.documentDirectory;
    if (dir) {
      await FileSystem.writeAsStringAsync(dir + "shiurpod_device_id.txt", deviceId);
    }
  } catch {}
}

/**
 * Get a stable Android ID that survives reinstalls.
 * Returns null on non-Android or if unavailable.
 */
async function getAndroidStableId(): Promise<string | null> {
  if (Platform.OS !== "android") return null;
  try {
    const Application = require("expo-application");
    const androidId = Application.getAndroidId?.() || Application.androidId;
    if (androidId && androidId !== "unknown") return androidId;
  } catch {}
  return null;
}

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  // First check AsyncStorage (existing ID)
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);

  if (!id) {
    // On Android, try to use the stable hardware ID that survives reinstalls
    const stableId = await getAndroidStableId();
    if (stableId) {
      // Hash it so we don't store raw hardware IDs
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        stableId
      );
      id = hash.substring(0, 36); // trim to UUID-like length
    } else {
      // Fallback: generate random UUID (iOS, web, or Android fallback)
      id = Crypto.randomUUID();
    }
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }

  cachedDeviceId = id;
  persistToNativePrefs(id).catch(() => {});
  return id;
}
