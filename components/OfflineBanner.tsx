import React, { useState, useEffect, useRef } from "react";
import { View, Text, StyleSheet, Platform, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, { useAnimatedStyle, withTiming, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const checkRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") {
      const handleOnline = () => setIsOnline(true);
      const handleOffline = () => setIsOnline(false);
      setIsOnline(navigator.onLine);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    } else {
      let mounted = true;
      const check = async () => {
        try {
          const Network = require("expo-network");
          const state = await Network.getNetworkStateAsync();
          if (mounted) setIsOnline(!!state.isConnected && !!state.isInternetReachable);
        } catch {
          if (mounted) setIsOnline(true);
        }
      };
      check();
      checkRef.current = setInterval(check, 15000);
      return () => {
        mounted = false;
        if (checkRef.current) clearInterval(checkRef.current);
      };
    }
  }, []);

  return isOnline;
}

export default function OfflineBanner() {
  const isOnline = useNetworkStatus();
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(-60);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isOnline && !dismissed) {
      translateY.value = withTiming(0, { duration: 300 });
    } else {
      translateY.value = withTiming(-60, { duration: 200 });
    }
  }, [isOnline, dismissed]);

  useEffect(() => {
    if (isOnline) setDismissed(false);
  }, [isOnline]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (isOnline && !dismissed) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        { top: Platform.OS === "web" ? 67 : insets.top, pointerEvents: isOnline ? "none" as const : "auto" as const },
        animStyle,
      ]}
    >
      <View style={styles.inner}>
        <Ionicons name="cloud-offline-outline" size={16} color="#fff" />
        <Text style={styles.text}>No internet connection</Text>
        <Pressable onPress={() => setDismissed(true)} hitSlop={8}>
          <Ionicons name="close" size={16} color="rgba(255,255,255,0.7)" />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 9999,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(220, 38, 38, 0.92)",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  text: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600" as const,
    flex: 1,
  },
});
