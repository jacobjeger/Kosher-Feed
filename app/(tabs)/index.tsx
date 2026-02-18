import React, { useMemo, useState, useCallback, useEffect, useRef, forwardRef } from "react";
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, ActivityIndicator, RefreshControl, Platform, TextInput, Dimensions, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import PodcastCard from "@/components/PodcastCard";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import type { Feed, Episode, Category, MaggidShiur } from "@/lib/types";
import { queryClient, getApiUrl } from "@/lib/query-client";
import { router } from "expo-router";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { lightHaptic } from "@/lib/haptics";
import { ErrorBoundary } from "@/components/ErrorBoundary";

interface SavedPositionEntry {
  episodeId: string;
  feedId: string;
  positionMs: number;
  durationMs: number;
  updatedAt: string;
}

interface TrendingEpisode extends Episode {
  listenCount: number;
}

const screenWidth = Dimensions.get("window").width;
const CAROUSEL_WIDTH = Platform.OS === "web" ? Math.min(screenWidth - 40, 860) : screenWidth - 40;
const CAROUSEL_HEIGHT = Platform.OS === "web" ? 260 : 180;
const AUTO_SCROLL_INTERVAL = 5000;

const FeaturedCarousel = React.memo(function FeaturedCarousel({ feeds, colors }: { feeds: Feed[]; colors: any }) {
  const scrollRef = useRef<FlatList>(null);
  const activeIndexRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startAutoScroll = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (feeds.length <= 1) return;
    timerRef.current = setInterval(() => {
      const next = (activeIndexRef.current + 1) % feeds.length;
      activeIndexRef.current = next;
      setActiveIndex(next);
      scrollRef.current?.scrollToIndex({ index: next, animated: true });
    }, AUTO_SCROLL_INTERVAL);
  }, [feeds.length]);

  useEffect(() => {
    startAutoScroll();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [startAutoScroll]);

  const handleScrollEnd = useCallback((e: any) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / CAROUSEL_WIDTH);
    activeIndexRef.current = idx;
    setActiveIndex(idx);
    startAutoScroll();
  }, [startAutoScroll]);

  const handleScrollBegin = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const renderItem = useCallback(({ item }: { item: Feed }) => (
    <Pressable
      style={({ pressed }) => [styles.carouselSlide, { opacity: pressed ? 0.95 : 1 }]}
      onPress={() => { lightHaptic(); router.push(`/podcast/${item.id}`); }}
    >
      {item.imageUrl ? (
        <Image source={{ uri: item.imageUrl }} style={styles.carouselImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      ) : (
        <View style={[styles.carouselImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={56} color={colors.textSecondary} />
        </View>
      )}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.85)"]}
        style={styles.carouselGradient}
      />
      <View style={styles.carouselContent}>
        <View style={styles.carouselBadge}>
          <Ionicons name="star" size={11} color="#f59e0b" />
          <Text style={styles.carouselBadgeText}>Featured</Text>
        </View>
        <Text style={styles.carouselTitle} numberOfLines={2}>{item.title}</Text>
        {item.author ? (
          <Text style={styles.carouselAuthor} numberOfLines={1}>{item.author}</Text>
        ) : null}
      </View>
    </Pressable>
  ), [colors]);

  return (
    <View style={styles.carouselContainer}>
      <FlatList
        ref={scrollRef}
        data={feeds}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScrollEnd}
        onScrollBeginDrag={handleScrollBegin}
        snapToInterval={CAROUSEL_WIDTH}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: CAROUSEL_WIDTH, offset: CAROUSEL_WIDTH * index, index })}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={3}
      />
      {feeds.length > 1 && (
        <View style={styles.carouselDots}>
          {feeds.map((_, i) => (
            <View
              key={i}
              style={[
                styles.carouselDot,
                { backgroundColor: i === activeIndex ? "#fff" : "rgba(255,255,255,0.4)" },
              ]}
            />
          ))}
        </View>
      )}
    </View>
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
        <Image source={{ uri: feed.imageUrl }} style={styles.trendingImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
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

const MaggidShiurCard = React.memo(function MaggidShiurCard({ author, feeds, colors }: { author: string; feeds: Feed[]; colors: any }) {
  const firstImage = feeds.find(f => f.imageUrl)?.imageUrl;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.maggidCard,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
      ]}
      onPress={() => { lightHaptic(); router.push({ pathname: "/maggid-shiur/[author]" as any, params: { author, feedIds: feeds.map(f => f.id).join(",") } }); }}
    >
      {firstImage ? (
        <Image source={{ uri: firstImage }} style={styles.maggidAvatar} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      ) : (
        <View style={[styles.maggidAvatar, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="person" size={22} color={colors.textSecondary} />
        </View>
      )}
      <Text style={[styles.maggidName, { color: colors.text }]} numberOfLines={2}>
        {author}
      </Text>
      <Text style={[styles.maggidCount, { color: colors.textSecondary }]}>
        {feeds.length} {feeds.length === 1 ? "shiur" : "shiurim"}
      </Text>
    </Pressable>
  );
});

