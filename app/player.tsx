import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme, Platform } from "react-native";
import { Image } from "expo-image";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import Slider from "@react-native-community/slider";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import Colors from "@/constants/colors";
import * as Haptics from "expo-haptics";

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const { currentEpisode, currentFeed, playback, pause, resume, seekTo, skip, setRate, stop } = useAudioPlayer();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  if (!currentEpisode || !currentFeed) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="chevron-down" size={28} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.emptyState}>
          <Ionicons name="musical-notes-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No episode playing</Text>
        </View>
      </View>
    );
  }

  const progress = playback.durationMs > 0 ? (isSeeking ? seekValue : playback.positionMs) / playback.durationMs : 0;
  const currentRateIndex = RATES.indexOf(playback.playbackRate);

  const cycleRate = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const nextIndex = (currentRateIndex + 1) % RATES.length;
    await setRate(RATES[nextIndex]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === "web" ? 67 : 8) }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-down" size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.textSecondary }]}>Now Playing</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.artworkContainer}>
        {currentFeed.imageUrl ? (
          <Image
            source={{ uri: currentFeed.imageUrl }}
            style={styles.artwork}
            contentFit="cover"
          />
        ) : (
          <View style={[styles.artwork, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
            <Ionicons name="mic" size={80} color={colors.textSecondary} />
          </View>
        )}
      </View>

      <View style={styles.infoSection}>
        <Text style={[styles.episodeTitle, { color: colors.text }]} numberOfLines={2}>
          {currentEpisode.title}
        </Text>
        <Text style={[styles.feedName, { color: colors.accent }]} numberOfLines={1}>
          {currentFeed.title}
        </Text>
      </View>

      <View style={styles.sliderSection}>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={1}
          value={progress}
          onSlidingStart={() => setIsSeeking(true)}
          onValueChange={(val) => setSeekValue(val * playback.durationMs)}
          onSlidingComplete={async (val) => {
            await seekTo(val * playback.durationMs);
            setIsSeeking(false);
          }}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.border}
          thumbTintColor={colors.accent}
        />
        <View style={styles.timeRow}>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>
            {formatTime(isSeeking ? seekValue : playback.positionMs)}
          </Text>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>
            -{formatTime(Math.max(0, playback.durationMs - (isSeeking ? seekValue : playback.positionMs)))}
          </Text>
        </View>
      </View>

      <View style={styles.controls}>
        <Pressable
          onPress={cycleRate}
          style={[styles.rateBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Text style={[styles.rateText, { color: colors.text }]}>
            {playback.playbackRate}x
          </Text>
        </Pressable>

        <Pressable
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); skip(-30); }}
          hitSlop={8}
          style={styles.skipBtn}
        >
          <MaterialIcons name="replay-30" size={36} color={colors.text} />
        </Pressable>

        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            playback.isPlaying ? pause() : resume();
          }}
          style={[styles.playBtn, { backgroundColor: colors.accent }]}
        >
          <Ionicons
            name={playback.isPlaying ? "pause" : "play"}
            size={32}
            color="#fff"
            style={playback.isPlaying ? undefined : { marginLeft: 3 }}
          />
        </Pressable>

        <Pressable
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); skip(30); }}
          hitSlop={8}
          style={styles.skipBtn}
        >
          <MaterialIcons name="forward-30" size={36} color={colors.text} />
        </Pressable>

        <Pressable
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); stop(); router.back(); }}
          hitSlop={8}
          style={[styles.rateBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons name="stop" size={18} color={colors.danger} />
        </Pressable>
      </View>

      <View style={{ height: insets.bottom + 20 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  artworkContainer: {
    alignItems: "center",
    paddingHorizontal: 40,
    paddingVertical: 24,
    flex: 1,
    justifyContent: "center",
  },
  artwork: {
    width: "100%",
    maxWidth: 300,
    aspectRatio: 1,
    borderRadius: 16,
  },
  infoSection: {
    paddingHorizontal: 24,
    gap: 6,
    marginBottom: 16,
  },
  episodeTitle: {
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 26,
  },
  feedName: {
    fontSize: 15,
    fontWeight: "600",
  },
  sliderSection: {
    paddingHorizontal: 24,
    marginBottom: 20,
  },
  slider: {
    width: "100%",
    height: 40,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: -4,
  },
  timeText: {
    fontSize: 12,
    fontWeight: "500",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  rateBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  rateText: {
    fontSize: 13,
    fontWeight: "700",
  },
  skipBtn: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  playBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: "500",
  },
});
