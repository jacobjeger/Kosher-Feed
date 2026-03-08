import React from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import type { Feed, Episode } from "@/lib/types";

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
    <Pressable style={[styles.continueCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]} onPress={onPlay}>
      <Pressable style={[styles.continueDismiss, { backgroundColor: "rgba(0,0,0,0.5)" }]} onPress={onDismiss} hitSlop={6}>
        <Ionicons name="close" size={12} color="#fff" />
      </Pressable>
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.continueImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      ) : (
        <View style={[styles.continueImage, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name="mic" size={24} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.continueInfo}>
        <Text style={[styles.continueEpTitle, { color: colors.text }]} numberOfLines={2}>{episode.title}</Text>
        <Text style={[styles.continueFeedTitle, { color: colors.textSecondary }]} numberOfLines={1}>{feed.title}</Text>
        <View style={[styles.continueProgressBg, { backgroundColor: colors.border }]}>
          <View style={[styles.continueProgressFill, { width: `${progress * 100}%`, backgroundColor: colors.accent }]} />
        </View>
        <Text style={{ fontSize: 10, color: colors.textSecondary, marginTop: 2 }}>{remainingMin}m left</Text>
      </View>
    </Pressable>
  );
});

interface Props {
  items: ContinueListeningItem[];
  colors: any;
  onPlay: (episode: Episode, feed: Feed) => void;
  onDismiss: (episodeId: string) => void;
}

export default React.memo(function ContinueListeningSection({ items, colors, onPlay, onDismiss }: Props) {
  if (items.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>Continue Listening</Text>
      <FlatList
        horizontal
        data={items}
        keyExtractor={(item) => item.episode.id}
        renderItem={({ item }) => (
          <ContinueListeningCard
            episode={item.episode}
            feed={item.feed}
            position={item.position}
            colors={colors}
            onPlay={() => onPlay(item.episode, item.feed)}
            onDismiss={() => onDismiss(item.episode.id)}
          />
        )}
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
    marginBottom: 22,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
    paddingHorizontal: 20,
    marginBottom: 10,
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
