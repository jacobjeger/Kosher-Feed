import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, RefreshControl, Platform, TextInput, Dimensions, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";
import type { Feed, Episode, Category, MaggidShiur } from "@/lib/types";
import { queryClient, getApiUrl } from "@/lib/query-client";
import { router } from "expo-router";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { lightHaptic } from "@/lib/haptics";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePlayedEpisodes } from "@/contexts/PlayedEpisodesContext";
import { HomeScreenSkeleton } from "@/components/Skeleton";
import { useNetworkStatus } from "@/components/OfflineBanner";
import SearchSection from "@/components/home/SearchSection";
import ContinueListeningSection from "@/components/home/ContinueListeningSection";
import TrendingSection from "@/components/home/TrendingSection";
import AllShiurimSection from "@/components/home/AllShiurimSection";
import MaggidShiurSection from "@/components/home/MaggidShiurSection";
import CategoriesGrid from "@/components/home/CategoriesGrid";
import RecentlyListenedSection from "@/components/home/RecentlyListenedSection";
import RecommendedSection from "@/components/home/RecommendedSection";
import { getDeviceId } from "@/lib/device-id";
import { useRemoteConfig } from "@/contexts/RemoteConfigContext";

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
const CAROUSEL_WIDTH = Platform.OS === "web" ? Math.min(screenWidth - 40, 920) : screenWidth - 40;
const CAROUSEL_HEIGHT = Platform.OS === "web" ? 280 : 180;
const AUTO_SCROLL_INTERVAL = 5000;

const FeaturedCarousel = React.memo(function FeaturedCarousel({ feeds, colors, autoScrollMs }: { feeds: Feed[]; colors: any; autoScrollMs?: number }) {
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
    }, autoScrollMs || AUTO_SCROLL_INTERVAL);
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


const SCROLL_AMOUNT = 300;

