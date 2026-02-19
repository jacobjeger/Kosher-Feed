import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { addLog } from "@/lib/error-logger";

const DOWNLOADS_KEY = "@shiurpod_downloads";
const COMPLETED_KEY = "@shiurpod_completed_downloads";
const DELETE_DELAY_MS = 48 * 60 * 60 * 1000;

export async function markDownloadCompleted(episodeId: string): Promise<void> {
  try {
    const data = await AsyncStorage.getItem(COMPLETED_KEY);
    const completed: Record<string, number> = data ? JSON.parse(data) : {};
    if (!completed[episodeId]) {
      completed[episodeId] = Date.now();
      await AsyncStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
      addLog("info", `Marked download completed: ${episodeId} (will auto-delete in 48h)`, undefined, "downloads");
    }
  } catch {}
}

export async function cleanupExpiredDownloads(favoriteEpisodeIds: string[]): Promise<number> {
  if (Platform.OS === "web") return 0;

  try {
    const [completedData, downloadsData] = await Promise.all([
      AsyncStorage.getItem(COMPLETED_KEY),
      AsyncStorage.getItem(DOWNLOADS_KEY),
    ]);

    if (!completedData || !downloadsData) return 0;

    const completed: Record<string, number> = JSON.parse(completedData);
    const downloads: any[] = JSON.parse(downloadsData);
    const now = Date.now();
    const favSet = new Set(favoriteEpisodeIds);
    let deletedCount = 0;

    const toDelete: string[] = [];
    for (const [episodeId, completedAt] of Object.entries(completed)) {
      if (now - completedAt >= DELETE_DELAY_MS && !favSet.has(episodeId)) {
        toDelete.push(episodeId);
      }
    }

    if (toDelete.length === 0) return 0;

    const toDeleteSet = new Set(toDelete);

    try {
      const FileSystem = require("expo-file-system");
      for (const dl of downloads) {
        if (toDeleteSet.has(dl.episodeId) && dl.localUri) {
          try {
            const info = await FileSystem.getInfoAsync(dl.localUri);
            if (info.exists) {
              await FileSystem.deleteAsync(dl.localUri, { idempotent: true });
            }
          } catch {}
          deletedCount++;
        }
      }
    } catch {}

    const updatedDownloads = downloads.filter((d: any) => !toDeleteSet.has(d.episodeId));
    await AsyncStorage.setItem(DOWNLOADS_KEY, JSON.stringify(updatedDownloads));

    for (const id of toDelete) {
      delete completed[id];
    }
    await AsyncStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));

    if (deletedCount > 0) {
      addLog("info", `Auto-deleted ${deletedCount} expired downloads (48h after completion)`, undefined, "downloads");
    }

    return deletedCount;
  } catch (e) {
    addLog("warn", `Cleanup expired downloads failed: ${(e as any)?.message || e}`, undefined, "downloads");
    return 0;
  }
}
