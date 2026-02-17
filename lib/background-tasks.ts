import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { addLog } from "@/lib/error-logger";

const BACKGROUND_SYNC_TASK = "BACKGROUND_SYNC_TASK";
const LAST_BG_SYNC_KEY = "@shiurpod_last_bg_sync";

let TaskManager: any = null;
let BackgroundFetch: any = null;

if (Platform.OS !== "web") {
  try {
    TaskManager = require("expo-task-manager");
    BackgroundFetch = require("expo-background-fetch");
  } catch (e) {
    console.warn("Background task modules not available:", e);
  }
}

async function backgroundSyncHandler() {
  try {
    addLog("info", "Background sync task started", undefined, "background-sync");

    const lastSync = await AsyncStorage.getItem(LAST_BG_SYNC_KEY);
    const now = Date.now();
    if (lastSync && now - parseInt(lastSync, 10) < 4 * 60 * 1000) {
      addLog("info", "Background sync skipped (too soon)", undefined, "background-sync");
      return BackgroundFetch?.BackgroundFetchResult?.NoData;
    }

    await AsyncStorage.setItem(LAST_BG_SYNC_KEY, now.toString());

    const { getDeviceId } = require("@/lib/device-id");
    const { getApiUrl } = require("@/lib/query-client");
    const {
      checkForNewEpisodes,
      notifyNewEpisodes,
      checkNotificationPermission,
    } = require("@/lib/notifications");

    const deviceId = await getDeviceId();
    const baseUrl = getApiUrl();

    const feedsUrl = new URL(`/api/subscriptions/${deviceId}/feeds`, baseUrl);
    const feedsRes = await fetch(feedsUrl.toString());
    const feeds = await feedsRes.json();

    if (!feeds || feeds.length === 0) {
      addLog("info", "Background sync: no subscribed feeds", undefined, "background-sync");
      return BackgroundFetch?.BackgroundFetchResult?.NoData;
    }

    const episodesUrl = new URL("/api/episodes/latest?limit=100", baseUrl);
    const episodesRes = await fetch(episodesUrl.toString());
    const episodes = await episodesRes.json();

    const hasPermission = await checkNotificationPermission();
    let hasNewData = false;
    if (hasPermission) {
      const newEps = await checkForNewEpisodes(feeds, episodes);
      if (newEps.length > 0) {
        await notifyNewEpisodes(newEps, feeds);
        addLog("info", `Background sync: notified ${newEps.length} new episodes`, undefined, "background-sync");
        hasNewData = true;
      }
    }

    try {
      const settingsData = await AsyncStorage.getItem("@kosher_shiurim_settings");
      const settings = settingsData ? JSON.parse(settingsData) : {};
      if (settings.autoDownloadOnWifi) {
        const { isOnWifi } = require("@/lib/network");
        const onWifi = await isOnWifi();
        if (onWifi) {
          const feedSettingsData = await AsyncStorage.getItem("@kosher_shiurim_feed_settings");
          const feedSettings = feedSettingsData ? JSON.parse(feedSettingsData) : {};
          const maxDefault = settings.maxEpisodesPerFeed || 5;
          const downloadsData = await AsyncStorage.getItem("@kosher_podcast_downloads");
          const existingDownloads: any[] = downloadsData ? JSON.parse(downloadsData) : [];
          const downloadedIds = new Set(existingDownloads.map((d: any) => d.id));

          let downloadCount = 0;
          const FileSystem = require("expo-file-system/legacy");
          const { Paths: FSPaths } = require("expo-file-system");

          for (const feed of feeds) {
            const maxForFeed = feedSettings[feed.id]?.maxEpisodes ?? maxDefault;
            const existingForFeed = existingDownloads.filter((d: any) => d.feedId === feed.id);
            if (existingForFeed.length >= maxForFeed) continue;

            const epsUrl = new URL(`/api/feeds/${feed.id}/episodes`, baseUrl);
            const epsRes = await fetch(epsUrl.toString());
            const feedEpisodes = await epsRes.json();

            const toDownload = feedEpisodes
              .filter((ep: any) => !downloadedIds.has(ep.id))
              .slice(0, maxForFeed - existingForFeed.length);

            for (const ep of toDownload) {
              if (!ep.audioUrl) continue;
              try {
                const ext = ep.audioUrl.includes(".m4a") ? ".m4a" : ".mp3";
                const fileName = `shiurpod_${ep.id}${ext}`;
                const cacheDir = FSPaths.cache?.uri || FileSystem.cacheDirectory;
                const fileUri = `${cacheDir}${fileName}`;
                const result = await FileSystem.downloadAsync(ep.audioUrl, fileUri);
                if (result.status === 200) {
                  existingDownloads.push({
                    id: ep.id,
                    feedId: ep.feedId,
                    title: ep.title,
                    audioUrl: ep.audioUrl,
                    localUri: result.uri,
                    downloadedAt: new Date().toISOString(),
                    feedTitle: feed.title,
                    feedImageUrl: feed.imageUrl,
                  });
                  downloadedIds.add(ep.id);
                  downloadCount++;
                }
              } catch (dlErr) {
                addLog("warn", `Background download failed: ${ep.title} - ${(dlErr as any)?.message}`, undefined, "background-sync");
              }
            }
          }

          if (downloadCount > 0) {
            await AsyncStorage.setItem("@kosher_podcast_downloads", JSON.stringify(existingDownloads));
            addLog("info", `Background sync: downloaded ${downloadCount} episodes`, undefined, "background-sync");
            hasNewData = true;
          }
        }
      }
    } catch (dlError) {
      addLog("warn", `Background auto-download failed: ${(dlError as any)?.message}`, undefined, "background-sync");
    }

    if (hasNewData) {
      return BackgroundFetch?.BackgroundFetchResult?.NewData;
    }
    addLog("info", "Background sync completed (no new data)", undefined, "background-sync");
    return BackgroundFetch?.BackgroundFetchResult?.NoData;
  } catch (e) {
    addLog("error", `Background sync failed: ${(e as any)?.message || e}`, (e as any)?.stack, "background-sync");
    return BackgroundFetch?.BackgroundFetchResult?.Failed;
  }
}

export function defineBackgroundTasks() {
  if (Platform.OS === "web" || !TaskManager || !BackgroundFetch) return;

  try {
    TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
      return await backgroundSyncHandler();
    });
    addLog("info", "Background sync task defined", undefined, "background-sync");
  } catch (e) {
    addLog("warn", `Failed to define background task: ${(e as any)?.message || e}`, undefined, "background-sync");
  }
}

export async function registerBackgroundSync() {
  if (Platform.OS === "web" || !BackgroundFetch) return;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (isRegistered) {
      addLog("info", "Background sync already registered", undefined, "background-sync");
      return;
    }

    await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });

    addLog("info", "Background sync registered (15 min interval)", undefined, "background-sync");
  } catch (e) {
    addLog("warn", `Background sync registration failed: ${(e as any)?.message || e}`, undefined, "background-sync");
  }
}

export async function unregisterBackgroundSync() {
  if (Platform.OS === "web" || !TaskManager) return;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
      addLog("info", "Background sync unregistered", undefined, "background-sync");
    }
  } catch (e) {
    addLog("warn", `Background sync unregister failed: ${(e as any)?.message || e}`, undefined, "background-sync");
  }
}
