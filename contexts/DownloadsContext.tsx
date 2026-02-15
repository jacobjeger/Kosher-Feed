import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import { Platform } from "react-native";
import type { Episode, Feed, DownloadedEpisode } from "@/lib/types";

interface DownloadProgress {
  episodeId: string;
  progress: number;
}

interface DownloadsContextValue {
  downloads: DownloadedEpisode[];
  downloadProgress: Map<string, number>;
  downloadEpisode: (episode: Episode, feed: Feed) => Promise<void>;
  removeDownload: (episodeId: string) => Promise<void>;
  isDownloaded: (episodeId: string) => boolean;
  isDownloading: (episodeId: string) => boolean;
  getLocalUri: (episodeId: string) => string | null;
}

const DOWNLOADS_KEY = "@kosher_podcast_downloads";
const DownloadsContext = createContext<DownloadsContextValue | null>(null);

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadedEpisode[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    loadDownloads();
  }, []);

  const loadDownloads = async () => {
    try {
      const data = await AsyncStorage.getItem(DOWNLOADS_KEY);
      if (data) {
        setDownloads(JSON.parse(data));
      }
    } catch (e) {
      console.error("Failed to load downloads:", e);
    }
  };

  const saveDownloads = async (list: DownloadedEpisode[]) => {
    try {
      await AsyncStorage.setItem(DOWNLOADS_KEY, JSON.stringify(list));
    } catch (e) {
      console.error("Failed to save downloads:", e);
    }
  };

  const downloadEpisode = useCallback(async (episode: Episode, feed: Feed) => {
    if (Platform.OS === "web") {
      const downloaded: DownloadedEpisode = {
        ...episode,
        localUri: episode.audioUrl,
        feedTitle: feed.title,
        feedImageUrl: feed.imageUrl,
        downloadedAt: new Date().toISOString(),
      };
      setDownloads(prev => {
        const next = [downloaded, ...prev.filter(d => d.id !== episode.id)];
        saveDownloads(next);
        return next;
      });
      return;
    }

    const fileDir = `${FileSystem.documentDirectory}podcasts/`;
    const dirInfo = await FileSystem.getInfoAsync(fileDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(fileDir, { intermediates: true });
    }

    const safeFilename = episode.id.replace(/[^a-zA-Z0-9]/g, "_") + ".mp3";
    const fileUri = fileDir + safeFilename;

    setDownloadProgress(prev => {
      const next = new Map(prev);
      next.set(episode.id, 0);
      return next;
    });

    try {
      const downloadResumable = FileSystem.createDownloadResumable(
        episode.audioUrl,
        fileUri,
        {},
        (progress) => {
          const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
          setDownloadProgress(prev => {
            const next = new Map(prev);
            next.set(episode.id, pct);
            return next;
          });
        }
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) throw new Error("Download failed");

      const downloaded: DownloadedEpisode = {
        ...episode,
        localUri: result.uri,
        feedTitle: feed.title,
        feedImageUrl: feed.imageUrl,
        downloadedAt: new Date().toISOString(),
      };

      setDownloads(prev => {
        const next = [downloaded, ...prev.filter(d => d.id !== episode.id)];
        saveDownloads(next);
        return next;
      });
    } catch (e) {
      console.error("Download failed:", e);
    } finally {
      setDownloadProgress(prev => {
        const next = new Map(prev);
        next.delete(episode.id);
        return next;
      });
    }
  }, []);

  const removeDownload = useCallback(async (episodeId: string) => {
    const ep = downloads.find(d => d.id === episodeId);
    if (ep && Platform.OS !== "web") {
      try {
        const info = await FileSystem.getInfoAsync(ep.localUri);
        if (info.exists) {
          await FileSystem.deleteAsync(ep.localUri);
        }
      } catch (e) {
        console.error("Failed to delete file:", e);
      }
    }

    setDownloads(prev => {
      const next = prev.filter(d => d.id !== episodeId);
      saveDownloads(next);
      return next;
    });
  }, [downloads]);

  const isDownloaded = useCallback((episodeId: string) => {
    return downloads.some(d => d.id === episodeId);
  }, [downloads]);

  const isDownloading = useCallback((episodeId: string) => {
    return downloadProgress.has(episodeId);
  }, [downloadProgress]);

  const getLocalUri = useCallback((episodeId: string) => {
    const ep = downloads.find(d => d.id === episodeId);
    return ep?.localUri || null;
  }, [downloads]);

  const value = useMemo(() => ({
    downloads,
    downloadProgress,
    downloadEpisode,
    removeDownload,
    isDownloaded,
    isDownloading,
    getLocalUri,
  }), [downloads, downloadProgress, downloadEpisode, removeDownload, isDownloaded, isDownloading, getLocalUri]);

  return (
    <DownloadsContext.Provider value={value}>
      {children}
    </DownloadsContext.Provider>
  );
}

export function useDownloads() {
  const context = useContext(DownloadsContext);
  if (!context) {
    throw new Error("useDownloads must be used within DownloadsProvider");
  }
  return context;
}
