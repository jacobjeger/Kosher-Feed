import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, router, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import { AppState, InteractionManager, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@/lib/kv";
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
import { getNotificationData, setupForegroundNotificationHandler, setupPushNotificationChannels, registerPushToken } from "@/lib/push-notifications";
import { addLog } from "@/lib/error-logger";
import AnnouncementModal from "@/components/AnnouncementModal";
import MiniPlayerHost from "@/components/MiniPlayerHost";
import { RemoteConfigProvider } from "@/contexts/RemoteConfigContext";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl, apiRequest } from "@/lib/query-client";
import { checkForUpdate } from "@/lib/updates";

const ONBOARDING_KEY = "@shiurpod_onboarding_complete";

SplashScreen.preventAutoHideAsync();
// Capture launch time as early as possible — used for the cold_start_ms metric
// emitted once the splash screen hides (= app reached interactive).
const APP_LAUNCH_TS = Date.now();
// Kick off the one-time AsyncStorage→MMKV migration. Fire-and-forget;
// every kv.* call internally awaits this promise so we don't need a
// race-free boot order. The migration is ~5-20ms on first launch after
// the new APK installs; nothing on subsequent launches.
try {
  const { initKV } = require("@/lib/kv");
  initKV().catch(() => {});
} catch {}
initErrorLogger();
setupGlobalErrorHandlers();
// Replay any native crash captured by withNativeCrashCapture on the previous
// launch — Java/Kotlin/Obj-C crashes don't hit ErrorUtils, so we picked them
// up via a sidecar file written by the native uncaught-exception handler.
try {
  const { replayNativeCrashIfAny } = require("@/lib/telemetry/native-crash-replay");
  replayNativeCrashIfAny().catch(() => {});
} catch {}
setupForegroundNotificationHandler();
setupPushNotificationChannels();
// Jank detector: ticks a setInterval to spot JS-thread blocks > 500ms.
// Emits js_jank_ms metric + console.warn for live adb visibility. The
// heaviest YTC hot paths (cached() disk parse, full-shiurim fetch+map,
// shiurim list state swap) wrap themselves in markJank() so we know
// which path was running when a jank fires.
try {
  const { installJankDetector } = require("@/lib/perf/jank-detector");
  installJankDetector();
} catch {}


// Jank detector: keep the background marker in sync with the current
// route so any "unknown" jank is at least attributed to the screen the
// user was on when the JS thread blocked.
function JankRouteSync() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      const { setJankRoute } = require("@/lib/perf/jank-detector");
      setJankRoute(pathname || null);
    } catch {}
  }, [pathname]);
  return null;
}

