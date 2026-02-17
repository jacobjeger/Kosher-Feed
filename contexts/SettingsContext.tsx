import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { scheduleDailyReminder, cancelDailyReminder } from "@/lib/notifications";

const SETTINGS_KEY = "@kosher_shiurim_settings";
const FEED_SETTINGS_KEY = "@kosher_shiurim_feed_settings";

interface AppSettings {
  notificationsEnabled: boolean;
  autoDownloadOnWifi: boolean;
  maxEpisodesPerFeed: number;
  skipForwardSeconds: number;
  skipBackwardSeconds: number;
  audioBoostEnabled: boolean;
  continuousPlayback: boolean;
  darkModeOverride: 'system' | 'light' | 'dark';
  dailyReminderEnabled: boolean;
  dailyReminderHour: number;
}

export interface FeedSettings {
  notificationsEnabled: boolean;
  maxEpisodes: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  notificationsEnabled: false,
  autoDownloadOnWifi: false,
  maxEpisodesPerFeed: 5,
  skipForwardSeconds: 30,
  skipBackwardSeconds: 30,
  audioBoostEnabled: false,
  continuousPlayback: true,
  darkModeOverride: 'system',
  dailyReminderEnabled: false,
  dailyReminderHour: 8,
};

interface SettingsContextValue {
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  isLoaded: boolean;
  getFeedSettings: (feedId: string) => FeedSettings;
  updateFeedSettings: (feedId: string, partial: Partial<FeedSettings>) => void;
  feedSettingsMap: Record<string, FeedSettings>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [feedSettingsMap, setFeedSettingsMap] = useState<Record<string, FeedSettings>>({});
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(SETTINGS_KEY),
      AsyncStorage.getItem(FEED_SETTINGS_KEY),
    ]).then(([settingsData, feedData]) => {
      if (settingsData) {
        try {
          setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(settingsData) });
        } catch {}
      }
      if (feedData) {
        try {
          setFeedSettingsMap(JSON.parse(feedData));
        } catch {}
      }
      setIsLoaded(true);
    }).catch(() => setIsLoaded(true));
  }, []);

  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const getFeedSettings = useCallback((feedId: string): FeedSettings => {
    const custom = feedSettingsMap[feedId];
    return {
      notificationsEnabled: custom?.notificationsEnabled ?? settings.notificationsEnabled,
      maxEpisodes: custom?.maxEpisodes ?? settings.maxEpisodesPerFeed,
    };
  }, [feedSettingsMap, settings.notificationsEnabled, settings.maxEpisodesPerFeed]);

  const updateFeedSettings = useCallback((feedId: string, partial: Partial<FeedSettings>) => {
    setFeedSettingsMap(prev => {
      const existing = prev[feedId] || {};
      const next = { ...prev, [feedId]: { ...existing, ...partial } };
      AsyncStorage.setItem(FEED_SETTINGS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  // Handle daily reminder scheduling
  useEffect(() => {
    if (!isLoaded) return;

    if (settings.dailyReminderEnabled) {
      scheduleDailyReminder(settings.dailyReminderHour);
    } else {
      cancelDailyReminder();
    }
  }, [settings.dailyReminderEnabled, settings.dailyReminderHour, isLoaded]);

  const value = useMemo(() => ({
    settings,
    updateSettings,
    isLoaded,
    getFeedSettings,
    updateFeedSettings,
    feedSettingsMap,
  }), [settings, updateSettings, isLoaded, getFeedSettings, updateFeedSettings, feedSettingsMap]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings must be used within SettingsProvider");
  }
  return context;
}
