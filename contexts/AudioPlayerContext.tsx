import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Episode, Feed } from "@/lib/types";
import { addLog } from "@/lib/error-logger";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import { getQueue, addToQueue as addToQueueStorage, removeFromQueue as removeFromQueueStorage, clearQueue as clearQueueStorage, type QueueItem } from "@/lib/queue";
import { addToHistory, updateHistoryPosition } from "@/lib/history";
import { notifyEpisodePlayed } from "@/contexts/PlayedEpisodesContext";

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
  refreshQueue: () => Promise<void>;
  playNext: () => Promise<void>;
  subscribePosition: (cb: () => void) => () => void;
  getPositionSnapshot: () => PositionState;
  episodeCompleted: string | null;
  clearEpisodeCompleted: () => void;
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
  const [episodeCompleted, setEpisodeCompleted] = useState<string | null>(null);

  const clearEpisodeCompleted = useCallback(() => setEpisodeCompleted(null), []);

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
        try {
          const player = soundRef.current;
          const newPos = (player.currentTime || 0) * 1000;
          const newDur = (player.duration || 0) * 1000;
          const newIsPlaying = player.playing || false;
          positionRef.current = { positionMs: newPos, durationMs: newDur };
          playbackRef.current = { ...playbackRef.current, positionMs: newPos, durationMs: newDur, isPlaying: newIsPlaying };
          notifyPositionListeners();
          setPlayback(prev => {
            if (prev.isPlaying !== newIsPlaying) {
              return { ...prev, positionMs: newPos, durationMs: newDur, isPlaying: newIsPlaying };
            }
            return prev;
          });
        } catch {}
      }
    }, trackingInterval);
  }, [notifyPositionListeners]);

  const pause = useCallback(async () => {
    if (Platform.OS === "web") {
      audioRef.current?.pause();
    } else if (soundRef.current) {
      soundRef.current.pause();
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
          removeSavedPosition(episode.id).catch(() => {});
          updateHistoryPosition(episode.id, 0, 0).catch(() => {});
          notifyEpisodePlayed(episode.id);
          if (sleepTimerRef.current.active && sleepTimerRef.current.mode === "endOfEpisode") {
            cancelSleepTimer();
          } else if (queueRef.current.length > 0) {
            playNextRef.current();
          } else {
            AsyncStorage.getItem("@kosher_shiurim_settings").then(data => {
              try {
                const settings = data ? JSON.parse(data) : {};
                if (settings.continuousPlayback !== false) {
                  const feedId = currentFeedRef.current?.id;
                  if (feedId) {
                    const baseUrl = getApiUrl();
                    fetch(new URL(`/api/feeds/${feedId}/episodes?sort=newest&limit=50`, baseUrl).toString())
                      .then(r => r.json())
                      .then((episodes: any[]) => {
                        const currentIdx = episodes.findIndex((e: any) => e.id === episode.id);
                        const nextEp = currentIdx >= 0 && currentIdx < episodes.length - 1 ? episodes[currentIdx + 1] : null;
                        if (nextEp && currentFeedRef.current) {
                          playEpisodeInternalRef.current(nextEp, currentFeedRef.current, false);
                        } else {
                          setEpisodeCompleted(episode.id);
                          stopRef.current();
                        }
                      }).catch(() => {
                        setEpisodeCompleted(episode.id);
                        stopRef.current();
                      });
                  } else {
                    setEpisodeCompleted(episode.id);
                    stopRef.current();
                  }
                } else {
                  setEpisodeCompleted(episode.id);
                  stopRef.current();
                }
              } catch {
                setEpisodeCompleted(episode.id);
                stopRef.current();
              }
            }).catch(() => {
              setEpisodeCompleted(episode.id);
              stopRef.current();
            });
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
          try {
            soundRef.current.remove?.();
            soundRef.current.release?.();
          } catch {}
          soundRef.current = null;
        }

        setCurrentEpisode(episode);
        setCurrentFeed(feed);
        setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: savedPos, durationMs: 0, playbackRate: feedSpeed }));

        const { createAudioPlayer, setAudioModeAsync } = require("expo-audio");
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldRouteThroughEarpiece: false,
          shouldPlayInBackground: true,
          interruptionMode: "doNotMix",
        });

        let retryCount = 0;
        const maxRetries = 2;
        let player: any = null;

        while (retryCount <= maxRetries) {
          try {
            player = createAudioPlayer({ uri: episode.audioUrl });
            try { player.rate = feedSpeed; } catch {}
            break;
          } catch (loadError: any) {
            retryCount++;
            addLog("warn", `Audio load failed (attempt ${retryCount}/${maxRetries + 1}): ${loadError?.message || loadError}`, undefined, "audio");
            if (retryCount > maxRetries) {
              throw loadError;
            }
            await new Promise(resolve => setTimeout(resolve, 1500 * retryCount));
          }
        }

        if (!player) {
          throw new Error("Audio failed to load after retries");
        }

        soundRef.current = player;

        const statusSub = player.addListener("playbackStatusUpdate", (status: any) => {
          if (status?.didJustFinish || (status?.playing === false && player.currentTime > 0 && player.duration > 0 && player.currentTime >= player.duration - 0.5)) {
            savePosition(episode.id, feed.id, 0, 0);
            removeSavedPosition(episode.id).catch(() => {});
            updateHistoryPosition(episode.id, 0, 0).catch(() => {});
            notifyEpisodePlayed(episode.id);
            if (sleepTimerRef.current.active && sleepTimerRef.current.mode === "endOfEpisode") {
              cancelSleepTimer();
            } else if (queueRef.current.length > 0) {
              playNextRef.current();
            } else {
              AsyncStorage.getItem("@kosher_shiurim_settings").then(data => {
                try {
                  const settings = data ? JSON.parse(data) : {};
                  if (settings.continuousPlayback !== false) {
                    const feedId = currentFeedRef.current?.id;
                    if (feedId) {
                      const baseUrl = getApiUrl();
                      fetch(new URL(`/api/feeds/${feedId}/episodes?sort=newest&limit=50`, baseUrl).toString())
                        .then(r => r.json())
                        .then((episodes: any[]) => {
                          const currentIdx = episodes.findIndex((e: any) => e.id === episode.id);
                          const nextEp = currentIdx >= 0 && currentIdx < episodes.length - 1 ? episodes[currentIdx + 1] : null;
                          if (nextEp && currentFeedRef.current) {
                            playEpisodeInternalRef.current(nextEp, currentFeedRef.current, false);
                          } else {
                            setEpisodeCompleted(episode.id);
                            stopRef.current();
                          }
                        }).catch(() => {
                          setEpisodeCompleted(episode.id);
                          stopRef.current();
                        });
                    } else {
                      setEpisodeCompleted(episode.id);
                      stopRef.current();
                    }
                  } else {
                    setEpisodeCompleted(episode.id);
                    stopRef.current();
                  }
                } catch {
                  setEpisodeCompleted(episode.id);
                  stopRef.current();
                }
              }).catch(() => {
                setEpisodeCompleted(episode.id);
                stopRef.current();
              });
            }
          }
          if (status?.error) {
            addLog("error", `Audio playback error: ${status.error}`, undefined, "audio");
          }
        });
        (player as any).__statusSub = statusSub;

        if (savedPos > 0) {
          player.seekTo(savedPos / 1000);
        }
        player.play();

        try {
          player.setActiveForLockScreen?.(true);
        } catch {}

        const applyMetadata = () => {
          try {
            soundRef.current?.updateNowPlayingMetadata?.({
              title: episode.title || "Unknown",
              artist: feed.title || "ShiurPod",
              album: feed.title || "ShiurPod",
              artwork: feed.imageUrl || undefined,
            });
          } catch {}
        };
        applyMetadata();
        setTimeout(applyMetadata, 500);
        setTimeout(applyMetadata, 2000);

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

  const playEpisodeInternalRef = useRef(playEpisodeInternal);
  useEffect(() => { playEpisodeInternalRef.current = playEpisodeInternal; }, [playEpisodeInternal]);

  const resume = useCallback(async () => {
    try {
      if (Platform.OS === "web") {
        await audioRef.current?.play();
      } else if (soundRef.current) {
        soundRef.current.play();
        try {
          const ep = currentEpisodeRef.current;
          const feed = currentFeedRef.current;
          if (ep && feed) {
            soundRef.current.updateNowPlayingMetadata?.({
              title: ep.title || "Unknown",
              artist: feed.title || "ShiurPod",
              album: feed.title || "ShiurPod",
              artwork: feed.imageUrl || undefined,
            });
          }
        } catch {}
      } else {
        const ep = currentEpisodeRef.current;
        const feed = currentFeedRef.current;
        if (ep && feed) {
          addLog("warn", "Audio player released, reloading episode...", undefined, "audio");
          await playEpisodeInternal(ep, feed, true);
          return;
        }
        return;
      }
      setPlayback(prev => ({ ...prev, isPlaying: true }));
    } catch (e) {
      addLog("error", `Resume failed: ${(e as any)?.message || e}`, (e as any)?.stack, "audio");
    }
  }, [playEpisodeInternal]);

  const seekTo = useCallback(async (positionMs: number) => {
    try {
      if (Platform.OS === "web" && audioRef.current) {
        audioRef.current.currentTime = positionMs / 1000;
      } else if (soundRef.current) {
        soundRef.current.seekTo(positionMs / 1000);
      }
      setPlayback(prev => ({ ...prev, positionMs }));
    } catch (e) {
      addLog("warn", `Seek failed: ${(e as any)?.message || e}`, undefined, "audio");
    }
  }, []);

  const skip = useCallback(async (seconds: number) => {
    const newPos = Math.max(0, Math.min(playback.positionMs + seconds * 1000, playback.durationMs));
    await seekTo(newPos);
  }, [playback.positionMs, playback.durationMs, seekTo]);

  const setRate = useCallback(async (rate: number) => {
    setPlayback(prev => ({ ...prev, playbackRate: rate }));
    try {
      if (Platform.OS === "web" && audioRef.current) {
        audioRef.current.playbackRate = rate;
      } else if (soundRef.current) {
        try { soundRef.current.rate = rate; } catch {}
      }
    } catch (e) {
      addLog("warn", `Set rate failed: ${(e as any)?.message || e}`, undefined, "audio");
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
      try {
        soundRef.current.removeFromLockScreen?.();
      } catch {}
      try {
        soundRef.current.pause();
        soundRef.current.remove?.();
        soundRef.current.release?.();
      } catch {}
      soundRef.current = null;
    }
    setCurrentEpisode(null);
    setCurrentFeed(null);
    setPlayback({ isPlaying: false, isLoading: false, positionMs: 0, durationMs: 0, playbackRate: 1.0 });
  }, [saveCurrentPosition, cancelSleepTimer]);

  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

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

  const refreshQueue = useCallback(async () => {
    const q = await getQueue();
    setQueue(q);
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
    refreshQueue,
    playNext,
    subscribePosition,
    getPositionSnapshot,
    episodeCompleted,
    clearEpisodeCompleted,
  }), [currentEpisode, currentFeed, playback, playEpisode, pause, resume, seekTo, skip, setRate, stop, getSavedPosition, removeSavedPosition, recentlyPlayed, getFeedSpeed, sleepTimer, setSleepTimerFn, cancelSleepTimer, getInProgressEpisodes, queue, handleAddToQueue, handleRemoveFromQueue, handleClearQueue, refreshQueue, playNext, subscribePosition, getPositionSnapshot, episodeCompleted, clearEpisodeCompleted]);

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
