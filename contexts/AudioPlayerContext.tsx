import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from "react";
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import type { Episode, Feed } from "@/lib/types";

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

  const soundRef = useRef<Audio.Sound | null>(null);
  const isLoadingRef = useRef(false);

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      staysActiveInBackground: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, []);

  const onPlaybackStatusUpdate = useCallback((status: any) => {
    if (!status.isLoaded) return;
    setPlayback(prev => ({
      ...prev,
      isPlaying: status.isPlaying,
      isLoading: status.isBuffering,
      positionMs: status.positionMillis || 0,
      durationMs: status.durationMillis || 0,
      playbackRate: status.rate || prev.playbackRate,
    }));
  }, []);

  const playEpisode = useCallback(async (episode: Episode, feed: Feed) => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }

      setCurrentEpisode(episode);
      setCurrentFeed(feed);
      setPlayback(prev => ({ ...prev, isLoading: true, isPlaying: false, positionMs: 0, durationMs: 0 }));

      const audioUri = episode.audioUrl;

      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUri },
        { shouldPlay: true, rate: playback.playbackRate, shouldCorrectPitch: true },
        onPlaybackStatusUpdate
      );

      soundRef.current = sound;
    } catch (e) {
      console.error("Failed to play episode:", e);
      setPlayback(prev => ({ ...prev, isLoading: false }));
    } finally {
      isLoadingRef.current = false;
    }
  }, [playback.playbackRate, onPlaybackStatusUpdate]);

  const pause = useCallback(async () => {
    if (soundRef.current) {
      await soundRef.current.pauseAsync();
    }
  }, []);

  const resume = useCallback(async () => {
    if (soundRef.current) {
      await soundRef.current.playAsync();
    }
  }, []);

  const seekTo = useCallback(async (positionMs: number) => {
    if (soundRef.current) {
      await soundRef.current.setPositionAsync(positionMs);
    }
  }, []);

  const skip = useCallback(async (seconds: number) => {
    if (soundRef.current) {
      const status = await soundRef.current.getStatusAsync();
      if (status.isLoaded) {
        const newPos = Math.max(0, Math.min(status.positionMillis + seconds * 1000, status.durationMillis || 0));
        await soundRef.current.setPositionAsync(newPos);
      }
    }
  }, []);

  const setRate = useCallback(async (rate: number) => {
    setPlayback(prev => ({ ...prev, playbackRate: rate }));
    if (soundRef.current) {
      await soundRef.current.setRateAsync(rate, true);
    }
  }, []);

  const stop = useCallback(async () => {
    if (soundRef.current) {
      await soundRef.current.stopAsync();
      await soundRef.current.unloadAsync();
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