const WebScrollArrows = React.memo(function WebScrollArrows({ children, colors }: { children: React.ReactNode; colors: any }) {
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

  if (Platform.OS !== "web") return <>{children}</>;

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


function SponsorBanner({ colors }: { colors: any }) {
  const sponsorQuery = useQuery<{ name: string; text?: string; logoUrl?: string; linkUrl?: string } | null>({
    queryKey: ["/api/sponsor"],
    staleTime: 60000,
  });

  const sponsor = sponsorQuery.data;
  if (!sponsor) return null;

  const content = (
    <View style={{ marginTop: 32, alignItems: "center", paddingHorizontal: 32 }}>
      {sponsor.logoUrl ? (
        <Image
          source={{ uri: sponsor.logoUrl }}
          style={{ width: 120, height: 60, marginBottom: 12 }}
          contentFit="contain"
          cachePolicy="memory-disk"
          transition={0}
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

  return content;
}

function HomeScreenInner() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { playEpisode, currentEpisode, playback, pause, resume, recentlyPlayed, getInProgressEpisodes, removeSavedPosition } = useAudioPlayer();
  const { isPlayed } = usePlayedEpisodes();
  const isOnline = useNetworkStatus();
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
  const recommendationsQuery = useQuery<Feed[]>({
    queryKey: ["/api/recommendations"],
    queryFn: async () => {
      const deviceId = await getDeviceId();
      const baseUrl = getApiUrl();
      const res = await fetch(`${baseUrl}/api/recommendations/${deviceId}?limit=10`);
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const isLoading = categoriesQuery.isLoading || feedsQuery.isLoading;
  const hasError = feedsQuery.isError || categoriesQuery.isError;
  const errorMessage = feedsQuery.error?.message || categoriesQuery.error?.message || "Could not connect to server";
  const categories = categoriesQuery.data || [];
  const allFeeds = feedsQuery.data || [];
  const latestEpisodes = (latestQuery.data || []).slice(0, 20);
  const trendingEpisodes = trendingQuery.data || [];
  const featuredFeeds = featuredQuery.data || [];
  const maggidShiurim = maggidQuery.data || [];
  const recommendedFeeds = recommendationsQuery.data || [];

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

  const feedsWithNew = useMemo(() => {
    const set = new Set<string>();
    for (const ep of latestEpisodes) {
      if (!isPlayed(ep.id)) {
        set.add(ep.feedId);
      }
    }
    return set;
  }, [latestEpisodes, isPlayed]);

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

  // Server-side feed search to find feeds hidden from browse (e.g. KH feeds)
  const feedSearchQuery = useQuery<Feed[]>({
    queryKey: ["/api/feeds/search", searchQuery],
    queryFn: async () => {
      const baseUrl = getApiUrl();
      const url = new URL("/api/feeds/search", baseUrl);
      url.searchParams.set("q", searchQuery.trim());
      url.searchParams.set("limit", "30");
      const res = await fetch(url.toString());
      if (!res.ok) return [];
      return res.json();
    },
    enabled: searchQuery.trim().length >= 2,
  });

  // Merge local + server feed search results (dedup by id)
  const mergedSearchResults = useMemo(() => {
    const localResults = searchResults;
    const serverResults = feedSearchQuery.data || [];
    if (serverResults.length === 0) return localResults;
    const seen = new Set(localResults.map(f => f.id));
    const merged = [...localResults];
    for (const f of serverResults) {
      if (!seen.has(f.id)) {
        merged.push(f);
        seen.add(f.id);
      }
    }
    return merged;
  }, [searchResults, feedSearchQuery.data]);

  const isSearching = searchQuery.trim().length > 0;

  const isWeb = Platform.OS === "web";

  const { config, refresh: refreshConfig } = useRemoteConfig();
  const homeSections = config.homeSections;
  const featureFlags = config.featureFlags || {};

  const onRefresh = useCallback(() => {
    refreshConfig().catch(() => {});
    queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/latest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/trending"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds/featured"] });
    queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={isWeb ? styles.webContentWrap : undefined}>
          <View style={{ paddingTop: isWeb ? 20 : insets.top + 8 }}>
            <HomeScreenSkeleton />
          </View>
        </View>
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
        <SearchSection
          searchQuery={searchQuery}
          searchResults={mergedSearchResults}
          searchedEpisodes={searchedEpisodes}
          speakerSearchResults={speakerSearchResults}
          isSearchLoading={episodeSearchQuery.isLoading}
          allFeeds={allFeeds}
          colors={colors}
          isOnline={isOnline}
        />
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

      {!isSearching && homeSections.map((section) => {
        switch (section) {
          case "continue":
            if (featureFlags.showContinueListening === false) return null;
            return <ContinueListeningSection key={section} items={continueListeningItems} colors={colors} onPlay={handlePlayEpisode} onDismiss={handleDismissContinue} />;
          case "featured":
            if (featuredFeeds.length === 0) return null;
            return <FeaturedCarousel key={section} feeds={featuredFeeds} colors={colors} autoScrollMs={config.carouselAutoScrollMs} />;
          case "trending":
            if (featureFlags.showTrending === false) return null;
            return <TrendingSection key={section} items={quickPlayItems} colors={colors} onPlay={handlePlayEpisode} />;
          case "allShiurim":
            return <AllShiurimSection key={section} feeds={allFeeds} feedsWithNew={feedsWithNew} colors={colors} />;
          case "recommended":
            if (featureFlags.showRecommended === false) return null;
            return <RecommendedSection key={section} feeds={recommendedFeeds} colors={colors} />;
          case "maggidShiur":
            if (featureFlags.showMaggidShiur === false) return null;
            return <MaggidShiurSection key={section} maggidShiurim={maggidShiurim} colors={colors} />;
          case "categories":
            return <CategoriesGrid key={section} categories={categories} allFeeds={allFeeds} colors={colors} />;
          case "recent":
            return <RecentlyListenedSection key={section} items={recentlyListenedItems} colors={colors} isOnline={isOnline} />;
          default:
            return null;
        }
      })}
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
    maxWidth: 1080,
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
    ...(Platform.OS === "web" ? { boxShadow: "0 4px 24px rgba(0,0,0,0.12)" as any } : {}),
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

  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    borderRadius: 14,
    borderWidth: 2,
    height: 48,
    marginBottom: 20,
    ...(Platform.OS === "web" ? { transition: "border-color 0.2s ease, box-shadow 0.2s ease" as any } : {}),
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 0,
    height: 48,
    ...(Platform.OS === "web" ? { outlineStyle: "none" as any } : {}),
  },
  searchClear: {
    padding: 10,
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
});
