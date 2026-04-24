import React from "react";
import { View, Platform } from "react-native";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MiniPlayer from "@/components/MiniPlayer";

// Routes where we explicitly do NOT show the MiniPlayer.
// - /player and /queue are full-screen modals that already have a player UI
// - /onboarding is the first-time setup screen, user isn't playing anything yet
const HIDE_ON_ROUTES = ["/player", "/queue", "/onboarding"];

// Tab routes — these have a bottom tab bar, so the MiniPlayer has to sit
// above it. The tab bar itself is ~56dp (Android) or 80dp (iOS) + safe area.
const TAB_ROUTES = new Set([
  "/",
  "/index",
  "/following",
  "/favorites",
  "/downloads",
  "/settings",
]);

const ANDROID_TAB_BAR = 56;
const IOS_TAB_BAR = 80;
const WEB_TAB_BAR = 56 + 34; // tab height + paddingBottom from (tabs)/_layout

export default function MiniPlayerHost() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  if (HIDE_ON_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))) {
    return null;
  }

  const isTabRoute = TAB_ROUTES.has(pathname);

  // Compute bottom offset:
  // - On tab routes: above the tab bar + safe area
  // - On non-tab routes: just the safe area (no tab bar in the way)
  let bottom: number;
  if (isTabRoute) {
    bottom = isWeb ? WEB_TAB_BAR : (isIOS ? IOS_TAB_BAR : ANDROID_TAB_BAR) + insets.bottom;
  } else {
    bottom = insets.bottom;
  }

  // On desktop web we have a top nav, no bottom tabs — pin to very bottom.
  // This matches the previous desktop-web behavior from (tabs)/_layout.tsx.
  const containerStyle = isWeb && isTabRoute
    ? ({ position: "fixed" as any, bottom: 0, left: 0, right: 0, zIndex: 200 } as const)
    : ({ position: "absolute" as const, bottom, left: 0, right: 0, zIndex: 50 } as const);

  return (
    <View pointerEvents="box-none" style={containerStyle}>
      <MiniPlayer />
    </View>
  );
}
