import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Dimensions,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Image } from "expo-image";
import { useQuery } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";
import { lightHaptic } from "@/lib/haptics";
import { getApiUrl } from "@/lib/query-client";
import type { Feed } from "@/lib/types";

const ONBOARDING_KEY = "@shiurpod_onboarding_complete";
const { width: SCREEN_WIDTH } = Dimensions.get("window");
const CONTENT_WIDTH = Platform.OS === "web" ? Math.min(SCREEN_WIDTH, 480) : SCREEN_WIDTH;

interface OnboardingPage {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  gradient: [string, string];
}

const PAGES: OnboardingPage[] = [
  {
    id: "welcome",
    icon: <MaterialCommunityIcons name="book-open-page-variant" size={64} color="#fff" />,
    title: "Welcome to ShiurPod",
    subtitle: "Your personal Torah learning companion. Browse curated shiurim from top speakers and learn on your schedule.",
    gradient: ["#1e3a5f", "#0f1923"],
  },
  {
    id: "follow",
    icon: <Ionicons name="heart" size={64} color="#fff" />,
    title: "Follow Your Favorites",
    subtitle: "Follow the shiurim and speakers you love. Get notified when new episodes are available so you never miss a shiur.",
    gradient: ["#1a3a2a", "#0f2318"],
  },
  {
    id: "offline",
    icon: <Ionicons name="cloud-download" size={64} color="#fff" />,
    title: "Listen Anywhere",
    subtitle: "Download episodes for offline listening. Auto-download on WiFi keeps your library fresh without using your data.",
    gradient: ["#3a1a3a", "#230f23"],
  },
  {
    id: "resume",
    icon: <Ionicons name="play-circle" size={64} color="#fff" />,
    title: "Pick Up Where You Left Off",
    subtitle: "Your playback position is saved automatically. Start a shiur on one device and continue on another.",
    gradient: ["#3a2a1a", "#231c0f"],
  },
];

