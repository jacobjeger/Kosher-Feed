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
    const apiUrl = process.env.EXPO_PUBLIC_API_URL || "https://kosher-feed.replit.app";
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

function addAutoXmlResource(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const resDir = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml"
      );
      fs.mkdirSync(resDir, { recursive: true });

      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<automotiveApp>
    <uses name="media" />
</automotiveApp>
`;
      fs.writeFileSync(
        path.join(resDir, "automotive_app_desc.xml"),
        xmlContent
      );

      return config;
    },
  ]);
}

module.exports = function withAndroidAuto(config) {
  config = addAutoMetaData(config);
  config = addAutoXmlResource(config);
  return config;
};
