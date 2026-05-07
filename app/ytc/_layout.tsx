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
import { View, ActivityIndicator, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { YtcAuthProvider, useYtcAuth } from "@/contexts/YtcAuthContext";
import { ytcColors } from "@/constants/ytcColors";
import { lightHaptic } from "@/lib/haptics";

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
      </Stack>
      <CloseButton />
    </View>
  );
}

export default function YtcRootLayout() {
  return (
    <YtcAuthProvider>
      <YtcGate />
    </YtcAuthProvider>
  );
}
