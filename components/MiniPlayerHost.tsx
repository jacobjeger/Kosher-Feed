import React, { useEffect, useState } from "react";
import { View, Platform, Pressable, StyleSheet } from "react-native";
import { usePathname, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from "react-native-reanimated";
import MiniPlayer from "@/components/MiniPlayer";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";

// Routes where we explicitly hide the MiniPlayer.
const HIDE_ON_ROUTES = ["/player", "/queue", "/onboarding"];

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

// Swipe ≥30% of screen width (or fast flick) → minimize to a floating bubble.
const MINIMIZE_THRESHOLD = 0.3;
const MINIMIZE_VELOCITY = 800;

export default function MiniPlayerHost() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const { currentEpisode, currentFeed, playback, pause, resume } = useAudioPlayer();

  const isHidden = HIDE_ON_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + "/"),
  );
  const isTabRoute = TAB_ROUTES.has(pathname);

  let bottom: number;
  if (isTabRoute) {
    bottom = isWeb ? WEB_TAB_BAR : (isIOS ? IOS_TAB_BAR : ANDROID_TAB_BAR) + insets.bottom;
  } else {
    bottom = insets.bottom;
  }

  // Whether the user has swiped the mini player off-screen. While true, we
  // render a small circular bubble in the corner instead. Reset to false
  // whenever a new episode starts so the user sees the player again.
  const [minimized, setMinimized] = useState(false);
  const lastEpisodeIdRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (currentEpisode?.id && currentEpisode.id !== lastEpisodeIdRef.current) {
      lastEpisodeIdRef.current = currentEpisode.id;
      setMinimized(false);
      translateX.value = withTiming(0, { duration: 0 });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpisode?.id]);

  const translateX = useSharedValue(0);

  // Pan gesture — disabled on web (web users can use the close affordance later;
  // gesture-handler is RN-only).
  const panGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .failOffsetY([-15, 15])
    .onUpdate((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      const screenWidth = 400; // approximate; threshold uses fraction so exact value not critical
      const past = Math.abs(e.translationX) > screenWidth * MINIMIZE_THRESHOLD;
      const flick = Math.abs(e.velocityX) > MINIMIZE_VELOCITY;
      if (past || flick) {
        const dir = e.translationX < 0 ? -1 : 1;
        translateX.value = withTiming(dir * 1000, { duration: 220 }, () => {
          runOnJS(setMinimized)(true);
          translateX.value = 0;
        });
      } else {
        translateX.value = withSpring(0, { damping: 14 });
      }
    });

  const swipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    opacity: interpolate(
      Math.abs(translateX.value),
      [0, 200],
      [1, 0.4],
      Extrapolation.CLAMP,
    ),
  }));

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

  const restore = () => setMinimized(false);

  // When minimized, render a small floating bubble in the bottom-right.
  // Tap → restore the mini player. Long-press play/pause via secondary press
  // is handled inline.
  if (minimized && !isHidden && currentEpisode) {
    const bubbleBottom = bottom + 12;
    return (
      <View pointerEvents="box-none" style={[containerStyle, { right: 12, left: undefined, bottom: bubbleBottom, alignItems: "flex-end" }]}>
        <Pressable
          onPress={restore}
          onLongPress={() => router.push("/player")}
          style={({ pressed }) => [
            styles.bubble,
            { transform: [{ scale: pressed ? 0.94 : 1 }] },
          ]}
        >
          {currentFeed?.imageUrl ? (
            <Image
              source={{ uri: currentFeed.imageUrl }}
              style={styles.bubbleImg}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={currentFeed.imageUrl}
            />
          ) : (
            <View style={[styles.bubbleImg, { backgroundColor: "#1f2937", alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="musical-notes" size={20} color="#9ca3af" />
            </View>
          )}
          {/* play/pause indicator over the artwork */}
          <Pressable
            hitSlop={6}
            onPress={(e) => { e.stopPropagation?.(); playback.isPlaying ? pause() : resume(); }}
            style={styles.bubbleOverlay}
          >
            <Ionicons
              name={playback.isPlaying ? "pause" : "play"}
              size={20}
              color="#fff"
              style={playback.isPlaying ? undefined : { marginLeft: 2 }}
            />
          </Pressable>
        </Pressable>
      </View>
    );
  }

  return (
    <View pointerEvents={isHidden ? "none" : "box-none"} style={containerStyle}>
      <GestureDetector gesture={panGesture}>
        <Animated.View style={swipeStyle}>
          <MiniPlayer />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
    backgroundColor: "#000",
  },
  bubbleImg: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  bubbleOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.42)",
    alignItems: "center",
    justifyContent: "center",
  },
});
