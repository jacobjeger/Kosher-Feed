import React, { useMemo } from "react";
import { View, Text, FlatList, StyleSheet, Platform, ActivityIndicator } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useFavorites } from "@/contexts/FavoritesContext";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import { Ionicons } from "@expo/vector-icons";
import type { Feed, Episode } from "@/lib/types";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function FavoritesScreenInner() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { favorites, isLoading: favsLoading } = useFavorites();

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const latestQuery = useQuery<Episode[]>({ queryKey: ["/api/episodes/latest"] });

  const allFeeds = feedsQuery.data || [];
  const allEpisodes = latestQuery.data || [];

  const favoriteEpisodes = useMemo(() => {
    if (favorites.length === 0 || allEpisodes.length === 0) return [];
    const favEpisodeIds = new Set(favorites.map(f => f.episodeId));
    return allEpisodes
      .filter(ep => favEpisodeIds.has(ep.id))
      .map(ep => ({
        episode: ep,
        feed: allFeeds.find(f => f.id === ep.feedId),
      }))
      .filter(item => item.feed) as { episode: Episode; feed: Feed }[];
  }, [favorites, allEpisodes, allFeeds]);

  const isLoading = favsLoading || feedsQuery.isLoading || latestQuery.isLoading;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Favorites</Text>
        <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]}>
          {favoriteEpisodes.length} {favoriteEpisodes.length === 1 ? "episode" : "episodes"}
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 60 }} />
      ) : favoriteEpisodes.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="star-outline" size={56} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No Favorites Yet</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            Star episodes you love to find them here
          </Text>
        </View>
      ) : (
        <FlatList
          data={favoriteEpisodes}
          keyExtractor={item => item.episode.id}
          renderItem={({ item }) => (
            <EpisodeItem episode={item.episode} feed={item.feed} showFeedTitle />
          )}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
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
});
