import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from "react";
import { Platform } from "react-native";
import type { Episode, Feed } from "@/lib/types";
import { apiRequest } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";

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
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const soundRef = useRef<any>(null);
  const intervalRef = useRef<any>(null);
  const isLoadingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
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

    try {
      if (intervalRef.current) clearInterval(intervalRef.current);

      if (Platform.OS === "web") {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = "";
        }
        const audio = new Audio(episode.audioUrl);
        audio.playbackRate = playback.playbackRate;
        audioRef.current = audio;

        setCurrentEpisode(episode);
        setCurrentFeed(feed);
        setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: 0, durationMs: 0 }));

        audio.oncanplay = () => {
          audio.play().catch(console.error);
          setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true, durationMs: (audio.duration || 0) * 1000 }));
          startPositionTracking();
        };
        audio.onended = () => {
          setPlayback(prev => ({ ...prev, isPlaying: false }));
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
        setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: 0, durationMs: 0 }));

        const { Audio } = require("expo-av");
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          staysActiveInBackground: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
        });

        const { sound } = await Audio.Sound.createAsync(
          { uri: episode.audioUrl },
          { shouldPlay: true, rate: playback.playbackRate, shouldCorrectPitch: true }
        );

        soundRef.current = sound;
        setPlayback(prev => ({ ...prev, isLoading: false, isPlaying: true }));
        startPositionTracking();
      }
      getDeviceId().then(deviceId => {
        apiRequest("POST", "/api/listens", { episodeId: episode.id, deviceId }).catch(() => {});
      });
    } catch (e) {
      console.error("Failed to play episode:", e);
      setPlayback(prev => ({ ...prev, isLoading: false }));
    } finally {
      isLoadingRef.current = false;
    }
  }, [playback.playbackRate, startPositionTracking]);

  const pause = useCallback(async () => {
    if (Platform.OS === "web") {
      audioRef.current?.pause();
    } else if (soundRef.current) {
      await soundRef.current.pauseAsync?.();
    }
    setPlayback(prev => ({ ...prev, isPlaying: false }));
  }, []);

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
  }), [currentEpisode, currentFeed, playback, playEpisode, pause, resume, seekTo, skip, setRate, stop]);

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
