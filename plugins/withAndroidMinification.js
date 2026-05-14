// Enable R8 minification + tree-shaking on Android release builds.
//
// build.gradle's release buildType already reads
// `android.enableMinifyInReleaseBuilds` from gradle.properties — by
// default the property is unset / false, so released APKs ship
// unminified. Flipping it to true cuts APK size ~20-30% and
// meaningfully speeds up cold-start parse on low-end Android devices
// (e.g. the Megalife).
//
// EAS regenerates android/ from app.json on every build, so editing
// android/gradle.properties locally has no effect on EAS-produced
// APKs. The withGradleProperties plugin path is the only one that
// survives prebuild — same pattern as withAndroidAbiFilter.js.
//
// Resource-shrinker (android.enableShrinkResourcesInReleaseBuilds) is
// intentionally left off — it occasionally strips drawables that are
// only referenced by string name, which is hard to debug.
//
// If a native module crashes at runtime after enabling this, add a
// `-keep` rule to android/app/proguard-rules.pro. The existing rules
// cover Reanimated + TurboModules; Expo + Firebase modules ship their
// own consumer-proguard-rules.pro via AAR.

const { withGradleProperties } = require("@expo/config-plugins");

module.exports = function withAndroidMinification(config) {
  return withGradleProperties(config, (config) => {
    const items = config.modResults;
    const existing = items.find(
      (item) =>
        item.type === "property" &&
        item.key === "android.enableMinifyInReleaseBuilds",
    );
    if (existing) {
      existing.value = "true";
    } else {
      items.push({
        type: "property",
        key: "android.enableMinifyInReleaseBuilds",
        value: "true",
      });
    }
    return config;
  });
};
