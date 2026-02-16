import React, { useCallback, useMemo } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { useQuery } from "@tanstack/react-query";
import { safeGoBack } from "@/lib/safe-back";
import Colors from "@/constants/colors";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";
import type { Feed, Episode } from "@/lib/types";
import { reorderQueue } from "@/lib/queue";

export default function QueueScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { currentEpisode, currentFeed, queue, removeFromQueue, clearQueue, playEpisode, refreshQueue } = useAudioPlayer();

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const latestQuery = useQuery<Episode[]>({ queryKey: ["/api/episodes/latest"] });
  const allFeeds = feedsQuery.data || [];
  const allEpisodes = latestQuery.data || [];

  const queueItems = useMemo(() => {
    return queue.map(item => {
      const episode = allEpisodes.find(e => e.id === item.episodeId);
      const feed = allFeeds.find(f => f.id === item.feedId);
      return { ...item, episode, feed };
    }).filter(item => item.episode && item.feed) as { episodeId: string; feedId: string; addedAt: number; episode: Episode; feed: Feed }[];
  }, [queue, allEpisodes, allFeeds]);

  const handleMoveUp = useCallback(async (index: number) => {
    if (index <= 0) return;
    lightHaptic();
    const newQueue = [...queue];
    [newQueue[index - 1], newQueue[index]] = [newQueue[index], newQueue[index - 1]];
    await reorderQueue(newQueue);
    await refreshQueue();
  }, [queue, refreshQueue]);

  const handleMoveDown = useCallback(async (index: number) => {
    if (index >= queue.length - 1) return;
    lightHaptic();
    const newQueue = [...queue];
    [newQueue[index], newQueue[index + 1]] = [newQueue[index + 1], newQueue[index]];
    await reorderQueue(newQueue);
    await refreshQueue();
  }, [queue, refreshQueue]);

  const handleRemove = useCallback(async (episodeId: string) => {
    mediumHaptic();
    await removeFromQueue(episodeId);
  }, [removeFromQueue]);

  const handleClear = useCallback(async () => {
    mediumHaptic();
    await clearQueue();
  }, [clearQueue]);

  const handlePlayFromQueue = useCallback(async (episode: Episode, feed: Feed) => {
    lightHaptic();
    await playEpisode(episode, feed);
    await removeFromQueue(episode.id);
  }, [playEpisode, removeFromQueue]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === "web" ? 67 : 8) }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={12}>
          <Ionicons name="chevron-down" size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Up Next</Text>
        {queueItems.length > 0 ? (
          <Pressable onPress={handleClear} hitSlop={8}>
            <Text style={[styles.clearText, { color: colors.danger }]}>Clear</Text>
          </Pressable>
        ) : (
          <View style={{ width: 44 }} />
        )}
      </View>

      {currentEpisode && currentFeed && (
        <View style={[styles.nowPlayingSection, { borderBottomColor: colors.border }]}>
          <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Now Playing</Text>
          <View style={[styles.nowPlayingCard, { backgroundColor: colors.surfaceAlt }]}>
            {currentFeed.imageUrl ? (
              <Image source={{ uri: currentFeed.imageUrl }} style={styles.artwork} contentFit="cover" cachePolicy="memory-disk" transition={0} />
            ) : (
              <View style={[styles.artwork, { backgroundColor: colors.border, alignItems: "center", justifyContent: "center" }]}>
                <Ionicons name="mic" size={18} color={colors.textSecondary} />
              </View>
            )}
            <View style={styles.itemInfo}>
              <Text style={[styles.itemTitle, { color: colors.text }]} numberOfLines={1}>{currentEpisode.title}</Text>
              <Text style={[styles.itemFeed, { color: colors.textSecondary }]} numberOfLines={1}>{currentFeed.title}</Text>
            </View>
            <Ionicons name="volume-high" size={18} color={colors.accent} />
          </View>
        </View>
      )}

      <FlatList
        data={queueItems}
        keyExtractor={item => item.episodeId}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
        ListHeaderComponent={queueItems.length > 0 ? (
          <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: 16 }]}>Queue ({queueItems.length})</Text>
        ) : null}
        renderItem={({ item, index }) => (
          <View style={[styles.queueCard, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
            <Pressable onPress={() => handlePlayFromQueue(item.episode, item.feed)} style={styles.queueCardContent}>
              {item.feed.imageUrl ? (
                <Image source={{ uri: item.feed.imageUrl }} style={styles.artwork} contentFit="cover" cachePolicy="memory-disk" transition={0} />
              ) : (
                <View style={[styles.artwork, { backgroundColor: colors.border, alignItems: "center", justifyContent: "center" }]}>
                  <Ionicons name="mic" size={18} color={colors.textSecondary} />
                </View>
              )}
              <View style={styles.itemInfo}>
                <Text style={[styles.itemTitle, { color: colors.text }]} numberOfLines={1}>{item.episode.title}</Text>
                <Text style={[styles.itemFeed, { color: colors.textSecondary }]} numberOfLines={1}>{item.feed.title}</Text>
              </View>
            </Pressable>
            <View style={styles.queueActions}>
              <Pressable onPress={() => handleMoveUp(index)} hitSlop={6} style={styles.reorderBtn} disabled={index === 0}>
                <Ionicons name="chevron-up" size={18} color={index === 0 ? colors.border : colors.textSecondary} />
              </Pressable>
              <Pressable onPress={() => handleMoveDown(index)} hitSlop={6} style={styles.reorderBtn} disabled={index === queueItems.length - 1}>
                <Ionicons name="chevron-down" size={18} color={index === queueItems.length - 1 ? colors.border : colors.textSecondary} />
              </Pressable>
              <Pressable onPress={() => handleRemove(item.episodeId)} hitSlop={6} style={styles.reorderBtn}>
                <Ionicons name="close" size={18} color={colors.danger} />
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="list-outline" size={56} color={colors.textSecondary} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>Queue is Empty</Text>
            <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
              Add episodes to your queue from the episode menu
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" as const },
  clearText: { fontSize: 14, fontWeight: "600" as const },
  nowPlayingSection: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  nowPlayingCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    gap: 12,
  },
  artwork: {
    width: 44,
    height: 44,
    borderRadius: 8,
  },
  itemInfo: { flex: 1, gap: 2 },
  itemTitle: { fontSize: 14, fontWeight: "600" as const },
  itemFeed: { fontSize: 12 },
  queueCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
    overflow: "hidden",
  },
  queueCardContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 12,
  },
  queueActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 8,
    gap: 2,
  },
  reorderBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
    gap: 12,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700" as const },
  emptySubtitle: { fontSize: 14, textAlign: "center" as const, lineHeight: 20 },
});