function FollowStep({ onComplete }: { onComplete: () => void }) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const insets = useSafeAreaInsets();
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [deviceId, setDeviceId] = useState<string | null>(null);

  React.useEffect(() => {
    AsyncStorage.getItem("@shiurpod_device_id").then((id) => {
      if (id) setDeviceId(id);
    });
  }, []);

  const { data: feeds, isLoading } = useQuery<Feed[]>({
    queryKey: ["/api/feeds"],
  });

  const activeFeeds = React.useMemo(
    () => (feeds || []).filter((f) => f.isActive),
    [feeds]
  );

  const toggleFollow = useCallback(
    async (feedId: string) => {
      lightHaptic();
      setFollowedIds((prev) => {
        const next = new Set(prev);
        if (next.has(feedId)) {
          next.delete(feedId);
          if (deviceId) {
            fetch(new URL(`/api/subscriptions/${deviceId}/${feedId}`, getApiUrl()).toString(), { method: "DELETE" }).catch(() => {});
          }
        } else {
          next.add(feedId);
          if (deviceId) {
            fetch(new URL("/api/subscriptions", getApiUrl()).toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deviceId, feedId }),
            }).catch(() => {});
          }
        }
        return next;
      });
    },
    [deviceId]
  );

  return (
    <View style={[styles.followContainer, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.followHeader,
          { paddingTop: Platform.OS === "web" ? 67 : insets.top + 16 },
        ]}
      >
        <MaterialCommunityIcons name="playlist-check" size={40} color={colors.accent} />
        <Text style={[styles.followTitle, { color: colors.text }]}>
          Follow Some Shiurim
        </Text>
        <Text style={[styles.followSubtitle, { color: colors.textSecondary }]}>
          Choose shiurim to follow and stay updated with new episodes. You can always change this later.
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={activeFeeds}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.feedList}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            const isFollowed = followedIds.has(item.id);
            return (
              <Pressable
                onPress={() => toggleFollow(item.id)}
                style={[
                  styles.feedItem,
                  {
                    backgroundColor: isFollowed
                      ? isDark
                        ? colors.accentLight
                        : "#eef4ff"
                      : colors.surface,
                    borderColor: isFollowed ? colors.accent : colors.border,
                  },
                ]}
              >
                <Image
                  source={{ uri: item.imageUrl || undefined }}
                  style={styles.feedImage}
                  contentFit="cover"
                />
                <View style={styles.feedInfo}>
                  <Text
                    style={[styles.feedTitle, { color: colors.text }]}
                    numberOfLines={1}
                  >
                    {item.title}
                  </Text>
                  <Text
                    style={[styles.feedAuthor, { color: colors.textSecondary }]}
                    numberOfLines={1}
                  >
                    {item.author || "Unknown Speaker"}
                  </Text>
                </View>
                <View
                  style={[
                    styles.followBadge,
                    {
                      backgroundColor: isFollowed ? colors.accent : "transparent",
                      borderColor: isFollowed ? colors.accent : colors.border,
                    },
                  ]}
                >
                  {isFollowed ? (
                    <Ionicons name="checkmark" size={18} color="#fff" />
                  ) : (
                    <Ionicons name="add" size={18} color={colors.textSecondary} />
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}

      <View
        style={[
          styles.followFooter,
          {
            backgroundColor: colors.background,
            paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16,
          },
        ]}
      >
        <Pressable
          onPress={onComplete}
          style={[styles.getStartedBtn, { backgroundColor: colors.accent }]}
        >
          <Text style={styles.getStartedText}>
            {followedIds.size > 0
              ? `Get Started (${followedIds.size} following)`
              : "Skip & Get Started"}
          </Text>
          <Ionicons name="arrow-forward" size={20} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

function PageIndicator({
  total,
  current,
  color,
}: {
  total: number;
  current: number;
  color: string;
}) {
  return (
    <View style={styles.indicators}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            {
              backgroundColor: i === current ? "#fff" : "rgba(255,255,255,0.3)",
              width: i === current ? 24 : 8,
            },
          ]}
        />
      ))}
    </View>
  );
}

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const [currentPage, setCurrentPage] = useState(0);
  const [showFollowStep, setShowFollowStep] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const completeOnboarding = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    router.replace("/(tabs)");
  }, []);

  const goToNext = useCallback(() => {
    lightHaptic();
    if (currentPage < PAGES.length - 1) {
      const next = currentPage + 1;
      setCurrentPage(next);
      flatListRef.current?.scrollToIndex({ index: next, animated: true });
    } else {
      setShowFollowStep(true);
    }
  }, [currentPage]);

  const handleScroll = useCallback((e: any) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / CONTENT_WIDTH);
    if (idx >= 0 && idx < PAGES.length) {
      setCurrentPage(idx);
    }
  }, []);

  if (showFollowStep) {
    return <FollowStep onComplete={completeOnboarding} />;
  }

  const page = PAGES[currentPage];

  return (
    <View style={styles.container}>
      <FlatList
        ref={flatListRef}
        data={PAGES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        keyExtractor={(item) => item.id}
        getItemLayout={(_, index) => ({
          length: CONTENT_WIDTH,
          offset: CONTENT_WIDTH * index,
          index,
        })}
        snapToInterval={CONTENT_WIDTH}
        decelerationRate="fast"
        style={{ flex: 1 }}
        renderItem={({ item }) => (
          <LinearGradient
            colors={item.gradient}
            style={[styles.page, { width: CONTENT_WIDTH }]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <View
              style={[
                styles.pageContent,
                { paddingTop: Platform.OS === "web" ? 67 : insets.top + 40 },
              ]}
            >
              <View style={styles.iconContainer}>{item.icon}</View>
              <Text style={styles.pageTitle}>{item.title}</Text>
              <Text style={styles.pageSubtitle}>{item.subtitle}</Text>
            </View>
          </LinearGradient>
        )}
      />

      <LinearGradient
        colors={page.gradient}
        style={[
          styles.bottomBar,
          { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 20 },
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      >
        <PageIndicator total={PAGES.length} current={currentPage} color="#fff" />

        <View style={styles.bottomActions}>
          <Pressable onPress={completeOnboarding} style={styles.skipBtn}>
            <Text style={styles.skipText}>Skip</Text>
          </Pressable>

          <Pressable onPress={goToNext} style={styles.nextBtn}>
            <Text style={styles.nextText}>
              {currentPage === PAGES.length - 1 ? "Choose Shiurim" : "Next"}
            </Text>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </Pressable>
        </View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f1923",
  },
  page: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  pageContent: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
    maxWidth: 480,
  },
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 36,
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: "800" as const,
    color: "#fff",
    textAlign: "center",
    marginBottom: 16,
    letterSpacing: -0.5,
  },
  pageSubtitle: {
    fontSize: 16,
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
    lineHeight: 24,
    maxWidth: 340,
  },
  bottomBar: {
    paddingTop: 20,
    paddingHorizontal: 24,
  },
  indicators: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  bottomActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  skipBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  skipText: {
    fontSize: 15,
    color: "rgba(255,255,255,0.5)",
    fontWeight: "500" as const,
  },
  nextBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  nextText: {
    fontSize: 16,
    fontWeight: "600" as const,
    color: "#fff",
  },
  followContainer: {
    flex: 1,
  },
  followHeader: {
    alignItems: "center",
    paddingHorizontal: 32,
    paddingBottom: 20,
  },
  followTitle: {
    fontSize: 24,
    fontWeight: "700" as const,
    marginTop: 12,
    textAlign: "center",
  },
  followSubtitle: {
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
    lineHeight: 20,
    maxWidth: 320,
  },
  feedList: {
    paddingHorizontal: 20,
    paddingBottom: 100,
    gap: 10,
  },
  feedItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    gap: 12,
  },
  feedImage: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: "#1e293b",
  },
  feedInfo: {
    flex: 1,
  },
  feedTitle: {
    fontSize: 15,
    fontWeight: "600" as const,
  },
  feedAuthor: {
    fontSize: 13,
    marginTop: 2,
  },
  followBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  followFooter: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 12,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.05)",
  },
  getStartedBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
  },
  getStartedText: {
    fontSize: 17,
    fontWeight: "700" as const,
    color: "#fff",
  },
});
