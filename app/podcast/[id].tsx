import React from "react";
import { View, Text, FlatList, Pressable, StyleSheet, useColorScheme, ActivityIndicator, Platform, Switch, Alert } from "react-native";
import { Image } from "expo-image";
import { Ionicons, Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import type { Feed, Episode, Subscription } from "@/lib/types";
import { mediumHaptic, lightHaptic } from "@/lib/haptics";
import { useSettings } from "@/contexts/SettingsContext";

const EPISODE_LIMIT_OPTIONS = [3, 5, 10, 15, 25, 50];

export default function PodcastDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { getFeedSettings, updateFeedSettings } = useSettings();

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const feed = feedsQuery.data?.find(f => f.id === id);

  const episodesQuery = useQuery<Episode[]>({
    queryKey: [`/api/feeds/${id}/episodes`],
    enabled: !!id,
  });

  const subsQuery = useQuery<Subscription[]>({
    queryKey: ["/api/subscriptions"],
    queryFn: async () => {
      const deviceId = await getDeviceId();
      const baseUrl = getApiUrl();
      const url = new URL(`/api/subscriptions/${deviceId}`, baseUrl);
      const res = await fetch(url.toString());
      return res.json();
    },
  });

  const isFollowing = subsQuery.data?.some(s => s.feedId === id) || false;
  const feedSettings = id ? getFeedSettings(id) : { notificationsEnabled: false, maxEpisodes: 5 };

  const followMutation = useMutation({
    mutationFn: async () => {
      const deviceId = await getDeviceId();
      if (isFollowing) {
        await apiRequest("DELETE", `/api/subscriptions/${deviceId}/${id}`);
      } else {
        await apiRequest("POST", "/api/subscriptions", { deviceId, feedId: id });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/subscriptions/feeds"] });
    },
  });

  const handleFollow = () => {
    mediumHaptic();
    followMutation.mutate();
  };

  const handleToggleNotifications = (value: boolean) => {
    lightHaptic();
    if (id) updateFeedSettings(id, { notificationsEnabled: value });
  };

  const handleChangeEpisodeLimit = () => {
    lightHaptic();
    if (!id) return;
    if (Platform.OS === "web") {
      const currentIndex = EPISODE_LIMIT_OPTIONS.indexOf(feedSettings.maxEpisodes);
      const nextIndex = (currentIndex + 1) % EPISODE_LIMIT_OPTIONS.length;
      updateFeedSettings(id, { maxEpisodes: EPISODE_LIMIT_OPTIONS[nextIndex] });
      return;
    }
    Alert.alert(
      "Episodes to Keep",
      "Choose how many episodes to keep downloaded for this shiur.",
      EPISODE_LIMIT_OPTIONS.map(n => ({
        text: `${n} episodes`,
        onPress: () => updateFeedSettings(id, { maxEpisodes: n }),
      })),
    );
  };

  if (!feed) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 100 }} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={episodesQuery.data || []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 120, paddingHorizontal: 16 }}
        ListHeaderComponent={() => (
          <View>
            <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === "web" ? 67 : 8) }]}>
              <Pressable onPress={() => router.back()} hitSlop={12}>
                <Ionicons name="arrow-back" size={24} color={colors.text} />
              </Pressable>
            </View>

            <View style={styles.podcastInfo}>
              {feed.imageUrl ? (
                <Image source={{ uri: feed.imageUrl }} style={styles.artwork} contentFit="cover" />
              ) : (
                <View style={[styles.artwork, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
                  <Ionicons name="mic" size={48} color={colors.textSecondary} />
                </View>
              )}

              <View style={styles.podcastMeta}>
                <Text style={[styles.podcastTitle, { color: colors.text }]}>{feed.title}</Text>
                {feed.author && (
                  <Text style={[styles.podcastAuthor, { color: colors.textSecondary }]}>{feed.author}</Text>
                )}

                <Pressable
                  onPress={handleFollow}
                  style={[
                    styles.followBtn,
                    {
                      backgroundColor: isFollowing ? colors.surfaceAlt : colors.accent,
                      borderColor: isFollowing ? colors.border : colors.accent,
                      borderWidth: isFollowing ? 1 : 0,
                    },
                  ]}
                >
                  <Feather
                    name={isFollowing ? "check" : "plus"}
                    size={16}
                    color={isFollowing ? colors.text : "#fff"}
                  />
                  <Text style={[styles.followText, { color: isFollowing ? colors.text : "#fff" }]}>
                    {isFollowing ? "Following" : "Follow"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {feed.description && (
              <Text style={[styles.description, { color: colors.textSecondary }]} numberOfLines={3}>
                {feed.description}
              </Text>
            )}

            {isFollowing && (
              <View style={[styles.feedSettingsCard, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
                <View style={styles.feedSettingRow}>
                  <View style={styles.feedSettingLeft}>
                    <Ionicons name="notifications-outline" size={18} color={colors.accent} />
                    <Text style={[styles.feedSettingLabel, { color: colors.text }]}>Notifications</Text>
                  </View>
                  <Switch
                    value={feedSettings.notificationsEnabled}
                    onValueChange={handleToggleNotifications}
                    trackColor={{ false: colors.border, true: colors.accent }}
                    thumbColor="#fff"
                  />
                </View>
                <View style={[styles.feedSettingDivider, { backgroundColor: colors.border }]} />
                <Pressable style={styles.feedSettingRow} onPress={handleChangeEpisodeLimit}>
                  <View style={styles.feedSettingLeft}>
                    <Ionicons name="layers-outline" size={18} color={colors.accent} />
                    <Text style={[styles.feedSettingLabel, { color: colors.text }]}>Episodes to keep</Text>
                  </View>
                  <View style={styles.feedSettingRight}>
                    <Text style={[styles.feedSettingValue, { color: colors.textSecondary }]}>{feedSettings.maxEpisodes}</Text>
                    <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                  </View>
                </Pressable>
              </View>
            )}

            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Episodes ({episodesQuery.data?.length || 0})
            </Text>
          </View>
        )}
        renderItem={({ item }) => <EpisodeItem episode={item} feed={feed} />}
        ListEmptyComponent={() =>
          episodesQuery.isLoading ? (
            <ActivityIndicator size="small" color={colors.accent} style={{ marginTop: 20 }} />
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="albums-outline" size={40} color={colors.textSecondary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No episodes found</Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 4,
    paddingBottom: 16,
  },
  podcastInfo: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 16,
  },
  artwork: {
    width: 120,
    height: 120,
    borderRadius: 14,
  },
  podcastMeta: {
    flex: 1,
    justifyContent: "center",
    gap: 6,
  },
  podcastTitle: {
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 24,
  },
  podcastAuthor: {
    fontSize: 14,
  },
  followBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  followText: {
    fontSize: 13,
    fontWeight: "600",
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  feedSettingsCard: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 20,
  },
  feedSettingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  feedSettingLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  feedSettingRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  feedSettingLabel: {
    fontSize: 14,
    fontWeight: "500",
  },
  feedSettingValue: {
    fontSize: 14,
  },
  feedSettingDivider: {
    height: 1,
    marginLeft: 42,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 12,
  },
  emptyState: {
    alignItems: "center",
    gap: 8,
    paddingTop: 40,
  },
  emptyText: {
    fontSize: 14,
  },
});
