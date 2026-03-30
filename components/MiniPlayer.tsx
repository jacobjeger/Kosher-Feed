import React from "react";
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator } from "react-native";
import FocusableView from "@/components/FocusableView";
import Animated, { FadeInDown, FadeOutDown, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, usePlaybackPosition } from "@/contexts/AudioPlayerContext";
import { router } from "expo-router";
import Colors from "@/constants/colors";

function formatTime(ms: number): string {
  if (!ms || ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function MiniPlayer() {
  const { currentEpisode, currentFeed, playback, pause, resume, seekTo } = useAudioPlayer();
  const position = usePlaybackPosition();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const isWeb = Platform.OS === "web";

  // Hooks must be called before any conditional return to avoid "Rendered more hooks" error
  const pressScale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
  }));

  if (!currentEpisode) return null;

  const rawProgress = position.durationMs > 0 ? position.positionMs / position.durationMs : 0;
  const progress = isNaN(rawProgress) ? 0 : Math.min(rawProgress, 1);

  const enteringAnimation = !isWeb ? FadeInDown.duration(300).springify() : undefined;
  const exitingAnimation = !isWeb ? FadeOutDown.duration(200) : undefined;

  return (
    <Animated.View entering={enteringAnimation} exiting={exitingAnimation} style={pressStyle}>
      <FocusableView
        focusRadius={14}
        style={[styles.container, { backgroundColor: colors.playerBg }]}
        onPress={() => router.push("/player")}
        onPressIn={() => { pressScale.value = withSpring(0.98, { damping: 15 }); }}
        onPressOut={() => { pressScale.value = withSpring(1, { damping: 15 }); }}
      >
        <View style={[styles.progressBar, { backgroundColor: "rgba(255,255,255,0.08)" }]}>
          <LinearGradient
            colors={[colors.gradientStart, colors.gradientEnd]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.progressFill, { width: `${progress * 100}%` }, isWeb ? { transition: 'width 0.3s ease' } as any : undefined]}
          />
          <View style={[styles.progressDot, { left: `${progress * 100}%`, backgroundColor: colors.gradientEnd }]} />
        </View>

        <View style={styles.content}>
          {currentFeed?.imageUrl ? (
            <Image
              source={{ uri: currentFeed.imageUrl }}
              style={styles.artwork}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={currentFeed.imageUrl}
              transition={0}
            />
          ) : (
            <View style={[styles.artwork, { backgroundColor: "rgba(255,255,255,0.1)" }]}>
              <Ionicons name="musical-notes" size={18} color={colors.playerAccent} />
            </View>
          )}

          <View style={styles.info}>
            <Text style={[styles.title, { color: colors.playerText }]} numberOfLines={1}>
              {currentEpisode.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable onPress={(e) => { e.stopPropagation(); if (currentFeed) router.push(`/podcast/${currentFeed.id}`); }} hitSlop={4}>
                <Text style={[styles.subtitle, { color: "rgba(255,255,255,0.55)" }]} numberOfLines={1}>
                  {currentFeed?.title}
                </Text>
              </Pressable>
              {isWeb && position.durationMs > 0 && (
                <Text style={{ color: "rgba(255,255,255,0.35)", fontSize: 11 }}>
                  {formatTime(position.positionMs)} / {formatTime(position.durationMs)}
                </Text>
              )}
            </View>
          </View>

          {isWeb && (
            <Pressable
              onPress={(e) => { e.stopPropagation(); seekTo(Math.max(0, position.positionMs - 15000)); }}
              hitSlop={8}
              style={styles.skipBtn}
            >
              <Ionicons name="play-back" size={18} color="rgba(255,255,255,0.7)" />
            </Pressable>
          )}

          <FocusableView
            focusRadius={20}
            onPress={(e) => {
              e.stopPropagation();
              playback.isPlaying ? pause() : resume();
            }}
            hitSlop={12}
            style={[styles.playBtn, isWeb && styles.playBtnWeb]}
          >
            {playback.isLoading ? (
              <ActivityIndicator size={18} color={colors.playerText} />
            ) : (
              <Ionicons
                name={playback.isPlaying ? "pause" : "play"}
                size={24}
                color={colors.playerText}
              />
            )}
          </FocusableView>

          {isWeb && (
            <Pressable
              onPress={(e) => { e.stopPropagation(); seekTo(Math.min(position.durationMs, position.positionMs + 30000)); }}
              hitSlop={8}
              style={styles.skipBtn}
            >
              <Ionicons name="play-forward" size={18} color="rgba(255,255,255,0.7)" />
            </Pressable>
          )}
        </View>
      </FocusableView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 12,
    overflow: "hidden",
    ...Platform.select({
      web: {
        boxShadow: "0 -2px 16px rgba(0,0,0,0.3)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        maxWidth: 900,
        marginHorizontal: "auto" as any,
        width: "calc(100% - 24px)" as any,
      } as any,
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: { elevation: 8 },
    }),
  },
  progressBar: {
    height: 4,
  },
  progressFill: {
    height: "100%" as any,
    borderRadius: 2,
  },
  progressDot: {
    position: "absolute" as const,
    top: -2,
    width: 7,
    height: 7,
    borderRadius: 4,
    marginLeft: -4,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  artwork: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  info: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 12,
  },
  playBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  playBtnWeb: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  skipBtn: {
    width: 44,
    height: 44,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: 22,
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
});
