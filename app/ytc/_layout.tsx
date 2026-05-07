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
import React, { useEffect } from "react";
import { Stack, router } from "expo-router";
import { View, ActivityIndicator } from "react-native";
import { YtcAuthProvider, useYtcAuth } from "@/contexts/YtcAuthContext";
import { ytcColors } from "@/constants/ytcColors";

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
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

export default function YtcRootLayout() {
  return (
    <YtcAuthProvider>
      <YtcGate />
    </YtcAuthProvider>
  );
}
