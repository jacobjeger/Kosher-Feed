import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Episode, Feed } from "@/lib/types";
import { addLog } from "@/lib/error-logger";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import { getQueue, addToQueue as addToQueueStorage, removeFromQueue as removeFromQueueStorage, clearQueue as clearQueueStorage, type QueueItem } from "@/lib/queue";
import { addToHistory, updateHistoryPosition } from "@/lib/history";

const POSITIONS_KEY = "@kosher_shiurim_positions";
const RECENTLY_PLAYED_KEY = "@shiurpod_recently_played";
const FEED_SPEEDS_KEY = "@shiurpod_feed_speeds";

interface SavedPosition {
  episodeId: string;
  feedId: string;
  positionMs: number;
  durationMs: number;
  updatedAt: string;
}

interface RecentlyPlayedEntry {
  episodeId: string;
  feedId: string;
  playedAt: number;
}

interface PlaybackState {
  isPlaying: boolean;
  isLoading: boolean;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
}

interface SleepTimerState {
  active: boolean;
  remainingMs: number;
  mode: "time" | "endOfEpisode";
}

interface PositionState {
  positionMs: number;
  durationMs: number;
}

interface AudioPlayerContextValue {
  currentEpisode: Episode | null;
  currentFeed: Feed | null;
  playback: PlaybackState;
  playEpisode: (episode: Episode, feed: Feed) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seekTo: (positionMs: number) => Promise<void>;
  skip: (seconds: number) => Promise<void>;
  setRate: (rate: number) => Promise<void>;
  stop: () => Promise<void>;
  getSavedPosition: (episodeId: string) => Promise<number>;
  removeSavedPosition: (episodeId: string) => Promise<void>;
  recentlyPlayed: RecentlyPlayedEntry[];
  getFeedSpeed: (feedId: string) => Promise<number>;
  sleepTimer: SleepTimerState;
  setSleepTimer: (minutes: number | "endOfEpisode") => void;
  cancelSleepTimer: () => void;
  getInProgressEpisodes: () => Promise<SavedPosition[]>;
  queue: QueueItem[];
  addToQueue: (episodeId: string, feedId: string) => Promise<void>;
  removeFromQueue: (episodeId: string) => Promise<void>;
  clearQueue: () => Promise<void>;
  playNext: () => Promise<void>;
  subscribePosition: (cb: () => void) => () => void;
  getPositionSnapshot: () => PositionState;
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export async function loadPositions(): Promise<Record<string, SavedPosition>> {
  try {
    const data = await AsyncStorage.getItem(POSITIONS_KEY);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

async function savePosition(episodeId: string, feedId: string, positionMs: number, durationMs: number) {
  try {
    const positions = await loadPositions();
    const completionRatio = durationMs > 0 ? positionMs / durationMs : 0;
    if (completionRatio > 0.97) {
      delete positions[episodeId];
    } else if (positionMs > 3000) {
      positions[episodeId] = {
        episodeId,
        feedId,
        positionMs,
        durationMs,
        updatedAt: new Date().toISOString(),
      };
    }
    const keys = Object.keys(positions);
    if (keys.length > 200) {
      const sorted = keys.sort((a, b) =>
        new Date(positions[a].updatedAt).getTime() - new Date(positions[b].updatedAt).getTime()
      );
      for (let i = 0; i < keys.length - 200; i++) {
        delete positions[sorted[i]];
      }
    }
    await AsyncStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
    syncPositionToServer(episodeId, feedId, positionMs, durationMs).catch(() => {});
  } catch (e) {
    console.error("Failed to save position:", e);
  }
}

async function syncPositionToServer(episodeId: string, feedId: string, positionMs: number, durationMs: number) {
  try {
    const deviceId = await getDeviceId();
    await apiRequest("POST", "/api/playback-positions", {
      episodeId,
      deviceId,
      positionMs: Math.round(positionMs),
      durationMs: Math.round(durationMs),
    });
  } catch {}
}

async function loadFeedSpeeds(): Promise<Record<string, number>> {
  try {
    const data = await AsyncStorage.getItem(FEED_SPEEDS_KEY);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

async function saveFeedSpeed(feedId: string, rate: number) {
  try {
    const speeds = await loadFeedSpeeds();
    speeds[feedId] = rate;
    await AsyncStorage.setItem(FEED_SPEEDS_KEY, JSON.stringify(speeds));
  } catch (e) {
    console.error("Failed to save feed speed:", e);
  }
}

async function fetchEpisodeAndFeed(episodeId: string, feedId: string): Promise<{ episode: Episode; feed: Feed } | null> {
  try {
    const baseUrl = getApiUrl();
    const feedUrl = new URL(`/api/feeds/${feedId}`, baseUrl);
    const episodesUrl = new URL(`/api/feeds/${feedId}/episodes`, baseUrl);
    const [feedRes, episodesRes] = await Promise.all([
      fetch(feedUrl.toString()),
      fetch(episodesUrl.toString()),
    ]);
    if (!feedRes.ok || !episodesRes.ok) return null;
    const feed: Feed = await feedRes.json();
    const episodes: Episode[] = await episodesRes.json();
    const episode = episodes.find((e) => e.id === episodeId);
    if (!episode) return null;
    return { episode, feed };
  } catch {
    return null;
  }
}

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const [currentEpisode, setCurrentEpisode] = useState<Episode | null>(null);
  const [currentFeed, setCurrentFeed] = useState<Feed | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>({
    isPlaying: false,
    isLoading: false,
    positionMs: 0,
    durationMs: 0,
    playbackRate: 1.0,
  });
  const [recentlyPlayed, setRecentlyPlayed] = useState<RecentlyPlayedEntry[]>([]);
  const [sleepTimer, setSleepTimerState] = useState<SleepTimerState>({
    active: false,
    remainingMs: 0,
    mode: "time",
  });
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const soundRef = useRef<any>(null);
  const intervalRef = useRef<any>(null);
  const isLoadingRef = useRef(false);
  const currentEpisodeRef = useRef<Episode | null>(null);
  const currentFeedRef = useRef<Feed | null>(null);
  const playbackRef = useRef<PlaybackState>(playback);
  const sleepTimerIntervalRef = useRef<any>(null);
  const sleepTimerRef = useRef<SleepTimerState>(sleepTimer);
  const queueRef = useRef<QueueItem[]>(queue);

  const positionRef = useRef<PositionState>({ positionMs: 0, durationMs: 0 });
  const positionListenersRef = useRef<Set<() => void>>(new Set());

  const subscribePosition = useCallback((cb: () => void) => {
    positionListenersRef.current.add(cb);
    return () => { positionListenersRef.current.delete(cb); };
  }, []);

  const getPositionSnapshot = useCallback(() => positionRef.current, []);

  useEffect(() => {
    sleepTimerRef.current = sleepTimer;
  }, [sleepTimer]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    AsyncStorage.getItem(RECENTLY_PLAYED_KEY).then(data => {
      if (data) {
        try {
          setRecentlyPlayed(JSON.parse(data));
        } catch {}
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    getQueue().then(setQueue).catch(() => {});
  }, []);

  const addRecentlyPlayed = useCallback(async (episodeId: string, feedId: string) => {
    setRecentlyPlayed(prev => {
      const filtered = prev.filter(e => e.episodeId !== episodeId);
      const updated = [{ episodeId, feedId, playedAt: Date.now() }, ...filtered].slice(0, 20);
      AsyncStorage.setItem(RECENTLY_PLAYED_KEY, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  }, []);

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  useEffect(() => {
    currentEpisodeRef.current = currentEpisode;
  }, [currentEpisode]);

  useEffect(() => {
    currentFeedRef.current = currentFeed;
  }, [currentFeed]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (sleepTimerIntervalRef.current) clearInterval(sleepTimerIntervalRef.current);
    };
  }, []);

  const saveCurrentPosition = useCallback(() => {
    const ep = currentEpisodeRef.current;
    const feed = currentFeedRef.current;
    const pb = playbackRef.current;
    if (ep && feed && pb.positionMs > 0) {
      savePosition(ep.id, feed.id, pb.positionMs, pb.durationMs);
    }
  }, []);

  useEffect(() => {
    const positionSaveInterval = setInterval(saveCurrentPosition, 30000);
    return () => clearInterval(positionSaveInterval);
  }, [saveCurrentPosition]);

  const getSavedPosition = useCallback(async (episodeId: string): Promise<number> => {
    try {
      const positions = await loadPositions();
      return positions[episodeId]?.positionMs || 0;
    } catch {
      return 0;
    }
  }, []);

  const removeSavedPosition = useCallback(async (episodeId: string): Promise<void> => {
    try {
      const positions = await loadPositions();
      delete positions[episodeId];
      await AsyncStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
    } catch (e) {
      console.error("Failed to remove saved position:", e);
    }
  }, []);

  const getFeedSpeed = useCallback(async (feedId: string): Promise<number> => {
    try {
      const speeds = await loadFeedSpeeds();
      return speeds[feedId] || 1.0;
    } catch {
      return 1.0;
    }
  }, []);

  const getInProgressEpisodes = useCallback(async (): Promise<SavedPosition[]> => {
    try {
      const positions = await loadPositions();
      return Object.values(positions).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    } catch {
      return [];
    }
  }, []);

  const notifyPositionListeners = useCallback(() => {
    positionListenersRef.current.forEach(fn => fn());
  }, []);

  const startPositionTracking = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const trackingInterval = Platform.OS === "web" ? 500 : 2000;
    intervalRef.current = setInterval(() => {
      if (Platform.OS === "web" && audioRef.current) {
        const newPos = (audioRef.current.currentTime || 0) * 1000;
        const newDur = (audioRef.current.duration || 0) * 1000;
        const newIsPlaying = !audioRef.current.paused;
        positionRef.current = { positionMs: newPos, durationMs: newDur };
        playbackRef.current = { ...playbackRef.current, positionMs: newPos, durationMs: newDur, isPlaying: newIsPlaying };
        notifyPositionListeners();
        setPlayback(prev => {
          if (prev.isPlaying !== newIsPlaying) {
            return { ...prev, positionMs: newPos, durationMs: newDur, isPlaying: newIsPlaying };
          }
          return prev;
        });
      } else if (soundRef.current) {
        soundRef.current.getStatusAsync?.().then((status: any) => {
          if (status?.isLoaded) {
            const newPos = status.positionMillis || 0;
            const newDur = status.durationMillis || 0;
            const newIsPlaying = status.isPlaying || false;
            const newIsLoading = status.isBuffering || false;
            positionRef.current = { positionMs: newPos, durationMs: newDur };
            playbackRef.current = { ...playbackRef.current, positionMs: newPos, durationMs: newDur, isPlaying: newIsPlaying, isLoading: newIsLoading };
            notifyPositionListeners();
            setPlayback(prev => {
              if (prev.isPlaying !== newIsPlaying || prev.isLoading !== newIsLoading) {
                return { ...prev, positionMs: newPos, durationMs: newDur, isPlaying: newIsPlaying, isLoading: newIsLoading };
              }
              return prev;
            });
          }
        }).catch(() => {});
      }
    }, trackingInterval);
  }, [notifyPositionListeners]);

  const pause = useCallback(async () => {
    if (Platform.OS === "web") {
      audioRef.current?.pause();
    } else if (soundRef.current) {
      await soundRef.current.pauseAsync?.();
    }
    setPlayback(prev => ({ ...prev, isPlaying: false }));
    saveCurrentPosition();
    const ep = currentEpisodeRef.current;
    const feed = currentFeedRef.current;
    const pb = playbackRef.current;
    if (ep && feed) {
      updateHistoryPosition(ep.id, pb.positionMs, pb.durationMs).catch(() => {});
    }
  }, [saveCurrentPosition]);

  const pauseRef = useRef(pause);
  useEffect(() => {
    pauseRef.current = pause;
  }, [pause]);

  const setSleepTimerFn = useCallback((minutes: number | "endOfEpisode") => {
    if (sleepTimerIntervalRef.current) {
      clearInterval(sleepTimerIntervalRef.current);
      sleepTimerIntervalRef.current = null;
    }

    if (minutes === "endOfEpisode") {
      setSleepTimerState({ active: true, remainingMs: 0, mode: "endOfEpisode" });
    } else {
      const ms = minutes * 60 * 1000;
      setSleepTimerState({ active: true, remainingMs: ms, mode: "time" });

      sleepTimerIntervalRef.current = setInterval(() => {
        setSleepTimerState(prev => {
          if (!prev.active || prev.mode !== "time") return prev;
          const newRemaining = prev.remainingMs - 1000;
          if (newRemaining <= 0) {
            if (sleepTimerIntervalRef.current) {
              clearInterval(sleepTimerIntervalRef.current);
              sleepTimerIntervalRef.current = null;
            }
            pauseRef.current();
            return { active: false, remainingMs: 0, mode: "time" };
          }
          return { ...prev, remainingMs: newRemaining };
        });
      }, 1000);
    }
  }, []);

  const cancelSleepTimer = useCallback(() => {
    if (sleepTimerIntervalRef.current) {
      clearInterval(sleepTimerIntervalRef.current);
      sleepTimerIntervalRef.current = null;
    }
    setSleepTimerState({ active: false, remainingMs: 0, mode: "time" });
  }, []);

  const playEpisodeInternal = useCallback(async (episode: Episode, feed: Feed, skipHistory?: boolean) => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    saveCurrentPosition();

    try {
      if (intervalRef.current) clearInterval(intervalRef.current);

      const [savedPos, feedSpeed] = await Promise.all([
        getSavedPosition(episode.id),
        getFeedSpeed(feed.id),
      ]);

      if (Platform.OS === "web") {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = "";
        }
        const audio = new Audio(episode.audioUrl);
        audio.playbackRate = feedSpeed;
        audio.preload = "auto";
        audioRef.current = audio;

        setCurrentEpisode(episode);
        setCurrentFeed(feed);
        setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: savedPos, durationMs: 0, playbackRate: feedSpeed }));

        audio.oncanplay = () => {
          if (savedPos > 0) {
            audio.currentTime = savedPos / 1000;
          }
          audio.play().catch(console.error);
          setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true, durationMs: (audio.duration || 0) * 1000 }));
          addLog("info", `Playing: ${episode.title} (feed: ${feed.title})`, undefined, "audio");
          startPositionTracking();
        };
        audio.onended = () => {
          setPlayback(prev => ({ ...prev, isPlaying: false }));
          savePosition(episode.id, feed.id, 0, 0);
          if (sleepTimerRef.current.active && sleepTimerRef.current.mode === "endOfEpisode") {
            cancelSleepTimer();
          } else {
            playNextRef.current();
          }
        };
        audio.onerror = () => {
          const retryCount = (audio as any).__retryCount || 0;
          if (retryCount < 2) {
            (audio as any).__retryCount = retryCount + 1;
            console.error(`Audio load failed, retrying (${retryCount + 1}/2)...`);
            setTimeout(() => {
              audio.load();
            }, 1000 * (retryCount + 1));
          } else {
            console.error("Audio playback failed after retries");
            setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: false }));
          }
        };
      } else {
        if (soundRef.current) {
          await soundRef.current.unloadAsync?.();
          soundRef.current = null;
        }

        setCurrentEpisode(episode);
        setCurrentFeed(feed);
        setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: savedPos, durationMs: 0, playbackRate: feedSpeed }));

        const { Audio } = require("expo-av");
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          staysActiveInBackground: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
        });

        const initialStatus: any = {
          shouldPlay: true,
          rate: feedSpeed,
          shouldCorrectPitch: true,
          progressUpdateIntervalMillis: 1000,
          androidImplementation: "SimpleExoPlayer",
        };
        if (savedPos > 0) {
          initialStatus.positionMillis = savedPos;
        }

        let retryCount = 0;
        const maxRetries = 2;
        let sound: any = null;

        while (retryCount <= maxRetries) {
          try {
            const result = await Audio.Sound.createAsync(
              { uri: episode.audioUrl },
              initialStatus
            );
            sound = result.sound;
            break;
          } catch (loadError: any) {
            retryCount++;
            console.error(`Audio load failed (attempt ${retryCount}/${maxRetries + 1}):`, loadError?.message || loadError);
            if (retryCount > maxRetries) {
              throw loadError;
            }
            await new Promise(resolve => setTimeout(resolve, 1500 * retryCount));
          }
        }

        if (!sound) {
          throw new Error("Audio failed to load after retries");
        }

        soundRef.current = sound;

        sound.setOnPlaybackStatusUpdate((status: any) => {
          if (status?.didJustFinish) {
            savePosition(episode.id, feed.id, 0, 0);
            if (sleepTimerRef.current.active && sleepTimerRef.current.mode === "endOfEpisode") {
              cancelSleepTimer();
            } else {
              playNextRef.current();
            }
          }
          if (status?.error) {
            console.error("Audio playback error:", status.error);
          }
        });

        setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true }));
        addLog("info", `Playing: ${episode.title} (feed: ${feed.title})`, undefined, "audio");
        startPositionTracking();
      }

      if (!skipHistory) {
        addRecentlyPlayed(episode.id, feed.id);
        addToHistory({
          episodeId: episode.id,
          feedId: feed.id,
          title: episode.title,
          feedTitle: feed.title,
          feedImageUrl: feed.imageUrl,
          positionMs: savedPos,
          durationMs: 0,
        }).catch(() => {});
      }

      getDeviceId().then(deviceId => {
        apiRequest("POST", "/api/listens", { episodeId: episode.id, deviceId }).catch(() => {});
      });
    } catch (e) {
      addLog("error", `Playback failed: ${episode.title} - ${(e as any)?.message || e}`, (e as any)?.stack, "audio");
      setPlayback(prev => ({ ...prev, isLoading: false }));
    } finally {
      isLoadingRef.current = false;
    }
  }, [startPositionTracking, getSavedPosition, getFeedSpeed, saveCurrentPosition, addRecentlyPlayed, cancelSleepTimer]);

  const playEpisode = useCallback(async (episode: Episode, feed: Feed) => {
    await playEpisodeInternal(episode, feed, false);
  }, [playEpisodeInternal]);

  const playNext = useCallback(async () => {
    const currentQueue = queueRef.current;
    if (currentQueue.length === 0) return;

    const nextItem = currentQueue[0];
    const remaining = currentQueue.slice(1);
    setQueue(remaining);
    clearQueueStorage().then(() => {
      const { reorderQueue } = require("@/lib/queue");
      reorderQueue(remaining);
    }).catch(() => {});

    const result = await fetchEpisodeAndFeed(nextItem.episodeId, nextItem.feedId);
    if (result) {
      await playEpisodeInternal(result.episode, result.feed, false);
    }
  }, [playEpisodeInternal]);

  const playNextRef = useRef(playNext);
  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  const resume = useCallback(async () => {
    try {
      if (Platform.OS === "web") {
        await audioRef.current?.play();
      } else if (soundRef.current) {
        const status = await soundRef.current.getStatusAsync?.();
        if (status?.isLoaded) {
          await soundRef.current.playAsync?.();
        } else {
          const ep = currentEpisodeRef.current;
          const feed = currentFeedRef.current;
          if (ep && feed) {
            console.warn("Audio unloaded, reloading episode...");
            await playEpisodeInternal(ep, feed, true);
            return;
          }
          return;
        }
      }
      setPlayback(prev => ({ ...prev, isPlaying: true }));
    } catch (e) {
      addLog("error", `Resume failed: ${(e as any)?.message || e}`, (e as any)?.stack, "audio");
    }
  }, [playEpisodeInternal]);

  const seekTo = useCallback(async (positionMs: number) => {
    if (Platform.OS === "web" && audioRef.current) {
      audioRef.current.currentTime = positionMs / 1000;
    } else if (soundRef.current) {
      await soundRef.current.setPositionAsync?.(positionMs);
    }
    setPlayback(prev => ({ ...prev, positionMs }));
  }, []);

  const skip = useCallback(async (seconds: number) => {
    const newPos = Math.max(0, Math.min(playback.positionMs + seconds * 1000, playback.durationMs));
    await seekTo(newPos);
  }, [playback.positionMs, playback.durationMs, seekTo]);

  const setRate = useCallback(async (rate: number) => {
    setPlayback(prev => ({ ...prev, playbackRate: rate }));
    if (Platform.OS === "web" && audioRef.current) {
      audioRef.current.playbackRate = rate;
    } else if (soundRef.current) {
      await soundRef.current.setRateAsync?.(rate, true);
    }
    const feed = currentFeedRef.current;
    if (feed) {
      saveFeedSpeed(feed.id, rate);
    }
  }, []);

  const stop = useCallback(async () => {
    saveCurrentPosition();
    cancelSleepTimer();
    const ep = currentEpisodeRef.current;
    const feed = currentFeedRef.current;
    const pb = playbackRef.current;
    if (ep && feed) {
      updateHistoryPosition(ep.id, pb.positionMs, pb.durationMs).catch(() => {});
    }
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (Platform.OS === "web") {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    } else if (soundRef.current) {
      await soundRef.current.stopAsync?.();
      await soundRef.current.unloadAsync?.();
      soundRef.current = null;
    }
    setCurrentEpisode(null);
    setCurrentFeed(null);
    setPlayback({ isPlaying: false, isLoading: false, positionMs: 0, durationMs: 0, playbackRate: 1.0 });
  }, [saveCurrentPosition, cancelSleepTimer]);

  useEffect(() => {
    if (sleepTimerRef.current.active && sleepTimerRef.current.mode === "endOfEpisode" && !playback.isPlaying && playback.positionMs > 0 && playback.durationMs > 0) {
      const ratio = playback.positionMs / playback.durationMs;
      if (ratio > 0.97) {
        cancelSleepTimer();
      }
    }
  }, [playback.isPlaying, playback.positionMs, playback.durationMs, cancelSleepTimer]);

  const handleAddToQueue = useCallback(async (episodeId: string, feedId: string) => {
    await addToQueueStorage(episodeId, feedId);
    const updated = await getQueue();
    setQueue(updated);
  }, []);

  const handleRemoveFromQueue = useCallback(async (episodeId: string) => {
    await removeFromQueueStorage(episodeId);
    const updated = await getQueue();
    setQueue(updated);
  }, []);

  const handleClearQueue = useCallback(async () => {
    await clearQueueStorage();
    setQueue([]);
  }, []);

  const value = useMemo(() => ({
    currentEpisode,
    currentFeed,
    playback,
    playEpisode,
    pause,
    resume,
    seekTo,
    skip,
    setRate,
    stop,
    getSavedPosition,
    removeSavedPosition,
    recentlyPlayed,
    getFeedSpeed,
    sleepTimer,
    setSleepTimer: setSleepTimerFn,
    cancelSleepTimer,
    getInProgressEpisodes,
    queue,
    addToQueue: handleAddToQueue,
    removeFromQueue: handleRemoveFromQueue,
    clearQueue: handleClearQueue,
    playNext,
    subscribePosition,
    getPositionSnapshot,
  }), [currentEpisode, currentFeed, playback, playEpisode, pause, resume, seekTo, skip, setRate, stop, getSavedPosition, removeSavedPosition, recentlyPlayed, getFeedSpeed, sleepTimer, setSleepTimerFn, cancelSleepTimer, getInProgressEpisodes, queue, handleAddToQueue, handleRemoveFromQueue, handleClearQueue, playNext, subscribePosition, getPositionSnapshot]);

  return (
    <AudioPlayerContext.Provider value={value}>
      {children}
    </AudioPlayerContext.Provider>
  );
}

export function useAudioPlayer() {
  const context = useContext(AudioPlayerContext);
  if (!context) {
    throw new Error("useAudioPlayer must be used within AudioPlayerProvider");
  }
  return context;
}

export function usePlaybackPosition() {
  const { subscribePosition, getPositionSnapshot } = useAudioPlayer();
  return useSyncExternalStore(subscribePosition, getPositionSnapshot, getPositionSnapshot);
}
