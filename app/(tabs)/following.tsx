import React, { useEffect, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, useColorScheme, ActivityIndicator, RefreshControl, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import PodcastCard from "@/components/PodcastCard";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl, queryClient } from "@/lib/query-client";
import type { Feed, Episode } from "@/lib/types";

export default function FollowingScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  const feedsQuery = useQuery<Feed[]>({
    queryKey: ["/api/subscriptions/feeds"],
    queryFn: async () => {
      if (!deviceId) return [];
      const baseUrl = getApiUrl();
      const url = new URL(`/api/subscriptions/${deviceId}/feeds`, baseUrl);
      const res = await fetch(url.toString());
      return res.json();
    },
    enabled: !!deviceId,
  });

  const episodesQuery = useQuery<Episode[]>({
    queryKey: ["/api/subscriptions/episodes"],
    queryFn: async () => {
      if (!deviceId) return [];
      const baseUrl = getApiUrl();
      const url = new URL(`/api/subscriptions/${deviceId}/episodes`, baseUrl);
      const res = await fetch(url.toString());
      return res.json();
    },
    enabled: !!deviceId,
  });

  const subscribedFeeds = feedsQuery.data || [];
  const episodes = episodesQuery.data || [];
  const isLoading = feedsQuery.isLoading || episodesQuery.isLoading;
  const hasError = feedsQuery.isError || episodesQuery.isError;
  const errorMessage = feedsQuery.error?.message || episodesQuery.error?.message || "Could not connect to server";

  const getFeedForEpisode = (ep: Episode): Feed | undefined => {
    return subscribedFeeds.find(f => f.id === ep.feedId);
  };

  const onRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/subscriptions/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/subscriptions/episodes"] });
  };

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
              ? "Unable to reach the server. Check your connection and try again."
              : `Something went wrong: ${errorMessage}`}
          </Text>
          <Pressable
            style={[styles.retryButton, { backgroundColor: colors.accent }]}
            onPress={onRefresh}
          >
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 140, paddingHorizontal: 16 }}
      data={episodes}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.accent} />
      }
      ListHeaderComponent={() => (
        <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Following</Text>

          {subscribedFeeds.length > 0 && (
            <FlatList
              horizontal
              data={subscribedFeeds}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => <PodcastCard feed={item} size="small" />}
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 24 }}
            />
          )}

          {episodes.length > 0 && (
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Latest from your shiurim</Text>
          )}
        </View>
      )}
      renderItem={({ item }) => {
        const feed = getFeedForEpisode(item);
        if (!feed) return null;
        return <EpisodeItem episode={item} feed={feed} showFeedTitle />;
      }}
      ListEmptyComponent={() => (
        <View style={styles.emptyState}>
          <Ionicons name="heart-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No Subscriptions Yet</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            Follow shiurim from the Home tab to see their latest episodes here.
          </Text>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    paddingHorizontal: 4,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
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
  retryText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600" as const,
  },
});
