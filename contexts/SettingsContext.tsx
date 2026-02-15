import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const SETTINGS_KEY = "@kosher_shiurim_settings";

interface AppSettings {
  notificationsEnabled: boolean;
  autoDownloadOnWifi: boolean;
  maxEpisodesPerFeed: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  notificationsEnabled: false,
  autoDownloadOnWifi: false,
  maxEpisodesPerFeed: 5,
};

interface SettingsContextValue {
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  isLoaded: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then(data => {
      if (data) {
        try {
          setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(data) });
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

  const value = useMemo(() => ({
    settings,
    updateSettings,
    isLoaded,
  }), [settings, updateSettings, isLoaded]);

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
