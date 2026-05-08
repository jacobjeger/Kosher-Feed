// YTC: shiurim list with search/filter/sort. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/shiurim.tsx with imports remapped
// and useAudio() → useYtcPlayer() (richer audio adapter hook).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, ScrollView, Platform, RefreshControl, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { fetchShiurim, invalidateYtcCache } from "@/lib/ytc/firebase";
import type { Shiur } from "@/types/ytc";
import { useYtcPlayer, YTC_EPISODE_PREFIX, ytcShiurToEpisodeAndFeed } from "@/lib/ytc/audio-adapter";
import { usePositions } from "@/contexts/PositionsContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { trackShiurDownload } from "@/lib/ytc/analytics";
import { useSavedShiurim } from "@/lib/ytc/useSavedShiurim";
import { YtcFocusable } from "@/components/ytc/YtcFocusable";

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
  const { isSaved, toggleSaved } = useSavedShiurim();

  const [shiurim, setShiurim] = useState<Shiur[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("dateDesc");
  // Multi-select filters — Sets so we can union match (e.g. show
  // shiurim by EITHER R' Reichman OR R' Friedman, AND tagged with
  // EITHER Halacha OR Mussar). Mirrors the website's
  // /shiurim?rebbe=A&rebbe=B&topic=Halacha pattern.
  const [selectedRebbeim, setSelectedRebbeim] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedSeries, setSelectedSeries] = useState<Set<string>>(new Set());
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [showInProgressOnly, setShowInProgressOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // Which filter accordion is expanded inside the Filters modal. Only
  // one open at a time so the modal stays scannable.
  const [openFilterSection, setOpenFilterSection] = useState<"sort" | "rebbe" | "topic" | "series" | null>("sort");
  // Visible shiur count — paginated 20-at-a-time as the user scrolls.
  // Reset whenever the filter inputs change so a new query renders fast.
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
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
  const allSeries = useMemo(
    () => [...new Set(shiurim.map((s) => s.series).filter(Boolean) as string[])].sort(),
    [shiurim],
  );

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
    // Multi-select: a shiur passes if it matches ANY selected value
    // within a category (OR), and matches ALL active categories (AND).
    if (selectedRebbeim.size > 0) result = result.filter((s) => selectedRebbeim.has(s.rebbe));
    if (selectedTags.size > 0) result = result.filter((s) => s.tags.some((t) => selectedTags.has(t)));
    if (selectedSeries.size > 0) result = result.filter((s) => !!s.series && selectedSeries.has(s.series));
    if (showSavedOnly) result = result.filter((s) => isSaved(s.id));
    if (showInProgressOnly) {
      result = result.filter((s) => {
        const pos = getPosition(`${YTC_EPISODE_PREFIX}${s.id}`);
        if (!pos || pos.durationMs <= 0 || pos.positionMs <= 0) return false;
        const pct = pos.positionMs / pos.durationMs;
        return pct > 0 && pct < 0.95;
      });
    }

    switch (sortOrder) {
      case "dateAsc": result.sort((a, b) => a.date.localeCompare(b.date)); break;
      case "titleAZ": result.sort((a, b) => a.title.localeCompare(b.title)); break;
      case "rebbeAZ": result.sort((a, b) => a.rebbe.localeCompare(b.rebbe)); break;
      default: result.sort((a, b) => b.date.localeCompare(a.date));
    }
    return result;
  }, [shiurim, search, selectedRebbeim, selectedTags, selectedSeries, showSavedOnly, showInProgressOnly, isSaved, getPosition, sortOrder]);

  // Reset pagination whenever the active filter window changes so the
  // first render shows the most relevant top-of-list slice fast.
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, selectedRebbeim, selectedTags, selectedSeries, showSavedOnly, showInProgressOnly, sortOrder]);

  const visibleShiurim = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMoreShiurim = filtered.length > visibleCount;

  const hasFilters =
    selectedRebbeim.size > 0 || selectedTags.size > 0 || selectedSeries.size > 0 ||
    showSavedOnly || showInProgressOnly;

  // Toggle helpers for multi-select. Returning a *new* Set on every
  // toggle is what triggers the dependent useEffect / useMemo recalcs.
  const toggleInSet = useCallback(<T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }, []);

  // Stable callbacks so the memoized ShiurCard doesn't re-render on
  // every parent state change. Each accepts the shiur as an argument
  // since the actions are global from the parent's perspective.
  const formatDate = useCallback((dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }, []);

  const onTagPress = useCallback((tag: string) => {
    // Multi-select: tap a tag inline → toggles it in the topic filter set.
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }, []);

  const onSavePress = useCallback((shiurId: string) => {
    toggleSaved(shiurId);
  }, [toggleSaved]);

  const onPlayPress = useCallback((shiur: Shiur, isCurrentlyActive: boolean) => {
    if (isCurrentlyActive) pauseResume(); else play(shiur);
  }, [play, pauseResume]);

  const onDownloadPressFor = useCallback((shiur: Shiur, isAlreadyDownloaded: boolean, isCurrentlyDownloading: boolean) => {
    if (!shiur.audioUrl) return;
    const epId = `${YTC_EPISODE_PREFIX}${shiur.id}`;
    if (isAlreadyDownloaded) {
      Alert.alert(
        "Remove download?",
        shiur.title,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: () => { removeDownload(epId); } },
        ],
      );
      return;
    }
    if (isCurrentlyDownloading) return;
    const { episode, feed } = ytcShiurToEpisodeAndFeed(shiur);
    trackShiurDownload(shiur.id).catch(() => {});
    downloadEpisode(episode, feed);
  }, [downloadEpisode, removeDownload]);

  const renderShiur = useCallback(({ item }: { item: Shiur }) => {
    const epId = `${YTC_EPISODE_PREFIX}${item.id}`;
    const isActive = currentShiurId === item.id;
    const saved = getPosition(epId);
    return (
      <ShiurCard
        item={item}
        isActive={isActive}
        isPlaying={isActive ? isPlaying : false}
        audioLoading={isActive ? audioLoading : false}
        savedPosition={saved}
        isSaved={isSaved(item.id)}
        downloaded={isDownloaded(epId)}
        downloading={isDownloading(epId)}
        downloadPct={isDownloading(epId) ? (downloadProgress.get(epId) || 0) : 0}
        onPlay={onPlayPress}
        onSave={onSavePress}
        onDownload={onDownloadPressFor}
        onTagPress={onTagPress}
        formatDate={formatDate}
      />
    );
  }, [currentShiurId, isPlaying, audioLoading, getPosition, isSaved, isDownloaded, isDownloading, downloadProgress, onPlayPress, onSavePress, onDownloadPressFor, onTagPress, formatDate]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Shiurim</Text>
        <Text style={styles.headerSubtitle}>Browse and listen to Torah shiurim from our Rebbeim</Text>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={Colors.navyOpacity50} style={{ marginRight: 8 }} />
          <TextInput style={styles.searchInput} placeholder="Search shiurim..." placeholderTextColor={Colors.navyOpacity50} value={search} onChangeText={setSearch} />
          {search ? <TouchableOpacity onPress={() => setSearch("")}><Ionicons name="close-circle" size={18} color={Colors.navyOpacity50} /></TouchableOpacity> : null}
        </View>
        <YtcFocusable style={[styles.filterBtn, hasFilters && styles.filterBtnActive]} onPress={() => setShowFilters(true)} focusRadius={10}>
          <Ionicons name="options" size={20} color={hasFilters ? Colors.cream : Colors.navy} />
        </YtcFocusable>
      </View>

      <View style={styles.quickFilters}>
        <YtcFocusable
          style={[styles.quickChip, showSavedOnly && styles.quickChipActive]}
          onPress={() => setShowSavedOnly((v) => !v)}
          focusRadius={16}
        >
          <Ionicons name={showSavedOnly ? "bookmark" : "bookmark-outline"} size={14} color={showSavedOnly ? Colors.cream : Colors.navy} />
          <Text style={[styles.quickChipText, showSavedOnly && styles.quickChipTextActive]}>Saved</Text>
        </YtcFocusable>
        <YtcFocusable
          style={[styles.quickChip, showInProgressOnly && styles.quickChipActive]}
          onPress={() => setShowInProgressOnly((v) => !v)}
          focusRadius={16}
        >
          <Ionicons name={showInProgressOnly ? "time" : "time-outline"} size={14} color={showInProgressOnly ? Colors.cream : Colors.navy} />
          <Text style={[styles.quickChipText, showInProgressOnly && styles.quickChipTextActive]}>In progress</Text>
        </YtcFocusable>
      </View>

      {(selectedRebbeim.size > 0 || selectedTags.size > 0 || selectedSeries.size > 0) && (
        <View style={styles.activeFilters}>
          {Array.from(selectedRebbeim).map((r) => (
            <TouchableOpacity key={`r-${r}`} style={styles.filterChip} onPress={() => toggleInSet(setSelectedRebbeim, r)}>
              <Text style={styles.filterChipText}>{r} ✕</Text>
            </TouchableOpacity>
          ))}
          {Array.from(selectedTags).map((t) => (
            <TouchableOpacity key={`t-${t}`} style={styles.filterChip} onPress={() => toggleInSet(setSelectedTags, t)}>
              <Text style={styles.filterChipText}>{t} ✕</Text>
            </TouchableOpacity>
          ))}
          {Array.from(selectedSeries).map((s) => (
            <TouchableOpacity key={`s-${s}`} style={styles.filterChip} onPress={() => toggleInSet(setSelectedSeries, s)}>
              <Text style={styles.filterChipText}>{s} ✕</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {!isLoading && <Text style={styles.countText}>{filtered.length} shiur{filtered.length !== 1 ? "im" : ""}</Text>}

      {isLoading ? (
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      ) : (
        <FlatList
          // Pagination: render only the first `visibleCount` (default
          // 20) and grow on scroll-to-bottom. Mirrors the website's
          // /shiurim infinite-scroll behavior — the user sees a
          // ready-to-scroll first page instantly even with 800+
          // shiurim in the underlying dataset.
          data={visibleShiurim}
          keyExtractor={(item) => item.id}
          renderItem={renderShiur}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}
          ListEmptyComponent={<View style={styles.empty}><Ionicons name="musical-notes" size={40} color={Colors.navyOpacity30} /><Text style={styles.emptyText}>No shiurim found</Text></View>}
          // Perf tuning kept from the previous pass — initialNumToRender
          // of 8 matches the first viewport; the rest of the 20-item
          // page renders during idle frames.
          removeClippedSubviews={Platform.OS !== "web"}
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={7}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (hasMoreShiurim) setVisibleCount((c) => c + PAGE_SIZE);
          }}
          ListFooterComponent={hasMoreShiurim ? (
            <View style={styles.loadMoreFooter}>
              <ActivityIndicator size="small" color={Colors.navy} />
              <Text style={styles.loadMoreText}>Loading more…</Text>
            </View>
          ) : null}
        />
      )}

      <Modal visible={showFilters} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filters & Sort</Text>
            <TouchableOpacity onPress={() => setShowFilters(false)}><Ionicons name="close" size={24} color={Colors.navy} /></TouchableOpacity>
          </View>
          {/* Accordion: each category collapses to a header row that
               shows a count badge + chevron. Tapping the header expands
               that section and collapses any other open section so the
               modal stays scannable on a small screen. Multi-select
               within each list — all "All ..." reset rows are gone in
               favor of the active-chips trail in the toolbar above. */}
          <ScrollView style={styles.modalBody}>
            <FilterSection
              label="Sort By"
              count={sortOrder === "dateDesc" ? 0 : 1}
              isOpen={openFilterSection === "sort"}
              onToggle={() => setOpenFilterSection(openFilterSection === "sort" ? null : "sort")}
            >
              {([["dateDesc", "Newest First"], ["dateAsc", "Oldest First"], ["titleAZ", "Title A–Z"], ["rebbeAZ", "Rebbe A–Z"]] as [SortOrder, string][]).map(([value, label]) => (
                <TouchableOpacity key={value} style={styles.filterOption} onPress={() => setSortOrder(value)}>
                  <Text style={styles.filterOptionText}>{label}</Text>
                  {sortOrder === value && <Ionicons name="checkmark" size={18} color={Colors.gold} />}
                </TouchableOpacity>
              ))}
            </FilterSection>

            {allRebbeim.length > 0 && (
              <FilterSection
                label={`Filter by Rebbe`}
                count={selectedRebbeim.size}
                isOpen={openFilterSection === "rebbe"}
                onToggle={() => setOpenFilterSection(openFilterSection === "rebbe" ? null : "rebbe")}
              >
                {allRebbeim.map((r) => {
                  const checked = selectedRebbeim.has(r);
                  return (
                    <TouchableOpacity key={r} style={styles.filterOption} onPress={() => toggleInSet(setSelectedRebbeim, r)}>
                      <Text style={styles.filterOptionText}>{r}</Text>
                      <Ionicons
                        name={checked ? "checkbox" : "square-outline"}
                        size={20}
                        color={checked ? Colors.gold : Colors.navyOpacity50}
                      />
                    </TouchableOpacity>
                  );
                })}
              </FilterSection>
            )}

            {allTags.length > 0 && (
              <FilterSection
                label="Filter by Topic"
                count={selectedTags.size}
                isOpen={openFilterSection === "topic"}
                onToggle={() => setOpenFilterSection(openFilterSection === "topic" ? null : "topic")}
              >
                <View style={styles.tagsGrid}>
                  {allTags.map((tag) => {
                    const checked = selectedTags.has(tag);
                    return (
                      <TouchableOpacity key={tag} style={[styles.tagChip, checked && styles.tagChipActive]} onPress={() => toggleInSet(setSelectedTags, tag)}>
                        <Text style={[styles.tagChipText, checked && styles.tagChipTextActive]}>{tag}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </FilterSection>
            )}

            {allSeries.length > 0 && (
              <FilterSection
                label="Filter by Series"
                count={selectedSeries.size}
                isOpen={openFilterSection === "series"}
                onToggle={() => setOpenFilterSection(openFilterSection === "series" ? null : "series")}
              >
                {allSeries.map((s) => {
                  const checked = selectedSeries.has(s);
                  return (
                    <TouchableOpacity key={s} style={styles.filterOption} onPress={() => toggleInSet(setSelectedSeries, s)}>
                      <Text style={styles.filterOptionText}>{s}</Text>
                      <Ionicons
                        name={checked ? "checkbox" : "square-outline"}
                        size={20}
                        color={checked ? Colors.gold : Colors.navyOpacity50}
                      />
                    </TouchableOpacity>
                  );
                })}
              </FilterSection>
            )}
          </ScrollView>
          <View style={styles.modalFooter}>
            <TouchableOpacity style={styles.clearBtn} onPress={() => { setSelectedRebbeim(new Set()); setSelectedTags(new Set()); setSelectedSeries(new Set()); setShowSavedOnly(false); setShowInProgressOnly(false); setSortOrder("dateDesc"); }}>
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

// Accordion section header for the Filters modal. Shows the section
// label, an active-count badge if any picks are made, and a chevron
// that rotates with the open/closed state. Children render only when
// open — keeps the modal short and the user oriented.
function FilterSection({ label, count, isOpen, onToggle, children }: {
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.accordion}>
      <TouchableOpacity style={styles.accordionHeader} onPress={onToggle} activeOpacity={0.7}>
        <Text style={styles.accordionTitle}>{label}</Text>
        {count > 0 && (
          <View style={styles.accordionBadge}>
            <Text style={styles.accordionBadgeText}>{count}</Text>
          </View>
        )}
        <Ionicons
          name={isOpen ? "chevron-up" : "chevron-down"}
          size={18}
          color={Colors.navyOpacity50}
        />
      </TouchableOpacity>
      {isOpen && <View>{children}</View>}
    </View>
  );
}

// Memoized card — re-renders only when its own props change.
// Crucial for the 800+ shiurim list performance: when a position
// updates for one playing shiur, only that one card re-renders;
// all other cards skip via React.memo's shallow comparison on the
// (primitive) props.
interface ShiurCardProps {
  item: Shiur;
  isActive: boolean;
  isPlaying: boolean;
  audioLoading: boolean;
  savedPosition: { positionMs: number; durationMs: number } | null;
  isSaved: boolean;
  downloaded: boolean;
  downloading: boolean;
  downloadPct: number;
  onPlay: (s: Shiur, isCurrentlyActive: boolean) => void;
  onSave: (id: string) => void;
  onDownload: (s: Shiur, isAlreadyDownloaded: boolean, isCurrentlyDownloading: boolean) => void;
  onTagPress: (tag: string) => void;
  formatDate: (dateStr: string) => string;
}

const ShiurCard = React.memo(function ShiurCardImpl(p: ShiurCardProps) {
  const { item, isActive, isPlaying, audioLoading, savedPosition, isSaved, downloaded, downloading, downloadPct, onPlay, onSave, onDownload, onTagPress, formatDate } = p;
  const hasProgress = !!savedPosition && savedPosition.durationMs > 0 && savedPosition.positionMs > 0;
  const pct = hasProgress ? Math.min(Math.round((savedPosition!.positionMs / savedPosition!.durationMs) * 100), 100) : 0;
  const completed = hasProgress && pct >= 95;
  return (
    <View style={[styles.shiurCard, isActive && styles.shiurCardActive]}>
      <View style={styles.shiurAccent} />
      <View style={styles.shiurBody}>
        <View style={styles.shiurTopRow}>
          <Ionicons name="headset-outline" size={20} color={Colors.gold} style={{ marginTop: 1 }} />
          <Text style={styles.shiurTitle} numberOfLines={3}>{item.title}</Text>
          <YtcFocusable onPress={() => onSave(item.id)} hitSlop={8} style={styles.iconBtn} focusRadius={14}>
            <Ionicons name={isSaved ? "bookmark" : "bookmark-outline"} size={20} color={isSaved ? Colors.gold : Colors.navyOpacity50} />
          </YtcFocusable>
        </View>

        {item.rebbe ? <Text style={styles.shiurRebbe}>by {item.rebbe}</Text> : null}

        <View style={styles.shiurMetaRow}>
          <Ionicons name="time-outline" size={13} color={Colors.navyOpacity50} />
          <Text style={styles.shiurMetaText}>{formatDate(item.date)}</Text>
          {downloading ? (
            <Text style={[styles.shiurMetaText, { color: Colors.gold }]}>· Downloading {Math.round(downloadPct * 100)}%</Text>
          ) : completed ? (
            <Text style={[styles.shiurMetaText, { color: Colors.gold }]}>· Completed</Text>
          ) : hasProgress ? (
            <Text style={[styles.shiurMetaText, { color: Colors.gold }]}>· Paused at {formatRemainingMin(savedPosition!.positionMs, savedPosition!.durationMs)}</Text>
          ) : null}
        </View>

        {item.series ? (
          <View style={[styles.tag, { alignSelf: "flex-start", marginTop: 8 }]}>
            <Ionicons name="folder-outline" size={11} color={Colors.navyOpacity70} style={{ marginRight: 4 }} />
            <Text style={styles.tagText}>{item.series}</Text>
          </View>
        ) : null}

        {item.tags.length > 0 && (
          <View style={styles.tagsRow}>
            {item.tags.slice(0, 4).map((tag) => (
              <TouchableOpacity key={tag} style={styles.tag} onPress={() => onTagPress(tag)}>
                <Text style={styles.tagText}>{tag}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {item.description ? (
          <Text style={styles.shiurDescription} numberOfLines={3}>{item.description}</Text>
        ) : null}

        {item.audioUrl && (
          <View style={styles.shiurActionsRow}>
            <YtcFocusable
              style={styles.playButton}
              onPress={() => onPlay(item, isActive)}
              focusRadius={10}
            >
              {isActive && audioLoading
                ? <ActivityIndicator size="small" color={Colors.cream} />
                : (
                  <>
                    <Ionicons name={isActive && isPlaying ? "pause" : "play"} size={16} color={Colors.cream} />
                    <Text style={styles.playButtonText}>{isActive && isPlaying ? "Pause" : "Play"}</Text>
                  </>
                )}
            </YtcFocusable>
            <YtcFocusable onPress={() => onDownload(item, downloaded, downloading)} hitSlop={4} style={styles.downloadIconBtn} focusRadius={10}>
              {downloading
                ? <ActivityIndicator size="small" color={Colors.navy} />
                : downloaded
                ? <Ionicons name="trash-outline" size={20} color={Colors.error} />
                : <Ionicons name="download-outline" size={22} color={Colors.navy} />}
            </YtcFocusable>
          </View>
        )}
      </View>
      {hasProgress && !completed && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>
      )}
    </View>
  );
});

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
  quickFilters: { flexDirection: "row", paddingHorizontal: 12, paddingTop: 6, paddingBottom: 4, gap: 8, backgroundColor: Colors.white },
  quickChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
    backgroundColor: Colors.creamDark,
  },
  quickChipActive: { backgroundColor: Colors.navy },
  quickChipText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  quickChipTextActive: { color: Colors.cream },
  activeFilters: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 12, paddingVertical: 6, gap: 8, backgroundColor: Colors.white },
  filterChip: { backgroundColor: Colors.goldOpacity15, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 },
  filterChipText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  countText: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 2, fontSize: 12, color: Colors.navyOpacity50 },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  listContent: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 120 },
  empty: { alignItems: "center", padding: 40, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.navyOpacity50 },
  shiurCard: {
    backgroundColor: Colors.white, borderRadius: 12, marginBottom: 10,
    overflow: "hidden",
    borderWidth: 1, borderColor: Colors.goldOpacity30,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 3, elevation: 1,
  },
  shiurCardActive: { borderColor: Colors.gold },
  // Top accent line (4px gold) — matches the website's h-1 gradient.
  shiurAccent: { height: 4, width: "100%", backgroundColor: Colors.gold },
  shiurBody: { padding: 14 },
  shiurTopRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  shiurTitle: {
    flex: 1, fontSize: 16, fontWeight: "700", color: Colors.navy, lineHeight: 22,
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  iconBtn: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  shiurRebbe: {
    fontSize: 13, color: Colors.gold, fontWeight: "600", marginTop: 4, marginLeft: 30,
    fontStyle: "italic",
  },
  shiurMetaRow: {
    flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6, marginLeft: 30,
  },
  shiurMetaText: { fontSize: 12, color: Colors.navyOpacity70 },
  tagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tag: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.navyOpacity05,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6,
  },
  tagText: { fontSize: 11, color: Colors.navy, fontWeight: "500" },
  shiurDescription: { fontSize: 13, color: Colors.navyOpacity70, lineHeight: 19, marginTop: 8 },
  shiurActionsRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  playButton: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: Colors.navy, paddingVertical: 12, borderRadius: 8,
  },
  playButtonText: { color: Colors.cream, fontSize: 14, fontWeight: "600" },
  downloadIconBtn: {
    width: 44, height: 44, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: Colors.goldOpacity30, borderRadius: 8,
  },
  progressTrack: { height: 3, backgroundColor: Colors.creamDark },
  progressFill: { height: 3, backgroundColor: Colors.gold },
  progressText: { fontSize: 11, color: Colors.gold, marginTop: 2, fontWeight: "500" },
  completedText: { fontSize: 11, color: Colors.navyOpacity50, marginTop: 2, fontWeight: "500" },
  modalSafe: { flex: 1, backgroundColor: Colors.cream },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.creamDark, backgroundColor: Colors.white },
  modalTitle: { fontSize: 18, fontWeight: "600", color: Colors.navy },
  modalBody: { flex: 1 },
  // Accordion: each section is a card-like container with a header row
  // that toggles the body's visibility. Top border on the first row
  // gives a clean stack appearance.
  accordion: { backgroundColor: Colors.white, borderTopWidth: 1, borderTopColor: Colors.creamDark },
  accordionHeader: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  accordionTitle: {
    flex: 1, fontSize: 14, fontWeight: "600", color: Colors.navyOpacity70,
    textTransform: "uppercase", letterSpacing: 0.6,
  },
  accordionBadge: {
    minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6,
    backgroundColor: Colors.gold, alignItems: "center", justifyContent: "center",
  },
  accordionBadgeText: { fontSize: 11, color: Colors.navy, fontWeight: "700" },
  filterOption: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.creamDark },
  filterOptionText: { fontSize: 15, color: Colors.navy },
  loadMoreFooter: { flexDirection: "row", alignItems: "center", justifyContent: "center", padding: 16, gap: 8 },
  loadMoreText: { fontSize: 13, color: Colors.navyOpacity70 },
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
