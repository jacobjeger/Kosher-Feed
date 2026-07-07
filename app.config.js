// Dynamic Expo config. Expo reads app.json first, hands the merged
// result to this function, and lets us mutate it before build.
//
// Purpose: strip @react-native-firebase/* plugins on the iOS build.
// Their plugin requires an iOS GoogleService-Info.plist we haven't
// generated yet, and YTC push (the only feature that actually uses
// FCM) is Android-only in practice — see the
// `project_ytc_android_only` memory. Keeping the plugins for Android
// leaves that flow untouched.
//
// If/when we later stand up the iOS Firebase app in the
// `toras-chaim-shiurim` Firebase project + download the plist, add
//   "ios": { "googleServicesFile": "./GoogleService-Info.plist" }
// to app.json and delete this file.

module.exports = ({ config }) => {
  // EAS sets EAS_BUILD_PLATFORM to "ios" or "android" during the build.
  // Locally (expo start / expo prebuild without --platform), it's unset;
  // don't strip anything then so Android dev flows are unaffected.
  const platform = process.env.EAS_BUILD_PLATFORM;

  if (platform === "ios" && Array.isArray(config.plugins)) {
    config.plugins = config.plugins.filter((entry) => {
      const name = Array.isArray(entry) ? entry[0] : entry;
      return typeof name !== "string" || !name.startsWith("@react-native-firebase/");
    });
  }

  return config;
};
