import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File } from "expo-file-system";
import * as LegacyFS from "expo-file-system/legacy";
import { Platform, InteractionManager } from "react-native";
import type { Episode, Feed, DownloadedEpisode } from "@/lib/types";
import { isOnWifi } from "@/lib/network";
import { getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import { addLog } from "@/lib/error-logger";

const PROGRESS_THROTTLE_MS = 4000;
const PROGRESS_UPDATE_MIN_CHANGE = 0.10;
const MAX_CONCURRENT_DOWNLOADS = 1;
const MAX_RETRY_COUNT = 2;

// Rewrite KH direct audio URLs to go through our server proxy
function resolveAudioUrl(audioUrl: string): string {
  const khMatch = audioUrl.match(/https?:\/\/srv\.kolhalashon\.com\/api\/files\/(?:GetMp3FileToPlay|getLocationOfFileToVideo)\/(\d+)/);
  if (khMatch) {
    const fileId = khMatch[1];
    return `${getApiUrl()}/api/audio/kh/${fileId}`;
  }
  return audioUrl;
}
const RETRY_BASE_DELAY_MS = 10000;

interface FailedDownloadInfo {
  retryCount: number;
  lastAttempt: number;
}

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
  failedDownloads: Map<string, FailedDownloadInfo>;
  retryDownload: (episodeId: string) => Promise<void>;
  retryAllFailed: () => Promise<void>;
  isRetrying: (episodeId: string) => boolean;
}

const DOWNLOADS_KEY = "@kosher_podcast_downloads";
const DownloadsContext = createContext<DownloadsContextValue | null>(null);

async function fileExistsSafeAsync(uri: string): Promise<boolean> {
  try {
    if (!uri) return false;
    const info = await LegacyFS.getInfoAsync(uri);
    return info.exists;
  } catch {
    return false;
  }
}

function fileExistsSafe(uri: string): boolean {
  try {
    if (!uri) return false;
    const f = new File(uri);
    return f.exists;
  } catch {
    try {
      return false;
    } catch {
      return false;
    }
  }
}

async function deleteFileSafeAsync(uri: string): Promise<void> {
  try {
    if (!uri) return;
    await LegacyFS.deleteAsync(uri, { idempotent: true });
  } catch {}
}

function deleteFileSafe(uri: string): void {
  try {
    if (!uri) return;
    LegacyFS.deleteAsync(uri, { idempotent: true }).catch(() => {});
  } catch {}
}

