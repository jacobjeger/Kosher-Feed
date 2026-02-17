import React, { useState, useMemo, useCallback, useRef, memo } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Platform, Switch, Alert, TextInput, RefreshControl } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Image } from "expo-image";
import { Ionicons, Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { safeGoBack } from "@/lib/safe-back";
import { useQuery, useMutation, useInfiniteQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";
import EpisodeItem from "@/components/EpisodeItem";
import Colors from "@/constants/colors";
import type { Feed, Episode, Subscription } from "@/lib/types";
import { mediumHaptic, lightHaptic } from "@/lib/haptics";
import { useSettings } from "@/contexts/SettingsContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { usePlayedEpisodes } from "@/contexts/PlayedEpisodesContext";
import { usePositions } from "@/contexts/PositionsContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import OptionPickerModal from "@/components/OptionPickerModal";

const StableArtwork = memo(function StableArtwork({ imageUrl, fallbackColor, iconColor }: { imageUrl?: string | null; fallbackColor: string; iconColor: string }) {
  if (imageUrl) {
    return <Image source={{ uri: imageUrl }} style={styles.artwork} contentFit="cover" cachePolicy="memory-disk" recyclingKey={imageUrl} transition={0} />;
  }
  return (
    <View style={[styles.artwork, { backgroundColor: fallbackColor, alignItems: "center", justifyContent: "center" }]}>
      <Ionicons name="mic" size={48} color={iconColor} />
    </View>
  );
});

const EPISODE_LIMIT_OPTIONS = [3, 5, 10, 15, 25, 50];
const PAGE_SIZE = 30;

interface PaginatedResponse {
  episodes: Episode[];
  page: number;
  totalPages: number;
  totalCount: number;
  hasMore: boolean;
}

function PodcastDetailScreenInner() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = useMemo(() => isDark ? Colors.dark : Colors.light, [isDark]);
  const { getFeedSettings, updateFeedSettings } = useSettings();
  const { batchDownload, isDownloaded } = useDownloads();
  const { isPlayed } = usePlayedEpisodes();
  const batchDownloadRef = useRef(batchDownload);
  batchDownloadRef.current = batchDownload;
  const [showFullDescription, setShowFullDescription] = useState<boolean>(false);
  const [episodeSearch, setEpisodeSearch] = useState("");
  const [isEpisodeSearchFocused, setIsEpisodeSearchFocused] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [showPreferences, setShowPreferences] = useState(false);
  const [episodeFilter, setEpisodeFilter] = useState<'all' | 'unplayed' | 'inprogress' | 'downloaded'>('all');
  const { positions: positionsMap } = usePositions();
  const inProgressIds = useMemo(() => new Set(Object.keys(positionsMap)), [positionsMap]);

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const feed = useMemo(() => feedsQuery.data?.find(f => f.id === id), [feedsQuery.data, id]);

  const episodesInfiniteQuery = useInfiniteQuery<PaginatedResponse>({
    queryKey: [`/api/feeds/${id}/episodes`, "paginated", sortOrder],
    queryFn: async ({ pageParam }) => {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/feeds/${id}/episodes`, baseUrl);
      url.searchParams.set("paginated", "1");
      url.searchParams.set("page", String(pageParam));
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("sort", sortOrder);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.page + 1 : undefined,
    enabled: !!id,
  });

  const allEpisodes = useMemo(() => {
    if (!episodesInfiniteQuery.data) return [];
    return episodesInfiniteQuery.data.pages.flatMap(page => page.episodes);
  }, [episodesInfiniteQuery.data]);

  const totalCount = episodesInfiniteQuery.data?.pages[0]?.totalCount || 0;

  const filteredEpisodes = useMemo(() => {
    let eps = allEpisodes;
    if (episodeSearch.trim()) {
      const q = episodeSearch.toLowerCase().trim();
      eps = eps.filter(ep => ep.title.toLowerCase().includes(q));
    }
    switch (episodeFilter) {
      case 'unplayed':
        eps = eps.filter(ep => !isPlayed(ep.id));
        break;
      case 'inprogress':
        eps = eps.filter(ep => inProgressIds.has(ep.id));
        break;
      case 'downloaded':
        eps = eps.filter(ep => isDownloaded(ep.id));
        break;
    }
    return eps;
  }, [allEpisodes, episodeSearch, episodeFilter, isPlayed, inProgressIds, isDownloaded]);

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
  const [episodeLimitPickerVisible, setEpisodeLimitPickerVisible] = useState(false);

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
    onError: () => {
      Alert.alert("Error", "Could not update follow status. Please try again.");
    },
  });

  const handleFollow = useCallback(() => {
    mediumHaptic();
    followMutation.mutate();
  }, [followMutation]);

  const handleToggleNotifications = useCallback(async (value: boolean) => {
    lightHaptic();
    if (value) {
      const { requestNotificationPermissions, setupNotificationChannel } = await import("@/lib/notifications");
      await setupNotificationChannel();
      const granted = await requestNotificationPermissions();
      if (!granted) {
        if (Platform.OS !== "web") {
          Alert.alert(
            "Notifications",
            "Please enable notifications in your device settings to receive alerts for new episodes."
          );
        }
        return;
      }
    }
    if (id) updateFeedSettings(id, { notificationsEnabled: value });
  }, [id, updateFeedSettings]);

  const handleChangeEpisodeLimit = useCallback(() => {
    lightHaptic();
    if (!id) return;
    if (Platform.OS === "web") {
      const currentIndex = EPISODE_LIMIT_OPTIONS.indexOf(feedSettings.maxEpisodes);
      const nextIndex = (currentIndex + 1) % EPISODE_LIMIT_OPTIONS.length;
      updateFeedSettings(id, { maxEpisodes: EPISODE_LIMIT_OPTIONS[nextIndex] });
      return;
    }
    setEpisodeLimitPickerVisible(true);
  }, [id, feedSettings.maxEpisodes, updateFeedSettings]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [`/api/feeds/${id}/episodes`, "paginated"] });
    queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
    queryClient.invalidateQueries({ queryKey: ["/api/subscriptions"] });
  }, [id]);

  const handleLoadMore = useCallback(() => {
    if (episodesInfiniteQuery.hasNextPage && !episodesInfiniteQuery.isFetchingNextPage && !episodeSearch.trim()) {
      episodesInfiniteQuery.fetchNextPage();
    }
  }, [episodesInfiniteQuery, episodeSearch]);

  const renderEpisodeItem = useCallback(({ item }: { item: Episode }) => {
    if (!feed) return null;
    return <EpisodeItem episode={item} feed={feed} />;
  }, [feed]);

  const feedError = feedsQuery.isError || episodesInfiniteQuery.isError;
  const feedErrorMsg = feedsQuery.error?.message || episodesInfiniteQuery.error?.message || "";

  const headerElement = useMemo(() => {
    if (feedError && !feed) {
      return (
        <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 80, paddingHorizontal: 40, gap: 12 }}>
          <Pressable onPress={() => safeGoBack()} style={{ alignSelf: "flex-start", paddingTop: insets.top + 8 }}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Ionicons name="cloud-offline-outline" size={56} color={colors.textSecondary} />
          <Text style={{ fontSize: 22, fontWeight: "700" as const, color: colors.text }}>Connection Issue</Text>
          <Text style={{ fontSize: 14, textAlign: "center", lineHeight: 20, color: colors.textSecondary }}>
            {feedErrorMsg.includes("Network") || feedErrorMsg.includes("fetch")
              ? "Unable to reach the server. Check your connection and try again."
              : `Something went wrong: ${feedErrorMsg}`}
          </Text>
          <Pressable
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, marginTop: 8, backgroundColor: colors.accent }}
            onPress={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/feeds"] });
              queryClient.invalidateQueries({ queryKey: [`/api/feeds/${id}/episodes`, "paginated"] });
            }}
          >
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" as const }}>Try Again</Text>
          </Pressable>
        </View>
      );
    }

    if (!feed) {
      return (
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 100 }} />
      );
    }

    return (
    <View>
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === "web" ? 12 : 8) }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
      </View>

      <View style={styles.podcastInfo}>
        <StableArtwork imageUrl={feed.imageUrl} fallbackColor={colors.surfaceAlt} iconColor={colors.textSecondary} />

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
        <View style={styles.descriptionBlock}>
          <Text
            style={[styles.description, { color: colors.textSecondary }]}
            numberOfLines={showFullDescription ? undefined : 3}
          >
            {feed.description}
          </Text>
          <Pressable onPress={() => setShowFullDescription(prev => !prev)}>
            <Text style={[styles.seeMoreText, { color: colors.accent }]}>
              {showFullDescription ? "See less" : "See more"}
            </Text>
          </Pressable>
        </View>
      )}

      {isFollowing && (
        <View style={{ marginBottom: 16 }}>
          <Pressable
            onPress={() => { lightHaptic(); setShowPreferences(prev => !prev); }}
            style={[styles.preferencesBtn, { backgroundColor: colors.surfaceAlt }]}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="options-outline" size={18} color={colors.accent} />
              <Text style={[styles.preferencesBtnText, { color: colors.text }]}>Preferences</Text>
            </View>
            <Ionicons name={showPreferences ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} />
          </Pressable>

          {showPreferences && (
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
              {allEpisodes.length > 0 && (
                <>
                  <View style={[styles.feedSettingDivider, { backgroundColor: colors.border }]} />
                  <Pressable
                    style={styles.feedSettingRow}
                    onPress={() => {
                      lightHaptic();
                      if (feed) batchDownloadRef.current(allEpisodes.slice(0, 20), feed);
                    }}
                  >
                    <View style={styles.feedSettingLeft}>
                      <Ionicons name="cloud-download-outline" size={18} color={colors.accent} />
                      <Text style={[styles.feedSettingLabel, { color: colors.text }]}>Download Latest Episodes</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
      )}

      <Text style={[styles.sectionTitle, { color: colors.text }]}>
        Episodes{totalCount > 0 ? ` (${totalCount})` : ""}
      </Text>

      <View style={styles.sortRow}>
        <Pressable
          onPress={() => { lightHaptic(); setSortOrder(prev => prev === 'newest' ? 'oldest' : 'newest'); }}
          style={[styles.sortBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons name={sortOrder === 'newest' ? 'arrow-down' : 'arrow-up'} size={14} color={colors.accent} />
          <Text style={[styles.sortBtnText, { color: colors.text }]}>
            {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
          </Text>
        </Pressable>
        {(['all', 'unplayed', 'inprogress', 'downloaded'] as const).map(filter => (
          <Pressable
            key={filter}
            onPress={() => { lightHaptic(); setEpisodeFilter(filter); }}
            style={[
              styles.sortBtn,
              { backgroundColor: episodeFilter === filter ? colors.accent : colors.surfaceAlt },
            ]}
          >
            <Text style={[styles.sortBtnText, { color: episodeFilter === filter ? '#fff' : colors.text }]}>
              {filter === 'all' ? 'All' : filter === 'unplayed' ? 'Unplayed' : filter === 'inprogress' ? 'Started' : 'Saved'}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={[styles.episodeSearchContainer, { backgroundColor: colors.surfaceAlt, borderColor: isEpisodeSearchFocused ? colors.accent : "transparent" }]}>
        <Ionicons name="search" size={16} color={colors.textSecondary} style={{ marginLeft: 12 }} />
        <TextInput
          style={[styles.episodeSearchInput, { color: colors.text }]}
          placeholder="Search episodes..."
          placeholderTextColor={colors.textSecondary}
          value={episodeSearch}
          onChangeText={setEpisodeSearch}
          onFocus={() => setIsEpisodeSearchFocused(true)}
          onBlur={() => setIsEpisodeSearchFocused(false)}
          returnKeyType="search"
        />
        {episodeSearch.length > 0 && (
          <Pressable onPress={() => setEpisodeSearch("")} style={styles.episodeSearchClear}>
            <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
    </View>
  );
  }, [feed, feedError, feedErrorMsg, colors, insets.top, isFollowing, showFullDescription, showPreferences, feedSettings, allEpisodes.length, totalCount, sortOrder, episodeSearch, isEpisodeSearchFocused, handleFollow, handleToggleNotifications, handleChangeEpisodeLimit, episodeFilter, inProgressIds, id]);

  const footerElement = useMemo(() => {
    if (episodesInfiniteQuery.isFetchingNextPage) {
      return (
        <View style={styles.loadingMore}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.loadingMoreText, { color: colors.textSecondary }]}>Loading more episodes...</Text>
        </View>
      );
    }
    if (allEpisodes.length > 0 && !episodesInfiniteQuery.hasNextPage && !episodeSearch.trim()) {
      return (
        <View style={styles.endOfList}>
          <Text style={[styles.endOfListText, { color: colors.textSecondary }]}>
            All {totalCount} episodes loaded
          </Text>
        </View>
      );
    }
    return null;
  }, [episodesInfiniteQuery.isFetchingNextPage, episodesInfiniteQuery.hasNextPage, allEpisodes.length, totalCount, episodeSearch, colors]);

  const emptyElement = useMemo(() => {
    if (episodesInfiniteQuery.isLoading) {
      return <ActivityIndicator size="small" color={colors.accent} style={{ marginTop: 20 }} />;
    }
    return (
      <View style={styles.emptyState}>
        <Ionicons name="albums-outline" size={40} color={colors.textSecondary} />
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No episodes found</Text>
      </View>
    );
  }, [episodesInfiniteQuery.isLoading, colors]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={filteredEpisodes}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 120, paddingHorizontal: 16, maxWidth: Platform.OS === "web" ? 1200 : undefined, marginHorizontal: Platform.OS === "web" ? "auto" as any : undefined, width: Platform.OS === "web" ? "100%" as any : undefined }}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={Platform.OS !== "web"}
        ListHeaderComponent={headerElement}
        renderItem={renderEpisodeItem}
        ListFooterComponent={footerElement}
        ListEmptyComponent={emptyElement}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={handleRefresh} tintColor={colors.accent} />
        }
      />

      <OptionPickerModal
        visible={episodeLimitPickerVisible}
        title="Episodes to Keep"
        subtitle="Choose how many episodes to keep downloaded for this shiur."
        options={EPISODE_LIMIT_OPTIONS.map(n => ({
          label: `${n} episodes`,
          onPress: () => { if (id) updateFeedSettings(id, { maxEpisodes: n }); },
          selected: feedSettings.maxEpisodes === n,
        }))}
        onClose={() => setEpisodeLimitPickerVisible(false)}
      />
    </View>
  );
}

export default function PodcastDetailScreen() {
  return (
    <ErrorBoundary>
      <PodcastDetailScreenInner />
    </ErrorBoundary>
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
    width: 100,
    height: 100,
    borderRadius: 14,
  },
  podcastMeta: {
    flex: 1,
    justifyContent: "center",
    gap: 6,
  },
  podcastTitle: {
    fontSize: 18,
    fontWeight: "700" as const,
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
    fontWeight: "600" as const,
  },
  descriptionBlock: {
    marginBottom: 16,
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
  },
  seeMoreText: {
    fontSize: 13,
    fontWeight: "600" as const,
    marginTop: 4,
  },
  preferencesBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginBottom: 8,
  },
  preferencesBtnText: {
    fontSize: 14,
    fontWeight: "600" as const,
  },
  feedSettingsCard: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
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
    fontWeight: "500" as const,
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
    fontWeight: "700" as const,
    marginBottom: 12,
  },
  sortRow: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: 8,
    marginBottom: 12,
  },
  sortBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  sortBtnText: {
    fontSize: 13,
    fontWeight: "500" as const,
  },
  episodeSearchContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 2,
    height: 40,
    marginBottom: 12,
  },
  episodeSearchInput: {
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 8,
    paddingVertical: 0,
    height: 40,
  },
  episodeSearchClear: {
    padding: 8,
  },
  loadingMore: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 20,
  },
  loadingMoreText: {
    fontSize: 13,
  },
  endOfList: {
    alignItems: "center",
    paddingVertical: 16,
  },
  endOfListText: {
    fontSize: 12,
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
