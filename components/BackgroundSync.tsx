import { useEffect, useRef, useState } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { useSettings } from "@/contexts/SettingsContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl } from "@/lib/query-client";
import {
  initializeSeenEpisodes,
  setupNotificationChannel,
  checkForNewEpisodes,
  notifyNewEpisodes,
} from "@/lib/notifications";

import { cleanupExpiredDownloads } from "@/lib/auto-delete-download";
import type { Feed, Episode } from "@/lib/types";
import { addLog } from "@/lib/error-logger";

export function BackgroundSync() {
  const { settings, feedSettingsMap } = useSettings();
  const { autoDownloadNewEpisodes } = useDownloads();
  const hasInitialized = useRef(false);
  const lastCheckRef = useRef(0);
  const mountedRef = useRef(true);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    setupNotificationChannel().catch(() => {});

    if (Platform.OS !== "web") {
      Notifications.dismissAllNotificationsAsync().catch(() => {});
      Notifications.setBadgeCountAsync(0).catch(() => {});
    }

    const timer = setTimeout(() => setReady(true), 30000);
    return () => clearTimeout(timer);
  }, []);

  const subscribedFeedsQuery = useQuery<Feed[]>({
    queryKey: ["/api/subscriptions/feeds/bg"],
    queryFn: async () => {
      const deviceId = await getDeviceId();
      const baseUrl = getApiUrl();
      const url = new URL(`/api/subscriptions/${deviceId}/feeds`, baseUrl);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30 * 60 * 1000,
    staleTime: 20 * 60 * 1000,
    enabled: ready,
  });

  const latestEpisodesQuery = useQuery<Episode[]>({
    queryKey: ["/api/episodes/latest/bg"],
    queryFn: async () => {
      const baseUrl = getApiUrl();
      const url = new URL("/api/episodes/latest?limit=100", baseUrl);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30 * 60 * 1000,
    staleTime: 20 * 60 * 1000,
    enabled: ready,
  });

  useEffect(() => {
    if (!latestEpisodesQuery.data || hasInitialized.current) return;
    initializeSeenEpisodes(latestEpisodesQuery.data);
    hasInitialized.current = true;
    addLog("info", `BackgroundSync: initialized seen episodes (${latestEpisodesQuery.data.length} total)`, undefined, "background-sync");
  }, [latestEpisodesQuery.data]);

  useEffect(() => {
    const feeds = subscribedFeedsQuery.data;
    const episodes = latestEpisodesQuery.data;
    if (!feeds || !episodes || feeds.length === 0) {
      if (ready && !feeds) {
        addLog("info", "BackgroundSync: no subscribed feeds data yet", undefined, "background-sync");
      }
      return;
    }

    const now = Date.now();
    if (now - lastCheckRef.current < 5 * 60 * 1000) return;
    lastCheckRef.current = now;

    const runCheck = async () => {
      try {
        addLog("info", `BackgroundSync: running check (${feeds.length} feeds, ${episodes.length} episodes)`, undefined, "background-sync");

        if (settings.autoDownloadOnWifi) {
          try {
            await autoDownloadNewEpisodes(feeds, settings.maxEpisodesPerFeed);
          } catch (e) {
            addLog("error", `BackgroundSync: auto-download failed: ${(e as any)?.message || e}`, (e as any)?.stack, "background-sync");
          }
        }

        // Check for new episodes and send local notifications
        if (hasInitialized.current) {
          try {
            const newEpisodes = await checkForNewEpisodes(feeds, episodes);
            if (newEpisodes.length > 0) {
              addLog("info", `BackgroundSync: ${newEpisodes.length} new episode(s) detected`, undefined, "background-sync");
              await notifyNewEpisodes(newEpisodes, feeds);
            }
          } catch (e) {
            addLog("warn", `BackgroundSync: new episode check failed: ${(e as any)?.message || e}`, undefined, "background-sync");
          }
        }

        if (settings.autoDeleteAfterListen !== false) {
          try {
            const deviceId = await getDeviceId();
            const baseUrl = getApiUrl();
            const favRes = await fetch(new URL(`/api/favorites/${deviceId}`, baseUrl).toString());
            if (!favRes.ok) throw new Error(`Favorites HTTP ${favRes.status}`);
            const favs: any[] = await favRes.json();
            const favIds = favs.map((f: any) => f.episodeId);
            await cleanupExpiredDownloads(favIds);
          } catch (e) {
            addLog("warn", `BackgroundSync: auto-delete cleanup failed: ${(e as any)?.message || e}`, undefined, "background-sync");
          }
        }
      } catch (e) {
        addLog("error", `BackgroundSync: sync failed: ${(e as any)?.message || e}`, (e as any)?.stack, "background-sync");
      }
    };

    runCheck();
  }, [
    subscribedFeedsQuery.data,
    latestEpisodesQuery.data,
    settings.autoDownloadOnWifi,
    settings.maxEpisodesPerFeed,
    autoDownloadNewEpisodes,
  ]);

  useEffect(() => {
    const handleAppState = (state: AppStateStatus) => {
      if (state === "active") {
        subscribedFeedsQuery.refetch();
        latestEpisodesQuery.refetch();
        if (Platform.OS !== "web") {
          Notifications.dismissAllNotificationsAsync().catch(() => {});
          Notifications.setBadgeCountAsync(0).catch(() => {});
        }
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
