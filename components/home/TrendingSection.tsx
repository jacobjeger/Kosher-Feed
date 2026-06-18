import React, { useCallback, useMemo } from "react";
import { View, Text, StyleSheet, FlatList } from "react-native";
import FocusableView from "@/components/FocusableView";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import SectionHeader from "./SectionHeader";
import type { Feed, Episode } from "@/lib/types";
import { resizedImageUrl, IMG_CARD } from "@/lib/image-resize";

interface TrendingEpisode extends Episode {
  listenCount: number;
}

const TrendingEpisodeCard = React.memo(function TrendingEpisodeCard({ episode, feed, rank, colors, onPlay }: { episode: TrendingEpisode; feed: Feed; rank: number; colors: any; onPlay: () => void }) {
  return (
    <FocusableView focusRadius={14} style={[styles.trendingCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]} onPress={onPlay}>
      <View style={[styles.rankBadge, { backgroundColor: rank <= 3 ? colors.accent : colors.surfaceAlt }]}>
        <Text style={[styles.rankText, { color: rank <= 3 ? "#fff" : colors.textSecondary }]}>{rank}</Text>
      </View>
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.trendingImage} contentFit="cover" cachePolicy="memory-disk" transition={180} />
      ) : (
        <View style={[styles.trendingImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={20} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.trendingInfo}>
        <Text style={[styles.trendingFeed, { color: colors.accent }]} numberOfLines={1}>{feed.title}</Text>
        <Text style={[styles.trendingTitle, { color: colors.text }]} numberOfLines={2}>{episode.title}</Text>
        <View style={styles.trendingMeta}>
          <Ionicons name="headset-outline" size={11} color={colors.textSecondary} />
          <Text style={[styles.trendingMetaText, { color: colors.textSecondary }]}>
            {episode.listenCount} {episode.listenCount === 1 ? "listen" : "listens"}
          </Text>
        </View>
      </View>
      <FocusableView focusRadius={16} style={[styles.trendingPlayBtn, { backgroundColor: colors.accent }]} onPress={onPlay}>
        <Ionicons name="play" size={16} color="#fff" />
      </FocusableView>
    </FocusableView>
  );
});

interface Props {
  items: { episode: TrendingEpisode; feed: Feed }[];
  colors: any;
  onPlay: (episode: Episode, feed: Feed) => void;
}

type TrendingItem = { episode: TrendingEpisode; feed: Feed };

export default React.memo(function TrendingSection({ items, colors, onPlay }: Props) {
  // Switched from an unmemoized .map() to a FlatList so renderItem is a
  // stable callback (was creating a fresh `() => onPlay(...)` closure per
  // card on every parent re-render). Vertical stack stays the same — the
  // list isn't paginated, just virtualized.
  const itemsWithRank = useMemo(
    () => items.map((it, i): TrendingItem & { rank: number } => ({ ...it, rank: i + 1 })),
    [items],
  );
  const renderItem = useCallback(({ item }: { item: TrendingItem & { rank: number } }) => (
    <TrendingEpisodeCard
      episode={item.episode}
      feed={item.feed}
      rank={item.rank}
      colors={colors}
      onPlay={() => onPlay(item.episode, item.feed)}
    />
  ), [colors, onPlay]);
  const keyExtractor = useCallback((item: TrendingItem) => item.episode.id, []);

  if (items.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title="Trending" icon="flame" iconColor="#f59e0b" colors={colors} />
      <FlatList
        data={itemsWithRank}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        scrollEnabled={false}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        initialNumToRender={5}
        maxToRenderPerBatch={3}
        windowSize={2}
        removeClippedSubviews={false}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    marginBottom: 28,
  },
  trendingCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 10,
    paddingRight: 12,
  },
  rankBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 12,
  },
  rankText: {
    fontSize: 13,
    fontWeight: "800" as const,
  },
  trendingImage: {
    width: 52,
    height: 52,
    borderRadius: 10,
    marginLeft: 10,
    marginVertical: 10,
  },
  trendingInfo: {
    flex: 1,
    paddingHorizontal: 12,
    gap: 2,
  },
  trendingFeed: {
    fontSize: 10,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.3,
  },
  trendingTitle: {
    fontSize: 13,
    fontWeight: "600" as const,
    lineHeight: 17,
  },
  trendingMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 1,
  },
  trendingMetaText: {
    fontSize: 11,
  },
  trendingPlayBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
});
