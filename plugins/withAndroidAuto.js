const {
  withAndroidManifest,
  withDangerousMod,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

function addAutoMetaData(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = manifest.manifest.application?.[0];
    if (!app) return config;

    // Add automotive_app_desc metadata to <application>
    if (!app["meta-data"]) app["meta-data"] = [];
    const existing = app["meta-data"].find(
      (m) => m.$["android:name"] === "com.google.android.gms.car.application"
    );
    if (!existing) {
      app["meta-data"].push({
        $: {
          "android:name": "com.google.android.gms.car.application",
          "android:resource": "@xml/automotive_app_desc",
        },
      });
    }

    // Add API base URL meta-data for Android Auto browsing service
    const apiUrl = process.env.EXPO_PUBLIC_API_URL || "https://kosher-feed-production.up.railway.app";
    const apiMeta = app["meta-data"].find(
      (m) => m.$["android:name"] === "shiurpod_api_url"
    );
    if (apiMeta) {
      apiMeta.$["android:value"] = apiUrl;
    } else {
      app["meta-data"].push({
        $: {
          "android:name": "shiurpod_api_url",
          "android:value": apiUrl,
        },
      });
    }

    // Add ShiurPodAutoService declaration
    if (!app.service) app.service = [];
    const autoServiceExists = app.service.find(
      (s) =>
        s.$["android:name"] ===
        "expo.modules.audio.service.ShiurPodAutoService"
    );
    if (!autoServiceExists) {
      app.service.push({
        $: {
          "android:name": "expo.modules.audio.service.ShiurPodAutoService",
          "android:exported": "true",
          "android:foregroundServiceType": "mediaPlayback",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name":
                    "android.media.browse.MediaBrowserService",
                },
              },
            ],
          },
        ],
      });
    }

    // Make AudioControlsService exported so Android Auto can access the session
    const audioService = app.service.find(
      (s) =>
        s.$["android:name"] === ".service.AudioControlsService" ||
        s.$["android:name"] ===
          "expo.modules.audio.service.AudioControlsService"
    );
    if (audioService) {
      audioService.$["android:exported"] = "true";
    }

    return config;
  });
}

function addAutoXmlAndDependencies(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;

      // Create automotive_app_desc.xml
      const resDir = path.join(platformRoot, "app", "src", "main", "res", "xml");
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(
        path.join(resDir, "automotive_app_desc.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<automotiveApp>\n    <uses name="media" />\n</automotiveApp>\n`
      );

      // Copy ShiurPodAutoService.kt into the app's own source directory
      // (expo-audio module build doesn't compile it — class not in dex)
      const serviceSource = path.join(
        config.modRequest.projectRoot,
        "node_modules", "expo-audio", "android", "src", "main", "java",
        "expo", "modules", "audio", "service", "ShiurPodAutoService.kt"
      );
      const serviceDestDir = path.join(
        platformRoot, "app", "src", "main", "java",
        "expo", "modules", "audio", "service"
      );
      if (fs.existsSync(serviceSource)) {
        fs.mkdirSync(serviceDestDir, { recursive: true });
        fs.copyFileSync(serviceSource, path.join(serviceDestDir, "ShiurPodAutoService.kt"));
      }

      // Add Guava + media3 dependencies to app build.gradle (required by ShiurPodAutoService)
      const appBuildGradle = path.join(platformRoot, "app", "build.gradle");
      if (fs.existsSync(appBuildGradle)) {
        let content = fs.readFileSync(appBuildGradle, "utf-8");
        if (!content.includes("guava")) {
          content = content.replace(
            /dependencies\s*\{/,
            `dependencies {\n    implementation "com.google.guava:guava:32.1.3-android"\n    implementation "androidx.media3:media3-session:1.8.0"\n    implementation "androidx.media3:media3-exoplayer:1.8.0"\n    implementation "androidx.media3:media3-common:1.8.0"`
          );
          fs.writeFileSync(appBuildGradle, content);
        }
      }

      return config;
    },
  ]);
}

module.exports = function withAndroidAuto(config) {
  config = addAutoMetaData(config);
  config = addAutoXmlAndDependencies(config);
  return config;
};
