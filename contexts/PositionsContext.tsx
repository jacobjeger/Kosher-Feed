import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { loadPositions, onPositionsChanged } from "@/contexts/AudioPlayerContext";

interface SavedPosition {
  episodeId: string;
  feedId: string;
  positionMs: number;
  durationMs: number;
  updatedAt: string;
}

interface PositionsContextValue {
  positions: Record<string, SavedPosition>;
  refreshPositions: () => void;
  getPosition: (episodeId: string) => SavedPosition | null;
}

const PositionsContext = createContext<PositionsContextValue | null>(null);

export function PositionsProvider({ children }: { children: ReactNode }) {
  const [positions, setPositions] = useState<Record<string, SavedPosition>>({});
  const loadedRef = useRef(false);

  const refreshPositions = useCallback(() => {
    loadPositions().then(setPositions).catch(() => {});
  }, []);

  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      refreshPositions();
    }
    const unsub = onPositionsChanged(refreshPositions);
    return unsub;
  }, [refreshPositions]);

  const getPosition = useCallback((episodeId: string): SavedPosition | null => {
    return positions[episodeId] || null;
  }, [positions]);

  const value = useMemo(() => ({
    positions,
    refreshPositions,
    getPosition,
  }), [positions, refreshPositions, getPosition]);

  return (
    <PositionsContext.Provider value={value}>
      {children}
    </PositionsContext.Provider>
  );
}

export function usePositions() {
  const context = useContext(PositionsContext);
  if (!context) throw new Error("usePositions must be used within PositionsProvider");
  return context;
}
