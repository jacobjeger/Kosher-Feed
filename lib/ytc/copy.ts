// YTC: copy-to-clipboard helper.
//
// Path 1 (NEW APK): expo-clipboard's native module is linked.
//   setStringAsync(value) writes silently → toast confirmation.
//
// Path 2 (OLD APK / OTA users): native module not linked.
//   Show an Alert with the value pre-formatted; on Android the user
//   can long-press to copy. Faster + less surprising than popping the
//   system share sheet (the previous fallback could take 30s+ on
//   slow devices because the share sheet enumerates installed apps).
//
// Lazy require on FIRST CALL — module init shouldn't trigger native
// module probing for OTA users where the require may take a noticeable
// chunk of JS-thread time.

import { ToastAndroid, Platform, Alert } from "react-native";

type ClipboardModule = typeof import("expo-clipboard");
let _clipboardMod: ClipboardModule | null = null;
let _attemptedRequire = false;

function getClipboardMod(): ClipboardModule | null {
  if (_attemptedRequire) return _clipboardMod;
  _attemptedRequire = true;
  try { _clipboardMod = require("expo-clipboard"); }
  catch { _clipboardMod = null; }
  return _clipboardMod;
}

/** Toast confirmation. Android: native toast. iOS: nothing —
 *  ToastAndroid is Android-only and we don't want to pop another
 *  Alert chained on iOS. */
function flashCopiedToast(label: string): void {
  if (Platform.OS === "android") {
    try { ToastAndroid.show(`${label} copied`, ToastAndroid.SHORT); } catch {}
  }
}

export async function copyToClipboard(value: string, labelForToast: string): Promise<void> {
  if (!value) return;
  const mod = getClipboardMod();
  if (mod) {
    try {
      await mod.setStringAsync(value);
      flashCopiedToast(labelForToast);
      return;
    } catch {
      /* fall through to manual Alert */
    }
  }
  // OLD APK fallback — show the value so the user can long-press +
  // Android system "Copy" picker. Resolves immediately; doesn't
  // depend on the system share sheet's slow enumeration.
  Alert.alert(labelForToast, value, [{ text: "OK", style: "default" }]);
}
