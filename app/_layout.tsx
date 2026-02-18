import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as Notifications from "expo-notifications";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AudioPlayerProvider } from "@/contexts/AudioPlayerContext";
import { DownloadsProvider } from "@/contexts/DownloadsContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { FavoritesProvider } from "@/contexts/FavoritesContext";
import { PlayedEpisodesProvider } from "@/contexts/PlayedEpisodesContext";
import { PositionsProvider } from "@/contexts/PositionsContext";
import { BackgroundSync } from "@/components/BackgroundSync";
import OfflineBanner from "@/components/OfflineBanner";
import { setupNotificationChannel } from "@/lib/notifications";
import { initErrorLogger, setupGlobalErrorHandlers } from "@/lib/error-logger";
import { defineBackgroundTasks } from "@/lib/background-tasks";
import { DeepLinkHandler } from "@/components/DeepLinkHandler";
import { getNotificationData } from "@/lib/push-notifications";
import { addLog } from "@/lib/error-logger";

SplashScreen.preventAutoHideAsync();
initErrorLogger();
setupGlobalErrorHandlers();
defineBackgroundTasks();


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
      <Stack.Screen
        name="queue"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen name="all-shiurim" options={{ headerShown: false }} />
      <Stack.Screen name="all-maggidei-shiur" options={{ headerShown: false }} />
      <Stack.Screen name="category/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="stats" options={{ headerShown: false }} />
      <Stack.Screen name="storage" options={{ headerShown: false }} />
      <Stack.Screen name="debug-logs" options={{ headerShown: false }} />
      <Stack.Screen name="legal" options={{ headerShown: false }} />
      <Stack.Screen
        name="podcast/[id]"
        options={{
          headerShown: false,
        }}
      />
    </Stack>
  );
}

function handleNotificationResponse(response: Notifications.NotificationResponse) {
  try {
    const data = getNotificationData(response);
    addLog("info", `Notification tapped: ${JSON.stringify(data)}`, undefined, "push");

    if (data.feedId) {
      setTimeout(() => {
        router.push(`/podcast/${data.feedId}` as any);
      }, 500);
    }
  } catch (e) {
    addLog("error", `Notification tap handler error: ${(e as any)?.message || e}`, undefined, "push");
  }
}

export default function RootLayout() {
  const notificationResponseListener = useRef<Notifications.EventSubscription | null>(null);
  const [fontsLoaded] = useFonts({
    ...Ionicons.font,
    ...Feather.font,
    ...MaterialCommunityIcons.font,
  });

  useEffect(() => {
    if (!fontsLoaded) return;
    SplashScreen.hideAsync();
    setupNotificationChannel();

    if (Platform.OS !== "web") {
      notificationResponseListener.current =
        Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);

      Notifications.getLastNotificationResponseAsync().then((response) => {
        if (response) {
          handleNotificationResponse(response);
        }
      });
    }

    return () => {
      notificationResponseListener.current?.remove();
    };
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <AudioPlayerProvider>
            <DownloadsProvider>
              <FavoritesProvider>
                <PlayedEpisodesProvider>
                  <PositionsProvider>
                    <GestureHandlerRootView>
                      <KeyboardProvider>
                        <BackgroundSync />
                        <OfflineBanner />
                        <DeepLinkHandler />
                        <RootLayoutNav />
                      </KeyboardProvider>
                    </GestureHandlerRootView>
                  </PositionsProvider>
                </PlayedEpisodesProvider>
              </FavoritesProvider>
            </DownloadsProvider>
          </AudioPlayerProvider>
        </SettingsProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
