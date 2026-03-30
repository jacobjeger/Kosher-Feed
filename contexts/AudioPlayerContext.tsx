import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Platform, InteractionManager } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Episode, Feed } from "@/lib/types";
import { addLog } from "@/lib/error-logger";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import { getQueue, addToQueue as addToQueueStorage, removeFromQueue as removeFromQueueStorage, clearQueue as clearQueueStorage, initQueueFromServer, type QueueItem } from "@/lib/queue";
import { addToHistory, updateHistoryPosition } from "@/lib/history";
import { notifyEpisodePlayed } from "@/contexts/PlayedEpisodesContext";
// Dynamic imports to avoid circular dependency issues in production builds
const getAutoDelete = () => require("@/lib/auto-delete-download") as { markDownloadCompleted: (id: string) => void };
const getQueueUtils = () => require("@/lib/queue") as { reorderQueue: (items: any[]) => void };

let expoAudioModule: any = null;
let createAudioPlayerFn: any = null;
let setAudioModeAsyncFn: any = null;

// Rewrite KH direct audio URLs to go through our server proxy
function resolveAudioUrl(audioUrl: string): string {
  const khMatch = audioUrl.match(/https?:\/\/srv\.kolhalashon\.com\/api\/files\/(?:GetMp3FileToPlay|getLocationOfFileToVideo)\/(\d+)/);
  if (khMatch) {
    const fileId = khMatch[1];
    return `${getApiUrl()}/api/audio/kh/${fileId}`;
  }
  return audioUrl;
}

if (Platform.OS !== "web") {
  try {
    const expoAudio = require("expo-audio");
    createAudioPlayerFn = expoAudio.createAudioPlayer;
    setAudioModeAsyncFn = expoAudio.setAudioModeAsync;
    expoAudioModule = expoAudio.default || expoAudio.AudioModule;
  } catch (e) {
    addLog("warn", `expo-audio not available: ${(e as any)?.message}`, undefined, "audio");
  }
}

const POSITIONS_KEY = "@kosher_shiurim_positions";
const RECENTLY_PLAYED_KEY = "@shiurpod_recently_played";
const FEED_SPEEDS_KEY = "@shiurpod_feed_speeds";
const SETTINGS_KEY = "@kosher_shiurim_settings";
const BOOST_VOLUME = 1.5;
const NORMAL_VOLUME = 1.0;

async function getAudioBoostEnabled(): Promise<boolean> {
  try {
    const data = await AsyncStorage.getItem(SETTINGS_KEY);
    if (data) {
      const s = JSON.parse(data);
      return s.audioBoostEnabled === true;
    }
  } catch {}
  return false;
}

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
  setAudioBoost: (enabled: boolean) => void;
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

