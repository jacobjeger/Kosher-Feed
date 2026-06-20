// YTC: theme provider — light / dark / system.
//
// Mounted by app/ytc/_layout.tsx so the YTC subtree gets a context
// that components can consume via useYtcColors() (returns the active
// palette) or useYtcTheme() (full state + setter).
//
// Persistence: the user's choice ("light"|"dark"|"system") is saved
// to AsyncStorage. On mount we hydrate the preference + subscribe to
// the OS color-scheme via useColorScheme() so "system" mode follows
// the device.
//
// Components that need theme-aware colors can either:
//   const colors = useYtcColors();
//   <View style={{ backgroundColor: colors.bg }}>...</View>
// or use the makeYtcStyles helper for parameterized StyleSheets.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance, useColorScheme as useRNColorScheme, StyleSheet } from "react-native";
import AsyncStorage from "@/lib/kv";
import { ytcColors, ytcDarkColors, type YtcColorPalette } from "@/constants/ytcColors";

const STORAGE_KEY = "@ytc_theme:v1";

export type YtcThemeMode = "light" | "dark" | "system";

interface YtcThemeValue {
  mode: YtcThemeMode;            // user's choice
  resolved: "light" | "dark";    // effective scheme after resolving "system"
  colors: YtcColorPalette;       // active palette (ytcColors or ytcDarkColors)
  setMode: (m: YtcThemeMode) => Promise<void>;
}

const Ctx = createContext<YtcThemeValue>({
  mode: "system",
  resolved: "light",
  colors: ytcColors,
  setMode: async () => {},
});

export function YtcThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useRNColorScheme(); // "light" | "dark" | null
  const [mode, setModeState] = useState<YtcThemeMode>("system");

  // Hydrate persisted choice on mount (synchronously fall back to
  // system until storage resolves).
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw === "light" || raw === "dark" || raw === "system") {
          setModeState(raw);
        }
      })
      .catch(() => {});
  }, []);

  const setMode = useCallback(async (m: YtcThemeMode) => {
    setModeState(m);
    try { await AsyncStorage.setItem(STORAGE_KEY, m); } catch {}
  }, []);

  const resolved: "light" | "dark" = useMemo(() => {
    if (mode === "system") return systemScheme === "dark" ? "dark" : "light";
    return mode;
  }, [mode, systemScheme]);

  const colors = resolved === "dark" ? ytcDarkColors : ytcColors;

  const value: YtcThemeValue = useMemo(
    () => ({ mode, resolved, colors, setMode }),
    [mode, resolved, colors, setMode],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Active theme + setter. Use when you need the mode itself. */
export function useYtcTheme(): YtcThemeValue {
  return useContext(Ctx);
}

/** Active palette only. Use in render-time color references:
 *    const colors = useYtcColors();
 *    <View style={{ backgroundColor: colors.bg }}> */
export function useYtcColors(): YtcColorPalette {
  return useContext(Ctx).colors;
}

/** Helper that returns a stable hook for theme-parameterized styles.
 *  Usage:
 *    const useStyles = makeYtcStyles((c) => StyleSheet.create({
 *      container: { backgroundColor: c.bg, color: c.text },
 *    }));
 *    function Component() {
 *      const styles = useStyles();
 *      ...
 *    }
 */
export function makeYtcStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (c: YtcColorPalette) => T,
): () => T {
  return function useStyles(): T {
    const c = useYtcColors();
    return useMemo(() => factory(c), [c]);
  };
}

// Force-suppress the React Native bridge warning about Appearance
// being used during initial render — a no-op import here keeps
// TypeScript from complaining about the import being unused on web.
void Appearance;