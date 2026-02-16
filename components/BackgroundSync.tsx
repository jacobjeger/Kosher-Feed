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
  setupNotificationChannel,
} from "@/lib/notifications";
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
    addLog("info", `BackgroundSync: initialized seen episodes (${latestEpisodesQuery.data.length} total)`, undefined, "background-sync");
  }, [latestEpisodesQuery.data]);

  const anyNotificationsEnabled = settings.notificationsEnabled || Object.values(feedSettingsMap).some(fs => fs.notificationsEnabled);

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
    if (now - lastCheckRef.current < 60000) return;
    lastCheckRef.current = now;

    const runCheck = async () => {
      try {
        addLog("info", `BackgroundSync: running check (${feeds.length} feeds, ${episodes.length} episodes, globalNotif=${settings.notificationsEnabled}, anyNotif=${anyNotificationsEnabled})`, undefined, "background-sync");

        if (anyNotificationsEnabled) {
          try {
            const hasPermission = await checkNotificationPermission();
            addLog("info", `BackgroundSync: notification permission=${hasPermission}`, undefined, "background-sync");
            if (hasPermission) {
              const newEps = await checkForNewEpisodes(feeds, episodes);
              addLog("info", `BackgroundSync: found ${newEps.length} new episodes for notification`, undefined, "background-sync");
              if (newEps.length > 0) {
                await notifyNewEpisodes(newEps, feeds);
                addLog("info", `BackgroundSync: sent notifications for ${newEps.length} episodes`, undefined, "background-sync");
              }
            } else {
              addLog("warn", "BackgroundSync: notifications enabled in settings but permission not granted on device", undefined, "background-sync");
            }
          } catch (e) {
            addLog("error", `BackgroundSync: notification check failed: ${(e as any)?.message || e}`, (e as any)?.stack, "background-sync");
          }
        } else {
          addLog("info", "BackgroundSync: notifications disabled (global and all per-feed)", undefined, "background-sync");
        }

        if (settings.autoDownloadOnWifi) {
          try {
            await autoDownloadNewEpisodes(feeds, settings.maxEpisodesPerFeed);
          } catch (e) {
            addLog("error", `BackgroundSync: auto-download failed: ${(e as any)?.message || e}`, (e as any)?.stack, "background-sync");
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
    settings.notificationsEnabled,
    settings.autoDownloadOnWifi,
    settings.maxEpisodesPerFeed,
    autoDownloadNewEpisodes,
    anyNotificationsEnabled,
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
