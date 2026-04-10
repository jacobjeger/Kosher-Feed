import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const DEVICE_ID_KEY = "@kosher_podcast_device_id";
const SECURE_DEVICE_ID_KEY = "shiurpod_device_id";

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

/**
 * iOS: Read/write device ID from Keychain via SecureStore.
 * Keychain entries persist across app reinstalls.
 */
async function getSecureStoreId(): Promise<string | null> {
  if (Platform.OS !== "ios") return null;
  try {
    const SecureStore = require("expo-secure-store");
    return await SecureStore.getItemAsync(SECURE_DEVICE_ID_KEY);
  } catch {}
  return null;
}

async function setSecureStoreId(id: string): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const SecureStore = require("expo-secure-store");
    await SecureStore.setItemAsync(SECURE_DEVICE_ID_KEY, id);
  } catch {}
}

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  // Check AsyncStorage first (existing ID from previous sessions)
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);

  if (!id) {
    // iOS: Check Keychain (survives reinstalls)
    if (Platform.OS === "ios") {
      id = await getSecureStoreId();
    }

    // Android: Use stable hardware ID (survives reinstalls)
    if (!id && Platform.OS === "android") {
      const stableId = await getAndroidStableId();
      if (stableId) {
        const hash = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          stableId
        );
        id = hash.substring(0, 36);
      }
    }

    // Fallback: generate random UUID
    if (!id) {
      id = Crypto.randomUUID();
    }

    await AsyncStorage.setItem(DEVICE_ID_KEY, id);

    // Persist to Keychain on iOS so it survives reinstalls (only on first generation)
    if (Platform.OS === "ios") {
      setSecureStoreId(id).catch(() => {});
    }
  }

  cachedDeviceId = id;
  persistToNativePrefs(id).catch(() => {});
  return id;
}
