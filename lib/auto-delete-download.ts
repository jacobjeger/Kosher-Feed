import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { addLog } from "@/lib/error-logger";

const DOWNLOADS_KEY = "@shiurpod_downloads";

export async function autoDeleteDownloadedEpisode(episodeId: string): Promise<void> {
  if (Platform.OS === "web") return;

  try {
    const data = await AsyncStorage.getItem(DOWNLOADS_KEY);
    if (!data) return;

    const downloads: any[] = JSON.parse(data);
    const download = downloads.find((d: any) => d.episodeId === episodeId);
    if (!download) return;

    try {
      const FileSystem = require("expo-file-system");
      if (download.localUri) {
        const info = await FileSystem.getInfoAsync(download.localUri);
        if (info.exists) {
          await FileSystem.deleteAsync(download.localUri, { idempotent: true });
        }
      }
    } catch {}

    const updated = downloads.filter((d: any) => d.episodeId !== episodeId);
    await AsyncStorage.setItem(DOWNLOADS_KEY, JSON.stringify(updated));
    addLog("info", `Auto-deleted download after listening: ${episodeId}`, undefined, "downloads");
  } catch (e) {
    addLog("warn", `Auto-delete failed: ${(e as any)?.message || e}`, undefined, "downloads");
  }
}
