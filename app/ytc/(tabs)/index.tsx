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
  View, Text, ScrollView, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, RefreshControl, Platform, Pressable, Modal,
  Dimensions, StatusBar,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { PartyPopper, Megaphone } from "lucide-react-native";
import { router, useFocusEffect } from "expo-router";
import { resizedImageUrl, IMG_CARD, IMG_HERO } from "@/lib/image-resize";
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


export default function HomeScreen() {
  const { user, isAdmin, signOut } = useYtcAuth();
  const playShiur = useYtcPlay();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [hasAlumniEntry, setHasAlumniEntry] = useState<boolean | null>(null);
  // Show-more toggles for the announcement and upcoming-simcha sections.
  // Default 3 visible to mirror the website's preview-then-expand pattern.
  const [showAllAnnouncements, setShowAllAnnouncements] = useState(false);
  const [showAllSimchas, setShowAllSimchas] = useState(false);
  const ANNOUNCEMENT_PREVIEW = 3;
  const SIMCHA_PREVIEW = 3;

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
  const [featuredShiurim, setFeaturedShiurim] = useState<Shiur[]>([]);
  const [collections, setCollections] = useState<ShiurCollection[]>([]);
  const [alumniPhotos, setAlumniPhotos] = useState<AlumniPhoto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);

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
      // Defensive: every fetcher SHOULD return an array, but Firestore
      // errors / cache misses can intermittently yield null and that
      // crashed render with "Cannot read property 'map' of null" for ~10
      // users in the dashboard. Coerce to [] before setting state so a
      // bad fetch leaves an empty section instead of a screen-wide crash.
      setCarouselImages(Array.isArray(images) ? (images as CarouselImage[]) : []);
      setAnnouncements(Array.isArray(anns) ? (anns as Announcement[]) : []);
      setUpcomingEvents(Array.isArray(events) ? (events as YtcEvent[]) : []);
      setRecentShiur((shiur as Shiur | null) || null);
      setFeaturedShiurim(Array.isArray(featured) ? (featured as Shiur[]) : []);
      setCollections(Array.isArray(cols) ? (cols as ShiurCollection[]) : []);
      setAlumniPhotos(Array.isArray(photos) ? (photos as AlumniPhoto[]) : []);
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
    // Pass raw email — fetchMyAlumniContact now scans the collection
    // for `data.email === user.email` (matches website behavior).
    fetchMyAlumniContact(user.email)
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

  // Hero is now a swipeable horizontal FlatList (per user feedback —
  // images should be user-scrollable, not just an auto-rotator). The
  // auto-cycle still runs as a hint that there's more, but a user
  // touch / swipe pauses it for 8s so the user can dwell on the image
  // they're looking at.
  const heroFlatListRef = useRef<FlatList<CarouselImage>>(null);
  const heroAutoPausedUntilRef = useRef<number>(0);
  // Switched from useEffect to useFocusEffect so the auto-rotate timer
  // doesn't keep ticking (and re-rendering this whole screen) when the
  // user is on Shiurim / Events / Contacts tabs. Each invisible tick
  // measured ~50ms on Schok F1 — 10× per minute of pure waste.
  useFocusEffect(useCallback(() => {
    if (carouselImages.length <= 1) return;
    const timer = setInterval(() => {
      if (Date.now() < heroAutoPausedUntilRef.current) return;
      setCarouselIndex((i) => {
        const next = (i + 1) % carouselImages.length;
        try { heroFlatListRef.current?.scrollToIndex({ index: next, animated: true }); } catch {}
        return next;
      });
    }, 6000);
    return () => clearInterval(timer);
  }, [carouselImages.length]));

  // Width-based snap target — used by both `getItemLayout` and the
  // momentum-end index calc.
  const HERO_WIDTH = Dimensions.get("window").width;

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

  // (Hero CTA removed — see commit log. The most-recent shiur card
  // below provides the same play affordance.)

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.navy} />
      <ScrollView style={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}>
        {/* Hero — full-bleed image backdrop with overlay text + watermark
             logo + CTA. Mirrors the website's home hero. The first
             carousel image is the backdrop; if multiple, it auto-cycles
             on a 6s timer (existing carouselIndex/setCarouselIndex
             state controls it). Profile circle floats top-right. */}
        <View style={styles.hero}>
          {carouselImages.length > 0 ? (
            <FlatList
              ref={heroFlatListRef}
              data={carouselImages}
              keyExtractor={(item, idx) => item.id ?? String(idx)}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onTouchStart={() => { heroAutoPausedUntilRef.current = Date.now() + 8000; }}
              onMomentumScrollEnd={(e) => {
                const x = e.nativeEvent.contentOffset.x;
                const idx = Math.round(x / HERO_WIDTH);
                setCarouselIndex(idx);
              }}
              getItemLayout={(_, index) => ({ length: HERO_WIDTH, offset: HERO_WIDTH * index, index })}
              renderItem={({ item }) => (
                <View style={{ width: HERO_WIDTH, height: "100%" }}>
                  <Image
                    source={{ uri: resizedImageUrl(item.url, IMG_HERO)! }}
                    style={StyleSheet.absoluteFillObject as any}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    recyclingKey={item.id}
                    transition={120}
                    priority="high"
                  />
                </View>
              )}
            />
          ) : (
            <View style={[StyleSheet.absoluteFillObject, { backgroundColor: Colors.navy }]} />
          )}
          {/* Dark overlay so cream text reads against any backdrop.
               pointerEvents="none" so it doesn't swallow the swipes. */}
          <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: "rgba(10, 22, 40, 0.55)" }]} />

          {/* Watermark logo upper-left. */}
          <Image
            source={require("@/assets/images/ytc-logo.png")}
            style={styles.heroLogoWatermark}
            contentFit="contain"
            pointerEvents={"none" as any}
          />

          {/* Profile circle upper-right. */}
          <View style={styles.heroProfileWrap}>
            <YtcFocusable onPress={() => setProfileMenuOpen(true)} hitSlop={8} style={styles.profileBtn} focusRadius={20}>
              <Text style={styles.profileBtnInitial}>{userInitial}</Text>
            </YtcFocusable>
          </View>

          {/* Title + subtitle, centered with gold accent rules
               flanking the subtitle. Matches the user-supplied
               screenshot: white serif title above, short gold line,
               uppercase gold "ALUMNI NETWORK" caption with tracking,
               another short gold line. */}
          <View pointerEvents="none" style={styles.heroContent}>
            <Text style={styles.heroTitle}>Yeshiva Toras Chaim</Text>
            <View style={styles.heroAccent} />
            <Text style={styles.heroSubtitle}>ALUMNI NETWORK</Text>
            <View style={styles.heroAccent} />
          </View>

          {/* Page-indicator dots — shown only when there's more than one
               image. Sits just under the title block so the user knows
               the hero is swipeable. */}
          {carouselImages.length > 1 && (
            <View pointerEvents="none" style={styles.heroDots}>
              {carouselImages.map((_, i) => (
                <View
                  key={i}
                  style={[styles.heroDot, i === carouselIndex && styles.heroDotActive]}
                />
              ))}
            </View>
          )}
        </View>

        <View style={styles.body}>
          {announcements.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Mazel Tovs & Announcements</Text>
              {(showAllAnnouncements ? announcements : announcements.slice(0, ANNOUNCEMENT_PREVIEW)).map((ann) => (
                <AnnouncementCard key={ann.id} ann={ann} />
              ))}
              {announcements.length > ANNOUNCEMENT_PREVIEW && (
                <YtcFocusable style={styles.showMoreBtn} onPress={() => setShowAllAnnouncements((v) => !v)} focusRadius={10}>
                  <Text style={styles.showMoreText}>
                    {showAllAnnouncements ? "Show less" : `Show ${announcements.length - ANNOUNCEMENT_PREVIEW} more`}
                  </Text>
                  <Ionicons name={showAllAnnouncements ? "chevron-up" : "chevron-down"} size={16} color={Colors.gold} />
                </YtcFocusable>
              )}
            </View>
          )}

          {/* Featured shiur — admin-pinned via settings/featuredShiur.
               Rendered with a gold-accented title to differentiate from
               the most-recent slot below. Placed BEFORE upcoming simchas
               so the user lands on featured Torah content first. */}
          {featuredShiurim.map((featured, i) => (
            <ShiurHomeCard
              key={featured.id}
              shiur={featured}
              sectionTitle={i === 0 ? (featuredShiurim.length > 1 ? "Featured Shiurim" : "Featured Shiur") : undefined}
              isFeatured
              getPosition={getPosition}
              playShiur={playShiur}
              formatDate={formatDate}
            />
          ))}

          {/* Most recent shiur — only shown when distinct from any featured
               (matches iOS behavior at HomeView.swift:71). */}
          {recentShiur && !featuredShiurim.some((f) => f.id === recentShiur.id) && (
            <ShiurHomeCard
              shiur={recentShiur}
              sectionTitle="Most Recent Shiur"
              isFeatured={false}
              getPosition={getPosition}
              playShiur={playShiur}
              formatDate={formatDate}
            />
          )}

          {upcomingEvents.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Upcoming Simchos</Text>
              {(showAllSimchas ? upcomingEvents : upcomingEvents.slice(0, SIMCHA_PREVIEW)).map((event) => (
                <YtcFocusable
                  key={event.id}
                  style={styles.eventCard}
                  onPress={() => router.push("/ytc/(tabs)/events" as any)}
                  focusRadius={14}
                >
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
                  <Ionicons name="chevron-forward" size={18} color={Colors.navyOpacity50} />
                </YtcFocusable>
              ))}
              {upcomingEvents.length > SIMCHA_PREVIEW && (
                <YtcFocusable style={styles.showMoreBtn} onPress={() => setShowAllSimchas((v) => !v)} focusRadius={10}>
                  <Text style={styles.showMoreText}>
                    {showAllSimchas ? "Show less" : `Show ${upcomingEvents.length - SIMCHA_PREVIEW} more`}
                  </Text>
                  <Ionicons name={showAllSimchas ? "chevron-up" : "chevron-down"} size={16} color={Colors.gold} />
                </YtcFocusable>
              )}
            </View>
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
                    <Image source={{ uri: resizedImageUrl(item.url, IMG_CARD)! }} style={styles.spotlightImg} contentFit="cover" cachePolicy="memory-disk" recyclingKey={item.id} transition={150} />
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
              onPress={() => { setProfileMenuOpen(false); router.push("/ytc/email-updates" as any); }}
              focusRadius={4}
            >
              <Ionicons name="mail-outline" size={18} color={Colors.navy} />
              <Text style={styles.menuItemText}>Email Updates</Text>
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
  sectionTitle?: string;
  isFeatured: boolean;
  getPosition: (id: string) => { positionMs: number; durationMs: number } | null;
  playShiur: (shiur: Shiur) => void;
  formatDate: (dateStr: string) => string;
}

