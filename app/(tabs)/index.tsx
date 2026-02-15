import React, { useMemo } from "react";
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, useColorScheme, ActivityIndicator, RefreshControl, Platform, Dimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import PodcastCard from "@/components/PodcastCard";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import type { Feed, Episode, Category } from "@/lib/types";
import { queryClient } from "@/lib/query-client";
import { router } from "expo-router";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { lightHaptic } from "@/lib/haptics";

const SCREEN_WIDTH = Dimensions.get("window").width;

interface TrendingEpisode extends Episode {
  listenCount: number;
}

function TrendingHero({ episode, feed, colors, onPlay }: { episode: TrendingEpisode; feed: Feed; colors: any; onPlay: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.heroCard, { opacity: pressed ? 0.95 : 1 }]}
      onPress={onPlay}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.heroImage} contentFit="cover" />
      ) : (
        <View style={[styles.heroImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={56} color={colors.textSecondary} />
        </View>
      )}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.85)"]}
        style={styles.heroGradient}
      />
      <View style={styles.heroContent}>
        <View style={styles.heroBadge}>
          <Ionicons name="flame" size={11} color="#f59e0b" />
          <Text style={styles.heroBadgeText}>Trending</Text>
        </View>
        <Text style={styles.heroTitle} numberOfLines={2}>{episode.title}</Text>
        <Text style={styles.heroAuthor} numberOfLines={1}>{feed.title}</Text>
        {episode.listenCount > 0 && (
          <View style={styles.heroListens}>
            <Ionicons name="headset-outline" size={12} color="rgba(255,255,255,0.6)" />
            <Text style={styles.heroListensText}>
              {episode.listenCount} {episode.listenCount === 1 ? "listen" : "listens"}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

function TrendingEpisodeCard({ episode, feed, rank, colors, onPlay }: { episode: TrendingEpisode; feed: Feed; rank: number; colors: any; onPlay: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.trendingCard,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
      ]}
      onPress={onPlay}
    >
      <View style={[styles.rankBadge, { backgroundColor: rank <= 3 ? colors.accent : colors.surfaceAlt }]}>
        <Text style={[styles.rankText, { color: rank <= 3 ? "#fff" : colors.textSecondary }]}>{rank}</Text>
      </View>
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.trendingImage} contentFit="cover" />
      ) : (
        <View style={[styles.trendingImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={16} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.trendingInfo}>
        <Text style={[styles.trendingFeed, { color: colors.accent }]} numberOfLines={1}>
          {feed.title}
        </Text>
        <Text style={[styles.trendingTitle, { color: colors.text }]} numberOfLines={2}>
          {episode.title}
        </Text>
        {episode.listenCount > 0 && (
          <View style={styles.trendingMeta}>
            <Ionicons name="headset-outline" size={11} color={colors.textSecondary} />
            <Text style={[styles.trendingMetaText, { color: colors.textSecondary }]}>
              {episode.listenCount}
            </Text>
          </View>
        )}
      </View>
      <View style={[styles.trendingPlayBtn, { backgroundColor: colors.accentLight }]}>
        <Ionicons name="play" size={14} color={colors.accent} />
      </View>
    </Pressable>
  );
}