const SCROLL_AMOUNT = 300;

const WebScrollArrows = React.memo(function WebScrollArrows({ children, colors }: { children: React.ReactNode; colors: any }) {
  if (Platform.OS !== "web") return <>{children}</>;

  const scrollRef = useRef<FlatList>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const scrollOffsetRef = useRef(0);
  const contentWidthRef = useRef(0);
  const containerWidthRef = useRef(0);

  const updateArrows = useCallback(() => {
    const offset = scrollOffsetRef.current;
    const maxScroll = contentWidthRef.current - containerWidthRef.current;
    setCanScrollLeft(offset > 5);
    setCanScrollRight(offset < maxScroll - 5);
  }, []);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = e.nativeEvent.contentOffset.x;
    containerWidthRef.current = e.nativeEvent.layoutMeasurement.width;
    contentWidthRef.current = e.nativeEvent.contentSize.width;
    updateArrows();
  }, [updateArrows]);

  const scrollLeft = useCallback(() => {
    const newOffset = Math.max(0, scrollOffsetRef.current - SCROLL_AMOUNT);
    scrollRef.current?.scrollToOffset({ offset: newOffset, animated: true });
  }, []);

  const scrollRight = useCallback(() => {
    const maxScroll = contentWidthRef.current - containerWidthRef.current;
    const newOffset = Math.min(maxScroll, scrollOffsetRef.current + SCROLL_AMOUNT);
    scrollRef.current?.scrollToOffset({ offset: newOffset, animated: true });
  }, []);

  const cloned = React.Children.map(children, (child) => {
    if (React.isValidElement(child) && (child.type === FlatList || (child as any).type?.name === "FlatList")) {
      return React.cloneElement(child as React.ReactElement<any>, {
        ref: scrollRef,
        onScroll: handleScroll,
        scrollEventThrottle: 16,
      });
    }
    return child;
  });

  return (
    <View style={arrowStyles.wrapper}>
      {cloned}
      {canScrollLeft && (
        <Pressable
          onPress={scrollLeft}
          style={({ pressed }) => [
            arrowStyles.arrowBtn,
            arrowStyles.arrowLeft,
            { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.7 : 0.92 },
          ]}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
      )}
      {canScrollRight && (
        <Pressable
          onPress={scrollRight}
          style={({ pressed }) => [
            arrowStyles.arrowBtn,
            arrowStyles.arrowRight,
            { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.7 : 0.92 },
          ]}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </Pressable>
      )}
    </View>
  );
});

