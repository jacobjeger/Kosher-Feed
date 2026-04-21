import { Platform } from "react-native";

// Pre-import so we don't pay a dynamic import() round-trip every time the
// user taps a button. On web the module is not available; fall through.
let Haptics: typeof import("expo-haptics") | null = null;
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Haptics = require("expo-haptics");
  } catch {
    Haptics = null;
  }
}

// Synchronous cached flag. Populated from AsyncStorage at boot via
// primeHapticSetting() and kept in sync by setHapticEnabled() whenever
// the user toggles the setting. This avoids an AsyncStorage round-trip
// on every tap — critical for perceived haptic responsiveness.
let _hapticEnabled = false;
let _primed = false;

export function setHapticEnabled(v: boolean) {
  _hapticEnabled = v;
  _primed = true;
}

export async function primeHapticSetting() {
  if (_primed) return;
  try {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const raw = await AsyncStorage.getItem("@kosher_shiurim_settings");
    if (raw) {
      const settings = JSON.parse(raw);
      _hapticEnabled = settings.hapticFeedback === true;
    }
  } catch {}
  _primed = true;
}

// Kick off priming immediately on module load so the first tap after app
// start is likely to have the correct setting.
primeHapticSetting();

export function lightHaptic() {
  if (!_hapticEnabled || !Haptics) return;
  try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {}
}

export function mediumHaptic() {
  if (!_hapticEnabled || !Haptics) return;
  try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
}

/**
 * @deprecated — replaced by setHapticEnabled()/primeHapticSetting().
 * Kept as a no-op for backwards compatibility with existing callers.
 */
export function invalidateHapticCache() {
  _primed = false;
  primeHapticSetting();
}