function CategorySection({ category, feeds, colors }: { category: Category; feeds: Feed[]; colors: any }) {
  if (feeds.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{category.name}</Text>
      <FlatList
        horizontal
        data={feeds}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <PodcastCard feed={item} size="small" />}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20 }}
      />
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { playEpisode, currentEpisode, playback, pause, resume } = useAudioPlayer();

  const categoriesQuery = useQuery<Category[]>({ queryKey: ["/api/categories"] });
  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const latestQuery = useQuery<Episode[]>({ queryKey: ["/api/episodes/latest"] });
  const trendingQuery = useQuery<TrendingEpisode[]>({ queryKey: ["/api/episodes/trending"] });

  const isLoading = categoriesQuery.isLoading || feedsQuery.isLoading;
  const categories = categoriesQuery.data || [];
  const allFeeds = feedsQuery.data || [];
  const latestEpisodes = (latestQuery.data || []).slice(0, 20);
  const trendingEpisodes = trendingQuery.data || [];

  const handlePlayEpisode = (episode: Episode, feed: Feed) => {
    lightHaptic();
    if (currentEpisode?.id === episode.id) {
      playback.isPlaying ? pause() : resume();
    } else {
      playEpisode(episode, feed);
    }
  };

  const { heroEpisode, heroFeed, quickPlayItems } = useMemo(() => {
    const trending = trendingEpisodes.length > 0 ? trendingEpisodes : latestEpisodes.map(e => ({ ...e, listenCount: 0 }));
    if (trending.length === 0) return { heroEpisode: null, heroFeed: null, quickPlayItems: [] };
    
    const hero = trending[0] as TrendingEpisode;
    const hFeed = allFeeds.find(f => f.id === hero.feedId);
    
    const qpItems: { episode: TrendingEpisode; feed: Feed }[] = [];
    for (let i = 1; i < trending.length && qpItems.length < 5; i++) {
      const ep = trending[i] as TrendingEpisode;
      const feed = allFeeds.find(f => f.id === ep.feedId);
      if (feed) qpItems.push({ episode: ep, feed });
    }
    
    return { heroEpisode: hero, heroFeed: hFeed || null, quickPlayItems: qpItems };
  }, [trendingEpisodes, latestEpisodes, allFeeds]);

  const recentEpisodes = useMemo(() => {
    const trendingIds = new Set(trendingEpisodes.slice(0, 6).map(e => e.id));
    return latestEpisodes
      .filter(ep => !trendingIds.has(ep.id))
      .slice(0, 8)
      .map(ep => ({
        episode: ep,
        feed: allFeeds.find(f => f.id === ep.feedId),
      }))
      .filter(x => x.feed) as { episode: Episode; feed: Feed }[];
  }, [latestEpisodes, trendingEpisodes, allFeeds]);

  const onRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/latest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/trending"] });
  };

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 100 }} />
      </View>
    );
  }

  const hasContent = allFeeds.length > 0;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 140 }}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.greeting, { color: colors.textSecondary }]}>Discover</Text>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Kosher Podcasts</Text>
          </View>
          <View style={[styles.headerIcon, { backgroundColor: colors.surfaceAlt }]}>
            <Ionicons name="headset" size={24} color={colors.accent} />
          </View>
        </View>
      </View>

      {!hasContent && (
        <View style={styles.emptyState}>
          <Ionicons name="radio-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Welcome!</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            Podcasts will appear here once the admin adds approved RSS feeds.
          </Text>
        </View>
      )}

      {heroEpisode && heroFeed && (
        <View style={styles.heroSection}>
          <TrendingHero
            episode={heroEpisode}
            feed={heroFeed}
            colors={colors}
            onPlay={() => handlePlayEpisode(heroEpisode, heroFeed)}
          />
        </View>
      )}

      {quickPlayItems.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Ionicons name="flame" size={18} color="#f59e0b" />
            <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0 }]}>Trending</Text>
          </View>
          <View style={{ paddingHorizontal: 20 }}>
            {quickPlayItems.map(({ episode, feed }, index) => (
              <TrendingEpisodeCard
                key={episode.id}
                episode={episode}
                feed={feed}
                rank={index + 2}
                colors={colors}
                onPlay={() => handlePlayEpisode(episode, feed)}
              />
            ))}
          </View>
        </View>
      )}

      {allFeeds.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>All Shows</Text>
          <FlatList
            horizontal
            data={allFeeds}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <PodcastCard feed={item} size="small" />}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20 }}
          />
        </View>
      )}

      {categories.map(cat => {
        const catFeeds = allFeeds.filter(f => f.categoryId === cat.id);
        return <CategorySection key={cat.id} category={cat} feeds={catFeeds} colors={colors} />;
      })}

      {recentEpisodes.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent Episodes</Text>
          <View style={{ paddingHorizontal: 20 }}>
            {recentEpisodes.map(({ episode, feed }) => (
              <EpisodeItem key={episode.id} episode={episode} feed={feed} showFeedTitle />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  greeting: {
    fontSize: 13,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800" as const,
    marginTop: 2,
  },
  headerIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },

  heroSection: {
    paddingHorizontal: 20,
    marginBottom: 28,
  },
  heroCard: {
    borderRadius: 20,
    overflow: "hidden",
    position: "relative",
  },
  heroImage: {
    width: "100%" as any,
    height: 200,
    alignItems: "center",
    justifyContent: "center",
  },
  heroGradient: {
    ...StyleSheet.absoluteFillObject,
    top: "40%" as any,
  },
  heroContent: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 18,
    gap: 4,
  },
  heroBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 4,
  },
  heroBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  heroTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "800" as const,
    lineHeight: 24,
  },
  heroAuthor: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
  },
  heroListens: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  heroListensText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
  },

  section: {
    marginBottom: 28,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
    paddingHorizontal: 20,
    marginBottom: 14,
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

  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: "700" as const,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
