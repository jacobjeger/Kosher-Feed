// YTC: events list. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/events.tsx with imports remapped.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, Platform, RefreshControl, TouchableOpacity, Modal, Pressable, Dimensions, StatusBar } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { fetchEvents, invalidateYtcCache } from "@/lib/ytc/firebase";
import { useYtcAuth } from "@/contexts/YtcAuthContext";
import { SubmitSimchaForm } from "@/components/ytc/SubmitSimchaForm";
import { YtcFocusable } from "@/components/ytc/YtcFocusable";
import type { YtcEvent } from "@/types/ytc";

const { width: SCREEN_W } = Dimensions.get("window");
const PAST_GRID_GUTTER = 8;
const PAST_GRID_PADDING = 16;
const PAST_GRID_COL_WIDTH = (SCREEN_W - PAST_GRID_PADDING * 2 - PAST_GRID_GUTTER) / 2;
const PAST_GRID_CAP = 8;

export default function EventsScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useYtcAuth();
  const [events, setEvents] = useState<YtcEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  const loadEvents = async () => {
    try {
      const data = await fetchEvents();
      setEvents(data as YtcEvent[]);
    } catch (e) {
      console.error("YTC Events load error:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadEvents(); }, []);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await invalidateYtcCache("events");
    loadEvents();
  }, []);

  const today = new Date().toISOString().split("T")[0];
  const upcoming = useMemo(() => events.filter((e) => e.date >= today), [events, today]);
  const past = useMemo(() => events.filter((e) => e.date < today).reverse(), [events, today]);

  const renderUpcomingEvent = (event: YtcEvent) => {
    const d = new Date(event.date + "T00:00:00");
    const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
    const day = String(d.getDate());
    return (
      <View key={event.id} style={styles.eventCard}>
        <View style={styles.dateBadge}>
          <Text style={styles.dateMonth}>{month}</Text>
          <Text style={styles.dateDay}>{day}</Text>
        </View>
        <View style={styles.eventBody}>
          <Text style={styles.eventName}>{event.eventName}</Text>
          <Text style={styles.eventFamily}>{event.personFamily}</Text>
          {/* Location/time row — emojis dropped per user feedback.
               The label color + spacing carries enough hierarchy. */}
          <View style={styles.eventMeta}>
            {event.location ? <Text style={styles.metaText}>{event.location}</Text> : null}
            {event.time ? <Text style={styles.metaText}>{event.time}</Text> : null}
          </View>
          {event.type && <View style={styles.typeBadge}><Text style={styles.typeBadgeText}>{event.type}</Text></View>}
          {event.description && <Text style={styles.eventDesc}>{event.description}</Text>}
          {event.imageUrl && (
            <YtcFocusable
              style={styles.eventImageWrap}
              onPress={() => setZoomImage(event.imageUrl!)}
              focusRadius={10}
            >
              <Image
                source={{ uri: event.imageUrl }}
                style={styles.eventImage}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={event.id}
                transition={150}
              />
              <View style={styles.eventImageExpandBadge}>
                <Ionicons name="expand" size={14} color={Colors.cream} />
              </View>
            </YtcFocusable>
          )}
        </View>
      </View>
    );
  };

  // Past simchos: compact list-style chips matching the website's
  // /events Past section (no images, just date pill + name + family).
  // The website uses a simple grid of cards with a JAN/24 navy date
  // badge on the left and event details on the right — drop image
  // entirely.
  const renderPastTile = ({ item: event }: { item: YtcEvent }) => {
    const d = new Date(event.date + "T00:00:00");
    const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
    const day = String(d.getDate());
    return (
      <View style={styles.pastChip}>
        <View style={styles.pastChipBadge}>
          <Text style={styles.pastChipMonth}>{month}</Text>
          <Text style={styles.pastChipDay}>{day}</Text>
        </View>
        <View style={styles.pastChipBody}>
          <Text style={styles.pastChipName} numberOfLines={1}>{event.eventName}</Text>
          <Text style={styles.pastChipFamily} numberOfLines={1}>{event.personFamily}</Text>
        </View>
      </View>
    );
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={[]}>
        <StatusBar barStyle="light-content" backgroundColor={Colors.navy} />
        <View style={[styles.header, { paddingTop: insets.top + 18 }]}>
          <Text style={styles.headerTitle}>Yeshiva Simchos</Text>
        </View>
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      </SafeAreaView>
    );
  }

  return (
    // edges={[]} — header bleeds into the status bar so the time area
    // is navy (matches the Swift screenshot).
    <SafeAreaView style={styles.safe} edges={[]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.navy} />
      {/* Fullscreen image viewer — tap backdrop to dismiss. */}
      <Modal visible={!!zoomImage} transparent animationType="fade" onRequestClose={() => setZoomImage(null)}>
        <Pressable style={styles.zoomBackdrop} onPress={() => setZoomImage(null)}>
          {zoomImage && (
            <Image
              source={{ uri: zoomImage }}
              style={styles.zoomImage}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={150}
            />
          )}
          <Pressable style={styles.zoomCloseBtn} onPress={() => setZoomImage(null)} hitSlop={12}>
            <Ionicons name="close" size={22} color={Colors.cream} />
          </Pressable>
        </Pressable>
      </Modal>

      <FlatList
        data={[]}
        keyExtractor={() => ""}
        renderItem={null}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}
        ListHeaderComponent={
          <>
            <View style={[styles.header, { paddingTop: insets.top + 18 }]}>
              <Text style={styles.headerTitle}>Yeshiva Simchos</Text>
            </View>
            <View style={styles.body}>
              {upcoming.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Upcoming</Text>
                  {upcoming.map((e) => renderUpcomingEvent(e))}
                </View>
              ) : (
                <View style={styles.emptySection}>
                  <Ionicons name="calendar-outline" size={40} color={Colors.gold} />
                  <Text style={styles.emptyText}>No upcoming simchos</Text>
                </View>
              )}
              {/* Past Simchos section removed per user feedback —
                   the page now scrolls upcoming directly into the
                   "Share Your Simcha" form, with no historical list
                   in between. */}

              {/* Inline "Share Your Simcha" form — replaces the old +
                   button modal. Matches the website's events page where
                   the form sits directly below the past simchos grid. */}
              {user?.email ? (
                <SubmitSimchaForm
                  submitterEmail={user.email}
                  onSubmitted={() => { invalidateYtcCache("events").then(() => loadEvents()); }}
                />
              ) : null}
            </View>
          </>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  header: {
    backgroundColor: Colors.navy,
    // Thicker + centered per user feedback. The previous header was a
    // sliver — easy to miss on a phone. Bumped vertical padding and
    // dropped the row layout so the title centers cleanly.
    paddingTop: 18, paddingBottom: 18, paddingHorizontal: 16,
    alignItems: "center", justifyContent: "center",
  },
  headerAction: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  headerTitle: {
    color: Colors.cream, fontSize: 22, fontWeight: "700", letterSpacing: 0.3,
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  body: { padding: 16, gap: 24, paddingBottom: 120 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: Colors.navy, fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  emptySection: { alignItems: "center", paddingVertical: 40, gap: 12 },
  emptyIcon: { fontSize: 40 },
  emptyText: { fontSize: 15, color: Colors.navyOpacity50 },
  eventCard: { flexDirection: "row", backgroundColor: Colors.white, borderRadius: 14, padding: 16, gap: 14, shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 2 },
  eventCardPast: { opacity: 0.65 },
  dateBadge: { width: 54, height: 54, borderRadius: 10, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  dateBadgePast: { backgroundColor: Colors.navyOpacity50 },
  dateMonth: { color: Colors.gold, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  dateMonthPast: { color: Colors.creamOpacity70 },
  dateDay: { color: Colors.cream, fontSize: 22, fontWeight: "bold", lineHeight: 26 },
  dateDayPast: { color: Colors.cream },
  eventBody: { flex: 1, gap: 4 },
  eventName: { fontSize: 16, fontWeight: "600", color: Colors.navy },
  eventFamily: { fontSize: 14, color: Colors.navyOpacity70, fontWeight: "500" },
  eventMeta: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 },
  metaText: { fontSize: 12, color: Colors.navyOpacity50 },
  typeBadge: { alignSelf: "flex-start", backgroundColor: Colors.goldOpacity15, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, marginTop: 4 },
  typeBadgeText: { fontSize: 11, color: Colors.navy, fontWeight: "500" },
  eventDesc: { fontSize: 13, color: Colors.navyOpacity70, lineHeight: 19, marginTop: 4 },
  textMuted: { color: Colors.navyOpacity50 },
  eventImageWrap: { marginTop: 8, position: "relative", borderRadius: 10, overflow: "hidden" },
  eventImage: { width: "100%", height: 160, backgroundColor: Colors.creamDark },
  eventImageExpandBadge: {
    position: "absolute", top: 6, right: 6,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center", justifyContent: "center",
  },
  // Past chip: compact horizontal card matching the website's past-event grid.
  pastChip: {
    width: PAST_GRID_COL_WIDTH,
    backgroundColor: Colors.white, borderRadius: 10, overflow: "hidden",
    flexDirection: "row", alignItems: "center", padding: 8, gap: 10,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
  },
  pastChipBadge: {
    width: 40, height: 40, borderRadius: 6,
    backgroundColor: Colors.creamDark,
    alignItems: "center", justifyContent: "center",
  },
  pastChipMonth: { color: Colors.gold, fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  pastChipDay: { color: Colors.navy, fontSize: 16, fontWeight: "700", lineHeight: 18 },
  pastChipBody: { flex: 1, gap: 1 },
  pastChipName: { fontSize: 13, fontWeight: "600", color: Colors.navy },
  pastChipFamily: { fontSize: 11, color: Colors.navyOpacity70 },
  zoomBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center", justifyContent: "center",
  },
  zoomImage: { width: SCREEN_W, height: "80%" },
  zoomCloseBtn: {
    position: "absolute", top: 40, right: 16,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center",
  },
});
