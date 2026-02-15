import React from "react";
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, useColorScheme, ActivityIndicator, RefreshControl, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import PodcastCard from "@/components/PodcastCard";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import type { Feed, Episode, Category } from "@/lib/types";
import { queryClient, getApiUrl } from "@/lib/query-client";

function CategorySection({ category, feeds }: { category: Category; feeds: Feed[] }) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

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
        contentContainerStyle={{ paddingHorizontal: 16 }}
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
  const latestEpisodes = (latestQuery.data || []).slice(0, 15);

  const uncategorizedFeeds = allFeeds.filter(f => !f.categoryId);

  const onRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/episodes/latest"] });
  };

  const getFeedForEpisode = (ep: Episode): Feed | undefined => {
    return allFeeds.find(f => f.id === ep.feedId);
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

      {latestEpisodes.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Latest Episodes</Text>
          <View style={{ paddingHorizontal: 16 }}>
            {latestEpisodes.map(ep => {
              const feed = getFeedForEpisode(ep);
              if (!feed) return null;
              return <EpisodeItem key={ep.id} episode={ep} feed={feed} showFeedTitle />;
            })}
          </View>
        </View>
      )}

      {categories.map(cat => {
        const catFeeds = allFeeds.filter(f => f.categoryId === cat.id);
        return <CategorySection key={cat.id} category={cat} feeds={catFeeds} />;
      })}

      {uncategorizedFeeds.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>More Podcasts</Text>
          <FlatList
            horizontal
            data={uncategorizedFeeds}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <PodcastCard feed={item} size="small" />}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16 }}
          />
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
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    marginTop: 2,
  },
  headerIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700",
    paddingHorizontal: 20,
    marginBottom: 12,
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
    fontWeight: "700",
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
