// YTC: auth gate for the /ytc subtree. Mounts YtcAuthProvider here (NOT
// in the root layout) so Firebase only initializes when a user actually
// navigates into /ytc. Verbatim port from
// /tmp/ytc-source/expo-app/app/_layout.tsx, with these changes:
//   - YTC's own SafeAreaProvider / GestureHandlerRootView / SplashScreen
//     are dropped — shiurpod's root layout already provides them.
//   - YTC's AudioContext is dropped — shiurpod's AudioPlayerContext is
//     the canonical player; YTC plays through the audio adapter
//     (lib/ytc/audio-adapter.ts).
//   - Auth-state routes use /ytc-prefixed paths.
//   - Floating X-to-close button at top-left dismisses the YTC modal
//     and returns the user to whatever tab they came from. ShiurPod's
//     <MiniPlayerHost> renders globally, so any in-progress shiurpod
//     audio keeps playing while the user browses YTC, and the
//     mini-player floats above this layout's content.
import React, { useEffect } from "react";
import { Stack, router } from "expo-router";
import { View, ActivityIndicator, Pressable, Platform, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { YtcAuthProvider, useYtcAuth } from "@/contexts/YtcAuthContext";
import { YtcThemeProvider, useYtcColors } from "@/contexts/YtcThemeContext";
import { ytcColors } from "@/constants/ytcColors";
import { lightHaptic } from "@/lib/haptics";
import { YtcAnalyticsObserver } from "@/components/YtcAnalyticsObserver";
import { YtcPushHost } from "@/components/ytc/YtcPushHost";

// Inline error boundary so any render-time throw inside YTC shows a
// visible fallback (with the X to close) instead of leaving the user
// staring at a black modal they can't dismiss without force-quitting.
class YtcErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    try {
      // Use console.error so it lands in logcat under ReactNativeJS,
      // making post-mortem diagnosis from adb possible.
      // eslint-disable-next-line no-console
      console.error("[YTC] render boundary caught:", error?.message, error?.stack);
    } catch {}
  }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: ytcColors.cream, justifyContent: "center", alignItems: "center", padding: 24 }}>
          <Ionicons name="alert-circle-outline" size={48} color={ytcColors.navy} />
          <Text style={{ color: ytcColors.navy, fontSize: 16, fontWeight: "600", marginTop: 12, textAlign: "center" }}>
            YTC failed to load
          </Text>
          <Text style={{ color: ytcColors.navyOpacity70, fontSize: 13, marginTop: 8, textAlign: "center" }}>
            {this.state.error.message || "Unknown error"}
          </Text>
          <Pressable onPress={() => { try { router.back(); } catch {} }} style={{ marginTop: 24, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: ytcColors.navy }}>
            <Text style={{ color: ytcColors.cream, fontSize: 14, fontWeight: "600" }}>Close</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

function CloseButton() {
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      onPress={() => { lightHaptic(); router.back(); }}
      hitSlop={12}
      style={({ pressed }) => ({
        position: "absolute",
        top: insets.top + 8,
        left: 12,
        zIndex: 100,
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: ytcColors.navyOpacity30,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
      accessibilityLabel="Close YTC and return to ShiurPod"
      accessibilityRole="button"
    >
      <Ionicons name="close" size={20} color={ytcColors.cream} />
    </Pressable>
  );
}

function YtcGate() {
  const { user, isApproved, isLoading } = useYtcAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!user) router.replace("/ytc/(auth)/login" as any);
    else if (!isApproved) router.replace("/ytc/(auth)/pending" as any);
    else router.replace("/ytc/(tabs)" as any);
  }, [user, isApproved, isLoading]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: ytcColors.cream }}>
        <ActivityIndicator size="large" color={ytcColors.gold} />
        <CloseButton />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="collections/[id]" />
      </Stack>
      <CloseButton />
      <YtcAnalyticsObserver />
      <YtcPushHost />
    </View>
  );
}

function YtcRootBg({ children }: { children: React.ReactNode }) {
  // Reads the active palette so the root background swaps with the
  // user's theme choice. Must be inside YtcThemeProvider.
  const colors = useYtcColors();
  return <View style={{ flex: 1, backgroundColor: colors.bg }}>{children}</View>;
}

export default function YtcRootLayout() {
  return (
    <YtcThemeProvider>
      <YtcRootBg>
        <YtcErrorBoundary>
          <YtcAuthProvider>
            <YtcGate />
          </YtcAuthProvider>
        </YtcErrorBoundary>
      </YtcRootBg>
    </YtcThemeProvider>
  );
}
