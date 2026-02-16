import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Episode, Feed } from "@/lib/types";
import { apiRequest } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";

const POSITIONS_KEY = "@kosher_shiurim_positions";
const RECENTLY_PLAYED_KEY = "@shiurpod_recently_played";

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
  recentlyPlayed: RecentlyPlayedEntry[];
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

async function loadPositions(): Promise<Record<string, SavedPosition>> {
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
  } catch (e) {
    console.error("Failed to save position:", e);
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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const soundRef = useRef<any>(null);
  const intervalRef = useRef<any>(null);
  const isLoadingRef = useRef(false);
  const currentEpisodeRef = useRef<Episode | null>(null);
  const currentFeedRef = useRef<Feed | null>(null);
  const playbackRef = useRef<PlaybackState>(playback);

  useEffect(() => {
    AsyncStorage.getItem(RECENTLY_PLAYED_KEY).then(data => {
      if (data) {
        try {
          setRecentlyPlayed(JSON.parse(data));
        } catch {}
      }
    }).catch(() => {});
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
    const positionSaveInterval = setInterval(saveCurrentPosition, 10000);
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

  const startPositionTracking = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      if (Platform.OS === "web" && audioRef.current) {
        setPlayback(prev => ({
          ...prev,
          positionMs: (audioRef.current?.currentTime || 0) * 1000,
          durationMs: (audioRef.current?.duration || 0) * 1000,
          isPlaying: !audioRef.current?.paused,
        }));
      } else if (soundRef.current) {
        soundRef.current.getStatusAsync?.().then((status: any) => {
          if (status?.isLoaded) {
            setPlayback(prev => ({
              ...prev,
              positionMs: status.positionMillis || 0,
              durationMs: status.durationMillis || 0,
              isPlaying: status.isPlaying || false,
              isLoading: status.isBuffering || false,
            }));
          }
        }).catch(() => {});
      }
    }, 500);
  }, []);

  const playEpisode = useCallback(async (episode: Episode, feed: Feed) => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    saveCurrentPosition();

    try {
      if (intervalRef.current) clearInterval(intervalRef.current);

      const savedPos = await getSavedPosition(episode.id);

      if (Platform.OS === "web") {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = "";
        }
        const audio = new Audio(episode.audioUrl);
        audio.playbackRate = playback.playbackRate;
        audio.preload = "auto";
        audioRef.current = audio;

        setCurrentEpisode(episode);
        setCurrentFeed(feed);
        setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: savedPos, durationMs: 0 }));

        audio.oncanplay = () => {
          if (savedPos > 0) {
            audio.currentTime = savedPos / 1000;
          }
          audio.play().catch(console.error);
          setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true, durationMs: (audio.duration || 0) * 1000 }));
          startPositionTracking();
        };
        audio.onended = () => {
          setPlayback(prev => ({ ...prev, isPlaying: false }));
          savePosition(episode.id, feed.id, 0, 0);
        };
        audio.onerror = () => {
          setPlayback(prev => ({ ...prev, isLoading: false }));
        };
      } else {
        if (soundRef.current) {
          await soundRef.current.unloadAsync?.();
          soundRef.current = null;
        }

        setCurrentEpisode(episode);
        setCurrentFeed(feed);
        setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: savedPos, durationMs: 0 }));

        const { Audio } = require("expo-av");
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          staysActiveInBackground: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
        });

        const initialStatus: any = {
          shouldPlay: true,
          rate: playback.playbackRate,
          shouldCorrectPitch: true,
          progressUpdateIntervalMillis: 500,
          androidImplementation: "MediaPlayer",
        };
        if (savedPos > 0) {
          initialStatus.positionMillis = savedPos;
        }

        const { sound } = await Audio.Sound.createAsync(
          { uri: episode.audioUrl },
          initialStatus
        );

        soundRef.current = sound;
        setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true }));
        startPositionTracking();
      }

      addRecentlyPlayed(episode.id, feed.id);

      getDeviceId().then(deviceId => {
        apiRequest("POST", "/api/listens", { episodeId: episode.id, deviceId }).catch(() => {});
      });
    } catch (e) {
      console.error("Failed to play episode:", e);
      setPlayback(prev => ({ ...prev, isLoading: false }));
    } finally {
      isLoadingRef.current = false;
    }
  }, [playback.playbackRate, startPositionTracking, getSavedPosition, saveCurrentPosition, addRecentlyPlayed]);

  const pause = useCallback(async () => {
    if (Platform.OS === "web") {
      audioRef.current?.pause();
    } else if (soundRef.current) {
      await soundRef.current.pauseAsync?.();
    }
    setPlayback(prev => ({ ...prev, isPlaying: false }));
    saveCurrentPosition();
  }, [saveCurrentPosition]);

  const resume = useCallback(async () => {
    if (Platform.OS === "web") {
      audioRef.current?.play();
    } else if (soundRef.current) {
      await soundRef.current.playAsync?.();
    }
    setPlayback(prev => ({ ...prev, isPlaying: true }));
  }, []);

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
  }, []);

  const stop = useCallback(async () => {
    saveCurrentPosition();
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
  }, [saveCurrentPosition]);

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
    recentlyPlayed,
  }), [currentEpisode, currentFeed, playback, playEpisode, pause, resume, seekTo, skip, setRate, stop, getSavedPosition, recentlyPlayed]);

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
