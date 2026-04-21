import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiUrl } from "@/lib/query-client";
import { setAudioProxyRules } from "@/lib/audio-url";
import { applyDownloadConfig } from "@/contexts/DownloadsContext";
import { setAutoDeleteDelay } from "@/lib/auto-delete-download";

const CACHE_KEY = "@shiurpod_remote_config";

export interface AudioProxyRule {
  match: string; // regex pattern to match audio URLs
  replace: string; // replacement template ($1, $2 for capture groups)
}

export interface RemoteConfig {
  homeSections: string[];
  defaultSkipForward: number;
  defaultSkipBackward: number;
  defaultMaxEpisodes: number;
  carouselAutoScrollMs: number;
  featureFlags: Record<string, boolean>;
  minAppVersion: string;
  // Audio proxy rules — allows adding new source proxies without app update
  audioProxyRules: AudioProxyRule[];
  // Download settings
  maxConcurrentDownloads: number;
  maxDownloadRetries: number;
  downloadRetryDelayMs: number;
  autoDeleteDelayMs: number;
  // Pagination limits
  recommendationsLimit: number;
  [key: string]: any;
}

const DEFAULT_CONFIG: RemoteConfig = {
  homeSections: ["continue", "featured", "trending", "popular", "allShiurim", "maggidShiur", "categories", "recent"],
  defaultSkipForward: 30,
  defaultSkipBackward: 30,
  defaultMaxEpisodes: 5,
  carouselAutoScrollMs: 5000,
  featureFlags: {
    showRecommended: true,
    showMaggidShiur: true,
    showTrending: true,
    showContinueListening: true,
  },
  minAppVersion: "1.0.0",
  audioProxyRules: [
    { match: "https?://srv\\.kolhalashon\\.com/api/files/(?:GetMp3FileToPlay|getLocationOfFileToVideo)/(\\d+)", replace: "/api/audio/kh/$1" },
  ],
  maxConcurrentDownloads: 1,
  maxDownloadRetries: 2,
  downloadRetryDelayMs: 10000,
  autoDeleteDelayMs: 48 * 60 * 60 * 1000,
  recommendationsLimit: 10,
};

interface RemoteConfigContextValue {
  config: RemoteConfig;
  isLoaded: boolean;
  refresh: () => Promise<void>;
}

function applyConfig(cfg: RemoteConfig) {
  if (cfg.audioProxyRules) setAudioProxyRules(cfg.audioProxyRules);
  applyDownloadConfig({ maxConcurrentDownloads: cfg.maxConcurrentDownloads, maxDownloadRetries: cfg.maxDownloadRetries, downloadRetryDelayMs: cfg.downloadRetryDelayMs });
  if (cfg.autoDeleteDelayMs) setAutoDeleteDelay(cfg.autoDeleteDelayMs);
}

const RemoteConfigContext = createContext<RemoteConfigContextValue | null>(null);

export function RemoteConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RemoteConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const baseUrl = getApiUrl();
      const res = await fetch(`${baseUrl}/api/config`);
      if (res.ok) {
        const data = await res.json();
        const merged = { ...DEFAULT_CONFIG, ...data };
        setConfig(merged);
        applyConfig(merged);
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(merged)).catch(() => {});
        return;
      }
    } catch {}
    // On failure, try cached
    try {
      const cached = await AsyncStorage.getItem(CACHE_KEY);
      if (cached) {
        const merged = { ...DEFAULT_CONFIG, ...JSON.parse(cached) };
        setConfig(merged);
        applyConfig(merged);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchConfig().finally(() => setIsLoaded(true));
  }, [fetchConfig]);

  const refresh = useCallback(async () => {
    await fetchConfig();
  }, [fetchConfig]);

  const value = useMemo(() => ({ config, isLoaded, refresh }), [config, isLoaded, refresh]);

  return (
    <RemoteConfigContext.Provider value={value}>
      {children}
    </RemoteConfigContext.Provider>
  );
}

export function useRemoteConfig(): RemoteConfigContextValue {
  const context = useContext(RemoteConfigContext);
  if (!context) {
    throw new Error("useRemoteConfig must be used within RemoteConfigProvider");
  }
  return context;
}
