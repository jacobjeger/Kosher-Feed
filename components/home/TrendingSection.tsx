import React from "react";
import { View, Text, StyleSheet } from "react-native";
import FocusableView from "@/components/FocusableView";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import SectionHeader from "./SectionHeader";
import type { Feed, Episode } from "@/lib/types";

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
        <Image source={{ uri: feed.imageUrl }} style={styles.trendingImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
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

export default React.memo(function TrendingSection({ items, colors, onPlay }: Props) {
  if (items.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title="Trending" icon="flame" iconColor="#f59e0b" colors={colors} />
      <View style={{ paddingHorizontal: 20 }}>
        {items.map(({ episode, feed }, index) => (
          <TrendingEpisodeCard
            key={episode.id}
            episode={episode}
            feed={feed}
            rank={index + 1}
            colors={colors}
            onPlay={() => onPlay(episode, feed)}
          />
        ))}
      </View>
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
