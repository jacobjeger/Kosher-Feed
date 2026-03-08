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

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  cachedDeviceId = id;
  persistToNativePrefs(id).catch(() => {});
  return id;
}
