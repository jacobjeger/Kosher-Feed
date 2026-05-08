// YTC: copy-to-clipboard helper with a graceful fallback for builds
// that don't have expo-clipboard's native module linked yet (OTA
// users on older APKs). Tries expo-clipboard's setStringAsync first;
// if that throws — most likely because the native module isn't
// registered — falls back to React Native's Share API which exposes
// a "Copy" option in the system sheet on every supported platform.

import { Share, ToastAndroid, Platform, Alert } from "react-native";

let clipboardMod: typeof import("expo-clipboard") | null = null;
try { clipboardMod = require("expo-clipboard"); } catch { /* native not linked */ }

/** Toast confirmation. Android: native toast. iOS: small Alert. */
function flashCopiedToast(label: string): void {
  const msg = `${label} copied`;
  if (Platform.OS === "android") {
    try { ToastAndroid.show(msg, ToastAndroid.SHORT); return; } catch {}
  }
  Alert.alert(msg);
}

export async function copyToClipboard(value: string, labelForToast: string): Promise<void> {
  if (!value) return;
  if (clipboardMod) {
    try {
      await clipboardMod.setStringAsync(value);
      flashCopiedToast(labelForToast);
      return;
    } catch {
      /* fall through */
    }
  }
  // Last-resort: open the system share sheet which includes "Copy".
  try { await Share.share({ message: value }); } catch {}
}
