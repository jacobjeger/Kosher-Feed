import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PLAYED_KEY = "@shiurpod_played_episodes";

type PlayedListener = (episodeId: string) => void;
const playedListeners = new Set<PlayedListener>();

export function notifyEpisodePlayed(episodeId: string) {
  AsyncStorage.getItem(PLAYED_KEY).then(data => {
    const arr: string[] = data ? JSON.parse(data) : [];
    if (!arr.includes(episodeId)) {
      arr.push(episodeId);
      if (arr.length > 5000) arr.splice(0, arr.length - 5000);
      AsyncStorage.setItem(PLAYED_KEY, JSON.stringify(arr)).catch(() => {});
    }
  }).catch(() => {});
  playedListeners.forEach(fn => fn(episodeId));
}

interface PlayedEpisodesContextValue {
  playedEpisodes: Set<string>;
  markAsPlayed: (episodeId: string) => void;
  markAsUnplayed: (episodeId: string) => void;
  isPlayed: (episodeId: string) => boolean;
  togglePlayed: (episodeId: string) => void;
}

const PlayedEpisodesContext = createContext<PlayedEpisodesContextValue | null>(null);

export function PlayedEpisodesProvider({ children }: { children: ReactNode }) {
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(PLAYED_KEY).then(data => {
      if (data) {
        try {
          const arr = JSON.parse(data);
          if (Array.isArray(arr)) setPlayedIds(new Set(arr));
        } catch {}
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const listener: PlayedListener = (episodeId: string) => {
      setPlayedIds(prev => {
        if (prev.has(episodeId)) return prev;
        const next = new Set(prev);
        next.add(episodeId);
        return next;
      });
    };
    playedListeners.add(listener);
    return () => { playedListeners.delete(listener); };
  }, []);

  const persist = useCallback((ids: Set<string>) => {
    const arr = Array.from(ids);
    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
    AsyncStorage.setItem(PLAYED_KEY, JSON.stringify(arr)).catch(() => {});
  }, []);

  const markAsPlayed = useCallback((episodeId: string) => {
    setPlayedIds(prev => {
      const next = new Set(prev);
      next.add(episodeId);
      persist(next);
      return next;
    });
  }, [persist]);

  const markAsUnplayed = useCallback((episodeId: string) => {
    setPlayedIds(prev => {
      const next = new Set(prev);
      next.delete(episodeId);
      persist(next);
      return next;
    });
  }, [persist]);

  const isPlayed = useCallback((episodeId: string) => {
    return playedIds.has(episodeId);
  }, [playedIds]);

  const togglePlayed = useCallback((episodeId: string) => {
    setPlayedIds(prev => {
      const next = new Set(prev);
      if (next.has(episodeId)) {
        next.delete(episodeId);
      } else {
        next.add(episodeId);
      }
      persist(next);
      return next;
    });
  }, [persist]);

  const value = useMemo(() => ({
    playedEpisodes: playedIds,
    markAsPlayed,
    markAsUnplayed,
    isPlayed,
    togglePlayed,
  }), [playedIds, markAsPlayed, markAsUnplayed, isPlayed, togglePlayed]);

  return (
    <PlayedEpisodesContext.Provider value={value}>
      {children}
    </PlayedEpisodesContext.Provider>
  );
}

export function usePlayedEpisodes() {
  const context = useContext(PlayedEpisodesContext);
  if (!context) throw new Error("usePlayedEpisodes must be used within PlayedEpisodesProvider");
  return context;
}
