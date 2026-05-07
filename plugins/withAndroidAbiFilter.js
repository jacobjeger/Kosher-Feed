// Android ABI filter — keep arm64-v8a + armeabi-v7a only.
//
// Why: a default EAS Android build produces a "fat" APK with native
// libs for FOUR architectures (arm64-v8a, armeabi-v7a, x86, x86_64).
// x86 and x86_64 are emulator-only — no real Android phone uses them.
// They roughly DOUBLE the APK size for no user benefit.
//
// This plugin injects ndk.abiFilters into android/app/build.gradle's
// defaultConfig at prebuild time so EAS builds the APK with only the
// two ARM variants we care about.
//
// Cuts APK size by ~40 MB on a typical ShiurPod build.

const { withAppBuildGradle } = require("@expo/config-plugins");

const KEEP_ABIS = ["arm64-v8a", "armeabi-v7a"];

module.exports = function withAndroidAbiFilter(config) {
  return withAppBuildGradle(config, (config) => {
    let src = config.modResults.contents;

    // Idempotent: skip if we've already injected.
    if (src.includes("// SHIURPOD_ABI_FILTERS")) return config;

    // Find the defaultConfig block and inject ndk { abiFilters ... }
    // immediately inside it. We anchor on `defaultConfig {` and add
    // our snippet on the next line.
    const anchor = "defaultConfig {";
    const idx = src.indexOf(anchor);
    if (idx === -1) {
      // build.gradle layout changed — fail loudly so we notice.
      throw new Error(
        "[withAndroidAbiFilter] couldn't find 'defaultConfig {' in app build.gradle",
      );
    }

    const insertAt = idx + anchor.length;
    const filterArgs = KEEP_ABIS.map((a) => `"${a}"`).join(", ");
    const snippet = `
        // SHIURPOD_ABI_FILTERS — keep ARM only, drop x86/x86_64 (emulator-only)
        ndk {
            abiFilters ${filterArgs}
        }`;

    src = src.slice(0, insertAt) + snippet + src.slice(insertAt);
    config.modResults.contents = src;
    return config;
  });
};
