import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const SETTINGS_KEY = "@kosher_shiurim_settings";

let cachedEnabled: boolean | null = null;

async function isHapticEnabled(): Promise<boolean> {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const settings = JSON.parse(raw);
      cachedEnabled = settings.hapticFeedbackEnabled ?? false;
      return cachedEnabled;
    }
  } catch {}
  cachedEnabled = false;
  return false;
}

export function invalidateHapticCache() {
  cachedEnabled = null;
}

export async function lightHaptic() {
  if (Platform.OS === "web") return;
  if (!(await isHapticEnabled())) return;
  try {
    const Haptics = require("expo-haptics");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch (e) {}
}

export async function mediumHaptic() {
  if (Platform.OS === "web") return;
  if (!(await isHapticEnabled())) return;
  try {
    const Haptics = require("expo-haptics");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch (e) {}
}