// React.memo — props are stable refs (formatDate/playShiur from
// useCallback at parent, getPosition from PositionsContext, shiur is
// stable per id), so this card avoids re-rendering when sibling state
// changes (carousel index, refresh control toggle, etc).
// Extracted from an inline .map() so the carousel auto-rotate tick doesn't
// re-render every announcement card on the home screen every 6 seconds.
// React.memo + stable Announcement props (shallow-compared) short-circuits
// the re-render of the entire list when only the carousel index changed.
const AnnouncementCard = React.memo(function AnnouncementCardImpl({ ann }: { ann: Announcement }) {
  const isMazelTov = ann.type === "mazel_tov";
  // Strip a redundant "Mazel Tov" prefix (incl. trailing "!" / ":" / "—")
  // from the title — many entries are worded "Mazel Tov!" or "Mazel Tov to
  // the Smith family" and we don't want to show that twice once the bold
  // MAZEL TOV label is already on the card. If stripping leaves only
  // punctuation/whitespace, the label renders alone with no title row.
  let titleText: string | null = ann.title;
  if (isMazelTov) {
    const stripped = ann.title
      .replace(/^\s*mazel\s*tov\s*[!:\-—–]*\s*(to\s+)?/i, "")
      .replace(/^[!:.\-—–\s]+/, "")
      .trim();
    titleText = stripped.length > 0 ? stripped : null;
  }
  return (
    <View style={styles.announcementCard}>
      <View style={styles.announcementBody}>
        <View style={styles.announcementIconRow}>
          <View style={[styles.announcementIconBadge, { backgroundColor: isMazelTov ? Colors.goldOpacity15 : Colors.navyOpacity10 }]}>
            {isMazelTov
              ? <PartyPopper size={18} color={Colors.gold} />
              : <Megaphone size={18} color={Colors.navy} />}
          </View>
          <View style={{ flex: 1 }}>
            {isMazelTov && (
              <Text style={styles.mazelTovLabel}>Mazel Tov</Text>
            )}
            {titleText && (
              <Text style={styles.announcementTitle}>{titleText}</Text>
            )}
          </View>
        </View>
        <Text style={styles.announcementContent}>{ann.content}</Text>
      </View>
    </View>
  );
});