const arrowStyles = StyleSheet.create({
  wrapper: {
    position: "relative" as const,
  },
  arrowBtn: {
    position: "absolute" as const,
    top: "50%" as any,
    marginTop: -18,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1,
    zIndex: 10,
    ...(Platform.OS === "web" ? { cursor: "pointer" as any, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" as any } : {}),
  },
  arrowLeft: {
    left: 4,
  },
  arrowRight: {
    right: 4,
  },
});

const CategorySection = React.memo(function CategorySection({ category, feeds, colors }: { category: Category; feeds: Feed[]; colors: any }) {
  if (feeds.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRowSpaced}>
        <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0, marginBottom: 0 }]}>{category.name}</Text>
        <Pressable
          onPress={() => { lightHaptic(); router.push({ pathname: "/category/[id]", params: { id: category.id, name: category.name } }); }}
          style={({ pressed }) => [styles.seeAllBtn, { backgroundColor: colors.accentLight, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={[styles.seeAllText, { color: colors.accent }]}>See All</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.accent} />
        </Pressable>
      </View>
      <WebScrollArrows colors={colors}>
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
      </WebScrollArrows>
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
        <Image source={{ uri: feed.imageUrl }} style={styles.searchResultImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
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
        <Image source={{ uri: feed.imageUrl }} style={styles.continueImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
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

function SponsorBanner({ colors }: { colors: any }) {
  const sponsorQuery = useQuery<{ name: string; text?: string; logoUrl?: string; linkUrl?: string } | null>({
    queryKey: ["/api/sponsor"],
    staleTime: 60000,
  });

  const sponsor = sponsorQuery.data;
  if (!sponsor) return null;

  return (
    <View style={{ marginTop: 32, alignItems: "center", paddingHorizontal: 32 }}>
      {sponsor.logoUrl ? (
        <Image
          source={{ uri: sponsor.logoUrl }}
          style={{ width: 120, height: 60, marginBottom: 12 }}
          contentFit="contain"
        />
      ) : null}
      {sponsor.text ? (
        <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 18 }}>
          {sponsor.text}
        </Text>
      ) : (
        <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: "center" }}>
          Sponsored by {sponsor.name}
        </Text>
      )}
    </View>
  );
}

function HomeScreenInner() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
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
  const featuredQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds/featured"] });
  const maggidQuery = useQuery<{ author: string; feeds: Feed[] }[]>({ queryKey: ["/api/feeds/maggid-shiur"] });

  const isLoading = categoriesQuery.isLoading || feedsQuery.isLoading;
  const hasError = feedsQuery.isError || categoriesQuery.isError;
  const errorMessage = feedsQuery.error?.message || categoriesQuery.error?.message || "Could not connect to server";
  const categories = categoriesQuery.data || [];
  const allFeeds = feedsQuery.data || [];
  const latestEpisodes = (latestQuery.data || []).slice(0, 20);
  const trendingEpisodes = trendingQuery.data || [];
  const featuredFeeds = featuredQuery.data || [];
  const maggidShiurim = maggidQuery.data || [];

  const handleDismissContinue = useCallback(async (episodeId: string) => {
    lightHaptic();
    await removeSavedPosition(episodeId);
    setInProgressPositions(prev => prev.filter(p => p.episodeId !== episodeId));
  }, [removeSavedPosition]);

  const handlePlayEpisode = useCallback((episode: Episode, feed: Feed) => {
    lightHaptic();
    if (currentEpisode?.id === episode.id) {
      playback.isPlaying ? pause() : resume();
      router.push("/player");
    } else {
      playEpisode(episode, feed).then(() => {
        router.push("/player");
      }).catch(console.error);
    }
  }, [currentEpisode?.id, playback.isPlaying, pause, resume, playEpisode]);

  const quickPlayItems = useMemo(() => {
    const trending = trendingEpisodes.length > 0 ? trendingEpisodes : latestEpisodes.map(e => ({ ...e, listenCount: 0 }));
    if (trending.length === 0) return [];
    
    const items: { episode: TrendingEpisode; feed: Feed }[] = [];
    for (let i = 0; i < trending.length && items.length < 6; i++) {
      const ep = trending[i] as TrendingEpisode;
      const feed = allFeeds.find(f => f.id === ep.feedId);
      if (feed) items.push({ episode: ep, feed });
    }
    
    return items;
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

  const speakerSearchResults = useMemo(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) return [];
    const q = searchQuery.toLowerCase().trim();
    return maggidShiurim.filter(s => s.author.toLowerCase().includes(q));
  }, [searchQuery, maggidShiurim]);

  const episodeSearchQuery = useQuery<Episode[]>({
    queryKey: ["/api/episodes/search", searchQuery],
    queryFn: async () => {
      const baseUrl = getApiUrl();
      const url = new URL("/api/episodes/search", baseUrl);
      url.searchParams.set("q", searchQuery.trim());
      url.searchParams.set("limit", "20");
      const res = await fetch(url.toString());
      if (!res.ok) return [];
      return res.json();
    },
    enabled: searchQuery.trim().length >= 3,
  });

  const searchedEpisodes = episodeSearchQuery.data || [];

  const isSearching = searchQuery.trim().length > 0;

  const onRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/latest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/trending"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds/featured"] });
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <SponsorBanner colors={colors} />
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

  const isWeb = Platform.OS === "web";

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 140 }}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
     <View style={isWeb ? styles.webContentWrap : undefined}>
      <View style={{ paddingTop: isWeb ? 20 : insets.top + 8 }}>
        {!isWeb && (
          <View style={styles.headerRow}>
            <View>
              <Text style={[styles.greeting, { color: colors.textSecondary }]}>Discover</Text>
              <Text style={[styles.headerTitle, { color: colors.text }]}>ShiurPod</Text>
            </View>
            <View style={[styles.headerIcon, { backgroundColor: colors.surfaceAlt }]}>
              <Ionicons name="headset" size={24} color={colors.accent} />
            </View>
          </View>
        )}

        <View style={[styles.searchContainer, { backgroundColor: colors.surfaceAlt, borderColor: isSearchFocused ? colors.accent : "transparent" }]}>
          <Ionicons name="search" size={18} color={colors.textSecondary} style={{ marginLeft: 14 }} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search shiurim, speakers, episodes..."
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
          {searchResults.length === 0 && searchedEpisodes.length === 0 && speakerSearchResults.length === 0 && searchQuery.trim().length >= 3 && !episodeSearchQuery.isLoading ? (
            <View style={styles.noResults}>
              <Ionicons name="search-outline" size={40} color={colors.textSecondary} />
              <Text style={[styles.noResultsText, { color: colors.textSecondary }]}>
                No results found for "{searchQuery}"
              </Text>
            </View>
          ) : (
            <>
              {speakerSearchResults.length > 0 && (
                <>
                  <Text style={[styles.searchSectionLabel, { color: colors.textSecondary }]}>Maggidei Shiur</Text>
                  <View style={{ paddingHorizontal: 20 }}>
                    {speakerSearchResults.map((speaker) => (
                      <Pressable
                        key={speaker.author}
                        style={({ pressed }) => [
                          styles.searchResult,
                          { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.9 : 1 },
                        ]}
                        onPress={() => { lightHaptic(); router.push({ pathname: "/maggid-shiur/[author]" as any, params: { author: speaker.author, feedIds: speaker.feeds.map((f: Feed) => f.id).join(",") } }); }}
                      >
                        {speaker.feeds[0]?.imageUrl ? (
                          <Image source={{ uri: speaker.feeds[0].imageUrl }} style={styles.searchResultImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
                        ) : (
                          <View style={[styles.searchResultImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
                            <Ionicons name="person" size={20} color={colors.textSecondary} />
                          </View>
                        )}
                        <View style={styles.searchResultInfo}>
                          <Text style={[styles.searchResultTitle, { color: colors.text }]} numberOfLines={1}>
                            {speaker.author}
                          </Text>
                          <Text style={[styles.searchResultAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
                            {speaker.feeds.length} {speaker.feeds.length === 1 ? "shiur" : "shiurim"}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                      </Pressable>
                    ))}
                  </View>
                </>
              )}
              {searchResults.length > 0 && (
                <>
                  <Text style={[styles.searchSectionLabel, { color: colors.textSecondary }]}>Shiurim</Text>
                  <View style={{ paddingHorizontal: 20 }}>
                    {searchResults.map((feed) => (
                      <SearchResultItem key={feed.id} feed={feed} colors={colors} />
                    ))}
                  </View>
                </>
              )}
              {searchedEpisodes.length > 0 && (
                <>
                  <Text style={[styles.searchSectionLabel, { color: colors.textSecondary }]}>Episodes</Text>
                  <View style={{ paddingHorizontal: 16 }}>
                    {searchedEpisodes.map((ep) => {
                      const epFeed = allFeeds.find(f => f.id === ep.feedId);
                      if (!epFeed) return null;
                      return <EpisodeItem key={ep.id} episode={ep} feed={epFeed} showFeedTitle />;
                    })}
                  </View>
                </>
              )}
              {searchQuery.trim().length < 3 && searchResults.length === 0 && speakerSearchResults.length === 0 && (
                <View style={styles.noResults}>
                  <Text style={[styles.noResultsText, { color: colors.textSecondary }]}>
                    Type 3+ characters to search episodes
                  </Text>
                </View>
              )}
              {episodeSearchQuery.isLoading && (
                <ActivityIndicator size="small" color={colors.accent} style={{ marginTop: 12 }} />
              )}
            </>
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

      {!isSearching && featuredFeeds.length > 0 && (
        <FeaturedCarousel feeds={featuredFeeds} colors={colors} />
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
                rank={index + 1}
                colors={colors}
                onPlay={() => handlePlayEpisode(episode, feed)}
              />
            ))}
          </View>
        </View>
      )}

      {!isSearching && allFeeds.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRowSpaced}>
            <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0, marginBottom: 0 }]}>All Shiurim</Text>
            <Pressable
              onPress={() => { lightHaptic(); router.push("/all-shiurim"); }}
              style={({ pressed }) => [styles.seeAllBtn, { backgroundColor: colors.accentLight, opacity: pressed ? 0.8 : 1 }]}
            >
              <Text style={[styles.seeAllText, { color: colors.accent }]}>See All</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.accent} />
            </Pressable>
          </View>
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

      {!isSearching && maggidShiurim.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRowSpaced}>
            <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0, marginBottom: 0 }]}>Maggidei Shiur</Text>
            <Pressable
              onPress={() => { lightHaptic(); router.push("/all-maggidei-shiur"); }}
              style={({ pressed }) => [styles.seeAllBtn, { backgroundColor: colors.accentLight, opacity: pressed ? 0.8 : 1 }]}
            >
              <Text style={[styles.seeAllText, { color: colors.accent }]}>See All</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.accent} />
            </Pressable>
          </View>
          <FlatList
            horizontal
            data={maggidShiurim}
            keyExtractor={(item) => item.author}
            renderItem={({ item }) => <MaggidShiurCard author={item.author} feeds={item.feeds} colors={colors} />}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20 }}
            initialNumToRender={6}
            maxToRenderPerBatch={5}
            windowSize={3}
            removeClippedSubviews={Platform.OS !== "web"}
          />
        </View>
      )}

      {!isSearching && categories.map(cat => {
        const catFeeds = allFeeds.filter(f => 
          (f.categoryIds && f.categoryIds.includes(cat.id)) || f.categoryId === cat.id
        );
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
     </View>
    </ScrollView>
  );
}

export default function HomeScreen() {
  return (
    <ErrorBoundary>
      <HomeScreenInner />
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webContentWrap: {
    maxWidth: 900,
    marginHorizontal: "auto" as any,
    width: "100%" as any,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  greeting: {
    fontSize: 13,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
  },
  headerTitle: {
    fontSize: 24,
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

  carouselContainer: {
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  carouselSlide: {
    width: CAROUSEL_WIDTH,
    height: CAROUSEL_HEIGHT,
    borderRadius: 20,
    overflow: "hidden",
    position: "relative" as const,
  },
  carouselImage: {
    width: "100%" as any,
    height: CAROUSEL_HEIGHT,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  carouselGradient: {
    ...StyleSheet.absoluteFillObject,
    top: "35%" as any,
  },
  carouselContent: {
    position: "absolute" as const,
    bottom: 0,
    left: 0,
    right: 0,
    padding: 18,
    gap: 4,
  },
  carouselBadge: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignSelf: "flex-start" as const,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 4,
  },
  carouselBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  carouselTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "800" as const,
    lineHeight: 24,
  },
  carouselAuthor: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
  },
  carouselDots: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 6,
    marginTop: 10,
  },
  carouselDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },

  section: {
    marginBottom: 22,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  sectionHeaderRowSpaced: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  seeAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  seeAllText: {
    fontSize: 13,
    fontWeight: "600" as const,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
    paddingHorizontal: 20,
    marginBottom: 10,
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
  searchSectionLabel: {
    fontSize: 13,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
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
  maggidCard: {
    width: 110,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginRight: 12,
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  maggidAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    marginBottom: 8,
  },
  maggidName: {
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center" as const,
    lineHeight: 16,
    marginBottom: 2,
  },
  maggidCount: {
    fontSize: 11,
    textAlign: "center" as const,
  },
});
