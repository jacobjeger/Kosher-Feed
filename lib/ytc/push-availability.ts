// YTC: detect whether @react-native-firebase is even linked into the
// running APK without importing the package. Using `require()` evaluates
// the package's JS, which may register native event handlers or other
// side effects that misbehave when the underlying native module is
// missing (e.g. on a build that hasn't yet shipped the native deps).
//
// Critical guard: ShiurPod's APRIL 22 release does NOT have
// react-native-firebase natively linked, but today's OTA bundle code
// references the package via require(). Even though the require is in
// a try/catch, the package's JS evaluation can produce edge cases
// (top-level NativeEventEmitter, async setup that throws unhandled).
// This module checks NativeModules.RNFBAppModule presence — that
// reflects native linkage exactly — and gates ALL push code on it.
//
// Result: on builds without the native module, every push entry point
// is a no-op. On builds with it, push works normally.

import { NativeModules, Platform } from "react-native";

let _checked = false;
let _available = false;

export function isReactNativeFirebaseAvailable(): boolean {
  if (_checked) return _available;
  _checked = true;
  if (Platform.OS !== "android") { _available = false; return false; }
  try {
    // RNFBAppModule is registered by @react-native-firebase/app's native
    // code only when the package is actually compiled into the build.
    // No require() of the JS is needed to check this.
    _available = !!(NativeModules as any).RNFBAppModule;
  } catch {
    _available = false;
  }
  return _available;
}
