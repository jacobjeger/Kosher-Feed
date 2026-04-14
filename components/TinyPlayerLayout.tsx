import React, { useState, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import FocusableView from "@/components/FocusableView";
import { Image } from "expo-image";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import type { Episode, Feed } from "@/lib/types";

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
    episode, feed, playback, position, colors, insetTop,
    onBack, onPause, onResume, onSeekTo, onSkip, onSetRate, onStop,
    skipForwardSeconds, skipBackwardSeconds, skipBackwardIcon, skipForwardIcon,
    onSleepPress, onBookmarkPress, onFavoritePress, onQueuePress,
    sleepLabel, sleepActive, bookmarkSaved, isFavorited, onOpenPodcast,
  } = props;

  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const progress = position.durationMs > 0 ? (isSeeking ? seekValue : position.positionMs) / position.durationMs : 0;

  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const currentRateIndex = RATES.indexOf(playback.playbackRate);
  const cycleRate = useCallback(async () => {
    const nextIndex = (currentRateIndex + 1) % RATES.length;
    await onSetRate(RATES[nextIndex]);
  }, [currentRateIndex, onSetRate]);

  return (
    <View style={[styles.container, { paddingTop: insetTop + 2 }]}>
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
        {feed.imageUrl ? (
          <Image source={{ uri: feed.imageUrl }} style={styles.artwork} contentFit="cover" cachePolicy="memory-disk" transition={0} />
        ) : (
          <View style={[styles.artwork, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
            <Ionicons name="mic" size={36} color={colors.textSecondary} />
          </View>
        )}
        <View style={styles.artInfo}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{episode.title}</Text>
          <Pressable onPress={onOpenPodcast} hitSlop={8}>
            <Text style={[styles.feedName, { color: colors.accent }]} numberOfLines={1}>{feed.title}</Text>
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
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.border}
          thumbTintColor={colors.accent}
        />
        <View style={styles.timeRow}>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>{formatTime(isSeeking ? seekValue : position.positionMs)}</Text>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>-{formatTime(Math.max(0, position.durationMs - (isSeeking ? seekValue : position.positionMs)))}</Text>
        </View>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <FocusableView focusRadius={12} onPress={cycleRate} style={[styles.smallBtn, { backgroundColor: colors.surfaceAlt }]}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: colors.text }}>{playback.playbackRate}x</Text>
        </FocusableView>
        <FocusableView focusRadius={20} onPress={() => onSkip(-skipBackwardSeconds)} hitSlop={8} style={styles.skipBtn}>
          <MaterialIcons name={skipBackwardIcon as any} size={26} color={colors.text} />
        </FocusableView>
        <FocusableView autoFocus focusRadius={32} onPress={() => { playback.isPlaying ? onPause() : onResume(); }} hitSlop={12} style={[styles.playBtn, { backgroundColor: colors.accent }]}>
          {playback.isLoading ? <ActivityIndicator size={28} color="#fff" /> : <Ionicons name={playback.isPlaying ? "pause" : "play"} size={32} color="#fff" style={playback.isPlaying ? undefined : { marginLeft: 3 }} />}
        </FocusableView>
        <FocusableView focusRadius={20} onPress={() => onSkip(skipForwardSeconds)} hitSlop={8} style={styles.skipBtn}>
          <MaterialIcons name={skipForwardIcon as any} size={26} color={colors.text} />
        </FocusableView>
        <FocusableView focusRadius={12} onPress={onStop} hitSlop={8} style={[styles.smallBtn, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name="stop" size={16} color={colors.danger} />
        </FocusableView>
      </View>

      {/* Secondary */}
      <View style={styles.secondary}>
        <FocusableView focusRadius={10} onPress={onSleepPress} style={[styles.secBtn, { backgroundColor: sleepActive ? colors.accentLight : colors.surfaceAlt }]}>
          <Ionicons name="moon-outline" size={16} color={sleepActive ? colors.accent : colors.textSecondary} />
          {sleepLabel ? <Text style={{ fontSize: 11, color: colors.accent }}>{sleepLabel}</Text> : null}
        </FocusableView>
        <FocusableView focusRadius={10} onPress={onBookmarkPress} style={[styles.secBtn, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name={bookmarkSaved ? "checkmark" : "bookmark-outline"} size={16} color={bookmarkSaved ? colors.success : colors.textSecondary} />
        </FocusableView>
        <FocusableView focusRadius={10} onPress={onFavoritePress} style={[styles.secBtn, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name={isFavorited ? "star" : "star-outline"} size={16} color={isFavorited ? colors.accent : colors.textSecondary} />
        </FocusableView>
        <FocusableView focusRadius={10} onPress={onQueuePress} style={[styles.secBtn, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name="list" size={16} color={colors.textSecondary} />
        </FocusableView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "space-between" as const },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8 },
  headerTitle: { fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1 },
  artRow: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 12, gap: 14, alignItems: "center" },
  artwork: { width: 130, height: 130, borderRadius: 14 },
  artInfo: { flex: 1, gap: 6 },
  title: { fontSize: 17, fontWeight: "700", lineHeight: 22 },
  feedName: { fontSize: 14, textDecorationLine: "underline" },
  sliderWrap: { paddingHorizontal: 20, marginBottom: 8 },
  slider: { width: "100%" as any, height: 36 },
  timeRow: { flexDirection: "row", justifyContent: "space-between" },
  timeText: { fontSize: 12, fontWeight: "500" },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 16, paddingVertical: 10 },
  smallBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  skipBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  playBtn: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
  secondary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, paddingVertical: 8, paddingBottom: 16 },
  secBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
});
