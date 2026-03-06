import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
import { DeepLinkHandler } from "@/components/DeepLinkHandler";
import { getNotificationData, setupForegroundNotificationHandler, setupPushNotificationChannels } from "@/lib/push-notifications";
import { addLog } from "@/lib/error-logger";
import AnnouncementModal from "@/components/AnnouncementModal";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl, apiRequest } from "@/lib/query-client";

const ONBOARDING_KEY = "@shiurpod_onboarding_complete";

SplashScreen.preventAutoHideAsync();
initErrorLogger();
setupGlobalErrorHandlers();
setupForegroundNotificationHandler();
setupPushNotificationChannels();


function RootLayoutNav({ initialRoute }: { initialRoute: string }) {
  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }} initialRouteName={initialRoute}>
      <Stack.Screen name="onboarding" options={{ headerShown: false, animation: "none" }} />
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
      <Stack.Screen
        name="maggid-shiur/[author]"
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
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [initialRoute, setInitialRoute] = useState("(tabs)");

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY).then((value) => {
      if (value !== "true") {
        setInitialRoute("onboarding");
      }
      setOnboardingChecked(true);
    }).catch(() => {
      setOnboardingChecked(true);
    });
  }, []);

  useEffect(() => {
    if (!fontsLoaded || !onboardingChecked) return;
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
  }, [fontsLoaded, onboardingChecked]);

  // Announcements
  const [currentAnnouncement, setCurrentAnnouncement] = useState<any>(null);
  const [announcementQueue, setAnnouncementQueue] = useState<any[]>([]);
  const [announcementVisible, setAnnouncementVisible] = useState(false);

  useEffect(() => {
    if (!fontsLoaded || !onboardingChecked || initialRoute !== "(tabs)") return;
    (async () => {
      try {
        const deviceId = await getDeviceId();
        const baseUrl = getApiUrl();
        const res = await fetch(`${baseUrl}/api/announcements/${deviceId}`);
        if (!res.ok) return;
        const anns = await res.json();
        if (anns.length > 0) {
          setAnnouncementQueue(anns);
          setCurrentAnnouncement(anns[0]);
          setAnnouncementVisible(true);
        }
      } catch {}
    })();
  }, [fontsLoaded, onboardingChecked, initialRoute]);

  const handleDismissAnnouncement = async () => {
    if (currentAnnouncement) {
      try {
        const deviceId = await getDeviceId();
        await apiRequest("POST", `/api/announcements/${currentAnnouncement.id}/dismiss`, { deviceId });
      } catch {}
    }
    setAnnouncementVisible(false);
    // Show next in queue
    const remaining = announcementQueue.slice(1);
    setAnnouncementQueue(remaining);
    if (remaining.length > 0) {
      setTimeout(() => {
        setCurrentAnnouncement(remaining[0]);
        setAnnouncementVisible(true);
      }, 300);
    } else {
      setCurrentAnnouncement(null);
    }
  };

  if (!fontsLoaded || !onboardingChecked) return null;

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
                        <RootLayoutNav initialRoute={initialRoute} />
                        <AnnouncementModal
                          announcement={currentAnnouncement}
                          visible={announcementVisible}
                          onDismiss={handleDismissAnnouncement}
                        />
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
