import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Directory, Paths } from "expo-file-system";
import * as LegacyFS from "expo-file-system/legacy";
import { Platform } from "react-native";
import type { Episode, Feed, DownloadedEpisode } from "@/lib/types";
import { isOnWifi } from "@/lib/network";
import { getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import { addLog } from "@/lib/error-logger";

const PROGRESS_THROTTLE_MS = 1500;
const PROGRESS_UPDATE_MIN_CHANGE = 0.05;
const MAX_CONCURRENT_DOWNLOADS = 3;

interface DownloadsContextValue {
  downloads: DownloadedEpisode[];
  downloadProgress: Map<string, number>;
  downloadEpisode: (episode: Episode, feed: Feed) => Promise<void>;
  removeDownload: (episodeId: string) => Promise<void>;
  isDownloaded: (episodeId: string) => boolean;
  isDownloading: (episodeId: string) => boolean;
  getLocalUri: (episodeId: string) => string | null;
  autoDownloadNewEpisodes: (feeds: Feed[], maxPerFeed: number) => Promise<void>;
  enforceStorageLimit: (feedId: string, maxPerFeed: number) => Promise<void>;
  getDownloadsForFeed: (feedId: string) => DownloadedEpisode[];
  batchDownload: (episodes: Episode[], feed: Feed) => Promise<void>;
}

const DOWNLOADS_KEY = "@kosher_podcast_downloads";
const DownloadsContext = createContext<DownloadsContextValue | null>(null);

function fileExistsSafe(uri: string): boolean {
  try {
    if (!uri) return false;
    const f = new File(uri);
    return f.exists;
  } catch {
    return false;
  }
}

function deleteFileSafe(uri: string): void {
  try {
    if (!uri) return;
    const f = new File(uri);
    if (f.exists) {
      f.delete();
    }
  } catch {}
}

function ensurePodcastsDir(): string {
  const podcastsDir = new Directory(Paths.document, 'podcasts');
  if (!podcastsDir.exists) {
    podcastsDir.create();
  }
  return podcastsDir.uri;
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadedEpisode[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<Map<string, number>>(new Map());
  const downloadsRef = useRef<DownloadedEpisode[]>([]);
  const progressRef = useRef<Map<string, number>>(new Map());
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeDownloadsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    progressTimerRef.current = setInterval(() => {
      const current = progressRef.current;
      if (current.size > 0) {
        setDownloadProgress(new Map(current));
      }
    }, PROGRESS_THROTTLE_MS);
    return () => {
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, []);

  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  useEffect(() => {
    loadDownloads();
  }, []);

  const loadDownloads = async () => {
    try {
      const data = await AsyncStorage.getItem(DOWNLOADS_KEY);
      if (data) {
        let parsed: DownloadedEpisode[];
        try {
          parsed = JSON.parse(data);
          if (!Array.isArray(parsed)) {
            addLog("warn", "Downloads data corrupted, resetting", undefined, "downloads");
            await AsyncStorage.removeItem(DOWNLOADS_KEY);
            return;
          }
        } catch {
          addLog("warn", "Downloads JSON parse failed, resetting", undefined, "downloads");
          await AsyncStorage.removeItem(DOWNLOADS_KEY);
          return;
        }

        if (Platform.OS !== "web") {
          const validated: DownloadedEpisode[] = [];
          for (const dl of parsed) {
            try {
              if (!dl.localUri || dl.localUri === dl.audioUrl) {
                validated.push(dl);
                continue;
              }
              if (fileExistsSafe(dl.localUri)) {
                validated.push(dl);
              } else {
                console.warn(`Download file missing, removing: ${dl.title}`);
              }
            } catch {
              validated.push(dl);
            }
          }
          if (validated.length !== parsed.length) {
            await AsyncStorage.setItem(DOWNLOADS_KEY, JSON.stringify(validated));
          }
          setDownloads(validated);
        } else {
          setDownloads(parsed);
        }
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

  const downloadSingleEpisode = useCallback(async (episode: Episode, feed: Feed): Promise<DownloadedEpisode | null> => {
    if (activeDownloadsRef.current.has(episode.id)) return null;
    activeDownloadsRef.current.add(episode.id);

    if (Platform.OS === "web") {
      activeDownloadsRef.current.delete(episode.id);
      return {
        ...episode,
        localUri: episode.audioUrl,
        feedTitle: feed.title,
        feedImageUrl: feed.imageUrl,
        downloadedAt: new Date().toISOString(),
      };
    }

    const podcastsDirUri = ensurePodcastsDir();
    const safeFilename = episode.id.replace(/[^a-zA-Z0-9]/g, "_") + ".mp3";
    const fileUri = podcastsDirUri + '/' + safeFilename;

    progressRef.current.set(episode.id, 0);

    try {
      let lastReportedPct = 0;
      const downloadResumable = LegacyFS.createDownloadResumable(
        episode.audioUrl,
        fileUri,
        {},
        (progress) => {
          if (progress.totalBytesExpectedToWrite <= 0) return;
          const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
          if (pct - lastReportedPct >= PROGRESS_UPDATE_MIN_CHANGE || pct >= 1) {
            lastReportedPct = pct;
            progressRef.current.set(episode.id, pct);
          }
        }
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) throw new Error("Download failed");

      return {
        ...episode,
        localUri: result.uri,
        feedTitle: feed.title,
        feedImageUrl: feed.imageUrl,
        downloadedAt: new Date().toISOString(),
      };
    } catch (e) {
      addLog("error", `Download failed: ${episode.title} - ${(e as any)?.message || e}`, (e as any)?.stack, "downloads");
      return null;
    } finally {
      progressRef.current.delete(episode.id);
      activeDownloadsRef.current.delete(episode.id);
    }
  }, []);

  const downloadEpisode = useCallback(async (episode: Episode, feed: Feed) => {
    const result = await downloadSingleEpisode(episode, feed);
    if (result) {
      setDownloads(prev => {
        const next = [result, ...prev.filter(d => d.id !== episode.id)];
        saveDownloads(next);
        return next;
      });
    }
    setDownloadProgress(new Map(progressRef.current));
  }, [downloadSingleEpisode]);

  const removeDownload = useCallback(async (episodeId: string) => {
    const ep = downloadsRef.current.find(d => d.id === episodeId);
    if (ep && Platform.OS !== "web") {
      try {
        deleteFileSafe(ep.localUri);
      } catch (e) {
        addLog("warn", `File delete failed: ${episodeId} - ${(e as any)?.message || e}`, undefined, "downloads");
      }
    }

    setDownloads(prev => {
      const next = prev.filter(d => d.id !== episodeId);
      saveDownloads(next);
      return next;
    });
  }, []);

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

  const getDownloadsForFeed = useCallback((feedId: string) => {
    return downloads.filter(d => d.feedId === feedId);
  }, [downloads]);

  const batchDownload = useCallback(async (episodes: Episode[], feed: Feed) => {
    const toDownload = episodes.filter(ep => !downloadsRef.current.some(d => d.id === ep.id) && !activeDownloadsRef.current.has(ep.id));
    if (toDownload.length === 0) return;

    const chunks: Episode[][] = [];
    for (let i = 0; i < toDownload.length; i += MAX_CONCURRENT_DOWNLOADS) {
      chunks.push(toDownload.slice(i, i + MAX_CONCURRENT_DOWNLOADS));
    }

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map(ep => downloadSingleEpisode(ep, feed))
      );

      const completed: DownloadedEpisode[] = [];
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          completed.push(result.value);
        }
      }

      if (completed.length > 0) {
        setDownloads(prev => {
          const ids = new Set(completed.map(c => c.id));
          const next = [...completed, ...prev.filter(d => !ids.has(d.id))];
          saveDownloads(next);
          return next;
        });
      }

      setDownloadProgress(new Map(progressRef.current));
    }
  }, [downloadSingleEpisode]);

  const enforceStorageLimit = useCallback(async (feedId: string, maxPerFeed: number) => {
    const feedDownloads = downloadsRef.current
      .filter(d => d.feedId === feedId)
      .sort((a, b) => new Date(b.downloadedAt).getTime() - new Date(a.downloadedAt).getTime());

    if (feedDownloads.length <= maxPerFeed) return;

    const toRemove = feedDownloads.slice(maxPerFeed);
    for (const ep of toRemove) {
      if (Platform.OS !== "web") {
        deleteFileSafe(ep.localUri);
      }
    }

    const removeIds = new Set(toRemove.map(e => e.id));
    setDownloads(prev => {
      const next = prev.filter(d => !removeIds.has(d.id));
      saveDownloads(next);
      return next;
    });
  }, []);

  const autoDownloadNewEpisodes = useCallback(async (feeds: Feed[], maxPerFeed: number) => {
    try {
      const onWifi = await isOnWifi();
      if (!onWifi && Platform.OS !== "web") return;

      for (const feed of feeds) {
        const existingForFeed = downloadsRef.current.filter(d => d.feedId === feed.id);
        if (existingForFeed.length >= maxPerFeed) continue;

        try {
          const baseUrl = getApiUrl();
          const url = new URL(`/api/feeds/${feed.id}/episodes`, baseUrl);
          const res = await fetch(url.toString());
          const episodes: Episode[] = await res.json();

          const downloadedIds = new Set(downloadsRef.current.map(d => d.id));
          const toDownload = episodes
            .filter(ep => !downloadedIds.has(ep.id))
            .slice(0, maxPerFeed - existingForFeed.length);

          if (toDownload.length > 0) {
            await batchDownload(toDownload, feed);
          }

          await enforceStorageLimit(feed.id, maxPerFeed);
        } catch (e) {
          console.error(`Auto-download failed for feed ${feed.title}:`, e);
        }
      }
    } catch (e) {
      console.error("Auto-download check failed:", e);
    }
  }, [batchDownload, enforceStorageLimit]);

  const value = useMemo(() => ({
    downloads,
    downloadProgress,
    downloadEpisode,
    removeDownload,
    isDownloaded,
    isDownloading,
    getLocalUri,
    autoDownloadNewEpisodes,
    enforceStorageLimit,
    getDownloadsForFeed,
    batchDownload,
  }), [downloads, downloadProgress, downloadEpisode, removeDownload, isDownloaded, isDownloading, getLocalUri, autoDownloadNewEpisodes, enforceStorageLimit, getDownloadsForFeed, batchDownload]);

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
