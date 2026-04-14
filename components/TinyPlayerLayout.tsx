import React, { useState, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Platform } from "react-native";
import FocusableView from "@/components/FocusableView";
import { Image } from "expo-image";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import Slider from "@react-native-community/slider";
import type { Episode, Feed } from "@/lib/types";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface Props {
  episode: Episode;
  feed: Feed;
  playback: { isPlaying: boolean; isLoading: boolean; playbackRate: number };
  position: { positionMs: number; durationMs: number };
  colors: any;
  isDark: boolean;
  insetTop: number;
  onBack: () => void;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onSeekTo: (ms: number) => Promise<void>;
  onSkip: (seconds: number) => Promise<void>;
  onSetRate: (rate: number) => Promise<void>;
  onStop: () => Promise<void>;
  skipForwardSeconds: number;
  skipBackwardSeconds: number;
  skipBackwardIcon: string;
  skipForwardIcon: string;
  onSleepPress: () => void;
  onBookmarkPress: () => void;
  onFavoritePress: () => void;
  onQueuePress: () => void;
  sleepLabel: string | null;
  sleepActive: boolean;
  bookmarkSaved: boolean;
  isFavorited: boolean;
  onOpenPodcast: () => void;
}

export default function TinyPlayerLayout(props: Props) {
  const {
    episode, feed, playback, position, colors, isDark, insetTop,
    onBack, onPause, onResume, onSeekTo, onSkip, onSetRate, onStop,
    skipForwardSeconds, skipBackwardSeconds, skipBackwardIcon, skipForwardIcon,
    onSleepPress, onBookmarkPress, onFavoritePress, onQueuePress,
    sleepLabel, sleepActive, bookmarkSaved, isFavorited, onOpenPodcast,
  } = props;

  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const progress = position.durationMs > 0 ? (isSeeking ? seekValue : position.positionMs) / position.durationMs : 0;

  const currentRateIndex = RATES.indexOf(playback.playbackRate);
  const cycleRate = useCallback(async () => {
    const nextIndex = (currentRateIndex + 1) % RATES.length;
    await onSetRate(RATES[nextIndex]);
  }, [currentRateIndex, onSetRate]);

  return (
    <View style={[styles.container, { paddingTop: insetTop + 2, backgroundColor: colors.background }]}>
      {/* Background tint from album art */}
      {feed.imageUrl && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <BlurView intensity={80} style={StyleSheet.absoluteFill}>
            <Image
              source={{ uri: feed.imageUrl }}
              style={{ width: "100%", height: "100%", opacity: isDark ? 0.15 : 0.08 }}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          </BlurView>
        </View>
      )}

      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Ionicons name="chevron-down" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.textSecondary }]}>Now Playing</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Artwork + Info */}
      <View style={styles.artRow}>
        <View style={[styles.artworkWrap, { backgroundColor: colors.surfaceAlt, shadowColor: isDark ? "#000" : "#333" }]}>
          {feed.imageUrl ? (
            <Image source={{ uri: feed.imageUrl }} style={styles.artworkImg} contentFit="cover" cachePolicy="memory-disk" recyclingKey={feed.imageUrl} priority="high" transition={0} />
          ) : (
            <View style={[styles.artworkImg, { alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="mic" size={40} color={colors.textSecondary} />
            </View>
          )}
        </View>
        <View style={styles.artInfo}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={3}>{episode.title}</Text>
          <Pressable onPress={onOpenPodcast} hitSlop={8}>
            <Text style={[styles.feedName, { color: colors.accent }]} numberOfLines={2}>{feed.title}</Text>
          </Pressable>
        </View>
      </View>

      {/* Slider */}
      <View style={styles.sliderWrap}>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={1}
          value={progress}
          onSlidingStart={() => setIsSeeking(true)}
          onValueChange={(val: number) => setSeekValue(val * position.durationMs)}
          onSlidingComplete={async (val: number) => { await onSeekTo(val * position.durationMs); setIsSeeking(false); }}
          minimumTrackTintColor="#2563eb"
          maximumTrackTintColor={isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)"}
          thumbTintColor="#3b82f6"
        />
        <View style={styles.timeRow}>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>{formatTime(isSeeking ? seekValue : position.positionMs)}</Text>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>-{formatTime(Math.max(0, position.durationMs - (isSeeking ? seekValue : position.positionMs)))}</Text>
        </View>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <FocusableView focusRadius={12} onPress={cycleRate} style={[styles.smallBtn, { backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)" }]}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: colors.text }}>{playback.playbackRate}x</Text>
        </FocusableView>
        <FocusableView focusRadius={20} onPress={() => onSkip(-skipBackwardSeconds)} hitSlop={8} style={styles.skipBtn}>
          <MaterialIcons name={skipBackwardIcon as any} size={28} color={colors.text} />
        </FocusableView>
        <FocusableView autoFocus focusRadius={32} onPress={() => { playback.isPlaying ? onPause() : onResume(); }} hitSlop={12} style={[styles.playBtn, { backgroundColor: colors.accent }]}>
          {playback.isLoading ? <ActivityIndicator size={28} color="#fff" /> : <Ionicons name={playback.isPlaying ? "pause" : "play"} size={32} color="#fff" style={playback.isPlaying ? undefined : { marginLeft: 3 }} />}
        </FocusableView>
        <FocusableView focusRadius={20} onPress={() => onSkip(skipForwardSeconds)} hitSlop={8} style={styles.skipBtn}>
          <MaterialIcons name={skipForwardIcon as any} size={28} color={colors.text} />
        </FocusableView>
        <FocusableView focusRadius={12} onPress={onStop} hitSlop={8} style={[styles.smallBtn, { backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)" }]}>
          <Ionicons name="stop" size={16} color={colors.danger} />
        </FocusableView>
      </View>

      {/* Secondary */}
      <View style={styles.secondary}>
        <FocusableView focusRadius={10} onPress={onSleepPress} style={[styles.secBtn, { backgroundColor: sleepActive ? colors.accentLight : isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" }]}>
          <Ionicons name="moon-outline" size={16} color={sleepActive ? colors.accent : colors.textSecondary} />
          {sleepLabel ? <Text style={{ fontSize: 11, color: colors.accent }}>{sleepLabel}</Text> : null}
        </FocusableView>
        <FocusableView focusRadius={10} onPress={onBookmarkPress} style={[styles.secBtn, { backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" }]}>
          <Ionicons name={bookmarkSaved ? "checkmark" : "bookmark-outline"} size={16} color={bookmarkSaved ? colors.success : colors.textSecondary} />
        </FocusableView>
        <FocusableView focusRadius={10} onPress={onFavoritePress} style={[styles.secBtn, { backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" }]}>
          <Ionicons name={isFavorited ? "star" : "star-outline"} size={16} color={isFavorited ? colors.accent : colors.textSecondary} />
        </FocusableView>
        <FocusableView focusRadius={10} onPress={onQueuePress} style={[styles.secBtn, { backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" }]}>
          <Ionicons name="list" size={16} color={colors.textSecondary} />
        </FocusableView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "space-between" as const },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 2 },
  headerTitle: { fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1 },
  artRow: { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 4, gap: 12, alignItems: "center" },
  artworkWrap: {
    width: 150, height: 150, borderRadius: 14, overflow: "hidden",
    // Shadow for depth
    elevation: 6,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  artworkImg: { width: 150, height: 150, borderRadius: 14 },
  artInfo: { flex: 1, gap: 4 },
  title: { fontSize: 18, fontWeight: "700", lineHeight: 23 },
  feedName: { fontSize: 14, textDecorationLine: "underline" },
  sliderWrap: { paddingHorizontal: 20, marginBottom: 0 },
  slider: { width: "100%" as any, height: 32 },
  timeRow: { flexDirection: "row", justifyContent: "space-between" },
  timeText: { fontSize: 12, fontWeight: "500" },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 16, paddingVertical: 4 },
  smallBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  skipBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  playBtn: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
  secondary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, paddingVertical: 4, paddingBottom: 8 },
  secBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
});
