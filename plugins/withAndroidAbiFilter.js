// Limit which CPU architectures the EAS Android build includes.
//
// React Native's `com.facebook.react` gradle plugin reads
// `reactNativeArchitectures` from gradle.properties to decide which
// JNI libs to compile + ship. Default is all 4 (armeabi-v7a, arm64-v8a,
// x86, x86_64). x86 and x86_64 are emulator-only — no real Android
// phone uses them — and they roughly double the APK size.
//
// We modify gradle.properties at prebuild time via @expo/config-plugins'
// withGradleProperties helper. EAS regenerates android/ on every build,
// so editing the local file would have no effect on EAS-produced APKs;
// the plugin path is the only one that survives the regeneration.
//
// Earlier version of this plugin tried to inject ndk.abiFilters into
// app/build.gradle's defaultConfig — that's the wrong knob in modern
// RN/Expo (RN 0.71+). The com.facebook.react plugin produces JNI libs
// for every arch in reactNativeArchitectures regardless of abiFilters,
// and the resulting APK still contained x86 + x86_64.

const { withGradleProperties } = require("@expo/config-plugins");

const KEEP_ABIS = ["armeabi-v7a", "arm64-v8a"];

module.exports = function withAndroidAbiFilter(config) {
  return withGradleProperties(config, (config) => {
    const value = KEEP_ABIS.join(",");
    const items = config.modResults;

    // Replace the existing reactNativeArchitectures line if present,
    // otherwise append. Idempotent: a second prebuild leaves the
    // value unchanged.
    const existing = items.find(
      (item) =>
        item.type === "property" && item.key === "reactNativeArchitectures",
    );
    if (existing) {
      existing.value = value;
    } else {
      items.push({ type: "property", key: "reactNativeArchitectures", value });
    }
    return config;
  });
};
