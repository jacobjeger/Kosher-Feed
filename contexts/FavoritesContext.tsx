import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDeviceId } from "@/lib/device-id";
import { apiRequest, getApiUrl, queryClient } from "@/lib/query-client";
import type { Favorite } from "@/lib/types";
import { lightHaptic } from "@/lib/haptics";

interface FavoritesContextValue {
  favorites: Favorite[];
  toggleFavorite: (episodeId: string) => Promise<void>;
  isFavorite: (episodeId: string) => boolean;
  isLoading: boolean;
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // Initialize device ID on mount
  useEffect(() => {
    getDeviceId().then(setDeviceId).catch(() => {});
  }, []);

  // Fetch favorites using React Query
  const { isLoading } = useQuery({
    queryKey: ["/api/favorites", deviceId],
    queryFn: async () => {
      if (!deviceId) return [];
      const baseUrl = getApiUrl();
      const url = new URL(`/api/favorites/${deviceId}`, baseUrl);
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) return [];
      const data: Favorite[] = await res.json();
      setFavorites(data);
      return data;
    },
    enabled: !!deviceId,
    retry: 1,
  });

  const toggleFavorite = useCallback(
    async (episodeId: string) => {
      if (!deviceId) return;

      const isFav = favorites.some((f) => f.episodeId === episodeId);

      try {
        lightHaptic();

        if (isFav) {
          // Remove favorite
          await apiRequest("DELETE", `/api/favorites/${deviceId}/${episodeId}`);
          setFavorites((prev) => prev.filter((f) => f.episodeId !== episodeId));
        } else {
          // Add favorite
          const res = await apiRequest("POST", "/api/favorites", {
            episodeId,
            deviceId,
          });
          const newFavorite: Favorite = await res.json();
          setFavorites((prev) => [...prev, newFavorite]);
        }

        // Invalidate React Query cache to keep in sync
        queryClient.invalidateQueries({ queryKey: ["/api/favorites", deviceId] });
      } catch (e) {
        console.error("Failed to toggle favorite:", e);
      }
    },
    [favorites, deviceId]
  );

  const isFavorite = useCallback(
    (episodeId: string): boolean => {
      return favorites.some((f) => f.episodeId === episodeId);
    },
    [favorites]
  );

  const value = useMemo(
    () => ({
      favorites,
      toggleFavorite,
      isFavorite,
      isLoading,
    }),
    [favorites, toggleFavorite, isFavorite, isLoading]
  );

  return (
    <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>
  );
}

export function useFavorites() {
  const context = useContext(FavoritesContext);
  if (!context) {
    throw new Error("useFavorites must be used within FavoritesProvider");
  }
  return context;
}
