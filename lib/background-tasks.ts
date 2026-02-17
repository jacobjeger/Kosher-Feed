import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { addLog } from "@/lib/error-logger";

const BACKGROUND_SYNC_TASK = "BACKGROUND_SYNC_TASK";
const LAST_BG_SYNC_KEY = "@shiurpod_last_bg_sync";

let TaskManager: any = null;
let BackgroundTask: any = null;

if (Platform.OS !== "web") {
  try {
    TaskManager = require("expo-task-manager");
    BackgroundTask = require("expo-background-task");
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
      return BackgroundTask?.BackgroundTaskResult?.Success;
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

    const controller1 = new AbortController();
    const t1 = setTimeout(() => controller1.abort(), 15000);
    const feedsUrl = new URL(`/api/subscriptions/${deviceId}/feeds`, baseUrl);
    const feedsRes = await fetch(feedsUrl.toString(), { signal: controller1.signal });
    clearTimeout(t1);
    const feeds = await feedsRes.json();

    if (!feeds || feeds.length === 0) {
      addLog("info", "Background sync: no subscribed feeds", undefined, "background-sync");
      return BackgroundTask?.BackgroundTaskResult?.Success;
    }

    const controller2 = new AbortController();
    const t2 = setTimeout(() => controller2.abort(), 15000);
    const episodesUrl = new URL("/api/episodes/latest?limit=100", baseUrl);
    const episodesRes = await fetch(episodesUrl.toString(), { signal: controller2.signal });
    clearTimeout(t2);
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
          const { Directory: FSDirectory, Paths: FSPaths } = require("expo-file-system");

          const podcastsDir = new FSDirectory(FSPaths.document, 'podcasts');
          if (!podcastsDir.exists) podcastsDir.create();
          const podcastsDirUri = podcastsDir.uri;

          const allToDownload: { ep: any; feed: any }[] = [];
          for (const feed of feeds) {
            const maxForFeed = feedSettings[feed.id]?.maxEpisodes ?? maxDefault;
            const existingForFeed = existingDownloads.filter((d: any) => d.feedId === feed.id);
            if (existingForFeed.length >= maxForFeed) continue;

            const epsUrl = new URL(`/api/feeds/${feed.id}/episodes`, baseUrl);
            const epsRes = await fetch(epsUrl.toString());
            const feedEpisodes = await epsRes.json();

            const toDownload = feedEpisodes
              .filter((ep: any) => !downloadedIds.has(ep.id) && ep.audioUrl)
              .slice(0, maxForFeed - existingForFeed.length);

            for (const ep of toDownload) {
              allToDownload.push({ ep, feed });
            }
          }

          const BG_MAX_CONCURRENT = 3;
          for (let i = 0; i < allToDownload.length; i += BG_MAX_CONCURRENT) {
            const chunk = allToDownload.slice(i, i + BG_MAX_CONCURRENT);
            const results = await Promise.allSettled(
              chunk.map(async ({ ep, feed }) => {
                const safeFilename = ep.id.replace(/[^a-zA-Z0-9]/g, "_") + ".mp3";
                const fileUri = `${podcastsDirUri}/${safeFilename}`;
                const result = await FileSystem.downloadAsync(ep.audioUrl, fileUri);
                if (result.status === 200) {
                  return {
                    id: ep.id,
                    feedId: ep.feedId,
                    title: ep.title,
                    description: ep.description,
                    audioUrl: ep.audioUrl,
                    duration: ep.duration,
                    publishedAt: ep.publishedAt,
                    guid: ep.guid,
                    imageUrl: ep.imageUrl,
                    localUri: result.uri,
                    downloadedAt: new Date().toISOString(),
                    feedTitle: feed.title,
                    feedImageUrl: feed.imageUrl,
                  };
                }
                return null;
              })
            );

            for (const r of results) {
              if (r.status === "fulfilled" && r.value) {
                existingDownloads.push(r.value);
                downloadedIds.add(r.value.id);
                downloadCount++;
              } else if (r.status === "rejected") {
                addLog("warn", `Background download failed: ${r.reason?.message}`, undefined, "background-sync");
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

    addLog("info", `Background sync completed (${hasNewData ? "new data" : "no new data"})`, undefined, "background-sync");
    return BackgroundTask?.BackgroundTaskResult?.Success;
  } catch (e) {
    addLog("error", `Background sync failed: ${(e as any)?.message || e}`, (e as any)?.stack, "background-sync");
    return BackgroundTask?.BackgroundTaskResult?.Failed;
  }
}

export function defineBackgroundTasks() {
  if (Platform.OS === "web" || !TaskManager || !BackgroundTask) return;

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
  if (Platform.OS === "web" || !BackgroundTask) return;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (isRegistered) {
      addLog("info", "Background sync already registered", undefined, "background-sync");
      return;
    }

    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, {
      minimumInterval: 15 * 60,
    });

    addLog("info", "Background sync registered (15 min interval)", undefined, "background-sync");
  } catch (e) {
    addLog("warn", `Background sync registration failed: ${(e as any)?.message || e}`, undefined, "background-sync");
  }
}

export async function unregisterBackgroundSync() {
  if (Platform.OS === "web" || !TaskManager || !BackgroundTask) return;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (isRegistered) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
      addLog("info", "Background sync unregistered", undefined, "background-sync");
    }
  } catch (e) {
    addLog("warn", `Background sync unregister failed: ${(e as any)?.message || e}`, undefined, "background-sync");
  }
}
