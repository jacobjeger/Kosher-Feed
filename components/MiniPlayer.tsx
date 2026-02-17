import React from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, usePlaybackPosition } from "@/contexts/AudioPlayerContext";
import { router } from "expo-router";
import Colors from "@/constants/colors";

export default function MiniPlayer() {
  const { currentEpisode, currentFeed, playback, pause, resume } = useAudioPlayer();
  const position = usePlaybackPosition();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  if (!currentEpisode) return null;

  const rawProgress = position.durationMs > 0 ? position.positionMs / position.durationMs : 0;
  const progress = isNaN(rawProgress) ? 0 : Math.min(rawProgress, 1);

  const enteringAnimation = Platform.OS !== "web" ? FadeInDown.duration(250) : undefined;

  return (
    <Animated.View entering={enteringAnimation}>
      <Pressable
        style={[styles.container, { backgroundColor: colors.playerBg }]}
        onPress={() => router.push("/player")}
      >
        <View style={[styles.progressBar, { backgroundColor: "rgba(255,255,255,0.1)" }]}>
          <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: colors.playerAccent }]} />
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
            <Text style={[styles.subtitle, { color: "rgba(255,255,255,0.6)" }]} numberOfLines={1}>
              {currentFeed?.title}
            </Text>
          </View>

          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              playback.isPlaying ? pause() : resume();
            }}
            hitSlop={12}
            style={styles.playBtn}
          >
            <Ionicons
              name={playback.isPlaying ? "pause" : "play"}
              size={24}
              color={colors.playerText}
            />
          </Pressable>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 14,
    overflow: "hidden",
    ...Platform.select({
      web: {
        boxShadow: "0 -2px 16px rgba(0,0,0,0.3)",
        maxWidth: 1200,
        marginHorizontal: "auto" as any,
        width: "calc(100% - 24px)" as any,
      },
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
    height: 3,
  },
  progressFill: {
    height: "100%" as any,
    borderRadius: 2,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
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
});
