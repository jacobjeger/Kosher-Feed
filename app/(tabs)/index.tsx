import React, { useMemo, useState, useCallback, useEffect } from "react";
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, useColorScheme, ActivityIndicator, RefreshControl, Platform, Dimensions, TextInput } from "react-native";
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

interface SavedPositionEntry {
  episodeId: string;
  feedId: string;
  positionMs: number;
  durationMs: number;
  updatedAt: string;
}

const SCREEN_WIDTH = Dimensions.get("window").width;

interface TrendingEpisode extends Episode {
  listenCount: number;
}

const TrendingHero = React.memo(function TrendingHero({ episode, feed, colors, onPlay }: { episode: TrendingEpisode; feed: Feed; colors: any; onPlay: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.heroCard, { opacity: pressed ? 0.95 : 1 }]}
      onPress={onPlay}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.heroImage} contentFit="cover" cachePolicy="memory-disk" />
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
});

const TrendingEpisodeCard = React.memo(function TrendingEpisodeCard({ episode, feed, rank, colors, onPlay }: { episode: TrendingEpisode; feed: Feed; rank: number; colors: any; onPlay: () => void }) {
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
        <Image source={{ uri: feed.imageUrl }} style={styles.trendingImage} contentFit="cover" cachePolicy="memory-disk" />
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
});

const CategorySection = React.memo(function CategorySection({ category, feeds, colors }: { category: Category; feeds: Feed[]; colors: any }) {
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
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={3}
        removeClippedSubviews={Platform.OS !== "web"}
      />
    </View>
  );
});

