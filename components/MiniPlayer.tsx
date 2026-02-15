import React from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme, Platform } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { router } from "expo-router";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import Colors from "@/constants/colors";

export default function MiniPlayer() {
  const { currentEpisode, currentFeed, playback, pause, resume } = useAudioPlayer();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  if (!currentEpisode) return null;

  const progress = playback.durationMs > 0 ? playback.positionMs / playback.durationMs : 0;

  return (
    <Animated.View
      entering={FadeInDown.duration(300)}
      exiting={FadeOutDown.duration(200)}
    >
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
