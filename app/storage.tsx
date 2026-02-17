import React, { useState, useEffect, useMemo, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Alert, Platform, ActivityIndicator } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { safeGoBack } from "@/lib/safe-back";
import Colors from "@/constants/colors";
import { useDownloads } from "@/contexts/DownloadsContext";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";
import type { DownloadedEpisode } from "@/lib/types";

interface FeedStorageInfo {
  feedId: string;
  feedTitle: string;
  feedImageUrl: string | null;
  episodes: DownloadedEpisode[];
  totalSize: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function estimateSize(ep: DownloadedEpisode): number {
  if (ep.duration) {
    const durationSec = typeof ep.duration === "string" ? parseInt(ep.duration, 10) : ep.duration;
    if (durationSec > 0) {
      return durationSec * 16000;
    }
  }
  return 15 * 1024 * 1024;
}

export default function StorageScreen() {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const insets = useSafeAreaInsets();
  const { downloads, removeDownload } = useDownloads();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [clearingFeed, setClearingFeed] = useState<string | null>(null);

  const feedGroups = useMemo(() => {
    const groups: Record<string, FeedStorageInfo> = {};
    for (const ep of downloads) {
      const fid = ep.feedId || "unknown";
      if (!groups[fid]) {
        groups[fid] = {
          feedId: fid,
          feedTitle: ep.feedTitle || "Unknown",
          feedImageUrl: ep.feedImageUrl || null,
          episodes: [],
          totalSize: 0,
        };
      }
      const size = estimateSize(ep);
      groups[fid].episodes.push(ep);
      groups[fid].totalSize += size;
    }
    return Object.values(groups).sort((a, b) => b.totalSize - a.totalSize);
  }, [downloads]);

  const totalEstimatedSize = useMemo(() => {
    return feedGroups.reduce((acc, g) => acc + g.totalSize, 0);
  }, [feedGroups]);

  const handleDeleteEpisode = useCallback(async (episodeId: string, title: string) => {
    Alert.alert(
      "Remove Download",
      `Remove "${title}" from downloads?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setDeleting(episodeId);
            await removeDownload(episodeId);
            setDeleting(null);
            lightHaptic();
          },
        },
      ]
    );
  }, [removeDownload]);

  const handleClearFeed = useCallback(async (feed: FeedStorageInfo) => {
    Alert.alert(
      "Clear Downloads",
      `Remove all ${feed.episodes.length} downloaded episodes from "${feed.feedTitle}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove All",
          style: "destructive",
          onPress: async () => {
            setClearingFeed(feed.feedId);
            mediumHaptic();
            for (const ep of feed.episodes) {
              await removeDownload(ep.id);
            }
            setClearingFeed(null);
          },
        },
      ]
    );
  }, [removeDownload]);

  const handleClearAll = useCallback(() => {
    if (downloads.length === 0) return;
    Alert.alert(
      "Clear All Downloads",
      `Remove all ${downloads.length} downloaded episodes? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove All",
          style: "destructive",
          onPress: async () => {
            setClearingFeed("all");
            mediumHaptic();
            for (const ep of downloads) {
              await removeDownload(ep.id);
            }
            setClearingFeed(null);
          },
        },
      ]
    );
  }, [downloads, removeDownload]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Storage</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.summaryCard, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <View style={styles.summaryRow}>
            <Ionicons name="cloud-download" size={32} color={colors.accent} />
            <View style={styles.summaryTextWrap}>
              <Text style={[styles.summaryValue, { color: colors.text }]}>{formatBytes(totalEstimatedSize)}</Text>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
                {downloads.length} episode{downloads.length !== 1 ? "s" : ""} downloaded
              </Text>
            </View>
          </View>
          {downloads.length > 0 && (
            <Pressable
              style={[styles.clearAllBtn, { borderColor: "#EF4444" }]}
              onPress={handleClearAll}
              disabled={clearingFeed === "all"}
            >
              {clearingFeed === "all" ? (
                <ActivityIndicator size="small" color="#EF4444" />
              ) : (
                <>
                  <Ionicons name="trash-outline" size={16} color="#EF4444" />
                  <Text style={styles.clearAllText}>Clear All Downloads</Text>
                </>
              )}
            </Pressable>
          )}
        </View>

        {feedGroups.length === 0 && (
          <View style={styles.emptyContainer}>
            <Ionicons name="folder-open-outline" size={48} color={colors.textSecondary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No downloaded episodes</Text>
          </View>
        )}

        {feedGroups.map((group) => (
          <View key={group.feedId} style={[styles.feedSection, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
            <View style={styles.feedHeader}>
              {group.feedImageUrl ? (
                <Image source={{ uri: group.feedImageUrl }} style={styles.feedImage} contentFit="cover" />
              ) : (
                <View style={[styles.feedImage, { backgroundColor: colors.surfaceAlt }]}>
                  <Ionicons name="musical-notes" size={18} color={colors.textSecondary} />
                </View>
              )}
              <View style={styles.feedInfo}>
                <Text style={[styles.feedTitle, { color: colors.text }]} numberOfLines={1}>{group.feedTitle}</Text>
                <Text style={[styles.feedMeta, { color: colors.textSecondary }]}>
                  {group.episodes.length} episode{group.episodes.length !== 1 ? "s" : ""} · {formatBytes(group.totalSize)}
                </Text>
              </View>
              <Pressable
                onPress={() => handleClearFeed(group)}
                disabled={clearingFeed === group.feedId}
                hitSlop={8}
              >
                {clearingFeed === group.feedId ? (
                  <ActivityIndicator size="small" color="#EF4444" />
                ) : (
                  <Ionicons name="trash-outline" size={20} color="#EF4444" />
                )}
              </Pressable>
            </View>

            {group.episodes.map((ep, idx) => (
              <View key={ep.id}>
                {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
                <View style={styles.episodeRow}>
                  <View style={styles.episodeInfo}>
                    <Text style={[styles.episodeTitle, { color: colors.text }]} numberOfLines={2}>{ep.title}</Text>
                    <Text style={[styles.episodeSize, { color: colors.textSecondary }]}>
                      ~{formatBytes(estimateSize(ep))}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDeleteEpisode(ep.id, ep.title)}
                    disabled={deleting === ep.id}
                    hitSlop={8}
                  >
                    {deleting === ep.id ? (
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                    ) : (
                      <Ionicons name="close-circle-outline" size={22} color={colors.textSecondary} />
                    )}
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  summaryCard: {
    borderRadius: 14,
    padding: 20,
    marginBottom: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  summaryTextWrap: { flex: 1 },
  summaryValue: { fontSize: 24, fontWeight: "700" },
  summaryLabel: { fontSize: 13, marginTop: 2 },
  clearAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  clearAllText: { color: "#EF4444", fontWeight: "600", fontSize: 14 },
  emptyContainer: { alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 15 },
  feedSection: {
    borderRadius: 14,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  feedHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  feedImage: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  feedInfo: { flex: 1 },
  feedTitle: { fontSize: 15, fontWeight: "600" },
  feedMeta: { fontSize: 12, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  episodeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
  },
  episodeInfo: { flex: 1 },
  episodeTitle: { fontSize: 14 },
  episodeSize: { fontSize: 12, marginTop: 2 },
});
