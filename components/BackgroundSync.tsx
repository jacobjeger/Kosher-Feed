import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useSettings } from "@/contexts/SettingsContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl } from "@/lib/query-client";
import {
  checkForNewEpisodes,
  notifyNewEpisodes,
  initializeSeenEpisodes,
  checkNotificationPermission,
} from "@/lib/notifications";
import type { Feed, Episode } from "@/lib/types";

export function BackgroundSync() {
  const { settings } = useSettings();
  const { autoDownloadNewEpisodes } = useDownloads();
  const hasInitialized = useRef(false);
  const lastCheckRef = useRef(0);
  const mountedRef = useRef(true);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 15000);
    return () => clearTimeout(timer);
  }, []);

  const subscribedFeedsQuery = useQuery<Feed[]>({
    queryKey: ["/api/subscriptions/feeds/bg"],
    queryFn: async () => {
      const deviceId = await getDeviceId();
      const baseUrl = getApiUrl();
      const url = new URL(`/api/subscriptions/${deviceId}/feeds`, baseUrl);
      const res = await fetch(url.toString());
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
    enabled: ready,
  });

  const latestEpisodesQuery = useQuery<Episode[]>({
    queryKey: ["/api/episodes/latest/bg"],
    queryFn: async () => {
      const baseUrl = getApiUrl();
      const url = new URL("/api/episodes/latest?limit=100", baseUrl);
      const res = await fetch(url.toString());
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
    enabled: ready,
  });

  useEffect(() => {
    if (!latestEpisodesQuery.data || hasInitialized.current) return;
    initializeSeenEpisodes(latestEpisodesQuery.data);
    hasInitialized.current = true;
  }, [latestEpisodesQuery.data]);

  useEffect(() => {
    const feeds = subscribedFeedsQuery.data;
    const episodes = latestEpisodesQuery.data;
    if (!feeds || !episodes || feeds.length === 0) return;

    const now = Date.now();
    if (now - lastCheckRef.current < 60000) return;
    lastCheckRef.current = now;

    const runCheck = async () => {
      try {
        if (settings.notificationsEnabled) {
          try {
            const hasPermission = await checkNotificationPermission();
            if (hasPermission) {
              const newEps = await checkForNewEpisodes(feeds, episodes);
              if (newEps.length > 0) {
                await notifyNewEpisodes(newEps, feeds);
              }
            }
          } catch (e) {
            console.error(e);
          }
        }

        if (settings.autoDownloadOnWifi) {
          try {
            await autoDownloadNewEpisodes(feeds, settings.maxEpisodesPerFeed);
          } catch (e) {
            console.error(e);
          }
        }
      } catch (e) {
        console.error(e);
      }
    };

    runCheck();
  }, [
    subscribedFeedsQuery.data,
    latestEpisodesQuery.data,
    settings.notificationsEnabled,
    settings.autoDownloadOnWifi,
    settings.maxEpisodesPerFeed,
    autoDownloadNewEpisodes,
  ]);

  useEffect(() => {
    const handleAppState = (state: AppStateStatus) => {
      if (state === "active") {
        subscribedFeedsQuery.refetch();
        latestEpisodesQuery.refetch();
      }
    };
    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return null;
}
