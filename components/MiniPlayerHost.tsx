import React from "react";
import { View, Platform } from "react-native";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MiniPlayer from "@/components/MiniPlayer";

// Routes where we explicitly hide the MiniPlayer.
// - /player and /queue are full-screen modals that already have a player UI
// - /onboarding is the first-time setup screen
const HIDE_ON_ROUTES = ["/player", "/queue", "/onboarding"];

// Tab routes — these have a bottom tab bar, so the MiniPlayer has to sit
// above it.
const TAB_ROUTES = new Set([
  "/",
  "/index",
  "/following",
  "/favorites",
  "/downloads",
  "/settings",
]);

// YTC tab routes — pathname for app/ytc/(tabs)/* strips the (tabs)
// group, so /ytc/(tabs)/index → "/ytc" and /ytc/(tabs)/shiurim →
// "/ytc/shiurim", etc. Without this set the MiniPlayer was rendering
// flush to the bottom edge on /ytc/* and visually covering the YTC
// gold-pill tab bar (user-reported: "what can we do that the nav bar
// should not get blocked when listening to shiurim").
const YTC_TAB_ROUTES = new Set([
  "/ytc",
  "/ytc/index",
  "/ytc/shiurim",
  "/ytc/events",
  "/ytc/contacts",
]);

const ANDROID_TAB_BAR = 56;
const IOS_TAB_BAR = 80;
const WEB_TAB_BAR = 56 + 34;
// YTC tab bar height — kept in sync with app/ytc/(tabs)/_layout.tsx
// (we set tabBarStyle.height = 64 there to fit the gold-pill icon).
const YTC_TAB_BAR = 64;

export default function MiniPlayerHost() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  const isHidden = HIDE_ON_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + "/"),
  );
  const isTabRoute = TAB_ROUTES.has(pathname);
  const isYtcTabRoute = YTC_TAB_ROUTES.has(pathname);

  // Compute bottom offset so the mini-player floats ABOVE whichever
  // tab bar is currently on screen. Without the YTC branch, the
  // mini-player would sit on the bottom edge and cover the YTC tab
  // bar's gold-pill row.
  let bottom: number;
  if (isYtcTabRoute) {
    // YTC tabs handle insets.bottom internally via paddingBottom on
    // tabBarStyle, so just stack above the bar.
    bottom = YTC_TAB_BAR + insets.bottom;
  } else if (isTabRoute) {
    bottom = isWeb ? WEB_TAB_BAR : (isIOS ? IOS_TAB_BAR : ANDROID_TAB_BAR) + insets.bottom;
  } else {
    bottom = insets.bottom;
  }

  // Always render the container — only hide visually via opacity + disable
  // pointer events. Unmounting MiniPlayer during a navigation transition
  // would crash Android's renderer. Adding `elevation` on Android so the
  // mini player actually paints on top of the screen content (zIndex alone
  // doesn't cross stacking contexts on Android — was rendering UNDER the
  // tab screen's ScrollView and appearing as an empty dark rectangle).
  const containerStyle = isWeb && isTabRoute
    ? ({
        position: "fixed" as any,
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        opacity: isHidden ? 0 : 1,
      } as const)
    : ({
        position: "absolute" as const,
        bottom,
        left: 0,
        right: 0,
        zIndex: 50,
        elevation: 8,
        opacity: isHidden ? 0 : 1,
      } as const);

  return (
    <View pointerEvents={isHidden ? "none" : "box-none"} style={containerStyle}>
      <MiniPlayer />
    </View>
  );
}
