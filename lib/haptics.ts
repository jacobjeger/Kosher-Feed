import { Platform } from "react-native";

let Haptics: typeof import("expo-haptics") | null = null;

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

export async function lightHaptic() {
  const h = await loadHaptics();
  h?.impactAsync(h.ImpactFeedbackStyle.Light).catch(() => {});
}

export async function mediumHaptic() {
  const h = await loadHaptics();
  h?.impactAsync(h.ImpactFeedbackStyle.Medium).catch(() => {});
}

export function invalidateHapticCache() {
  Haptics = null;
}