const SearchResultItem = React.memo(function SearchResultItem({ feed, colors }: { feed: Feed; colors: any }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.searchResult,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.9 : 1 },
      ]}
      onPress={() => router.push(`/podcast/${feed.id}`)}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.searchResultImage} contentFit="cover" cachePolicy="memory-disk" />
      ) : (
        <View style={[styles.searchResultImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={20} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.searchResultInfo}>
        <Text style={[styles.searchResultTitle, { color: colors.text }]} numberOfLines={1}>
          {feed.title}
        </Text>
        {feed.author ? (
          <Text style={[styles.searchResultAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
            {feed.author}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </Pressable>
  );
});

const ContinueListeningCard = React.memo(function ContinueListeningCard({ episode, feed, position, colors, onPlay, onDismiss }: { episode: Episode; feed: Feed; position: SavedPositionEntry; colors: any; onPlay: () => void; onDismiss: () => void }) {
  const progress = position.durationMs > 0 ? position.positionMs / position.durationMs : 0;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.continueCard,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
      ]}
      onPress={onPlay}
    >
      <Pressable
        onPress={(e) => {
          e.stopPropagation?.();
          onDismiss();
        }}
        hitSlop={6}
        style={[styles.continueDismiss, { backgroundColor: colors.surfaceAlt }]}
      >
        <Ionicons name="close" size={12} color={colors.textSecondary} />
      </Pressable>
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.continueImage} contentFit="cover" cachePolicy="memory-disk" />
      ) : (
        <View style={[styles.continueImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={20} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.continueInfo}>
        <Text style={[styles.continueEpTitle, { color: colors.text }]} numberOfLines={2}>
          {episode.title}
        </Text>
        <Text style={[styles.continueFeedTitle, { color: colors.textSecondary }]} numberOfLines={1}>
          {feed.title}
        </Text>
        <View style={[styles.continueProgressBg, { backgroundColor: colors.border }]}>
          <View style={[styles.continueProgressFill, { width: `${Math.min(progress * 100, 100)}%` as any, backgroundColor: colors.accent }]} />
        </View>
      </View>
    </Pressable>
  );
});

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { playEpisode, currentEpisode, playback, pause, resume, recentlyPlayed, getInProgressEpisodes, removeSavedPosition } = useAudioPlayer();
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [inProgressPositions, setInProgressPositions] = useState<SavedPositionEntry[]>([]);

  useEffect(() => {
    getInProgressEpisodes().then(setInProgressPositions).catch(() => {});
  }, [getInProgressEpisodes]);

  const categoriesQuery = useQuery<Category[]>({ queryKey: ["/api/categories"] });
  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const latestQuery = useQuery<Episode[]>({ queryKey: ["/api/episodes/latest"] });
  const trendingQuery = useQuery<TrendingEpisode[]>({ queryKey: ["/api/episodes/trending"] });

  const isLoading = categoriesQuery.isLoading || feedsQuery.isLoading;
  const hasError = feedsQuery.isError || categoriesQuery.isError;
  const errorMessage = feedsQuery.error?.message || categoriesQuery.error?.message || "Could not connect to server";
  const categories = categoriesQuery.data || [];
  const allFeeds = feedsQuery.data || [];
  const latestEpisodes = (latestQuery.data || []).slice(0, 20);
  const trendingEpisodes = trendingQuery.data || [];

  const handleDismissContinue = useCallback(async (episodeId: string) => {
    lightHaptic();
    await removeSavedPosition(episodeId);
    setInProgressPositions(prev => prev.filter(p => p.episodeId !== episodeId));
  }, [removeSavedPosition]);

  const handlePlayEpisode = useCallback((episode: Episode, feed: Feed) => {
    lightHaptic();
    if (currentEpisode?.id === episode.id) {
      playback.isPlaying ? pause() : resume();
    } else {
      playEpisode(episode, feed);
    }
  }, [currentEpisode?.id, playback.isPlaying, pause, resume, playEpisode]);

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

  const continueListeningItems = useMemo(() => {
    if (inProgressPositions.length === 0 || allFeeds.length === 0) return [];
    const allEpisodes = latestQuery.data || [];
    const episodeMap = new Map(allEpisodes.map(ep => [ep.id, ep]));
    return inProgressPositions
      .map(pos => {
        const episode = episodeMap.get(pos.episodeId);
        const feed = allFeeds.find(f => f.id === pos.feedId);
        if (episode && feed) return { episode, feed, position: pos };
        return null;
      })
      .filter(Boolean)
      .slice(0, 10) as { episode: Episode; feed: Feed; position: SavedPositionEntry }[];
  }, [inProgressPositions, latestQuery.data, allFeeds]);

  const recentlyListenedItems = useMemo(() => {
    if (recentlyPlayed.length === 0) return [];
    const allEpisodes = latestQuery.data || [];
    const episodeMap = new Map(allEpisodes.map(ep => [ep.id, ep]));
    return recentlyPlayed
      .map(entry => {
        const episode = episodeMap.get(entry.episodeId);
        const feed = allFeeds.find(f => f.id === entry.feedId);
        if (episode && feed) return { episode, feed };
        return null;
      })
      .filter(Boolean) as { episode: Episode; feed: Feed }[];
  }, [recentlyPlayed, latestQuery.data, allFeeds]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase().trim();
    return allFeeds.filter(
      (f) =>
        f.title.toLowerCase().includes(q) ||
        (f.author && f.author.toLowerCase().includes(q)) ||
        (f.description && f.description.toLowerCase().includes(q))
    );
  }, [searchQuery, allFeeds]);

  const isSearching = searchQuery.trim().length > 0;

  const onRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/latest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/trending"] });
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 100 }} />
      </View>
    );
  }

  if (hasError) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.errorState}>
          <Ionicons name="cloud-offline-outline" size={56} color={colors.textSecondary} />
          <Text style={[styles.errorTitle, { color: colors.text }]}>Connection Issue</Text>
          <Text style={[styles.errorSubtitle, { color: colors.textSecondary }]}>
            {errorMessage.includes("Network") || errorMessage.includes("fetch")
              ? "Unable to reach the server. Please check your internet connection and try again."
              : `Something went wrong: ${errorMessage}`}
          </Text>
          <Pressable
            style={[styles.retryButton, { backgroundColor: colors.accent }]}
            onPress={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
              queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
              queryClient.invalidateQueries({ queryKey: ["/api/episodes/latest"] });
              queryClient.invalidateQueries({ queryKey: ["/api/episodes/trending"] });
            }}
          >
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={styles.retryButtonText}>Try Again</Text>
          </Pressable>
        </View>
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
            <Text style={[styles.headerTitle, { color: colors.text }]}>ShiurPod</Text>
          </View>
          <View style={[styles.headerIcon, { backgroundColor: colors.surfaceAlt }]}>
            <Ionicons name="headset" size={24} color={colors.accent} />
          </View>
        </View>

        <View style={[styles.searchContainer, { backgroundColor: colors.surfaceAlt, borderColor: isSearchFocused ? colors.accent : "transparent" }]}>
          <Ionicons name="search" size={18} color={colors.textSecondary} style={{ marginLeft: 14 }} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search shiurim..."
            placeholderTextColor={colors.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setIsSearchFocused(false)}
            returnKeyType="search"
            testID="search-input"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery("")} style={styles.searchClear} testID="search-clear">
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
      </View>

      {isSearching && (
        <View style={styles.searchResultsSection}>
          {searchResults.length > 0 ? (
            <>
              <Text style={[styles.searchResultsCount, { color: colors.textSecondary }]}>
                {searchResults.length} {searchResults.length === 1 ? "result" : "results"}
              </Text>
              <View style={{ paddingHorizontal: 20 }}>
                {searchResults.map((feed) => (
                  <SearchResultItem key={feed.id} feed={feed} colors={colors} />
                ))}
              </View>
            </>
          ) : (
            <View style={styles.noResults}>
              <Ionicons name="search-outline" size={40} color={colors.textSecondary} />
              <Text style={[styles.noResultsText, { color: colors.textSecondary }]}>
                No shiurim found for "{searchQuery}"
              </Text>
            </View>
          )}
        </View>
      )}

      {!isSearching && !hasContent && (
        <View style={styles.emptyState}>
          <Ionicons name="radio-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Welcome!</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            Shiurim will appear here once approved RSS feeds are added.
          </Text>
        </View>
      )}

      {!isSearching && continueListeningItems.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Continue Listening</Text>
          <FlatList
            horizontal
            data={continueListeningItems}
            keyExtractor={(item) => item.episode.id}
            renderItem={({ item }) => (
              <ContinueListeningCard
                episode={item.episode}
                feed={item.feed}
                position={item.position}
                colors={colors}
                onPlay={() => handlePlayEpisode(item.episode, item.feed)}
                onDismiss={() => handleDismissContinue(item.episode.id)}
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
      )}

      {!isSearching && heroEpisode && heroFeed && (
        <View style={styles.heroSection}>
          <TrendingHero
            episode={heroEpisode}
            feed={heroFeed}
            colors={colors}
            onPlay={() => handlePlayEpisode(heroEpisode, heroFeed)}
          />
        </View>
      )}

      {!isSearching && quickPlayItems.length > 0 && (
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

      {!isSearching && allFeeds.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>All Shiurim</Text>
          <FlatList
            horizontal
            data={allFeeds}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <PodcastCard feed={item} size="small" />}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20 }}
            initialNumToRender={5}
            maxToRenderPerBatch={5}
            windowSize={3}
            removeClippedSubviews={Platform.OS !== "web"}
          />
        </View>
      )}

      {!isSearching && categories.map(cat => {
        const catFeeds = allFeeds.filter(f => f.categoryId === cat.id);
        return <CategorySection key={cat.id} category={cat} feeds={catFeeds} colors={colors} />;
      })}

      {!isSearching && recentlyListenedItems.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recently Listened</Text>
          <View style={{ paddingHorizontal: 20 }}>
            {recentlyListenedItems.map(({ episode, feed }) => (
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

  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    borderRadius: 14,
    borderWidth: 2,
    height: 46,
    marginBottom: 20,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 0,
    height: 46,
  },
  searchClear: {
    padding: 10,
  },
  searchResultsSection: {
    paddingTop: 4,
    paddingBottom: 20,
  },
  searchResultsCount: {
    fontSize: 12,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  searchResult: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 10,
    paddingRight: 14,
  },
  searchResultImage: {
    width: 56,
    height: 56,
    borderRadius: 12,
    marginLeft: 12,
    marginVertical: 10,
  },
  searchResultInfo: {
    flex: 1,
    paddingHorizontal: 14,
    gap: 2,
  },
  searchResultTitle: {
    fontSize: 15,
    fontWeight: "600" as const,
  },
  searchResultAuthor: {
    fontSize: 12,
  },
  noResults: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    gap: 12,
  },
  noResultsText: {
    fontSize: 14,
    textAlign: "center",
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
  errorState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
    paddingHorizontal: 40,
    gap: 12,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: "700" as const,
  },
  errorSubtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  retryButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600" as const,
  },
  continueCard: {
    width: 160,
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
    height: 100,
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