function RootLayoutNav({ initialRoute }: { initialRoute: string }) {
  return (
    <Stack screenOptions={{ headerBackTitle: "Back", gestureEnabled: true, gestureDirection: "horizontal" }} initialRouteName={initialRoute}>
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
      <Stack.Screen name="messages" options={{ headerShown: false }} />
      <Stack.Screen name="feedback" options={{ headerShown: false }} />
      {/* YTC: ytc-unlock is the access-code modal; ytc is the auth-gated
           subtree, presented as a fullScreenModal so it takes over the
           whole screen with the YTC palette / nav while ShiurPod's tab
           bar sits underneath. The X button in app/ytc/_layout.tsx calls
           router.back() to dismiss. Both routes lazy-load when navigated
           to — expo-router does not import their components at app
           start, so non-YTC users pay zero runtime cost. */}
      <Stack.Screen name="ytc-unlock" options={{ headerShown: false, presentation: "modal", animation: "slide_from_bottom" }} />
      {/* contentStyle bg stays cream — the YtcThemeProvider's
           <YtcRootBg> wrapper inside paints the actual surface based
           on theme. This is just a fallback during the modal slide
           before the inner provider mounts. */}
      <Stack.Screen name="ytc" options={{ headerShown: false, presentation: "fullScreenModal", animation: "slide_from_bottom", contentStyle: { backgroundColor: "#faf8f3" } }} />
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

    // Track notification tap
    (async () => {
      try {
        const deviceId = await getDeviceId();
        await apiRequest("POST", "/api/notification-tap", {
          deviceId,
          notificationType: data.type,
          episodeId: data.episodeId,
          feedId: data.feedId,
        });
      } catch (e) {
        addLog("warn", `Failed to track notification tap: ${(e as any)?.message || e}`, undefined, "push");
      }
    })();

    // Route to the appropriate screen based on notification data
    setTimeout(() => {
      try {
        if (data.screen === "messages") {
          router.push("/messages" as any);
        } else if (data.feedId) {
          router.push(`/podcast/${data.feedId}` as any);
        }
      } catch (e) {
        addLog("warn", `Notification navigation failed: ${(e as any)?.message}`, undefined, "notifications");
      }
    }, 500);
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
    // Skip onboarding on web — the mobile-focused 3-slide flow doesn't
    // render well on desktop and isn't appropriate for anonymous web users.
    if (Platform.OS === "web") {
      setOnboardingChecked(true);
      return;
    }
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
    // Hide splash as soon as onboarding check completes. Fonts can load in
    // parallel — icon fonts falling back briefly is way better than a
    // multi-second white screen on cold start.
    if (!onboardingChecked) return;
    SplashScreen.hideAsync().catch(() => {});
    // cold_start_ms: launch → splash hide. The single best leading indicator
    // of "feels slow" complaints. Sampled at 1.0 (rare event).
    // ota_active: one row per launch tagged with the current EAS updateId so
    // the admin can show OTA-adoption (how many devices are on the latest).
    try {
      const { addMetric, emitOtaHeartbeat } = require("@/lib/telemetry/metrics");
      const coldStartMs = Date.now() - APP_LAUNCH_TS;
      // Drop the metric entirely if it's >30s. JS modules eval at app start
      // even when the OS launched the process in the background (push
      // notification wake, foreground service restart, etc.) — those
      // measurements aren't a "cold start" the user perceives, and they
      // were skewing p95 from ~1s into the multi-minute range.
      if (coldStartMs > 0 && coldStartMs < 30_000) {
        addMetric("cold_start_ms", { valueNum: coldStartMs, forceSample: true });
      }
      emitOtaHeartbeat();
    } catch {}
    setupNotificationChannel();

    // Notification-tap handlers stay synchronous — they must be registered
    // before any cold-launch from a notification tap can deliver its
    // payload, and getLastNotificationResponseAsync is what catches the
    // launch-from-tap case. Cheap setup, fires immediately.
    let pushAppStateSub: { remove: () => void } | null = null;
    let heavyStartupAppStateSub: { remove: () => void } | null = null;
    let heavyStartupTimer: ReturnType<typeof setTimeout> | null = null;
    let lastForegroundRegister = 0;
    if (Platform.OS !== "web") {
      notificationResponseListener.current =
        Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
      Notifications.getLastNotificationResponseAsync().then((response) => {
        if (response) {
          handleNotificationResponse(response);
        }
      });
    }

    // Defer the expensive startup work past the first interaction window.
    // Even with InteractionManager + cache-first push, checkForUpdate()
    // still costs a 6s round-trip to u.expo.dev that NEVER affects this
    // session (the new bundle only applies on next launch). So we hold
    // it back until either the user backgrounds the app (perfect moment
    // — they're off the screen) or a 60s fallback timer fires. Same
    // shape for device-profile sync (analytics, not user-facing).
    //
    // Push token has its own cache-first fast path in registerPushToken
    // (skips the FCM round-trip when the cache is <7d old) — for fresh
    // installs / TTL-expired tokens we use the same background-or-fallback
    // trigger so they don't block cold start either.
    //
    // Logcat measurements (Schok F1, 2026-06-18): the eager fan-out
    // burned 9.5s on the push token alone + 6.4s on the update check,
    // both on the JS thread, with a 1.2s 32MB GC at +11s.
    const deferredHandle = InteractionManager.runAfterInteractions(() => {
      // Light, idempotent work that doesn't touch the network — runs immediately.
      import("@/lib/device-profile").then(m => m.syncDeviceProfile()).catch(() => {});

      let fired = false;
      const fireHeavyStartup = () => {
        if (fired) return;
        fired = true;
        checkForUpdate();
        if (Platform.OS !== "web") {
          registerPushToken().catch(() => {});
        }
      };

      heavyStartupTimer = setTimeout(fireHeavyStartup, 60_000);
      heavyStartupAppStateSub = AppState.addEventListener("change", (state) => {
        if (state === "background" || state === "inactive") fireHeavyStartup();
      });

      // Foreground-return refresh: if the app comes back and the cached
      // push token is older than the TTL, re-register. Throttled to once
      // per 2 minutes so app-switching doesn't spam the network.
      if (Platform.OS !== "web") {
        pushAppStateSub = AppState.addEventListener("change", (state) => {
          if (state !== "active") return;
          const now = Date.now();
          if (now - lastForegroundRegister < 2 * 60 * 1000) return;
          lastForegroundRegister = now;
          registerPushToken().catch(() => {});
        });
      }
    });

    return () => {
      deferredHandle?.cancel?.();
      notificationResponseListener.current?.remove();
      pushAppStateSub?.remove();
      heavyStartupAppStateSub?.remove();
      if (heavyStartupTimer) clearTimeout(heavyStartupTimer);
    };
    // Deps used to include `fontsLoaded`, but this effect doesn't read
    // it — including it caused the effect to run twice on cold start
    // (once when onboardingChecked flipped true, again ~300ms later
    // when fontsLoaded flipped true). That doubled every startup task
    // — two parallel checkForUpdate() calls (each a 6.7s round-trip
    // to u.expo.dev), two registerPushToken() calls, two
    // setupNotificationChannel + syncDeviceProfile + notification
    // listener subscribe/unsubscribe pairs. Visible on the Megalife
    // as ~9 seconds of "clicks not working" after the splash hides.
    // Confirmed via logcat (2026-05-14) — both [Updates] check lines
    // fired 324ms apart, with 6.7s parallel responses.
  }, [onboardingChecked]);

  // Announcements
  const [currentAnnouncement, setCurrentAnnouncement] = useState<any>(null);
  const [announcementQueue, setAnnouncementQueue] = useState<any[]>([]);
  const [announcementVisible, setAnnouncementVisible] = useState(false);

  useEffect(() => {
    // Gate: wait for onboarding check to complete. Previously required
    // initialRoute === "(tabs)" but that was a mount-time snapshot that
    // never updated after the user finished onboarding, which blocked
    // announcements forever for any user without the flag set.
    if (!onboardingChecked) return;
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
  }, [onboardingChecked]);

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

  // Only wait for onboarding check (which route to start on). Fonts will
  // load asynchronously and icons will appear once ready — no white screen.
  if (!onboardingChecked) return null;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RemoteConfigProvider>
        <SettingsProvider>
          <AudioPlayerProvider>
            <DownloadsProvider>
              <FavoritesProvider>
                <PlayedEpisodesProvider>
                  <PositionsProvider>
                    <SafeAreaProvider initialWindowMetrics={initialWindowMetrics}>
                    <GestureHandlerRootView style={{ flex: 1 }}>
                      <KeyboardProvider>
                        <BackgroundSync />
                        <OfflineBanner />
                        <DeepLinkHandler />
                        <JankRouteSync />
                        <RootLayoutNav initialRoute={initialRoute} />
                        <MiniPlayerHost />
                        <AnnouncementModal
                          announcement={currentAnnouncement}
                          visible={announcementVisible}
                          onDismiss={handleDismissAnnouncement}
                        />
                      </KeyboardProvider>
                    </GestureHandlerRootView>
                    </SafeAreaProvider>
                  </PositionsProvider>
                </PlayedEpisodesProvider>
              </FavoritesProvider>
            </DownloadsProvider>
          </AudioPlayerProvider>
        </SettingsProvider>
        </RemoteConfigProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
