import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Directory, Paths } from "expo-file-system";
import * as LegacyFS from "expo-file-system/legacy";
import { Platform, InteractionManager } from "react-native";
import type { Episode, Feed, DownloadedEpisode } from "@/lib/types";
import { isOnWifi } from "@/lib/network";
import { getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import { addLog } from "@/lib/error-logger";

const PROGRESS_THROTTLE_MS = 2500;
const PROGRESS_UPDATE_MIN_CHANGE = 0.08;
const MAX_CONCURRENT_DOWNLOADS = 1;

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

const downloadedIdsCache = new Set<string>();
const downloadingIdsCache = new Set<string>();

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadedEpisode[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<Map<string, number>>(new Map());
  const downloadsRef = useRef<DownloadedEpisode[]>([]);
  const progressRef = useRef<Map<string, number>>(new Map());
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeDownloadsRef = useRef<Set<string>>(new Set());
  const lastProgressSnapshotRef = useRef<string>("");
  const downloadQueueRef = useRef<Array<{ episode: Episode; feed: Feed; resolve: (v: DownloadedEpisode | null) => void }>>([]);
  const processingQueueRef = useRef(false);

  useEffect(() => {
    progressTimerRef.current = setInterval(() => {
      const current = progressRef.current;
      if (current.size > 0) {
        const snapshot = Array.from(current.entries()).map(([k, v]) => `${k}:${Math.round(v * 100)}`).join(",");
        if (snapshot !== lastProgressSnapshotRef.current) {
          lastProgressSnapshotRef.current = snapshot;
          if (Platform.OS !== "web") {
            InteractionManager.runAfterInteractions(() => {
              setDownloadProgress(new Map(current));
            });
          } else {
            setDownloadProgress(new Map(current));
          }
        }
      } else if (lastProgressSnapshotRef.current !== "") {
        lastProgressSnapshotRef.current = "";
        setDownloadProgress(new Map());
      }
    }, PROGRESS_THROTTLE_MS);
    return () => {
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, []);

  useEffect(() => {
    downloadsRef.current = downloads;
    downloadedIdsCache.clear();
    downloads.forEach(d => downloadedIdsCache.add(d.id));
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
    downloadingIdsCache.add(episode.id);

    if (Platform.OS === "web") {
      activeDownloadsRef.current.delete(episode.id);
      downloadingIdsCache.delete(episode.id);
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
      let lastCallbackTime = 0;
      const downloadResumable = LegacyFS.createDownloadResumable(
        episode.audioUrl,
        fileUri,
        {},
        (progress) => {
          if (progress.totalBytesExpectedToWrite <= 0) return;
          const now = Date.now();
          if (now - lastCallbackTime < 2000) return;
          const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
          if (pct - lastReportedPct >= PROGRESS_UPDATE_MIN_CHANGE || pct >= 1) {
            lastCallbackTime = now;
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
      downloadingIdsCache.delete(episode.id);
    }
  }, []);

  const processDownloadQueue = useCallback(async () => {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;

    while (downloadQueueRef.current.length > 0) {
      const activeCount = activeDownloadsRef.current.size;
      if (activeCount >= MAX_CONCURRENT_DOWNLOADS) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const item = downloadQueueRef.current.shift();
      if (!item) break;

      const result = await downloadSingleEpisode(item.episode, item.feed);
      item.resolve(result);

      if (result) {
        if (Platform.OS !== "web") {
          InteractionManager.runAfterInteractions(() => {
            setDownloads(prev => {
              const next = [result, ...prev.filter(d => d.id !== item.episode.id)];
              saveDownloads(next);
              return next;
            });
          });
        } else {
          setDownloads(prev => {
            const next = [result, ...prev.filter(d => d.id !== item.episode.id)];
            saveDownloads(next);
            return next;
          });
        }
      }
    }

    processingQueueRef.current = false;
    if (Platform.OS !== "web") {
      InteractionManager.runAfterInteractions(() => {
        setDownloadProgress(new Map(progressRef.current));
      });
    } else {
      setDownloadProgress(new Map(progressRef.current));
    }
  }, [downloadSingleEpisode]);

  const downloadEpisode = useCallback(async (episode: Episode, feed: Feed) => {
    return new Promise<void>((resolve) => {
      downloadQueueRef.current.push({
        episode,
        feed,
        resolve: () => { resolve(); },
      });
      processDownloadQueue();
    });
  }, [processDownloadQueue]);

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
    return downloadedIdsCache.has(episodeId);
  }, [downloads]);

  const isDownloading = useCallback((episodeId: string) => {
    return activeDownloadsRef.current.has(episodeId) || downloadQueueRef.current.some(q => q.episode.id === episodeId);
  }, [downloadProgress]);

  const getLocalUri = useCallback((episodeId: string) => {
    const ep = downloadsRef.current.find(d => d.id === episodeId);
    return ep?.localUri || null;
  }, [downloads]);

  const getDownloadsForFeed = useCallback((feedId: string) => {
    return downloadsRef.current.filter(d => d.feedId === feedId);
  }, [downloads]);

  const batchDownload = useCallback(async (episodes: Episode[], feed: Feed) => {
    const toDownload = episodes.filter(ep => !downloadedIdsCache.has(ep.id) && !activeDownloadsRef.current.has(ep.id));
    if (toDownload.length === 0) return;

    for (const ep of toDownload) {
      await new Promise<void>((resolve) => {
        downloadQueueRef.current.push({
          episode: ep,
          feed,
          resolve: () => { resolve(); },
        });
        processDownloadQueue();
      });
    }
  }, [processDownloadQueue]);

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
