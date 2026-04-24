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

const ANDROID_TAB_BAR = 56;
const IOS_TAB_BAR = 80;
const WEB_TAB_BAR = 56 + 34;

export default function MiniPlayerHost() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  const isHidden = HIDE_ON_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + "/"),
  );
  const isTabRoute = TAB_ROUTES.has(pathname);

  // Compute bottom offset
  let bottom: number;
  if (isTabRoute) {
    bottom = isWeb ? WEB_TAB_BAR : (isIOS ? IOS_TAB_BAR : ANDROID_TAB_BAR) + insets.bottom;
  } else {
    bottom = insets.bottom;
  }

  // Always render the container — only hide visually via opacity + disable
  // pointer events. Unmounting MiniPlayer during a navigation transition
  // (which happens the instant the user taps the mini player to open the
  // full /player route) caused a NullPointerException in Android's
  // ViewGroup.dispatchGetDisplayList because the renderer still held a
  // reference to the just-detached View. Keeping it mounted fixes that.
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
        opacity: isHidden ? 0 : 1,
      } as const);

  return (
    <View pointerEvents={isHidden ? "none" : "box-none"} style={containerStyle}>
      <MiniPlayer />
    </View>
  );
}