async function ensurePodcastsDir(): Promise<string> {
  const baseDir = LegacyFS.documentDirectory;
  if (!baseDir) throw new Error("documentDirectory not available");
  const podcastsDirUri = baseDir + 'podcasts/';
  const dirInfo = await LegacyFS.getInfoAsync(podcastsDirUri);
  if (!dirInfo.exists) {
    await LegacyFS.makeDirectoryAsync(podcastsDirUri, { intermediates: true });
  }
  return podcastsDirUri;
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
  const [failedDownloads, setFailedDownloads] = useState<Map<string, FailedDownloadInfo>>(new Map());
  const failedDownloadsRef = useRef<Map<string, FailedDownloadInfo>>(new Map());
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const retryingIdsRef = useRef<Set<string>>(new Set());
  const episodeDataRef = useRef<Map<string, { episode: Episode; feed: Feed }>>(new Map());

  useEffect(() => {
    progressTimerRef.current = setInterval(() => {
      const current = progressRef.current;
      if (current.size > 0) {
        const snapshot = Array.from(current.entries()).map(([k, v]) => `${k}:${Math.round(v * 20)}`).join(",");
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
      retryTimersRef.current.forEach(timer => clearTimeout(timer));
      retryTimersRef.current.clear();
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
              const exists = await fileExistsSafeAsync(dl.localUri);
              if (exists) {
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

  const processQueueFnRef = useRef<() => void>(() => {});

  const scheduleRetry = useCallback((episodeId: string) => {
    const info = failedDownloadsRef.current.get(episodeId);
    if (!info || info.retryCount >= MAX_RETRY_COUNT) return;
    const data = episodeDataRef.current.get(episodeId);
    if (!data) return;

    const delay = RETRY_BASE_DELAY_MS * Math.pow(3, info.retryCount);
    addLog("info", `Scheduling retry #${info.retryCount + 1} for ${episodeId} in ${delay}ms`, undefined, "downloads");

    const existing = retryTimersRef.current.get(episodeId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      retryTimersRef.current.delete(episodeId);
      retryingIdsRef.current.add(episodeId);
      const nextCount = info.retryCount + 1;
      failedDownloadsRef.current.set(episodeId, { retryCount: nextCount, lastAttempt: Date.now() });
      setFailedDownloads(new Map(failedDownloadsRef.current));

      downloadQueueRef.current.push({
        episode: data.episode,
        feed: data.feed,
        resolve: () => {
          retryingIdsRef.current.delete(episodeId);
        },
      });
      processQueueFnRef.current();
    }, delay);
    retryTimersRef.current.set(episodeId, timer);
  }, []);

  const downloadSingleEpisode = useCallback(async (episode: Episode, feed: Feed): Promise<DownloadedEpisode | null> => {
    if (activeDownloadsRef.current.has(episode.id)) return null;
    activeDownloadsRef.current.add(episode.id);
    downloadingIdsCache.add(episode.id);

    episodeDataRef.current.set(episode.id, { episode, feed });

    if (Platform.OS === "web") {
      try {
        const origin = typeof window !== "undefined" ? window.location.origin : getApiUrl();
        const downloadUrl = `${origin}/api/episodes/${episode.id}/download`;
        window.open(downloadUrl, "_blank");
      } catch (e) {
        console.error("Web download failed:", e);
      }
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

    const podcastsDirUri = await ensurePodcastsDir();
    const safeFilename = episode.id.replace(/[^a-zA-Z0-9]/g, "_") + ".mp3";
    const fileUri = podcastsDirUri + safeFilename;

    // Check disk space before downloading (require at least 100MB free)
    try {
      const freeBytes = await LegacyFS.getFreeDiskStorageAsync();
      if (freeBytes < 100 * 1024 * 1024) {
        addLog("warn", `Download skipped: low disk space (${Math.round(freeBytes / 1024 / 1024)}MB free)`, undefined, "downloads");
        return null;
      }
    } catch {}

    progressRef.current.set(episode.id, 0);
    addLog("info", `Starting download: ${episode.title} -> ${fileUri}`, undefined, "downloads");
    addLog("info", `Audio URL: ${episode.audioUrl}`, undefined, "downloads");

    try {
      let lastReportedPct = 0;
      let lastCallbackTime = 0;
      const downloadResumable = LegacyFS.createDownloadResumable(
        resolveAudioUrl(episode.audioUrl),
        fileUri,
        {
          headers: {
            "User-Agent": "ShiurPod/1.0",
          },
        },
        (progress) => {
          if (progress.totalBytesExpectedToWrite <= 0) return;
          const now = Date.now();
          if (now - lastCallbackTime < 1000) return;
          const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
          if (pct - lastReportedPct >= 0.02 || pct >= 1) {
            lastCallbackTime = now;
            lastReportedPct = pct;
            progressRef.current.set(episode.id, pct);
          }
        }
      );

      let result: Awaited<ReturnType<typeof downloadResumable.downloadAsync>> | null = null;
      try {
        result = await downloadResumable.downloadAsync();
      } catch (directErr: any) {
        const errMsg = directErr?.message || '';
        // SSL cert errors or network failures — retry through server proxy
        if (errMsg.includes('CertPath') || errMsg.includes('SSL') || errMsg.includes('Trust anchor') || errMsg.includes('certificate')) {
          addLog("warn", `Direct download SSL error, retrying via proxy: ${episode.title}`, undefined, "downloads");
          const proxyUrl = `${getApiUrl()}/api/audio/proxy?url=${encodeURIComponent(episode.audioUrl)}`;
          const proxyResumable = LegacyFS.createDownloadResumable(proxyUrl, fileUri, {
            headers: { "User-Agent": "ShiurPod/1.0" },
          });
          result = await proxyResumable.downloadAsync();
        } else {
          throw directErr;
        }
      }
      if (!result) throw new Error("Download returned null result");

      addLog("info", `Download result: uri=${result.uri}, status=${result.status}, headers=${JSON.stringify(result.headers || {}).substring(0, 200)}`, undefined, "downloads");

      if (result.status && result.status >= 400) {
        throw new Error(`Download failed with HTTP status ${result.status}`);
      }

      const fileInfo = await LegacyFS.getInfoAsync(result.uri, { size: true });
      if (!fileInfo.exists) {
        throw new Error(`Downloaded file does not exist at ${result.uri}`);
      }
      const fileSize = (fileInfo as any).size || 0;
      addLog("info", `Download verified: ${episode.title} - ${fileSize} bytes at ${result.uri}`, undefined, "downloads");

      if (fileSize < 1000) {
        addLog("warn", `Downloaded file suspiciously small (${fileSize} bytes), may be invalid: ${episode.title}`, undefined, "downloads");
        await deleteFileSafeAsync(result.uri);
        throw new Error(`Downloaded file too small (${fileSize} bytes), likely not a valid audio file`);
      }

      return {
        ...episode,
        localUri: result.uri,
        feedTitle: feed.title,
        feedImageUrl: feed.imageUrl,
        downloadedAt: new Date().toISOString(),
      };
    } catch (e) {
      addLog("error", `Download failed: ${episode.title} - ${(e as any)?.message || e}`, (e as any)?.stack, "downloads");
      // Clean up partial file on error
      try { await LegacyFS.deleteAsync(fileUri, { idempotent: true }); } catch {}
      const existing = failedDownloadsRef.current.get(episode.id);
      const retryCount = existing ? existing.retryCount : 0;
      failedDownloadsRef.current.set(episode.id, { retryCount, lastAttempt: Date.now() });
      setFailedDownloads(new Map(failedDownloadsRef.current));
      if (retryCount < MAX_RETRY_COUNT) {
        scheduleRetry(episode.id);
      }
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
        failedDownloadsRef.current.delete(item.episode.id);
        setFailedDownloads(new Map(failedDownloadsRef.current));
        const existingTimer = retryTimersRef.current.get(item.episode.id);
        if (existingTimer) {
          clearTimeout(existingTimer);
          retryTimersRef.current.delete(item.episode.id);
        }
        retryingIdsRef.current.delete(item.episode.id);

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

  processQueueFnRef.current = processDownloadQueue;

  const downloadEpisode = useCallback(async (episode: Episode, feed: Feed) => {
    if (activeDownloadsRef.current.has(episode.id) || downloadingIdsCache.has(episode.id) || downloadedIdsCache.has(episode.id)) return;
    activeDownloadsRef.current.add(episode.id);
    downloadingIdsCache.add(episode.id);
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

  const retryDownload = useCallback(async (episodeId: string) => {
    const data = episodeDataRef.current.get(episodeId);
    if (!data) {
      addLog("warn", `Cannot retry download ${episodeId}: no stored episode data`, undefined, "downloads");
      return;
    }
    failedDownloadsRef.current.delete(episodeId);
    setFailedDownloads(new Map(failedDownloadsRef.current));
    const existingTimer = retryTimersRef.current.get(episodeId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      retryTimersRef.current.delete(episodeId);
    }
    await downloadEpisode(data.episode, data.feed);
  }, [downloadEpisode]);

  const retryAllFailed = useCallback(async () => {
    const failedIds = Array.from(failedDownloadsRef.current.keys());
    for (const episodeId of failedIds) {
      await retryDownload(episodeId);
    }
  }, [retryDownload]);

  const isRetrying = useCallback((episodeId: string) => {
    return retryingIdsRef.current.has(episodeId) || retryTimersRef.current.has(episodeId);
  }, [failedDownloads]);

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
    failedDownloads,
    retryDownload,
    retryAllFailed,
    isRetrying,
  }), [downloads, downloadProgress, downloadEpisode, removeDownload, isDownloaded, isDownloading, getLocalUri, autoDownloadNewEpisodes, enforceStorageLimit, getDownloadsForFeed, batchDownload, failedDownloads, retryDownload, retryAllFailed, isRetrying]);

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
