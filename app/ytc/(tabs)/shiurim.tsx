// YTC: shiurim list with search/filter/sort. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/shiurim.tsx with imports remapped
// and useAudio() → useYtcPlayer() (richer audio adapter hook).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, ScrollView, Platform, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { fetchShiurim, invalidateYtcCache } from "@/lib/ytc/firebase";
import type { Shiur } from "@/types/ytc";
import { useYtcPlayer, YTC_EPISODE_PREFIX, ytcShiurToEpisodeAndFeed } from "@/lib/ytc/audio-adapter";
import { usePositions } from "@/contexts/PositionsContext";
import { useDownloads } from "@/contexts/DownloadsContext";

type SortOrder = "dateDesc" | "dateAsc" | "titleAZ" | "rebbeAZ";

function formatRemainingMin(positionMs: number, durationMs: number): string {
  const remainingMs = Math.max(0, durationMs - positionMs);
  const total = Math.floor(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m} min left`;
}

export default function ShiurimScreen() {
  const { currentShiurId, isPlaying, isLoading: audioLoading, play, pauseResume } = useYtcPlayer();
  const { getPosition } = usePositions();
  const { downloadEpisode, removeDownload, isDownloaded, isDownloading, downloadProgress } = useDownloads();

  const [shiurim, setShiurim] = useState<Shiur[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("dateDesc");
  const [selectedRebbeFilter, setSelectedRebbeFilter] = useState<string | null>(null);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadShiurim = async () => {
    try {
      const data = await fetchShiurim();
      setShiurim(data as Shiur[]);
    } catch (e) {
      console.error("YTC Shiurim load error:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadShiurim(); }, []);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await invalidateYtcCache("shiurim");
    loadShiurim();
  }, []);

  const allRebbeim = useMemo(() => [...new Set(shiurim.map((s) => s.rebbe))].sort(), [shiurim]);
  const allTags = useMemo(() => [...new Set(shiurim.flatMap((s) => s.tags))].sort(), [shiurim]);

  const filtered = useMemo(() => {
    let result = [...shiurim];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.rebbe.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q)) ||
          (s.series?.toLowerCase().includes(q) ?? false),
      );
    }
    if (selectedRebbeFilter) result = result.filter((s) => s.rebbe === selectedRebbeFilter);
    if (selectedTagFilter) result = result.filter((s) => s.tags.includes(selectedTagFilter));

    switch (sortOrder) {
      case "dateAsc": result.sort((a, b) => a.date.localeCompare(b.date)); break;
      case "titleAZ": result.sort((a, b) => a.title.localeCompare(b.title)); break;
      case "rebbeAZ": result.sort((a, b) => a.rebbe.localeCompare(b.rebbe)); break;
      default: result.sort((a, b) => b.date.localeCompare(a.date));
    }
    return result;
  }, [shiurim, search, selectedRebbeFilter, selectedTagFilter, sortOrder]);

  const hasFilters = !!selectedRebbeFilter || !!selectedTagFilter;

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const renderShiur = ({ item }: { item: Shiur }) => {
    const isActive = currentShiurId === item.id;
    const isExpanded = expandedId === item.id;
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
        removeDownload(epId);
        return;
      }
      if (downloading) return;
      const { episode, feed } = ytcShiurToEpisodeAndFeed(item);
      downloadEpisode(episode, feed);
    };
    return (
      <View style={[styles.shiurCard, isActive && styles.shiurCardActive]}>
        <TouchableOpacity style={styles.shiurHeader} onPress={() => setExpandedId(isExpanded ? null : item.id)}>
          <View style={styles.shiurLeft}>
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
            <View style={styles.shiurMeta}>
              <Text style={[styles.shiurTitle, isActive && styles.shiurTitleActive]} numberOfLines={2}>{item.title}</Text>
              <Text style={styles.shiurRebbeDate}>{item.rebbe} · {formatDate(item.date)}</Text>
              {item.series && <Text style={styles.seriesText}>Series: {item.series}</Text>}
              {downloading && (
                <Text style={styles.progressText}>Downloading {Math.round(dlPct * 100)}%</Text>
              )}
              {!downloading && hasProgress && !completed && (
                <Text style={styles.progressText}>{pct}% · {formatRemainingMin(saved!.positionMs, saved!.durationMs)}</Text>
              )}
              {!downloading && completed && <Text style={styles.completedText}>Completed</Text>}
            </View>
          </View>
          {item.audioUrl && (
            <TouchableOpacity onPress={onDownloadPress} hitSlop={8} style={styles.downloadBtn}>
              {downloading
                ? <ActivityIndicator size="small" color={Colors.navy} />
                : downloaded
                ? <Ionicons name="checkmark-circle" size={22} color={Colors.gold} />
                : <Ionicons name="download-outline" size={22} color={Colors.navyOpacity70} />}
            </TouchableOpacity>
          )}
          <Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={16} color={Colors.navyOpacity50} />
        </TouchableOpacity>
        {isExpanded && (
          <View style={styles.shiurDetail}>
            {item.description && <Text style={styles.description}>{item.description}</Text>}
            {item.tags.length > 0 && (
              <View style={styles.tags}>
                {item.tags.map((tag) => (
                  <TouchableOpacity key={tag} style={styles.tag} onPress={() => { setSelectedTagFilter(selectedTagFilter === tag ? null : tag); setShowFilters(false); }}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={styles.statsRow}>
              {item.playCount != null && <Text style={styles.stat}>▶ {item.playCount} plays</Text>}
            </View>
          </View>
        )}
        {hasProgress && !completed && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Shiurim</Text>
        <Text style={styles.headerSubtitle}>Torah lectures from our Rebbeim</Text>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={Colors.navyOpacity50} style={{ marginRight: 8 }} />
          <TextInput style={styles.searchInput} placeholder="Search shiurim..." placeholderTextColor={Colors.navyOpacity50} value={search} onChangeText={setSearch} />
          {search ? <TouchableOpacity onPress={() => setSearch("")}><Ionicons name="close-circle" size={18} color={Colors.navyOpacity50} /></TouchableOpacity> : null}
        </View>
        <TouchableOpacity style={[styles.filterBtn, hasFilters && styles.filterBtnActive]} onPress={() => setShowFilters(true)}>
          <Ionicons name="options" size={20} color={hasFilters ? Colors.cream : Colors.navy} />
        </TouchableOpacity>
      </View>

      {hasFilters && (
        <View style={styles.activeFilters}>
          {selectedRebbeFilter && <TouchableOpacity style={styles.filterChip} onPress={() => setSelectedRebbeFilter(null)}><Text style={styles.filterChipText}>{selectedRebbeFilter} ✕</Text></TouchableOpacity>}
          {selectedTagFilter && <TouchableOpacity style={styles.filterChip} onPress={() => setSelectedTagFilter(null)}><Text style={styles.filterChipText}>{selectedTagFilter} ✕</Text></TouchableOpacity>}
        </View>
      )}

      {!isLoading && <Text style={styles.countText}>{filtered.length} shiur{filtered.length !== 1 ? "im" : ""}</Text>}

      {isLoading ? (
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderShiur}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}
          ListEmptyComponent={<View style={styles.empty}><Ionicons name="musical-notes" size={40} color={Colors.navyOpacity30} /><Text style={styles.emptyText}>No shiurim found</Text></View>}
        />
      )}

      <Modal visible={showFilters} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filters & Sort</Text>
            <TouchableOpacity onPress={() => setShowFilters(false)}><Ionicons name="close" size={24} color={Colors.navy} /></TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody}>
            <Text style={styles.filterSectionTitle}>Sort By</Text>
            {([["dateDesc", "Newest First"], ["dateAsc", "Oldest First"], ["titleAZ", "Title A–Z"], ["rebbeAZ", "Rebbe A–Z"]] as [SortOrder, string][]).map(([value, label]) => (
              <TouchableOpacity key={value} style={styles.filterOption} onPress={() => setSortOrder(value)}>
                <Text style={styles.filterOptionText}>{label}</Text>
                {sortOrder === value && <Ionicons name="checkmark" size={18} color={Colors.gold} />}
              </TouchableOpacity>
            ))}
            {allRebbeim.length > 0 && <>
              <Text style={styles.filterSectionTitle}>Filter by Rebbe</Text>
              <TouchableOpacity style={styles.filterOption} onPress={() => setSelectedRebbeFilter(null)}>
                <Text style={styles.filterOptionText}>All Rebbeim</Text>
                {!selectedRebbeFilter && <Ionicons name="checkmark" size={18} color={Colors.gold} />}
              </TouchableOpacity>
              {allRebbeim.map((r) => (
                <TouchableOpacity key={r} style={styles.filterOption} onPress={() => setSelectedRebbeFilter(r === selectedRebbeFilter ? null : r)}>
                  <Text style={styles.filterOptionText}>{r}</Text>
                  {selectedRebbeFilter === r && <Ionicons name="checkmark" size={18} color={Colors.gold} />}
                </TouchableOpacity>
              ))}
            </>}
            {allTags.length > 0 && <>
              <Text style={styles.filterSectionTitle}>Filter by Topic</Text>
              <View style={styles.tagsGrid}>
                {allTags.map((tag) => (
                  <TouchableOpacity key={tag} style={[styles.tagChip, selectedTagFilter === tag && styles.tagChipActive]} onPress={() => setSelectedTagFilter(selectedTagFilter === tag ? null : tag)}>
                    <Text style={[styles.tagChipText, selectedTagFilter === tag && styles.tagChipTextActive]}>{tag}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>}
          </ScrollView>
          <View style={styles.modalFooter}>
            <TouchableOpacity style={styles.clearBtn} onPress={() => { setSelectedRebbeFilter(null); setSelectedTagFilter(null); setSortOrder("dateDesc"); }}>
              <Text style={styles.clearBtnText}>Clear All</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.applyBtn} onPress={() => setShowFilters(false)}>
              <Text style={styles.applyBtnText}>Apply</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  header: { backgroundColor: Colors.navy, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, alignItems: "center" },
  headerTitle: { color: Colors.cream, fontSize: 18, fontWeight: "bold", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  headerSubtitle: { color: Colors.creamOpacity70, fontSize: 12, marginTop: 2 },
  searchRow: { flexDirection: "row", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 10, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.creamDark },
  searchBox: { flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: Colors.cream, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  searchInput: { flex: 1, fontSize: 15, color: Colors.navy },
  filterBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: Colors.creamDark, alignItems: "center", justifyContent: "center" },
  filterBtnActive: { backgroundColor: Colors.navy },
  activeFilters: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 12, paddingVertical: 6, gap: 8, backgroundColor: Colors.white },
  filterChip: { backgroundColor: Colors.goldOpacity15, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 },
  filterChipText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  countText: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 2, fontSize: 12, color: Colors.navyOpacity50 },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  listContent: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 120 },
  empty: { alignItems: "center", padding: 40, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.navyOpacity50 },
  shiurCard: { backgroundColor: Colors.white, borderRadius: 12, marginBottom: 8, shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2, overflow: "hidden" },
  shiurCardActive: { borderLeftWidth: 3, borderLeftColor: Colors.gold },
  shiurHeader: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  shiurLeft: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  playBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.creamDark, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  playBtnActive: { backgroundColor: Colors.navy },
  shiurMeta: { flex: 1 },
  shiurTitle: { fontSize: 14, fontWeight: "600", color: Colors.navy, lineHeight: 20 },
  shiurTitleActive: { color: Colors.navy },
  shiurRebbeDate: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2 },
  seriesText: { fontSize: 11, color: Colors.gold, marginTop: 2, fontWeight: "500" },
  progressText: { fontSize: 11, color: Colors.gold, marginTop: 2, fontWeight: "500" },
  downloadBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  completedText: { fontSize: 11, color: Colors.navyOpacity50, marginTop: 2, fontWeight: "500" },
  progressTrack: { height: 3, backgroundColor: Colors.creamDark },
  progressFill: { height: 3, backgroundColor: Colors.gold },
  shiurDetail: { paddingHorizontal: 14, paddingBottom: 14, paddingTop: 0 },
  description: { fontSize: 13, color: Colors.navyOpacity70, lineHeight: 19, marginBottom: 10 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  tag: { backgroundColor: Colors.navyOpacity10, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  tagText: { fontSize: 11, color: Colors.navy },
  statsRow: { flexDirection: "row", gap: 16 },
  stat: { fontSize: 11, color: Colors.navyOpacity50 },
  modalSafe: { flex: 1, backgroundColor: Colors.cream },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.creamDark, backgroundColor: Colors.white },
  modalTitle: { fontSize: 18, fontWeight: "600", color: Colors.navy },
  modalBody: { flex: 1 },
  filterSectionTitle: { fontSize: 13, fontWeight: "600", color: Colors.navyOpacity50, textTransform: "uppercase", letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  filterOption: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.creamDark },
  filterOptionText: { fontSize: 15, color: Colors.navy },
  tagsGrid: { flexDirection: "row", flexWrap: "wrap", padding: 12, gap: 8 },
  tagChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: Colors.creamDark, borderWidth: 1, borderColor: "transparent" },
  tagChipActive: { backgroundColor: Colors.navy },
  tagChipText: { fontSize: 13, color: Colors.navy },
  tagChipTextActive: { color: Colors.cream },
  modalFooter: { flexDirection: "row", padding: 16, gap: 12, borderTopWidth: 1, borderTopColor: Colors.creamDark, backgroundColor: Colors.white },
  clearBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: Colors.navyOpacity30, alignItems: "center" },
  clearBtnText: { fontSize: 15, color: Colors.navy, fontWeight: "500" },
  applyBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: Colors.navy, alignItems: "center" },
  applyBtnText: { fontSize: 15, color: Colors.cream, fontWeight: "600" },
});
