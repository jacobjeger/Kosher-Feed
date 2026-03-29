import React, { useMemo } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Platform, ActivityIndicator } from "react-native";
import FocusableView from "@/components/FocusableView";
import { router } from "expo-router";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useFavorites } from "@/contexts/FavoritesContext";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import { Ionicons } from "@expo/vector-icons";
import type { Feed, Episode } from "@/lib/types";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useNetworkStatus } from "@/components/OfflineBanner";
import { apiRequest } from "@/lib/query-client";

function FavoritesScreenInner() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const isOnline = useNetworkStatus();
  const { favorites, isLoading: favsLoading } = useFavorites();

  const favEpisodeIds = useMemo(() => favorites.map(f => f.episodeId), [favorites]);

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const episodesQuery = useQuery<Episode[]>({
    queryKey: ["/api/episodes/batch", favEpisodeIds],
    queryFn: async () => {
      if (favEpisodeIds.length === 0) return [];
      const res = await apiRequest("POST", "/api/episodes/batch", { ids: favEpisodeIds });
      return res.json();
    },
    enabled: favEpisodeIds.length > 0,
  });

  const allFeeds = feedsQuery.data || [];
  const allEpisodes = episodesQuery.data || [];

  const favoriteEpisodes = useMemo(() => {
    if (favorites.length === 0 || allEpisodes.length === 0) return [];
    const favSet = new Set(favEpisodeIds);
    return allEpisodes
      .filter(ep => favSet.has(ep.id))
      .map(ep => ({
        episode: ep,
        feed: allFeeds.find(f => f.id === ep.feedId),
      }))
      .filter(item => item.feed) as { episode: Episode; feed: Feed }[];
  }, [favorites, allEpisodes, allFeeds, favEpisodeIds]);

  const isLoading = favsLoading || feedsQuery.isLoading || episodesQuery.isLoading;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 20 : insets.top + 8 }, Platform.OS === "web" && styles.webWrap]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Favorites</Text>
        <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]}>
          {favoriteEpisodes.length} {favoriteEpisodes.length === 1 ? "episode" : "episodes"}
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 60 }} />
      ) : favoriteEpisodes.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={[styles.emptyIconBadge, { backgroundColor: colors.accentLight }]}>
            <Ionicons name="star-outline" size={36} color={colors.accent} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No Favorites Yet</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            Star episodes you love to find them here
          </Text>
          <FocusableView
            focusRadius={12}
            onPress={() => router.push("/(tabs)/")}
            style={[styles.emptyBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.emptyBtnText}>Browse Shiurim</Text>
          </FocusableView>
        </View>
      ) : (
        <FlatList
          data={favoriteEpisodes}
          keyExtractor={item => item.episode.id}
          renderItem={({ item }) => (
            <EpisodeItem episode={item.episode} feed={item.feed} showFeedTitle isOnline={isOnline} />
          )}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120, ...(Platform.OS === "web" ? { maxWidth: 900, marginHorizontal: "auto" as any, width: "100%" as any } : {}) }}
          initialNumToRender={8}
          maxToRenderPerBatch={5}
          windowSize={5}
          removeClippedSubviews={Platform.OS !== "web"}
        />
      )}
    </View>
  );
}

export default function FavoritesScreen() {
  return (
    <ErrorBoundary>
      <FavoritesScreenInner />
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webWrap: {
    maxWidth: 900,
    marginHorizontal: "auto" as any,
    width: "100%" as any,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800" as const,
  },
  headerSubtitle: {
    fontSize: 13,
    fontWeight: "500" as const,
    marginTop: 2,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 8,
    paddingBottom: 100,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center" as const,
    lineHeight: 20,
  },
  emptyIconBadge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginBottom: 4,
  },
  emptyBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  emptyBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600" as const,
  },
});
