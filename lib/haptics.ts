import { Platform } from "react-native";

let Haptics: typeof import("expo-haptics") | null = null;
let _hapticEnabled: boolean | null = null;

async function loadHaptics() {
  if (Platform.OS === "web") return null;
  if (!Haptics) {
    try {
      Haptics = await import("expo-haptics");
    } catch {
      Haptics = null;
    }
  }
  return Haptics;
}

async function isHapticEnabled(): Promise<boolean> {
  if (_hapticEnabled !== null) return _hapticEnabled;
  try {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const raw = await AsyncStorage.getItem("@kosher_shiurim_settings");
    if (raw) {
      const settings = JSON.parse(raw);
      _hapticEnabled = settings.hapticFeedback === true;
    } else {
      _hapticEnabled = false;
    }
  } catch {
    _hapticEnabled = false;
  }
  return _hapticEnabled;
}

export async function lightHaptic() {
  if (!(await isHapticEnabled())) return;
  const h = await loadHaptics();
  h?.impactAsync(h.ImpactFeedbackStyle.Light).catch(() => {});
}

export async function mediumHaptic() {
  if (!(await isHapticEnabled())) return;
  const h = await loadHaptics();
  h?.impactAsync(h.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Call when haptic setting changes to refresh the cached value */
export function invalidateHapticCache() {
  _hapticEnabled = null;
  Haptics = null;
}
