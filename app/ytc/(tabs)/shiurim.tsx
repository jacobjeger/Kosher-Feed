// YTC: shiurim list with search/filter/sort. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/shiurim.tsx with imports remapped
// and useAudio() → useYtcPlayer() (richer audio adapter hook).
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, ScrollView, Platform, RefreshControl, Alert,
  StatusBar,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { fetchShiurim, fetchShiurimFirstPage, fetchNewShiurimSince, invalidateYtcCache, peekYtcCacheMem } from "@/lib/ytc/firebase";
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

// Sort labels mirror the Swift app verbatim.
const SORT_LABELS: Record<SortOrder, string> = {
  dateDesc: "Newest First",
  dateAsc: "Oldest First",
  titleAZ: "Title A–Z",
  rebbeAZ: "Rebbe A–Z",
};
const SORT_ORDER_CYCLE: SortOrder[] = ["dateDesc", "dateAsc", "titleAZ", "rebbeAZ"];

export default function ShiurimScreen() {
  const insets = useSafeAreaInsets();
  const { currentShiurId, isPlaying, isLoading: audioLoading, play, pauseResume } = useYtcPlayer();
  const { getPosition } = usePositions();
  const { downloadEpisode, removeDownload, isDownloaded, isDownloading, downloadProgress } = useDownloads();
  const { isSaved, toggleSaved } = useSavedShiurim();

  // Seed from the in-memory cache so a focus after the YTC pre-warm
  // (YtcAuthContext) paints with data on the very first render — no
  // spinner flash on the Megalife's slower JS thread.
  const cachedInitial = useMemo(() => peekYtcCacheMem<Shiur[]>("shiurim") ?? [], []);
  const [shiurim, setShiurim] = useState<Shiur[]>(cachedInitial);
  const [isLoading, setIsLoading] = useState(cachedInitial.length === 0);
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
  const [showDownloadedOnly, setShowDownloadedOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // Which filter accordion is expanded inside the Filters modal. Only
  // one open at a time so the modal stays scannable.
  const [openFilterSection, setOpenFilterSection] = useState<"sort" | "rebbe" | "topic" | "series" | null>("sort");
  // Visible shiur count — paginated 20-at-a-time as the user scrolls.
  // Reset whenever the filter inputs change so a new query renders fast.
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Was a single fetchShiurim() that blocked first paint on a 300-800ms
  // JSON.parse of the full 800-doc cache. Now: read the small "first
  // page" mirror cache first (~20-50ms parse) and render immediately,
  // then fill in the rest from the full cache once the JS thread idles.
  // Result: Shiurim tab feels instant even on the Schok F1.
  const loadShiurim = async () => {
    let unlockedPaint = false;
    try {
      // Fast path: render the first 50 from the mirror cache. Fail
      // silently if it's not warm yet (truly cold install) — the full
      // fetch below will paint instead.
      try {
        const first = await fetchShiurimFirstPage();
        if (first.length > 0) {
          setShiurim(first);
          setIsLoading(false);
          unlockedPaint = true;
        }
      } catch {}

      // Background path: full list. Without unlockedPaint, this is the
      // first paint (cold install) and will block normally. With it, the
      // user already sees their 50 most-recent and this just merges in
      // the rest a few hundred ms later.
      const data = await fetchShiurim();
      setShiurim(data as Shiur[]);
    } catch (e) {
      console.error("YTC Shiurim load error:", e);
    } finally {
      if (!unlockedPaint) setIsLoading(false);
      setRefreshing(false);
    }
  };

  // On every focus: if we have nothing cached, do a full fetch. If we do,
  // ask Firestore only for shiurim newer than what we have and merge them
  // in. Avoids re-downloading the full ~800-doc list every time the user
  // taps Shiurim — the Megalife's slow eMMC + JSON.parse make that very
  // visible.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      if (shiurim.length === 0) {
        // Cold cache for this session — full fetch via SWR cache.
        await loadShiurim();
        return;
      }
      const maxDate = shiurim.reduce((m, s) => (s.date > m ? s.date : m), "");
      if (!maxDate) return;
      try {
        const res = await fetchNewShiurimSince(maxDate);
        if (cancelled || !res || res.added === 0) return;
        setShiurim(res.merged as Shiur[]);
      } catch (e) {
        console.warn("YTC incremental shiurim refresh failed:", e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

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

  // Pre-computed lowercase index — built once per shiurim change so the
  // search filter doesn't do 4 * 800 = ~3200 toLowerCase() allocations
  // per keystroke. On the Megalife's slow JS thread that was the typing
  // lag people felt in the search field.
  const searchIndex = useMemo(() => {
    const m = new Map<string, { titleLower: string; rebbeLower: string; tagsLower: string[]; seriesLower: string }>();
    for (const s of shiurim) {
      m.set(s.id, {
        titleLower: s.title.toLowerCase(),
        rebbeLower: s.rebbe.toLowerCase(),
        tagsLower: s.tags.map((t) => t.toLowerCase()),
        seriesLower: s.series?.toLowerCase() ?? "",
      });
    }
    return m;
  }, [shiurim]);

  // Deferred search keeps the TextInput itself responsive — React lets
  // typing land at high priority and re-runs the filter at idle. On a
  // fast device this is invisible; on the Megalife it's the difference
  // between smooth typing and visible per-keystroke lag.
  const deferredSearch = useDeferredValue(search);

  const filtered = useMemo(() => {
    let result: typeof shiurim = shiurim;
    if (deferredSearch) {
      const q = deferredSearch.toLowerCase();
      result = result.filter((s) => {
        const idx = searchIndex.get(s.id);
        if (!idx) return false;
        return (
          idx.titleLower.includes(q) ||
          idx.rebbeLower.includes(q) ||
          idx.tagsLower.some((t) => t.includes(q)) ||
          idx.seriesLower.includes(q)
        );
      });
    }
    // Multi-select: a shiur passes if it matches ANY selected value
    // within a category (OR), and matches ALL active categories (AND).
    if (selectedRebbeim.size > 0) result = result.filter((s) => selectedRebbeim.has(s.rebbe));
    if (selectedTags.size > 0) result = result.filter((s) => s.tags.some((t) => selectedTags.has(t)));
    if (selectedSeries.size > 0) result = result.filter((s) => !!s.series && selectedSeries.has(s.series));
    if (showSavedOnly) result = result.filter((s) => isSaved(s.id));
    if (showDownloadedOnly) {
      result = result.filter((s) => isDownloaded(`${YTC_EPISODE_PREFIX}${s.id}`));
    }
    if (showInProgressOnly) {
      result = result.filter((s) => {
        const pos = getPosition(`${YTC_EPISODE_PREFIX}${s.id}`);
        if (!pos || pos.durationMs <= 0 || pos.positionMs <= 0) return false;
        const pct = pos.positionMs / pos.durationMs;
        return pct > 0 && pct < 0.95;
      });
    }

    // Copy before sort so we don't mutate the upstream `shiurim` array
    // when no filters narrow the result.
    result = result.slice();
    switch (sortOrder) {
      case "dateAsc": result.sort((a, b) => a.date.localeCompare(b.date)); break;
      case "titleAZ": result.sort((a, b) => a.title.localeCompare(b.title)); break;
      case "rebbeAZ": result.sort((a, b) => a.rebbe.localeCompare(b.rebbe)); break;
      default: result.sort((a, b) => b.date.localeCompare(a.date));
    }
    return result;
  // Filter dep list — `showDownloadedOnly` + `isDownloaded` were
  // missing in a previous version, which is why toggling the
  // Downloaded chip didn't actually re-filter. Both must be deps so
  // the useMemo re-runs when the user taps the chip OR when a
  // download finishes (isDownloaded ref changes).
  }, [shiurim, deferredSearch, searchIndex, selectedRebbeim, selectedTags, selectedSeries, showSavedOnly, showInProgressOnly, showDownloadedOnly, isSaved, getPosition, isDownloaded, sortOrder]);

  // Reset pagination whenever the active filter window changes so the
  // first render shows the most relevant top-of-list slice fast.
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, selectedRebbeim, selectedTags, selectedSeries, showSavedOnly, showInProgressOnly, showDownloadedOnly, sortOrder]);

  const visibleShiurim = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMoreShiurim = filtered.length > visibleCount;

  const hasFilters =
    selectedRebbeim.size > 0 || selectedTags.size > 0 || selectedSeries.size > 0 ||
    showSavedOnly || showInProgressOnly || showDownloadedOnly;

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

  // Active-filter count badge for the slider button.
  const advancedFilterCount = selectedRebbeim.size + selectedTags.size + selectedSeries.size;

  // Cycle through the sort orders on tap. Matches the Swift quick-chip
  // behavior — long-press would open a menu but a single tap rotates.
  const cycleSortOrder = useCallback(() => {
    setSortOrder((cur) => {
      const i = SORT_ORDER_CYCLE.indexOf(cur);
      return SORT_ORDER_CYCLE[(i + 1) % SORT_ORDER_CYCLE.length];
    });
  }, []);

  const clearAllQuickFilters = useCallback(() => {
    setSelectedRebbeim(new Set());
    setSelectedTags(new Set());
    setSelectedSeries(new Set());
    setShowSavedOnly(false);
    setShowInProgressOnly(false);
    setShowDownloadedOnly(false);
    setSortOrder("dateDesc");
    setSearch("");
  }, []);

  return (
    // edges={[]} — the navy header bleeds under the status bar so the
    // time / battery / signal area is navy too (matches the screenshot
    // from the Swift app). We pad-by-inset.top inside the header.
    <SafeAreaView style={styles.safe} edges={[]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.navy} />

      {/* Full navy header — title + search + chip scroll row. Bleeds
           under the status bar via paddingTop = insets.top. */}
      <View style={[styles.headerNavy, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Shiurim</Text>

        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={Colors.navyOpacity50} style={{ marginRight: 8 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by title, rebbe, or topic..."
              placeholderTextColor={Colors.navyOpacity50}
              value={search}
              onChangeText={setSearch}
            />
            {search ? <TouchableOpacity onPress={() => setSearch("")}><Ionicons name="close-circle" size={18} color={Colors.navyOpacity50} /></TouchableOpacity> : null}
          </View>
          <YtcFocusable style={styles.filterBtn} onPress={() => setShowFilters(true)} focusRadius={10}>
            <Ionicons name="options" size={20} color={Colors.cream} />
            {advancedFilterCount > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{advancedFilterCount}</Text>
              </View>
            )}
          </YtcFocusable>
        </View>

        {/* Horizontally scrolling chip row — Saved, In Progress, Downloaded,
             Sort cycle, Clear (when any filter active). Outline-style:
             gold border + cream text on transparent navy until active,
             then gold-filled with navy text. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRowContent}
        >
          <QuickChip
            label="Saved"
            iconActive="bookmark"
            iconInactive="bookmark-outline"
            active={showSavedOnly}
            onPress={() => setShowSavedOnly((v) => !v)}
          />
          <QuickChip
            label="In Progress"
            iconActive="time"
            iconInactive="time-outline"
            active={showInProgressOnly}
            onPress={() => setShowInProgressOnly((v) => !v)}
          />
          <QuickChip
            label="Downloaded"
            iconActive="cloud-download"
            iconInactive="cloud-download-outline"
            active={showDownloadedOnly}
            onPress={() => setShowDownloadedOnly((v) => !v)}
          />
          <QuickChip
            label={SORT_LABELS[sortOrder]}
            iconActive="swap-vertical"
            iconInactive="swap-vertical"
            active={sortOrder !== "dateDesc"}
            onPress={cycleSortOrder}
          />
          {(hasFilters || sortOrder !== "dateDesc" || search) && (
            <YtcFocusable style={styles.clearChip} onPress={clearAllQuickFilters} focusRadius={16}>
              <Ionicons name="close" size={12} color={Colors.gold} />
              <Text style={styles.clearChipText}>Clear</Text>
            </YtcFocusable>
          )}
        </ScrollView>

        {/* Active advanced filters (rebbe/topic/series picks from the
             modal). Shown as removable gold pills inside the navy block
             so they read against the dark background. */}
        {(selectedRebbeim.size > 0 || selectedTags.size > 0 || selectedSeries.size > 0) && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.activeFilters}>
            {Array.from(selectedRebbeim).map((r) => (
              <TouchableOpacity key={`r-${r}`} style={styles.activePill} onPress={() => toggleInSet(setSelectedRebbeim, r)}>
                <Text style={styles.activePillText}>{r}</Text>
                <Ionicons name="close" size={11} color={Colors.navy} />
              </TouchableOpacity>
            ))}
            {Array.from(selectedTags).map((t) => (
              <TouchableOpacity key={`t-${t}`} style={styles.activePill} onPress={() => toggleInSet(setSelectedTags, t)}>
                <Text style={styles.activePillText}>{t}</Text>
                <Ionicons name="close" size={11} color={Colors.navy} />
              </TouchableOpacity>
            ))}
            {Array.from(selectedSeries).map((s) => (
              <TouchableOpacity key={`s-${s}`} style={styles.activePill} onPress={() => toggleInSet(setSelectedSeries, s)}>
                <Text style={styles.activePillText}>{s}</Text>
                <Ionicons name="close" size={11} color={Colors.navy} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {/* "X shiurim" count line removed per user feedback —
           the chip row above already gives the user filter context,
           the count was just visual noise above the list. */}

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

// QuickChip — outline-style chip for the navy header's filter row.
// Matches the screenshot: gold border + gold icon/text on transparent
// background until active, then filled gold with navy text.
function QuickChip({ label, iconActive, iconInactive, active, onPress }: {
  label: string;
  iconActive: any;
  iconInactive: any;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <YtcFocusable
      style={[styles.quickChip, active && styles.quickChipActive]}
      onPress={onPress}
      focusRadius={20}
    >
      <Ionicons
        name={active ? iconActive : iconInactive}
        size={13}
        color={active ? Colors.navy : Colors.gold}
      />
      <Text style={[styles.quickChipText, active && styles.quickChipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </YtcFocusable>
  );
}

// Card layout mirrors /tmp/ytc-source/ytcalumni1/Views/Shiurim/ShiurimView.swift
// → ShiurRowView. Avatar circle (44px) on the left with headphones icon,
// serif title + italic gold rebbe + date · series row, horizontal-scroll
// tag chips, optional resume line, full-width navy Play button +
// download button, gold bookmark in the top-right corner.
const ShiurCard = React.memo(function ShiurCardImpl(p: ShiurCardProps) {
  const { item, isActive, isPlaying, audioLoading, savedPosition, isSaved, downloaded, downloading, downloadPct, onPlay, onSave, onDownload, onTagPress, formatDate } = p;
  const hasProgress = !!savedPosition && savedPosition.durationMs > 0 && savedPosition.positionMs > 0;
  const pct = hasProgress ? Math.min(Math.round((savedPosition!.positionMs / savedPosition!.durationMs) * 100), 100) : 0;
  const completed = hasProgress && pct >= 95;
  const playLabel = isActive && isPlaying ? "Pause" : (hasProgress && !completed ? "Resume" : "Play");
  return (
    <View style={[styles.shiurCard, isActive && styles.shiurCardActive]}>
      {/* Top row: avatar + title block + bookmark */}
      <View style={styles.shiurTopRow}>
        <View style={[styles.avatar, isActive && styles.avatarActive]}>
          <Ionicons
            name={isActive && isPlaying ? "musical-notes" : "headset"}
            size={17}
            color={isActive ? Colors.navy : Colors.navyOpacity50}
          />
        </View>
        <View style={styles.shiurInfo}>
          {/* numberOfLines bumped 2 → 3 + lineHeight tightened so
               longer shiur names ("How To Address Tayvah In A Modern
               Era For The Yungerman" etc) wrap fully instead of
               getting cut off with an ellipsis. */}
          <Text style={styles.shiurTitle} numberOfLines={3}>{item.title}</Text>
          {item.rebbe ? <Text style={styles.shiurRebbe}>{item.rebbe}</Text> : null}
          <View style={styles.shiurDateRow}>
            <Text style={styles.shiurDate}>{formatDate(item.date)}</Text>
            {item.series ? (
              <>
                <Text style={styles.shiurDot}>·</Text>
                <Text style={styles.shiurSeries} numberOfLines={1}>{item.series}</Text>
              </>
            ) : null}
          </View>
        </View>
        <YtcFocusable onPress={() => onSave(item.id)} hitSlop={8} style={styles.bookmarkBtn} focusRadius={14}>
          <Ionicons name={isSaved ? "bookmark" : "bookmark-outline"} size={17} color={isSaved ? Colors.gold : Colors.navyOpacity30} />
        </YtcFocusable>
      </View>

      {/* Tags row — horizontal scroll, small navy/opacity chips */}
      {item.tags.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tagsScroll} contentContainerStyle={styles.tagsScrollContent}>
          {item.tags.map((tag) => (
            <TouchableOpacity key={tag} style={styles.tag} onPress={() => onTagPress(tag)}>
              <Text style={styles.tagText}>{tag}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Resume / Completed / Downloading status line */}
      {downloading ? (
        <View style={styles.statusLine}>
          <Ionicons name="cloud-download-outline" size={12} color={Colors.gold} />
          <Text style={styles.statusText}>Downloading {Math.round(downloadPct * 100)}%</Text>
        </View>
      ) : completed ? (
        <View style={styles.statusLine}>
          <Ionicons name="checkmark-circle-outline" size={12} color={Colors.navyOpacity50} />
          <Text style={[styles.statusText, { color: Colors.navyOpacity50 }]}>Completed</Text>
        </View>
      ) : hasProgress && !isActive ? (
        <View style={styles.statusLine}>
          <Ionicons name="time-outline" size={12} color={Colors.gold} />
          <Text style={styles.statusText}>Resume from {formatRemainingMin(savedPosition!.positionMs, savedPosition!.durationMs)}</Text>
        </View>
      ) : null}

      {/* Action row: full-width Play / Resume / Pause + download icon */}
      {item.audioUrl && (
        <View style={styles.shiurActionsRow}>
          <YtcFocusable
            style={[styles.playButton, isActive && styles.playButtonActive]}
            onPress={() => onPlay(item, isActive)}
            focusRadius={10}
          >
            {isActive && audioLoading
              ? <ActivityIndicator size="small" color={isActive ? Colors.navy : Colors.cream} />
              : (
                <>
                  <Ionicons
                    name={isActive && isPlaying ? "pause" : "play"}
                    size={14}
                    color={isActive ? Colors.navy : Colors.cream}
                  />
                  <Text style={[styles.playButtonText, isActive && styles.playButtonTextActive]}>{playLabel}</Text>
                </>
              )}
          </YtcFocusable>
          <YtcFocusable onPress={() => onDownload(item, downloaded, downloading)} hitSlop={4} style={styles.downloadIconBtn} focusRadius={10}>
            {downloading
              ? <ActivityIndicator size="small" color={Colors.navy} />
              : downloaded
              ? <Ionicons name="trash-outline" size={18} color={Colors.error} />
              : <Ionicons name="download-outline" size={20} color={Colors.navy} />}
          </YtcFocusable>
        </View>
      )}

      {/* Slim progress track at the very bottom of the card while a
           shiur has unfinished playback. Removed when active/playing
           since the card chrome already shows that state. */}
      {hasProgress && !completed && !isActive && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },

  // Full navy header — bleeds under the status bar (paddingTop applied
  // inline from useSafeAreaInsets). Mirrors the Swift app's ShiurimView
  // header block (verified against
  // /tmp/ytc-source/ytcalumni1/Views/Shiurim/ShiurimView.swift).
  headerNavy: {
    backgroundColor: Colors.navy,
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  headerTitle: {
    // Centered serif title — matches the home page hero treatment
    // and the user's "header text by shiurim should be centered"
    // ask. Width:100% so textAlign:center actually centers within
    // the navy header instead of just centering the rendered glyph
    // box.
    color: Colors.cream, fontSize: 24, fontWeight: "800",
    textAlign: "center",
    width: "100%",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },

  searchRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  searchBox: {
    flex: 1, flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.white, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.navy, paddingVertical: 0 },
  filterBtn: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: "rgba(250, 248, 243, 0.15)",
    alignItems: "center", justifyContent: "center",
  },
  filterBadge: {
    position: "absolute", top: -4, right: -4,
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: Colors.gold,
    alignItems: "center", justifyContent: "center",
  },
  filterBadgeText: { fontSize: 10, fontWeight: "700", color: Colors.navy },

  // Outline-style chip — gold border on transparent navy until tapped,
  // then filled gold with navy text. Matches the screenshot from the
  // Swift original.
  chipRowContent: { flexDirection: "row", gap: 8, alignItems: "center", paddingRight: 16 },
  quickChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
    borderWidth: 1, borderColor: Colors.gold,
    backgroundColor: "transparent",
  },
  quickChipActive: { backgroundColor: Colors.gold },
  quickChipText: { fontSize: 12, color: Colors.gold, fontWeight: "600" },
  quickChipTextActive: { color: Colors.navy },
  clearChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  clearChipText: { fontSize: 12, color: Colors.gold, fontWeight: "600" },

  // Active filter pills (rebbe / topic / series picks from the modal)
  // — gold-tinted and removable. Sit just below the chip row inside
  // the navy header.
  activeFilters: { flexDirection: "row", gap: 6, paddingRight: 16 },
  activePill: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
    backgroundColor: "rgba(212, 175, 55, 0.3)",
  },
  activePillText: { fontSize: 11, color: Colors.navy, fontWeight: "600" },

  countText: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2, fontSize: 12, color: Colors.navyOpacity50 },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 120 },
  empty: { alignItems: "center", padding: 40, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.navyOpacity50 },

  // Card — matches Swift ShiurRowView (16px radius, soft shadow).
  // Text scaled down a step across the card per user feedback —
  // shiurim list reads as a more compact list now, fits ~5 cards on
  // a typical viewport instead of ~3.5.
  shiurCard: {
    backgroundColor: Colors.white, borderRadius: 16, marginBottom: 10,
    padding: 14, gap: 10,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  shiurCardActive: { borderWidth: 1, borderColor: Colors.gold },

  // Top row — avatar circle + title/rebbe/date stack + bookmark.
  shiurTopRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  avatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: Colors.navyOpacity10,
    alignItems: "center", justifyContent: "center",
  },
  avatarActive: { backgroundColor: Colors.gold },
  shiurInfo: { flex: 1, gap: 3 },
  shiurTitle: {
    fontSize: 14, fontWeight: "700", color: Colors.navy, lineHeight: 18,
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  shiurRebbe: {
    fontSize: 11, color: Colors.gold, fontWeight: "600",
  },
  shiurDateRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
  shiurDate: { fontSize: 10, color: Colors.navyOpacity50 },
  shiurDot: { fontSize: 10, color: Colors.navyOpacity30 },
  shiurSeries: { flex: 1, fontSize: 10, color: Colors.gold, fontWeight: "500" },
  bookmarkBtn: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },

  // Tag chips — horizontal scroll matches the Swift design exactly.
  tagsScroll: { marginHorizontal: -14 },
  tagsScrollContent: { paddingHorizontal: 14, gap: 5 },
  tag: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.navyOpacity05,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
  },
  tagText: { fontSize: 10, color: Colors.navyOpacity70, fontWeight: "500" },

  // Resume / Completed / Downloading status line.
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusText: { fontSize: 10, color: Colors.gold, fontWeight: "500" },

  // Action row.
  shiurActionsRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  playButton: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: Colors.navy, paddingVertical: 9, borderRadius: 10,
  },
  playButtonActive: { backgroundColor: Colors.gold },
  playButtonText: { color: Colors.cream, fontSize: 12, fontWeight: "600" },
  playButtonTextActive: { color: Colors.navy },
  downloadIconBtn: {
    width: 38, height: 38, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: Colors.goldOpacity30, borderRadius: 10,
  },
  progressTrack: { height: 3, backgroundColor: Colors.creamDark, borderRadius: 1.5, marginHorizontal: -16, marginBottom: -16 },
  progressFill: { height: 3, backgroundColor: Colors.gold, borderRadius: 1.5 },
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
