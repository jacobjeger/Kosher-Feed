// YTC: home tab. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/index.tsx with these changes:
//  - imports remapped (firebase, AuthContext, Colors, types)
//  - useAudio() → useYtcPlay() from the audio adapter
//  - sign-out flows back to settings since the gate then hides /ytc
//  - announcement mazel-tov detection uses the typed `type` field
//    instead of ann.isMazelTov (the original screen referenced a
//    property that the type def doesn't expose)
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, StyleSheet, FlatList, Dimensions,
  TouchableOpacity, ActivityIndicator, RefreshControl, Platform, Pressable, Modal,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { PartyPopper, Megaphone } from "lucide-react-native";
import { router } from "expo-router";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { useYtcAuth } from "@/contexts/YtcAuthContext";
import { fetchCarouselImages, fetchAnnouncements, fetchUpcomingEvents, fetchMostRecentShiur, fetchFeaturedShiur, fetchActiveCollections, fetchAlumniPhotos, fetchMyAlumniContact, invalidateYtcCache } from "@/lib/ytc/firebase";
import { SubmitAlumniContactModal } from "@/components/ytc/SubmitAlumniContactModal";
import type { CarouselImage, Announcement, YtcEvent, Shiur, ShiurCollection, AlumniPhoto } from "@/types/ytc";
import { useYtcPlay, YTC_EPISODE_PREFIX } from "@/lib/ytc/audio-adapter";
import { usePositions } from "@/contexts/PositionsContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { runYtcAutoDownload } from "@/lib/ytc/downloads";
import { startYtcPositionSync, hydrateYtcPositions } from "@/lib/ytc/position-sync";
import { bootstrapYtcPush, requestNotificationPermission } from "@/lib/ytc/push";
import { YtcFocusable } from "@/components/ytc/YtcFocusable";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function HomeScreen() {
  const { user, isAdmin, signOut } = useYtcAuth();
  const playShiur = useYtcPlay();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [hasAlumniEntry, setHasAlumniEntry] = useState<boolean | null>(null);

  // First letter of displayName, falling back to email's first letter,
  // falling back to "Y" (for YTC) — never show "?" since that suggests
  // an unauthenticated state when actually we just don't know the user's
  // chosen display name yet.
  const userInitial = (() => {
    const name = (user?.displayName || "").trim();
    if (name) return name.charAt(0).toUpperCase();
    const email = (user?.email || "").trim();
    if (email) return email.charAt(0).toUpperCase();
    return "Y";
  })();
  const { getPosition } = usePositions();
  const downloadsCtx = useDownloads();

  // One-shot auto-download per session: kicked off after the home data
  // settles. Skips immediately when settings.mode === "off". Errors
  // here should never surface — auto-download is a background nicety.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    runYtcAutoDownload(downloadsCtx).catch(() => {});
    // Multi-device position sync: pull remote saved positions into local
    // AsyncStorage, then start a debounced upload loop on every position
    // change. Both fire-and-forget; failures don't block anything.
    hydrateYtcPositions().catch(() => {});
    startYtcPositionSync();
    // Push: ask for notification permission once, then subscribe to
    // default topics (idempotent — gated by a one-shot AsyncStorage flag).
    // Both no-op when @react-native-firebase/messaging isn't pointed at
    // the YTC Firebase project; the warning banner in /ytc/settings
    // tells the user.
    (async () => {
      try { await requestNotificationPermission(); } catch {}
      try { await bootstrapYtcPush(); } catch {}
    })();
  }, []);

  const [carouselImages, setCarouselImages] = useState<CarouselImage[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<YtcEvent[]>([]);
  const [recentShiur, setRecentShiur] = useState<Shiur | null>(null);
  const [featuredShiur, setFeaturedShiur] = useState<Shiur | null>(null);
  const [collections, setCollections] = useState<ShiurCollection[]>([]);
  const [alumniPhotos, setAlumniPhotos] = useState<AlumniPhoto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const carouselRef = useRef<FlatList>(null);

  const loadData = async () => {
    try {
      const [images, anns, events, shiur, featured, cols, photos] = await Promise.all([
        fetchCarouselImages(),
        fetchAnnouncements(),
        fetchUpcomingEvents(3),
        fetchMostRecentShiur(),
        fetchFeaturedShiur(),
        fetchActiveCollections(),
        fetchAlumniPhotos(),
      ]);
      setCarouselImages(images as CarouselImage[]);
      setAnnouncements(anns as Announcement[]);
      setUpcomingEvents(events as YtcEvent[]);
      setRecentShiur(shiur as Shiur | null);
      setFeaturedShiur(featured as Shiur | null);
      setCollections(cols as ShiurCollection[]);
      setAlumniPhotos(photos as AlumniPhoto[]);
    } catch (e) {
      console.error("YTC HomeScreen load error:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  // Detect whether the signed-in user already has an alumni-directory
  // entry. Drives the "Edit your info" vs "Add your info" label in
  // the profile menu. Independent of the home data fetch.
  useEffect(() => {
    if (!user?.email) { setHasAlumniEntry(false); return; }
    fetchMyAlumniContact(user.email.toLowerCase())
      .then((entry) => setHasAlumniEntry(!!entry))
      .catch(() => setHasAlumniEntry(false));
  }, [user?.email]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      invalidateYtcCache("carouselImages"),
      invalidateYtcCache("announcements"),
      invalidateYtcCache("upcomingEvents:3"),
      invalidateYtcCache("mostRecentShiur"),
      invalidateYtcCache("featuredShiur"),
      invalidateYtcCache("shiurCollections:active"),
      invalidateYtcCache("alumniPhotos"),
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

  // useCallback: stabilize the reference so React.memo on
  // ShiurHomeCard short-circuits on re-renders.
  const formatDate = useCallback((dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }, []);

  // Progressive render — instead of blocking the entire home screen
  // behind a single isLoading guard, each section renders empty until
  // its data resolves. Combined with pre-warm in YtcAuthProvider, the
  // user sees the chrome instantly and content fills in within a frame
  // on warm cache. Cold-cache: small spinner inside each section's
  // empty state if needed (currently we just don't render the section).

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView style={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}>
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>Yeshiva Toras Chaim</Text>
            <Text style={styles.headerSubtitle}>Alumni Portal</Text>
          </View>
          {/* Profile circle that drops a menu — single nav surface for
               settings / admin / sign-out, mirroring iOS HomeView profile
               button. */}
          <YtcFocusable onPress={() => setProfileMenuOpen(true)} hitSlop={8} style={styles.profileBtn} focusRadius={20}>
            <Text style={styles.profileBtnInitial}>{userInitial}</Text>
          </YtcFocusable>
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
                  <Image source={{ uri: item.url }} style={styles.carouselImage} contentFit="cover" cachePolicy="memory-disk" recyclingKey={item.id} transition={150} />
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
                  <View key={ann.id} style={styles.announcementCard}>
                    {/* Top accent line — gold for mazel tov, navy for general
                        announcements. Mirrors website's h-1 w-full gradient. */}
                    <View style={[styles.announcementAccent, { backgroundColor: isMazelTov ? Colors.gold : Colors.navy }]} />
                    <View style={styles.announcementBody}>
                      <View style={styles.announcementIconRow}>
                        <View style={[styles.announcementIconBadge, { backgroundColor: isMazelTov ? Colors.goldOpacity15 : Colors.navyOpacity10 }]}>
                          {isMazelTov
                            ? <PartyPopper size={22} color={Colors.gold} />
                            : <Megaphone size={22} color={Colors.navy} />}
                        </View>
                        <Text style={styles.announcementTitle}>{ann.title}</Text>
                      </View>
                      <Text style={styles.announcementContent}>{ann.content}</Text>
                    </View>
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

          {/* Featured shiur — admin-pinned via settings/featuredShiur.
               Rendered with a gold-accented title to differentiate from
               the most-recent slot below. */}
          {featuredShiur && (
            <ShiurHomeCard
              shiur={featuredShiur}
              sectionTitle="Featured Shiur"
              isFeatured
              getPosition={getPosition}
              playShiur={playShiur}
              formatDate={formatDate}
            />
          )}

          {/* Most recent shiur — only shown when distinct from featured
               (matches iOS behavior at HomeView.swift:71). */}
          {recentShiur && recentShiur.id !== featuredShiur?.id && (
            <ShiurHomeCard
              shiur={recentShiur}
              sectionTitle="Most Recent Shiur"
              isFeatured={false}
              getPosition={getPosition}
              playShiur={playShiur}
              formatDate={formatDate}
            />
          )}

          {collections.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Collections</Text>
              {collections.map((c) => (
                <YtcFocusable
                  key={c.id}
                  style={styles.collectionCard}
                  onPress={() => router.push(`/ytc/collections/${c.id}` as any)}
                  focusRadius={12}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.collectionName}>{c.name}</Text>
                    {c.description ? <Text style={styles.collectionDesc} numberOfLines={2}>{c.description}</Text> : null}
                    <Text style={styles.collectionCount}>{c.shiurIds.length} shiurim</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={Colors.navyOpacity50} />
                </YtcFocusable>
              ))}
            </View>
          )}

          {alumniPhotos.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Alumni Spotlight</Text>
              <FlatList
                horizontal
                data={alumniPhotos}
                keyExtractor={(item) => item.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12, paddingRight: 16 }}
                renderItem={({ item }) => (
                  <View style={styles.spotlightCard}>
                    <Image source={{ uri: item.url }} style={styles.spotlightImg} contentFit="cover" cachePolicy="memory-disk" recyclingKey={item.id} transition={150} />
                    {item.name ? <Text style={styles.spotlightName} numberOfLines={1}>{item.name}</Text> : null}
                    {item.year ? <Text style={styles.spotlightYear}>{item.year}</Text> : null}
                  </View>
                )}
              />
            </View>
          )}
        </View>
      </ScrollView>

      {/* Alumni-directory submit/edit modal triggered from the profile
           menu. Same component the Contacts tab uses. */}
      <SubmitAlumniContactModal
        visible={showInfoModal}
        onClose={() => setShowInfoModal(false)}
        onSubmitted={() => {
          // Refresh the gating state so the menu label flips
          // immediately on first submission.
          setHasAlumniEntry(true);
          invalidateYtcCache("approvedAlumni").catch(() => {});
        }}
        submitterEmail={user?.email ?? ""}
        submitterDisplayName={user?.displayName ?? null}
      />

      {/* Profile menu — anchored top-right, dismissable by backdrop tap.
           Notification Settings entry is intentionally omitted while
           YTC_PUSH_FEATURE_ENABLED is false (lib/ytc/push.ts). */}
      <Modal
        visible={profileMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setProfileMenuOpen(false)}
      >
        <Pressable style={styles.menuBackdrop} onPress={() => setProfileMenuOpen(false)}>
          <View style={styles.menuCard}>
            <View style={styles.menuHeader}>
              <View style={styles.menuAvatar}>
                <Text style={styles.menuAvatarInitial}>{userInitial}</Text>
              </View>
              <View style={{ flex: 1 }}>
                {user?.displayName ? <Text style={styles.menuName} numberOfLines={1}>{user.displayName}</Text> : null}
                {user?.email ? <Text style={styles.menuEmail} numberOfLines={1}>{user.email}</Text> : null}
                {isAdmin ? <Text style={styles.menuAdminBadge}>Admin</Text> : null}
              </View>
            </View>
            <YtcFocusable
              style={styles.menuItem}
              onPress={() => { setProfileMenuOpen(false); setShowInfoModal(true); }}
              focusRadius={4}
            >
              <Ionicons name={hasAlumniEntry ? "create-outline" : "person-add-outline"} size={18} color={Colors.navy} />
              <Text style={styles.menuItemText}>{hasAlumniEntry ? "Edit your info" : "Add your info"}</Text>
            </YtcFocusable>
            <YtcFocusable
              style={styles.menuItem}
              onPress={() => { setProfileMenuOpen(false); router.push("/ytc/settings" as any); }}
              focusRadius={4}
            >
              <Ionicons name="settings-outline" size={18} color={Colors.navy} />
              <Text style={styles.menuItemText}>Download Settings</Text>
            </YtcFocusable>
            <YtcFocusable
              style={[styles.menuItem, styles.menuItemDanger]}
              onPress={() => { setProfileMenuOpen(false); signOut(); }}
              focusRadius={4}
            >
              <Ionicons name="log-out-outline" size={18} color={Colors.error} />
              <Text style={[styles.menuItemText, styles.menuItemTextDanger]}>Sign Out</Text>
            </YtcFocusable>
          </View>
        </Pressable>
      </Modal>
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

interface ShiurHomeCardProps {
  shiur: Shiur;
  sectionTitle: string;
  isFeatured: boolean;
  getPosition: (id: string) => { positionMs: number; durationMs: number } | null;
  playShiur: (shiur: Shiur) => void;
  formatDate: (dateStr: string) => string;
}

// React.memo — props are stable refs (formatDate/playShiur from
// useCallback at parent, getPosition from PositionsContext, shiur is
// stable per id), so this card avoids re-rendering when sibling state
// changes (carousel index, refresh control toggle, etc).
const ShiurHomeCard = React.memo(function ShiurHomeCardImpl({ shiur, sectionTitle, isFeatured, getPosition, playShiur, formatDate }: ShiurHomeCardProps) {
  const saved = getPosition(`${YTC_EPISODE_PREFIX}${shiur.id}`);
  const hasProgress = saved && saved.durationMs > 0 && saved.positionMs > 0;
  const pct = hasProgress ? Math.min(Math.round((saved!.positionMs / saved!.durationMs) * 100), 100) : 0;
  const completed = hasProgress && pct >= 95;
  return (
    <View style={styles.section}>
      <View style={styles.shiurSectionTitleRow}>
        {isFeatured && <Ionicons name="star" size={14} color={Colors.gold} style={{ marginRight: 6 }} />}
        <Text style={styles.sectionTitle}>{sectionTitle}</Text>
      </View>
      <View style={[styles.shiurCardWrap, isFeatured && styles.shiurCardWrapFeatured]}>
        <View style={styles.shiurCard}>
          <View style={styles.shiurInfo}>
            <Text style={styles.shiurTitle}>{shiur.title}</Text>
            <Text style={styles.shiurRebbeDate}>{shiur.rebbe} · {formatDate(shiur.date)}</Text>
            {hasProgress && !completed && (
              <Text style={styles.progressText}>{formatRemainingMin(saved!.positionMs, saved!.durationMs)}</Text>
            )}
            {completed && <Text style={styles.completedText}>Completed</Text>}
            {shiur.tags.length > 0 && (
              <View style={styles.tags}>
                {shiur.tags.slice(0, 3).map((tag) => <View key={tag} style={styles.tag}><Text style={styles.tagText}>{tag}</Text></View>)}
              </View>
            )}
          </View>
          {shiur.audioUrl && (
            <YtcFocusable style={styles.playBtn} onPress={() => playShiur(shiur)} focusRadius={24}>
              <Text style={styles.playIcon}>▶</Text>
            </YtcFocusable>
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
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  loading: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: Colors.cream },
  scroll: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: Colors.navy, paddingHorizontal: 16, paddingVertical: 10 },
  headerTitle: { color: Colors.cream, fontSize: 16, fontWeight: "bold", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  headerSubtitle: { color: Colors.creamOpacity70, fontSize: 11 },
  profileBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.gold,
    alignItems: "center", justifyContent: "center",
  },
  profileBtnInitial: { color: Colors.navy, fontSize: 14, fontWeight: "700" },
  menuBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.4)",
    paddingTop: 60, paddingHorizontal: 12, alignItems: "flex-end",
  },
  menuCard: {
    backgroundColor: Colors.white, borderRadius: 12, minWidth: 240,
    paddingVertical: 6, shadowColor: Colors.black,
    shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18,
    shadowRadius: 12, elevation: 6,
  },
  menuHeader: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.creamDark,
  },
  menuAvatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.gold,
    alignItems: "center", justifyContent: "center",
  },
  menuAvatarInitial: { color: Colors.navy, fontSize: 16, fontWeight: "700" },
  menuName: { fontSize: 14, fontWeight: "600", color: Colors.navy },
  menuEmail: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2 },
  menuAdminBadge: {
    fontSize: 10, color: Colors.gold, fontWeight: "700",
    marginTop: 4, letterSpacing: 0.5,
  },
  menuItem: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  menuItemDanger: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.creamDark },
  menuItemText: { fontSize: 14, color: Colors.navy, fontWeight: "500" },
  menuItemTextDanger: { color: Colors.error },
  carouselContainer: { position: "relative" },
  carouselSlide: { width: SCREEN_WIDTH, height: 220 },
  // backgroundColor on the Image style is what expo-image paints before
  // decode finishes — gives an instant cream placeholder instead of a
  // black void, even on cold cache.
  carouselImage: { width: "100%", height: "100%", backgroundColor: Colors.creamDark },
  captionOverlay: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.4)", padding: 10 },
  caption: { color: Colors.white, fontSize: 13, textAlign: "center" },
  dots: { flexDirection: "row", justifyContent: "center", paddingVertical: 8, gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: Colors.navyOpacity30 },
  dotActive: { backgroundColor: Colors.navy, width: 18 },
  body: { padding: 16, gap: 24 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: Colors.navy, fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  announcementCard: {
    backgroundColor: Colors.white, borderRadius: 12, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.goldOpacity30,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 8, elevation: 2,
  },
  announcementAccent: { height: 4, width: "100%" },
  announcementBody: { padding: 16 },
  announcementIconRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
  announcementIconBadge: {
    width: 40, height: 40, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  announcementTitle: {
    flex: 1, fontSize: 17, fontWeight: "600", color: Colors.navy,
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  announcementContent: { fontSize: 14, color: Colors.navyOpacity70, lineHeight: 20 },
  eventCard: { flexDirection: "row", backgroundColor: Colors.white, borderRadius: 12, padding: 14, gap: 14, shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  eventDateBadge: { width: 52, height: 52, borderRadius: 8, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center" },
  eventMonth: { color: Colors.gold, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  eventDay: { color: Colors.cream, fontSize: 20, fontWeight: "bold" },
  eventInfo: { flex: 1 },
  eventName: { fontSize: 15, fontWeight: "600", color: Colors.navy },
  eventFamily: { fontSize: 13, color: Colors.navyOpacity70, marginTop: 2 },
  eventLocation: { fontSize: 12, color: Colors.navyOpacity50, marginTop: 2 },
  eventTime: { fontSize: 12, color: Colors.gold, marginTop: 2, fontWeight: "500" },
  shiurSectionTitleRow: { flexDirection: "row", alignItems: "center" },
  shiurCardWrap: { backgroundColor: Colors.white, borderRadius: 12, overflow: "hidden", shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
  shiurCardWrapFeatured: { borderWidth: 1, borderColor: Colors.gold },
  shiurCard: { flexDirection: "row", padding: 16, gap: 12, alignItems: "center" },
  shiurInfo: { flex: 1 },
  shiurTitle: { fontSize: 15, fontWeight: "600", color: Colors.navy, marginBottom: 4 },
  shiurRebbeDate: { fontSize: 13, color: Colors.navyOpacity70 },
  progressText: { fontSize: 12, color: Colors.gold, marginTop: 4, fontWeight: "500" },
  completedText: { fontSize: 12, color: Colors.navyOpacity50, marginTop: 4, fontWeight: "500" },
  progressTrack: { height: 3, backgroundColor: Colors.creamDark },
  progressFill: { height: 3, backgroundColor: Colors.gold },
  collectionCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: Colors.white, borderRadius: 12, padding: 14, marginBottom: 8,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  collectionName: { fontSize: 14, fontWeight: "600", color: Colors.navy },
  collectionDesc: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2 },
  collectionCount: { fontSize: 11, color: Colors.gold, marginTop: 4, fontWeight: "500" },
  spotlightCard: { width: 120, alignItems: "center" },
  spotlightImg: { width: 120, height: 120, borderRadius: 12, backgroundColor: Colors.creamDark },
  spotlightName: { fontSize: 12, fontWeight: "600", color: Colors.navy, marginTop: 6, textAlign: "center" },
  spotlightYear: { fontSize: 11, color: Colors.navyOpacity50, marginTop: 1 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tag: { backgroundColor: Colors.navyOpacity10, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  tagText: { fontSize: 11, color: Colors.navy },
  playBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center" },
  playIcon: { color: Colors.cream, fontSize: 18, marginLeft: 2 },
});