type PositionChangeListener = () => void;
const positionChangeListeners = new Set<PositionChangeListener>();
export function onPositionsChanged(cb: PositionChangeListener) {
  positionChangeListeners.add(cb);
  return () => { positionChangeListeners.delete(cb); };
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
    positionChangeListeners.forEach(fn => fn());
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
      feedId,
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

let nativePlayerInstance: any = null;
let nativePlayerReady = false;

async function initNativeAudio() {
  if (!setAudioModeAsyncFn || nativePlayerReady) return;
  try {
    await setAudioModeAsyncFn({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
      interruptionModeAndroid: "doNotMix",
      shouldDuckAndroid: false,
    });
    nativePlayerReady = true;
    addLog("info", "expo-audio initialized successfully", undefined, "audio");
  } catch (e: any) {
    addLog("error", `expo-audio init failed: ${e?.message || e}`, e?.stack, "audio");
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
  const intervalRef = useRef<any>(null);
  const isLoadingRef = useRef(false);
  const loadingGuardStartRef = useRef(0);
  const currentEpisodeRef = useRef<Episode | null>(null);
  const currentFeedRef = useRef<Feed | null>(null);
  const playbackRef = useRef<PlaybackState>(playback);
  const sleepTimerIntervalRef = useRef<any>(null);
  const sleepTimerRef = useRef<SleepTimerState>(sleepTimer);
  const queueRef = useRef<QueueItem[]>(queue);
  const nativePlayerRef = useRef<any>(null);
  const statusSubRef = useRef<any>(null);
  const preBufferRef = useRef<HTMLAudioElement | null>(null);
  const preBufferEpisodeIdRef = useRef<string | null>(null);

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
    initQueueFromServer().then(setQueue).catch(() => {});
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" && createAudioPlayerFn) {
      initNativeAudio();
    }
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
    intervalRef.current = setInterval(async () => {
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
      } else if (nativePlayerRef.current) {
        try {
          const player = nativePlayerRef.current;
          const newPos = (player.currentTime || 0) * 1000;
          const newDur = (player.duration || 0) * 1000;
          const newIsPlaying = !!player.playing;
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
    }, 500);
  }, [notifyPositionListeners]);

  const pause = useCallback(async () => {
    if (Platform.OS === "web") {
      audioRef.current?.pause();
    } else if (nativePlayerRef.current) {
      nativePlayerRef.current.pause();
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
      const targetTime = Date.now() + ms;
      setSleepTimerState({ active: true, remainingMs: ms, mode: "time" });

      sleepTimerIntervalRef.current = setInterval(() => {
        const remaining = targetTime - Date.now();
        if (remaining <= 0) {
          if (sleepTimerIntervalRef.current) {
            clearInterval(sleepTimerIntervalRef.current);
            sleepTimerIntervalRef.current = null;
          }
          pauseRef.current();
          setSleepTimerState({ active: false, remainingMs: 0, mode: "time" });
        } else {
          setSleepTimerState(prev => {
            if (!prev.active || prev.mode !== "time") return prev;
            return { ...prev, remainingMs: remaining };
          });
        }
      }, 500);
    }
  }, []);

  const cancelSleepTimer = useCallback(() => {
    if (sleepTimerIntervalRef.current) {
      clearInterval(sleepTimerIntervalRef.current);
      sleepTimerIntervalRef.current = null;
    }
    setSleepTimerState({ active: false, remainingMs: 0, mode: "time" });
  }, []);

  const handleEpisodeEnd = useCallback((episode: Episode, feed: Feed) => {
    setPlayback(prev => ({ ...prev, isPlaying: false }));
    savePosition(episode.id, feed.id, 0, 0);
    removeSavedPosition(episode.id).catch(() => {});
    updateHistoryPosition(episode.id, 0, 0).catch(() => {});
    notifyEpisodePlayed(episode.id);

    try {
      AsyncStorage.getItem("@kosher_shiurim_settings").then(data => {
        const s = data ? JSON.parse(data) : {};
        if (s.autoDeleteAfterListen === false) return;
        getAutoDelete().markDownloadCompleted(episode.id);
      }).catch(err => {
        addLog("warn", `Auto-delete check failed: ${(err as any)?.message || err}`, undefined, "audio");
      });
    } catch {}

    if (sleepTimerRef.current.active && sleepTimerRef.current.mode === "endOfEpisode") {
      cancelSleepTimer();
    } else if (queueRef.current.length > 0) {
      playNextRef.current();
    } else {
      const finishedEpisodeId = episode.id;
      AsyncStorage.getItem("@kosher_shiurim_settings").then(data => {
        try {
          const settings = data ? JSON.parse(data) : {};
          if (settings.continuousPlayback !== false) {
            const feedId = currentFeedRef.current?.id;
            if (feedId) {
              const baseUrl = getApiUrl();
              fetch(new URL(`/api/feeds/${feedId}/episodes?sort=newest&limit=50`, baseUrl).toString())
                .then(r => r.json())
                .then((eps: any[]) => {
                  // Guard: if user switched to a different episode during fetch, bail out
                  if (currentEpisodeRef.current?.id !== finishedEpisodeId && currentEpisodeRef.current !== null) return;
                  const currentIdx = eps.findIndex((e: any) => e.id === finishedEpisodeId);
                  const nextEp = currentIdx >= 0 && currentIdx < eps.length - 1 ? eps[currentIdx + 1] : null;
                  if (nextEp && currentFeedRef.current) {
                    playEpisodeInternalRef.current(nextEp, currentFeedRef.current, false);
                  } else {
                    setEpisodeCompleted(finishedEpisodeId);
                    stopRef.current();
                  }
                }).catch(() => {
                  setEpisodeCompleted(finishedEpisodeId);
                  stopRef.current();
                });
            } else {
              setEpisodeCompleted(finishedEpisodeId);
              stopRef.current();
            }
          } else {
            setEpisodeCompleted(finishedEpisodeId);
            stopRef.current();
          }
        } catch {
          setEpisodeCompleted(finishedEpisodeId);
          stopRef.current();
        }
      }).catch(() => {
        setEpisodeCompleted(finishedEpisodeId);
        stopRef.current();
      });
    }
  }, [cancelSleepTimer, removeSavedPosition]);

  const handleEpisodeEndRef = useRef(handleEpisodeEnd);
  useEffect(() => { handleEpisodeEndRef.current = handleEpisodeEnd; }, [handleEpisodeEnd]);

  const playEpisodeInternal = useCallback(async (episode: Episode, feed: Feed, skipHistory?: boolean) => {
    if (isLoadingRef.current) {
      // Allow retrying after 3s even if guard is set (previous attempt likely stuck)
      const guardAge = Date.now() - (loadingGuardStartRef.current || 0);
      if (guardAge < 3000) {
        addLog("warn", `Play blocked by loading guard for: ${episode.title} (${Math.round(guardAge)}ms ago)`, undefined, "audio");
        return;
      }
      addLog("warn", `Loading guard stale (${Math.round(guardAge)}ms) — forcing reset for: ${episode.title}`, undefined, "audio");
      isLoadingRef.current = false;
    }
    isLoadingRef.current = true;
    loadingGuardStartRef.current = Date.now();

    const safetyTimeout = setTimeout(() => {
      if (isLoadingRef.current) {
        addLog("warn", "Loading guard safety timeout — resetting after 15s", undefined, "audio");
        isLoadingRef.current = false;
        setPlayback(prev => prev.isLoading ? { ...prev, isLoading: false } : prev);
      }
    }, 15000);

    saveCurrentPosition();

    setCurrentEpisode(episode);
    setCurrentFeed(feed);
    setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: 0, durationMs: 0 }));

    try {
      if (intervalRef.current) clearInterval(intervalRef.current);

      if (Platform.OS === "web") {
        const [savedPos, feedSpeed, boostEnabled] = await Promise.all([
          getSavedPosition(episode.id),
          getFeedSpeed(feed.id),
          getAudioBoostEnabled(),
        ]);
        setPlayback(prev => ({ ...prev, positionMs: savedPos, playbackRate: feedSpeed }));

        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = "";
        }
        const audio = new Audio(resolveAudioUrl(episode.audioUrl));
        audio.playbackRate = feedSpeed;
        audio.volume = boostEnabled ? BOOST_VOLUME : NORMAL_VOLUME;
        audio.preload = "auto";
        audioRef.current = audio;

        audio.oncanplay = () => {
          if (savedPos > 0) {
            audio.currentTime = savedPos / 1000;
          }
          audio.play().catch(err => addLog("error", `Audio play failed: ${(err as any)?.message || err}`, undefined, "audio"));
          setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true, durationMs: (audio.duration || 0) * 1000 }));
          addLog("info", `Playing: ${episode.title} (feed: ${feed.title})`, undefined, "audio");
          startPositionTracking();
        };
        audio.onended = () => {
          handleEpisodeEndRef.current(episode, feed);
        };
        audio.onerror = () => {
          const code = audio.error?.code;
          const msg = audio.error?.message || '';
          const errorMap: Record<number, string> = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
          addLog("error", `Web audio error: ${episode.title} (${errorMap[code || 0] || 'UNKNOWN'}${msg ? ': ' + msg : ''})`, undefined, "audio");
          setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: false }));
        };
      } else if (createAudioPlayerFn && nativePlayerReady) {

        try {
          if (nativePlayerRef.current) {
            const oldPlayer = nativePlayerRef.current;
            nativePlayerRef.current = null;
            nativePlayerInstance = null;
            try { oldPlayer.pause(); } catch {}
            try { oldPlayer.clearLockScreenControls(); } catch {}
            // Remove listener subscription before destroying player
            if (statusSubRef.current) { try { statusSubRef.current.remove(); } catch {} statusSubRef.current = null; }
            try { oldPlayer.remove(); } catch {}
          }

          const player = createAudioPlayerFn(resolveAudioUrl(episode.audioUrl), {
            updateInterval: 500,
          });
          nativePlayerRef.current = player;
          nativePlayerInstance = player;

          let hasConfirmedPlaying = false;
          let lockScreenDone = false;
          const playStartTime = Date.now();

          const [savedPos, feedSpeed, boostEnabledNative] = await Promise.all([
            getSavedPosition(episode.id),
            getFeedSpeed(feed.id),
            getAudioBoostEnabled(),
          ]);
          setPlayback(prev => ({ ...prev, positionMs: savedPos, playbackRate: feedSpeed }));
          try { player.volume = boostEnabledNative ? BOOST_VOLUME : NORMAL_VOLUME; } catch {}
          try { player.setPlaybackRate(feedSpeed); } catch {}

          const setupLockScreen = () => {
            if (lockScreenDone || nativePlayerRef.current !== player) return;
            lockScreenDone = true;
            try {
              if (typeof player.setActiveForLockScreen === "function") {
                player.setActiveForLockScreen(true, {
                  title: episode.title || "Unknown",
                  artist: feed.title || "ShiurPod",
                  artworkUrl: feed.imageUrl || undefined,
                }, {
                  showSeekForward: true,
                  showSeekBackward: true,
                });
              }
            } catch (lockErr: any) {
              addLog("warn", `Lock screen setup failed: ${lockErr?.message}`, undefined, "audio");
            }
            setTimeout(() => {
              try {
                if (nativePlayerRef.current === player && typeof player.updateLockScreenMetadata === "function") {
                  player.updateLockScreenMetadata({
                    title: episode.title || "Unknown",
                    artist: feed.title || "ShiurPod",
                    artworkUrl: feed.imageUrl || undefined,
                  });
                }
              } catch {}
            }, 500);
          };

          statusSubRef.current = player.addListener("playbackStatusUpdate", (status: any) => {
            if (nativePlayerRef.current !== player) return;

            if (status.playing === true) {
              if (!hasConfirmedPlaying) {
                hasConfirmedPlaying = true;
                try { player.setPlaybackRate(feedSpeed); } catch {}
                setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true }));
                addLog("info", `Playing confirmed (expo-audio): ${episode.title} at ${feedSpeed}x`, undefined, "audio");
                setTimeout(setupLockScreen, 1500);
              } else {
                setPlayback(prev => prev.isPlaying ? prev : ({ ...prev, isPlaying: true }));
              }
            }

            if (status.playing === false && status.currentTime > 0 && status.duration > 0) {
              const ratio = status.currentTime / status.duration;
              if (ratio > 0.97) {
                const ep = currentEpisodeRef.current;
                const fd = currentFeedRef.current;
                if (ep && fd) {
                  handleEpisodeEndRef.current(ep, fd);
                }
              } else {
                setPlayback(prev => prev.isPlaying ? ({ ...prev, isPlaying: false }) : prev);
              }
            }
          });

          player.setPlaybackRate(feedSpeed);

          if (savedPos > 0) {
            player.seekTo(savedPos / 1000);
          }

          player.play();
          startPositionTracking();

          setTimeout(() => {
            if (!hasConfirmedPlaying && nativePlayerRef.current === player) {
              addLog("info", "Playback not confirmed after 15s, forcing state", undefined, "audio");
              hasConfirmedPlaying = true;
              setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true }));
              try { player.play(); } catch {}
              setTimeout(setupLockScreen, 1000);
            }
          }, 15000);

        } catch (audioErr: any) {
          const msg = audioErr?.message || String(audioErr);
          const isNetwork = /resolve host|no address|connection abort|network/i.test(msg);
          addLog("error", `expo-audio play failed: ${msg}`, audioErr?.stack, "audio");
          setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: false }));
          if (isNetwork) {
            addLog("warn", "Network unavailable — check your internet connection", undefined, "audio");
          }
        }
      } else {
        addLog("error", "No audio player available", undefined, "audio");
        setPlayback(prev => ({ ...prev, isLoading: false }));
      }

      const savedPos = positionRef.current.positionMs;
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
        return apiRequest("POST", "/api/listens", { episodeId: episode.id, deviceId });
      }).catch(err => addLog("warn", `Failed to record listen: ${(err as any)?.message || err}`, undefined, "audio"));
    } catch (e) {
      addLog("error", `Playback failed: ${episode.title} - ${(e as any)?.message || e}`, (e as any)?.stack, "audio");
      setPlayback(prev => ({ ...prev, isLoading: false }));
    } finally {
      isLoadingRef.current = false;
      clearTimeout(safetyTimeout);
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
      getQueueUtils().reorderQueue(remaining);
    }).catch(err => addLog("warn", `Queue reorder failed: ${(err as any)?.message || err}`, undefined, "audio"));

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
      setPlayback(prev => ({ ...prev, isPlaying: true }));
      if (Platform.OS === "web") {
        await audioRef.current?.play();
      } else if (nativePlayerRef.current) {
        const player = nativePlayerRef.current;
        player.play();

        const ep = currentEpisodeRef.current;
        const fd = currentFeedRef.current;
        if (ep && fd) {
          setTimeout(() => {
            try {
              if (nativePlayerRef.current === player && typeof player.setActiveForLockScreen === "function") {
                player.setActiveForLockScreen(true, {
                  title: ep.title || "Unknown",
                  artist: fd.title || "ShiurPod",
                  artworkUrl: fd.imageUrl || undefined,
                }, {
                  showSeekForward: true,
                  showSeekBackward: true,
                });
              }
            } catch {}
          }, 300);
        }
      } else {
        setPlayback(prev => ({ ...prev, isPlaying: false }));
        const ep = currentEpisodeRef.current;
        const feed = currentFeedRef.current;
        if (ep && feed) {
          addLog("warn", "Player not ready, reloading episode...", undefined, "audio");
          await playEpisodeInternal(ep, feed, true);
          return;
        }
        return;
      }
    } catch (e) {
      setPlayback(prev => ({ ...prev, isPlaying: false }));
      addLog("error", `Resume failed: ${(e as any)?.message || e}`, (e as any)?.stack, "audio");
    }
  }, [playEpisodeInternal]);

  const seekTo = useCallback(async (positionMs: number) => {
    try {
      if (Platform.OS === "web" && audioRef.current) {
        audioRef.current.currentTime = positionMs / 1000;
      } else if (nativePlayerRef.current) {
        nativePlayerRef.current.seekTo(positionMs / 1000);
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
      } else if (nativePlayerRef.current) {
        nativePlayerRef.current.setPlaybackRate(rate);
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
    } else if (nativePlayerRef.current) {
      const oldPlayer = nativePlayerRef.current;
      nativePlayerRef.current = null;
      nativePlayerInstance = null;
      try { oldPlayer.pause(); } catch {}
      try { oldPlayer.clearLockScreenControls(); } catch {}
      try { oldPlayer.remove(); } catch {}
    }
    if (preBufferRef.current) {
      preBufferRef.current.src = "";
      preBufferRef.current = null;
    }
    preBufferEpisodeIdRef.current = null;
    setCurrentEpisode(null);
    setCurrentFeed(null);
    setPlayback({ isPlaying: false, isLoading: false, positionMs: 0, durationMs: 0, playbackRate: 1.0 });
  }, [saveCurrentPosition, cancelSleepTimer]);

  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  const preBufferNextEpisode = useCallback(async () => {
    const q = queueRef.current;
    if (q.length === 0) return;
    const next = q[0];
    if (preBufferEpisodeIdRef.current === next.episodeId) return;
    if (Platform.OS !== "web") return;
    preBufferEpisodeIdRef.current = next.episodeId;
    try {
      const result = await fetchEpisodeAndFeed(next.episodeId, next.feedId);
      if (result && result.episode.audioUrl) {
        if (Platform.OS === "web") {
          const audio = new Audio();
          audio.preload = "auto";
          audio.src = resolveAudioUrl(result.episode.audioUrl);
          if (preBufferRef.current) {
            preBufferRef.current.src = "";
          }
          preBufferRef.current = audio;
        }
        addLog("info", `Pre-buffered next: ${result.episode.title}`, undefined, "audio");
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (playback.isPlaying && !playback.isLoading && queue.length > 0) {
      const timer = setTimeout(preBufferNextEpisode, 10000);
      return () => clearTimeout(timer);
    }
  }, [playback.isPlaying, playback.isLoading, queue.length, preBufferNextEpisode]);

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

  const setAudioBoost = useCallback((enabled: boolean) => {
    const vol = enabled ? BOOST_VOLUME : NORMAL_VOLUME;
    if (Platform.OS === "web" && audioRef.current) {
      audioRef.current.volume = vol;
    } else if (nativePlayerRef.current) {
      try { nativePlayerRef.current.volume = vol; } catch {}
    }
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
    setAudioBoost,
  }), [currentEpisode, currentFeed, playback, playEpisode, pause, resume, seekTo, skip, setRate, stop, getSavedPosition, removeSavedPosition, recentlyPlayed, getFeedSpeed, sleepTimer, setSleepTimerFn, cancelSleepTimer, getInProgressEpisodes, queue, handleAddToQueue, handleRemoveFromQueue, handleClearQueue, refreshQueue, playNext, subscribePosition, getPositionSnapshot, episodeCompleted, clearEpisodeCompleted, setAudioBoost]);

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