const ShiurHomeCard = React.memo(function ShiurHomeCardImpl({ shiur, sectionTitle, isFeatured, getPosition, playShiur, formatDate }: ShiurHomeCardProps) {
  const saved = getPosition(`${YTC_EPISODE_PREFIX}${shiur.id}`);
  const hasProgress = saved && saved.durationMs > 0 && saved.positionMs > 0;
  const pct = hasProgress ? Math.min(Math.round((saved!.positionMs / saved!.durationMs) * 100), 100) : 0;
  const completed = hasProgress && pct >= 95;
  return (
    <View style={styles.section}>
      {/* Star icon + isFeatured gold border were here — both removed
           per user feedback. The "Featured Shiur" / "Most Recent Shiur"
           section title alone signals the role; the card itself looks
           identical to other shiur cards. */}
      {sectionTitle ? <Text style={styles.sectionTitle}>{sectionTitle}</Text> : null}
      <View style={styles.shiurCardWrap}>
        <View style={styles.shiurCard}>
          <View style={styles.shiurInfo}>
            <Text style={styles.shiurTitle}>{shiur.title}</Text>
            <Text style={styles.shiurRebbeDate}>{shiur.rebbe} · {formatDate(shiur.date)}</Text>
            {hasProgress && !completed && (
              <Text style={styles.progressText}>{formatRemainingMin(saved!.positionMs, saved!.durationMs)}</Text>
            )}
            {completed && <Text style={styles.completedText}>Completed</Text>}
            {Array.isArray(shiur.tags) && shiur.tags.length > 0 && (
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
  // Hero — full-bleed photo backdrop with overlay text + watermark logo.
  // Trimmed from 440 → 280 per user feedback ("pictures take up too much
  // of the screen"). The CTA button was removed too — see render block.
  hero: { width: "100%", height: 280, position: "relative", overflow: "hidden" },
  heroLogoWatermark: { position: "absolute", top: 40, left: 16, width: 70, height: 70, opacity: 0.55 },
  heroProfileWrap: { position: "absolute", top: 46, right: 16 },
  // Hero title + caption are now CENTERED and stacked. The two
  // .heroAccent rules flank the gold caption.
  heroContent: {
    position: "absolute", left: 20, right: 20, bottom: 24,
    alignItems: "center",
  },
  heroTitle: {
    color: Colors.cream, fontSize: 30, fontWeight: "700", lineHeight: 36,
    textAlign: "center",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  heroAccent: {
    width: 80, height: 2, backgroundColor: Colors.gold,
    marginVertical: 8, opacity: 0.85,
  },
  heroSubtitle: {
    color: Colors.gold, fontSize: 13, fontWeight: "700",
    letterSpacing: 4, textAlign: "center",
  },
  // Page-indicator dots for the swipeable hero. Sit centered along
  // the bottom edge above the system gesture area.
  heroDots: {
    position: "absolute", bottom: 8, left: 0, right: 0,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  heroDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(250, 248, 243, 0.4)" },
  heroDotActive: { width: 18, backgroundColor: Colors.gold },

  showMoreBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4,
    paddingVertical: 10, marginTop: 4,
  },
  showMoreText: { color: Colors.gold, fontSize: 13, fontWeight: "600" },
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
    backgroundColor: Colors.white, borderRadius: 16, minWidth: 240,
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
  // backgroundColor on the Image style is what expo-image paints before
  // decode finishes — gives an instant cream placeholder instead of a
  // black void, even on cold cache.
  body: { padding: 16, gap: 24 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: Colors.navy, fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  // Card radius — bumped from 10/12 → 16 across the home-page cards
  // per user feedback ("make the home page cards more rounded").
  announcementCard: {
    backgroundColor: Colors.white, borderRadius: 16, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.creamDark,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 4, elevation: 1,
  },
  // announcementAccent removed — was the gold/navy h-1 strip on top.
  announcementBody: { padding: 12 },
  announcementIconRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  announcementIconBadge: {
    width: 30, height: 30, borderRadius: 6,
    alignItems: "center", justifyContent: "center",
  },
  // "Mazel Tov" celebration label that sits above the announcement
  // title on mazel_tov-type entries. Bold + gold to draw the eye and
  // clearly signal the card is a celebration rather than a generic
  // notice (matches the website's mazel-tov treatment).
  mazelTovLabel: {
    fontSize: 12, fontWeight: "800", color: Colors.gold,
    letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 2,
  },
  announcementTitle: {
    fontSize: 15, fontWeight: "600", color: Colors.navy,
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  announcementContent: { fontSize: 13, color: Colors.navyOpacity70, lineHeight: 18 },
  eventCard: { flexDirection: "row", backgroundColor: Colors.white, borderRadius: 16, padding: 14, gap: 14, shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  eventDateBadge: { width: 52, height: 52, borderRadius: 8, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center" },
  eventMonth: { color: Colors.gold, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  eventDay: { color: Colors.cream, fontSize: 20, fontWeight: "bold" },
  eventInfo: { flex: 1 },
  eventName: { fontSize: 15, fontWeight: "600", color: Colors.navy },
  eventFamily: { fontSize: 13, color: Colors.navyOpacity70, marginTop: 2 },
  eventLocation: { fontSize: 12, color: Colors.navyOpacity50, marginTop: 2 },
  eventTime: { fontSize: 12, color: Colors.gold, marginTop: 2, fontWeight: "500" },
  // shiurSectionTitleRow / shiurCardWrapFeatured removed — the row was
  // only there to hold the star icon next to the title, and the
  // featured variant border was dropped per user feedback.
  shiurCardWrap: { backgroundColor: Colors.white, borderRadius: 16, overflow: "hidden", shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
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
    backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 8,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  collectionName: { fontSize: 14, fontWeight: "600", color: Colors.navy },
  collectionDesc: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2 },
  collectionCount: { fontSize: 11, color: Colors.gold, marginTop: 4, fontWeight: "500" },
  spotlightCard: { width: 120, alignItems: "center" },
  spotlightImg: { width: 120, height: 120, borderRadius: 16, backgroundColor: Colors.creamDark },
  spotlightName: { fontSize: 12, fontWeight: "600", color: Colors.navy, marginTop: 6, textAlign: "center" },
  spotlightYear: { fontSize: 11, color: Colors.navyOpacity50, marginTop: 1 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tag: { backgroundColor: Colors.navyOpacity10, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  tagText: { fontSize: 11, color: Colors.navy },
  playBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center" },
  playIcon: { color: Colors.cream, fontSize: 18, marginLeft: 2 },
});
