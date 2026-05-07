// YTC: home tab. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/index.tsx with these changes:
//  - imports remapped (firebase, AuthContext, Colors, types)
//  - useAudio() → useYtcPlay() from the audio adapter
//  - sign-out flows back to settings since the gate then hides /ytc
//  - announcement mazel-tov detection uses the typed `type` field
//    instead of ann.isMazelTov (the original screen referenced a
//    property that the type def doesn't expose)
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, ScrollView, StyleSheet, FlatList, Dimensions,
  TouchableOpacity, ActivityIndicator, RefreshControl, Platform,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { useYtcAuth } from "@/contexts/YtcAuthContext";
import { fetchCarouselImages, fetchAnnouncements, fetchUpcomingEvents, fetchMostRecentShiur, invalidateYtcCache } from "@/lib/ytc/firebase";
import type { CarouselImage, Announcement, YtcEvent, Shiur } from "@/types/ytc";
import { useYtcPlay, YTC_EPISODE_PREFIX } from "@/lib/ytc/audio-adapter";
import { usePositions } from "@/contexts/PositionsContext";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function HomeScreen() {
  const { signOut } = useYtcAuth();
  const playShiur = useYtcPlay();
  const { getPosition } = usePositions();

  const [carouselImages, setCarouselImages] = useState<CarouselImage[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<YtcEvent[]>([]);
  const [recentShiur, setRecentShiur] = useState<Shiur | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const carouselRef = useRef<FlatList>(null);

  const loadData = async () => {
    try {
      const [images, anns, events, shiur] = await Promise.all([
        fetchCarouselImages(),
        fetchAnnouncements(),
        fetchUpcomingEvents(3),
        fetchMostRecentShiur(),
      ]);
      setCarouselImages(images as CarouselImage[]);
      setAnnouncements(anns as Announcement[]);
      setUpcomingEvents(events as YtcEvent[]);
      setRecentShiur(shiur as Shiur | null);
    } catch (e) {
      console.error("YTC HomeScreen load error:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      invalidateYtcCache("carouselImages"),
      invalidateYtcCache("announcements"),
      invalidateYtcCache("upcomingEvents:3"),
      invalidateYtcCache("mostRecentShiur"),
    ]);
    loadData();
  }, []);

  useEffect(() => {
    if (carouselImages.length <= 1) return;
    const timer = setInterval(() => {
      setCarouselIndex((i) => {
        const next = (i + 1) % carouselImages.length;
        carouselRef.current?.scrollToIndex({ index: next, animated: true });
        return next;
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [carouselImages.length]);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  if (isLoading) {
    return <View style={styles.loading}><ActivityIndicator size="large" color={Colors.navy} /></View>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView style={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}>
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>Yeshiva Toras Chaim</Text>
            <Text style={styles.headerSubtitle}>Alumni Portal</Text>
          </View>
          <TouchableOpacity onPress={signOut} style={styles.signOutBtn}><Text style={styles.signOutText}>Sign Out</Text></TouchableOpacity>
        </View>

        {carouselImages.length > 0 && (
          <View style={styles.carouselContainer}>
            <FlatList
              ref={carouselRef}
              data={carouselImages}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              keyExtractor={(item) => item.id}
              onMomentumScrollEnd={(e) => {
                const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
                setCarouselIndex(idx);
              }}
              renderItem={({ item }) => (
                <View style={styles.carouselSlide}>
                  <Image source={{ uri: item.url }} style={styles.carouselImage} contentFit="cover" />
                  {item.caption && <View style={styles.captionOverlay}><Text style={styles.caption}>{item.caption}</Text></View>}
                </View>
              )}
            />
            {carouselImages.length > 1 && (
              <View style={styles.dots}>{carouselImages.map((_, i) => <View key={i} style={[styles.dot, i === carouselIndex && styles.dotActive]} />)}</View>
            )}
          </View>
        )}

        <View style={styles.body}>
          {announcements.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Announcements</Text>
              {announcements.map((ann) => {
                const isMazelTov = ann.type === "mazel_tov";
                return (
                  <View key={ann.id} style={[styles.card, isMazelTov && styles.mazelTovCard]}>
                    {isMazelTov && <View style={styles.mazelTovBadge}><Text style={styles.mazelTovBadgeText}>🎉 Mazel Tov</Text></View>}
                    <Text style={styles.cardTitle}>{ann.title}</Text>
                    <Text style={styles.cardContent}>{ann.content}</Text>
                  </View>
                );
              })}
            </View>
          )}

          {upcomingEvents.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Upcoming Simchos</Text>
              {upcomingEvents.map((event) => (
                <View key={event.id} style={styles.eventCard}>
                  <View style={styles.eventDateBadge}>
                    <Text style={styles.eventMonth}>{formatEventMonth(event.date)}</Text>
                    <Text style={styles.eventDay}>{formatEventDay(event.date)}</Text>
                  </View>
                  <View style={styles.eventInfo}>
                    <Text style={styles.eventName}>{event.eventName}</Text>
                    <Text style={styles.eventFamily}>{event.personFamily}</Text>
                    <Text style={styles.eventLocation}>{event.location}</Text>
                    {event.time && <Text style={styles.eventTime}>{event.time}</Text>}
                  </View>
                </View>
              ))}
            </View>
          )}

          {recentShiur && (() => {
            const saved = getPosition(`${YTC_EPISODE_PREFIX}${recentShiur.id}`);
            const hasProgress = saved && saved.durationMs > 0 && saved.positionMs > 0;
            const pct = hasProgress ? Math.min(Math.round((saved!.positionMs / saved!.durationMs) * 100), 100) : 0;
            const completed = hasProgress && pct >= 95;
            return (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Latest Shiur</Text>
                <View style={styles.shiurCardWrap}>
                  <View style={styles.shiurCard}>
                    <View style={styles.shiurInfo}>
                      <Text style={styles.shiurTitle}>{recentShiur.title}</Text>
                      <Text style={styles.shiurRebbeDate}>{recentShiur.rebbe} · {formatDate(recentShiur.date)}</Text>
                      {hasProgress && !completed && (
                        <Text style={styles.progressText}>{pct}% · {formatRemainingMin(saved!.positionMs, saved!.durationMs)}</Text>
                      )}
                      {completed && <Text style={styles.completedText}>Completed</Text>}
                      {recentShiur.tags.length > 0 && (
                        <View style={styles.tags}>
                          {recentShiur.tags.slice(0, 3).map((tag) => <View key={tag} style={styles.tag}><Text style={styles.tagText}>{tag}</Text></View>)}
                        </View>
                      )}
                    </View>
                    {recentShiur.audioUrl && (
                      <TouchableOpacity style={styles.playBtn} onPress={() => playShiur(recentShiur)}>
                        <Text style={styles.playIcon}>▶</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {hasProgress && !completed && (
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${pct}%` }]} />
                    </View>
                  )}
                </View>
              </View>
            );
          })()}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function formatEventMonth(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleString("en-US", { month: "short" }).toUpperCase();
}
function formatEventDay(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return String(d.getDate());
}
function formatRemainingMin(positionMs: number, durationMs: number): string {
  const remainingMs = Math.max(0, durationMs - positionMs);
  const total = Math.floor(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m} min left`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  loading: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: Colors.cream },
  scroll: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: Colors.navy, paddingHorizontal: 16, paddingVertical: 10 },
  headerTitle: { color: Colors.cream, fontSize: 16, fontWeight: "bold", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  headerSubtitle: { color: Colors.creamOpacity70, fontSize: 11 },
  signOutBtn: { padding: 8 },
  signOutText: { color: Colors.gold, fontSize: 13, fontWeight: "500" },
  carouselContainer: { position: "relative" },
  carouselSlide: { width: SCREEN_WIDTH, height: 220 },
  carouselImage: { width: "100%", height: "100%" },
  captionOverlay: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.4)", padding: 10 },
  caption: { color: Colors.white, fontSize: 13, textAlign: "center" },
  dots: { flexDirection: "row", justifyContent: "center", paddingVertical: 8, gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: Colors.navyOpacity30 },
  dotActive: { backgroundColor: Colors.navy, width: 18 },
  body: { padding: 16, gap: 24 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: Colors.navy, fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  card: { backgroundColor: Colors.white, borderRadius: 12, padding: 16, shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
  mazelTovCard: { borderLeftWidth: 3, borderLeftColor: Colors.gold },
  mazelTovBadge: { flexDirection: "row", backgroundColor: Colors.goldOpacity15, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, marginBottom: 8 },
  mazelTovBadgeText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  cardTitle: { fontSize: 15, fontWeight: "600", color: Colors.navy, marginBottom: 6 },
  cardContent: { fontSize: 14, color: Colors.navyOpacity70, lineHeight: 20 },
  eventCard: { flexDirection: "row", backgroundColor: Colors.white, borderRadius: 12, padding: 14, gap: 14, shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  eventDateBadge: { width: 52, height: 52, borderRadius: 8, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center" },
  eventMonth: { color: Colors.gold, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  eventDay: { color: Colors.cream, fontSize: 20, fontWeight: "bold" },
  eventInfo: { flex: 1 },
  eventName: { fontSize: 15, fontWeight: "600", color: Colors.navy },
  eventFamily: { fontSize: 13, color: Colors.navyOpacity70, marginTop: 2 },
  eventLocation: { fontSize: 12, color: Colors.navyOpacity50, marginTop: 2 },
  eventTime: { fontSize: 12, color: Colors.gold, marginTop: 2, fontWeight: "500" },
  shiurCardWrap: { backgroundColor: Colors.white, borderRadius: 12, overflow: "hidden", shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
  shiurCard: { flexDirection: "row", padding: 16, gap: 12, alignItems: "center" },
  shiurInfo: { flex: 1 },
  shiurTitle: { fontSize: 15, fontWeight: "600", color: Colors.navy, marginBottom: 4 },
  shiurRebbeDate: { fontSize: 13, color: Colors.navyOpacity70 },
  progressText: { fontSize: 12, color: Colors.gold, marginTop: 4, fontWeight: "500" },
  completedText: { fontSize: 12, color: Colors.navyOpacity50, marginTop: 4, fontWeight: "500" },
  progressTrack: { height: 3, backgroundColor: Colors.creamDark },
  progressFill: { height: 3, backgroundColor: Colors.gold },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tag: { backgroundColor: Colors.navyOpacity10, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  tagText: { fontSize: 11, color: Colors.navy },
  playBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center" },
  playIcon: { color: Colors.cream, fontSize: 18, marginLeft: 2 },
});
