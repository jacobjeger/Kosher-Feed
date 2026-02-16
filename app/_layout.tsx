import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AudioPlayerProvider } from "@/contexts/AudioPlayerContext";
import { DownloadsProvider } from "@/contexts/DownloadsContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { FavoritesProvider } from "@/contexts/FavoritesContext";
import { BackgroundSync } from "@/components/BackgroundSync";
import { setupNotificationChannel } from "@/lib/notifications";
import { initErrorLogger } from "@/lib/error-logger";

SplashScreen.preventAutoHideAsync();
initErrorLogger();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="player"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen name="stats" options={{ headerShown: false }} />
      <Stack.Screen name="debug-logs" options={{ headerShown: false }} />
      <Stack.Screen
        name="podcast/[id]"
        options={{
          headerShown: false,
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
    setupNotificationChannel();
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <AudioPlayerProvider>
            <DownloadsProvider>
              <FavoritesProvider>
                <GestureHandlerRootView>
                  <KeyboardProvider>
                    <BackgroundSync />
                    <RootLayoutNav />
                  </KeyboardProvider>
                </GestureHandlerRootView>
              </FavoritesProvider>
            </DownloadsProvider>
          </AudioPlayerProvider>
        </SettingsProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
