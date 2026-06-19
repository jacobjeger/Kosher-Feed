import React, { useCallback } from "react";
import { View, Text, FlatList, StyleSheet, Platform } from "react-native";
import FocusableView from "@/components/FocusableView";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import SectionHeader from "./SectionHeader";
import type { Feed, Episode } from "@/lib/types";
import { feedImageSource, IMG_CARD } from "@/lib/image-resize";

interface SavedPositionEntry {
  episodeId: string;
  feedId: string;
  positionMs: number;
  durationMs: number;
  updatedAt: string;
}

interface ContinueListeningItem {
  episode: Episode;
  feed: Feed;
  position: SavedPositionEntry;
}

const ContinueListeningCard = React.memo(function ContinueListeningCard({ episode, feed, position, colors, onPlay, onDismiss }: { episode: Episode; feed: Feed; position: SavedPositionEntry; colors: any; onPlay: () => void; onDismiss: () => void }) {
  const progress = position.durationMs > 0 ? Math.min(position.positionMs / position.durationMs, 1) : 0;
  const remainingMs = position.durationMs - position.positionMs;
  const remainingMin = Math.max(1, Math.round(remainingMs / 60000));

  return (
    <FocusableView focusRadius={14} style={[styles.continueCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]} onPress={onPlay}>
      <FocusableView focusRadius={11} style={[styles.continueDismiss, { backgroundColor: "rgba(0,0,0,0.5)" }]} onPress={onDismiss} hitSlop={6}>
        <Ionicons name="close" size={12} color="#fff" />
      </FocusableView>
      {feed.imageUrl ? (
        <Image source={feedImageSource(feed.imageUrl, IMG_CARD)} style={styles.continueImage} contentFit="cover" cachePolicy="memory-disk" recyclingKey={feed.id} transition={180} />
      ) : (
        <View style={[styles.continueImage, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name="mic" size={24} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.continueInfo}>
        <Text style={[styles.continueEpTitle, { color: colors.text }]} numberOfLines={2}>{episode.title}</Text>
        <Text style={[styles.continueFeedTitle, { color: colors.textSecondary }]} numberOfLines={1}>{feed.title}</Text>
        <View style={[styles.continueProgressBg, { backgroundColor: colors.progressBg }]}>
          <View style={[styles.continueProgressFill, { width: `${progress * 100}%`, backgroundColor: colors.accent }]} />
        </View>
        <Text style={{ fontSize: 10, color: colors.textTertiary, marginTop: 2 }}>{remainingMin}m left</Text>
      </View>
    </FocusableView>
  );
});

interface Props {
  items: ContinueListeningItem[];
  colors: any;
  onPlay: (episode: Episode, feed: Feed) => void;
  onDismiss: (episodeId: string) => void;
}

export default React.memo(function ContinueListeningSection({ items, colors, onPlay, onDismiss }: Props) {
  // renderItem stabilized on the props that actually drive child renders.
  // Per-card onPlay/onDismiss are now bound via item ids so we don't create
  // new closures inside the render path for every card every parent render.
  const renderItem = useCallback(({ item }: { item: ContinueListeningItem }) => (
    <ContinueListeningCard
      episode={item.episode}
      feed={item.feed}
      position={item.position}
      colors={colors}
      onPlay={() => onPlay(item.episode, item.feed)}
      onDismiss={() => onDismiss(item.episode.id)}
    />
  ), [colors, onPlay, onDismiss]);
  const keyExtractor = useCallback((item: ContinueListeningItem) => item.episode.id, []);

  if (items.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title="Continue Listening" colors={colors} />
      <FlatList
        horizontal
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={3}
        removeClippedSubviews={Platform.OS !== "web"}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    marginBottom: 28,
  },
  continueCard: {
    width: 145,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginRight: 12,
    position: "relative" as const,
  },
  continueDismiss: {
    position: "absolute" as const,
    top: 6,
    right: 6,
    zIndex: 10,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  continueImage: {
    width: "100%" as any,
    height: 85,
    alignItems: "center",
    justifyContent: "center",
  },
  continueInfo: {
    padding: 10,
    gap: 4,
  },
  continueEpTitle: {
    fontSize: 12,
    fontWeight: "600" as const,
    lineHeight: 16,
  },
  continueFeedTitle: {
    fontSize: 10,
    fontWeight: "500" as const,
  },
  continueProgressBg: {
    height: 3,
    borderRadius: 2,
    marginTop: 4,
  },
  continueProgressFill: {
    height: "100%" as any,
    borderRadius: 2,
  },
});
