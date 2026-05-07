// YTC: collection drill-in. Mirrors the iOS app's CollectionDetailView
// (/tmp/ytc-source/ytcalumni1/Views/Shiurim/CollectionDetailView.swift).
//
// Loads the collection by id, then filters the cached shiurim list down
// to the collection's `shiurIds`. Renders a header (name + description
// + count) and the shiurim with the same play/download/progress UI as
// the main shiurim screen.
import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator,
  Platform, RefreshControl, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { ytcColors as Colors } from "@/constants/ytcColors";
import {
  fetchCollectionById, fetchShiurim, invalidateYtcCache,
} from "@/lib/ytc/firebase";
import type { Shiur, ShiurCollection } from "@/types/ytc";
import {
  useYtcPlayer, YTC_EPISODE_PREFIX, ytcShiurToEpisodeAndFeed,
} from "@/lib/ytc/audio-adapter";
import { usePositions } from "@/contexts/PositionsContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { trackShiurDownload } from "@/lib/ytc/analytics";

function formatRemainingMin(positionMs: number, durationMs: number): string {
  const remainingMs = Math.max(0, durationMs - positionMs);
  const total = Math.floor(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m} min left`;
}

export default function CollectionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const collectionId = Array.isArray(id) ? id[0] : id;

  const { currentShiurId, isPlaying, isLoading: audioLoading, play, pauseResume } = useYtcPlayer();
  const { getPosition } = usePositions();
  const { downloadEpisode, removeDownload, isDownloaded, isDownloading, downloadProgress } = useDownloads();

  const [collection, setCollection] = useState<ShiurCollection | null>(null);
  const [shiurim, setShiurim] = useState<Shiur[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!collectionId) return;
    try {
      const [c, allShiurim] = await Promise.all([
        fetchCollectionById(collectionId),
        fetchShiurim(),
      ]);
      setCollection(c as ShiurCollection | null);
      setShiurim(allShiurim as Shiur[]);
    } catch (e) {
      console.error("YTC CollectionDetail load error:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [collectionId]);

  const onRefresh = async () => {
    if (!collectionId) return;
    setRefreshing(true);
    await Promise.all([
      invalidateYtcCache(`shiurCollection:${collectionId}`),
      invalidateYtcCache("shiurim"),
    ]);
    load();
  };

  // Filter the master shiurim list down to this collection's ids,
  // preserving the order specified in shiurIds (collections may be
  // intentionally ordered, e.g. lecture series).
  const collectionShiurim = useMemo(() => {
    if (!collection) return [];
    const byId = new Map(shiurim.map((s) => [s.id, s]));
    return collection.shiurIds.map((sid) => byId.get(sid)).filter(Boolean) as Shiur[];
  }, [collection, shiurim]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const renderShiur = ({ item }: { item: Shiur }) => {
    const isActive = currentShiurId === item.id;
    const epId = `${YTC_EPISODE_PREFIX}${item.id}`;
    const saved = getPosition(epId);
    const hasProgress = saved && saved.durationMs > 0 && saved.positionMs > 0;
    const pct = hasProgress ? Math.min(Math.round((saved!.positionMs / saved!.durationMs) * 100), 100) : 0;
    const completed = hasProgress && pct >= 95;
    const downloaded = isDownloaded(epId);
    const downloading = isDownloading(epId);
    const dlPct = downloading ? (downloadProgress.get(epId) || 0) : 0;
    const onDownloadPress = () => {
      if (!item.audioUrl) return;
      if (downloaded) {
        Alert.alert("Remove download?", item.title, [
          { text: "Cancel", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: () => { removeDownload(epId); } },
        ]);
        return;
      }
      if (downloading) return;
      const { episode, feed } = ytcShiurToEpisodeAndFeed(item);
      trackShiurDownload(item.id).catch(() => {});
      downloadEpisode(episode, feed);
    };
    return (
      <View style={[styles.card, isActive && styles.cardActive]}>
        <View style={styles.row}>
          {item.audioUrl && (
            <TouchableOpacity
              style={[styles.playBtn, isActive && styles.playBtnActive]}
              onPress={() => { if (isActive) pauseResume(); else play(item); }}
            >
              {isActive && audioLoading
                ? <ActivityIndicator size="small" color={Colors.cream} />
                : <Ionicons name={isActive && isPlaying ? "pause" : "play"} size={18} color={isActive ? Colors.cream : Colors.navy} />}
            </TouchableOpacity>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
            <Text style={styles.meta}>{item.rebbe}{item.date ? ` · ${formatDate(item.date)}` : ""}</Text>
            {downloading && (
              <Text style={styles.progressText}>Downloading {Math.round(dlPct * 100)}%</Text>
            )}
            {!downloading && hasProgress && !completed && (
              <Text style={styles.progressText}>{pct}% · {formatRemainingMin(saved!.positionMs, saved!.durationMs)}</Text>
            )}
            {!downloading && completed && <Text style={styles.completedText}>Completed</Text>}
          </View>
          {item.audioUrl && (
            <TouchableOpacity onPress={onDownloadPress} hitSlop={8} style={styles.dlBtn}>
              {downloading
                ? <ActivityIndicator size="small" color={Colors.navy} />
                : downloaded
                ? <Ionicons name="trash-outline" size={20} color={Colors.error} />
                : <Ionicons name="download-outline" size={22} color={Colors.navyOpacity70} />}
            </TouchableOpacity>
          )}
        </View>
        {hasProgress && !completed && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
    );
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      </SafeAreaView>
    );
  }

  if (!collection) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Collection</Text>
        </View>
        <View style={styles.empty}>
          <Ionicons name="folder-open-outline" size={40} color={Colors.navyOpacity30} />
          <Text style={styles.emptyText}>This collection is no longer available.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={2}>{collection.name}</Text>
        {collection.description ? (
          <Text style={styles.headerSubtitle} numberOfLines={3}>{collection.description}</Text>
        ) : null}
        <Text style={styles.countText}>
          {collectionShiurim.length} shiur{collectionShiurim.length !== 1 ? "im" : ""}
        </Text>
      </View>
      <FlatList
        data={collectionShiurim}
        keyExtractor={(item) => item.id}
        renderItem={renderShiur}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="musical-notes-outline" size={40} color={Colors.navyOpacity30} />
            <Text style={styles.emptyText}>No shiurim in this collection yet.</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  loader: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    backgroundColor: Colors.navy, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
    alignItems: "center", gap: 4,
  },
  headerTitle: {
    color: Colors.cream, fontSize: 18, fontWeight: "bold",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", textAlign: "center",
  },
  headerSubtitle: { color: Colors.creamOpacity70, fontSize: 12, textAlign: "center", marginTop: 2 },
  countText: { color: Colors.gold, fontSize: 11, fontWeight: "500", marginTop: 4 },
  listContent: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 120 },
  empty: { alignItems: "center", padding: 40, gap: 12 },
  emptyText: { fontSize: 14, color: Colors.navyOpacity50, textAlign: "center" },
  card: {
    backgroundColor: Colors.white, borderRadius: 12, marginBottom: 8, overflow: "hidden",
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06,
    shadowRadius: 4, elevation: 2,
  },
  cardActive: { borderLeftWidth: 3, borderLeftColor: Colors.gold },
  row: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  playBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.creamDark,
    alignItems: "center", justifyContent: "center",
  },
  playBtnActive: { backgroundColor: Colors.navy },
  title: { fontSize: 14, fontWeight: "600", color: Colors.navy, lineHeight: 20 },
  meta: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2 },
  progressText: { fontSize: 11, color: Colors.gold, marginTop: 2, fontWeight: "500" },
  completedText: { fontSize: 11, color: Colors.navyOpacity50, marginTop: 2, fontWeight: "500" },
  progressTrack: { height: 3, backgroundColor: Colors.creamDark },
  progressFill: { height: 3, backgroundColor: Colors.gold },
  dlBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
});
