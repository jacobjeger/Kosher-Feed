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

const SCREEN_WIDTH = Dimensions.get("window").width;

function FeaturedHero({ feed, colors, isDark }: { feed: Feed; colors: any; isDark: boolean }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.heroCard, { opacity: pressed ? 0.95 : 1 }]}
      onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.heroImage} contentFit="cover" />
      ) : (
        <View style={[styles.heroImage, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons name="mic" size={56} color={colors.textSecondary} />
        </View>
      )}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.85)"]}
        style={styles.heroGradient}
      />
      <View style={styles.heroContent}>
        <View style={styles.heroBadge}>
          <Ionicons name="star" size={10} color="#fbbf24" />
          <Text style={styles.heroBadgeText}>Featured</Text>
        </View>
        <Text style={styles.heroTitle} numberOfLines={2}>{feed.title}</Text>
        {feed.author && (
          <Text style={styles.heroAuthor} numberOfLines={1}>{feed.author}</Text>
        )}
      </View>
    </Pressable>
  );
}

function QuickPlayEpisode({ episode, feed, colors }: { episode: Episode; feed: Feed; colors: any }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.quickPlayCard,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
      ]}
      onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.quickPlayImage} contentFit="cover" />
      ) : (
        <View style={[styles.quickPlayImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={16} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.quickPlayInfo}>
        <Text style={[styles.quickPlayFeed, { color: colors.textSecondary }]} numberOfLines={1}>
          {feed.title}
        </Text>
        <Text style={[styles.quickPlayTitle, { color: colors.text }]} numberOfLines={1}>
          {episode.title}
        </Text>
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

  const categoriesQuery = useQuery<Category[]>({ queryKey: ["/api/categories"] });
  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const latestQuery = useQuery<Episode[]>({ queryKey: ["/api/episodes/latest"] });

  const isLoading = categoriesQuery.isLoading || feedsQuery.isLoading;
  const categories = categoriesQuery.data || [];
  const allFeeds = feedsQuery.data || [];
  const latestEpisodes = (latestQuery.data || []).slice(0, 20);

  const uncategorizedFeeds = allFeeds.filter(f => !f.categoryId);

  const { featuredFeed, remainingFeeds } = useMemo(() => {
    if (allFeeds.length === 0) return { featuredFeed: null, remainingFeeds: [] };
    const featured = allFeeds[0];
    const rest = allFeeds.slice(1);
    return { featuredFeed: featured, remainingFeeds: rest };
  }, [allFeeds]);

  const quickPlayItems = useMemo(() => {
    const items: { episode: Episode; feed: Feed }[] = [];
    for (const ep of latestEpisodes) {
      const feed = allFeeds.find(f => f.id === ep.feedId);
      if (feed && items.length < 6) {
        items.push({ episode: ep, feed });
      }
    }
    return items;
  }, [latestEpisodes, allFeeds]);

  const recentEpisodes = useMemo(() => {
    return latestEpisodes.slice(0, 10).map(ep => ({
      episode: ep,
      feed: allFeeds.find(f => f.id === ep.feedId),
    })).filter(x => x.feed) as { episode: Episode; feed: Feed }[];
  }, [latestEpisodes, allFeeds]);

  const onRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/latest"] });
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

      {featuredFeed && (
        <View style={styles.heroSection}>
          <FeaturedHero feed={featuredFeed} colors={colors} isDark={isDark} />
        </View>
      )}

      {quickPlayItems.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Play</Text>
          <View style={styles.quickPlayGrid}>
            {quickPlayItems.map(({ episode, feed }) => (
              <QuickPlayEpisode key={episode.id} episode={episode} feed={feed} colors={colors} />
            ))}
          </View>
        </View>
      )}

      {remainingFeeds.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>All Shows</Text>
          <FlatList
            horizontal
            data={remainingFeeds}
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
    fontSize: 22,
    fontWeight: "800" as const,
    lineHeight: 26,
  },
  heroAuthor: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
  },

  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
    paddingHorizontal: 20,
    marginBottom: 14,
  },

  quickPlayGrid: {
    paddingHorizontal: 20,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  quickPlayCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    width: (SCREEN_WIDTH - 50) / 2,
    height: 56,
  },
  quickPlayImage: {
    width: 56,
    height: 56,
  },
  quickPlayInfo: {
    flex: 1,
    paddingHorizontal: 10,
    gap: 2,
  },
  quickPlayFeed: {
    fontSize: 10,
    fontWeight: "600" as const,
  },
  quickPlayTitle: {
    fontSize: 12,
    fontWeight: "600" as const,
    lineHeight: 15,
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
