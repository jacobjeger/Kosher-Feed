import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
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
const SMALL_HEIGHT = 640;

interface PageData {
  id: string;
  iconName: string;
  iconSet: "material" | "ionicons";
  title: string;
  subtitle: string;
  gradient: [string, string];
}

const PAGE_DATA: PageData[] = [
  {
    id: "welcome",
    iconName: "book-open-page-variant",
    iconSet: "material",
    title: "Welcome to ShiurPod",
    subtitle: "Your personal Torah learning companion. Browse curated shiurim from top speakers and learn on your schedule.",
    gradient: ["#1e3a5f", "#0f1923"],
  },
  {
    id: "follow",
    iconName: "heart",
    iconSet: "ionicons",
    title: "Follow Your Favorites",
    subtitle: "Follow the shiurim and speakers you love. Get notified when new episodes are available.",
    gradient: ["#1a3a2a", "#0f2318"],
  },
  {
    id: "offline",
    iconName: "cloud-download",
    iconSet: "ionicons",
    title: "Listen Anywhere",
    subtitle: "Download episodes for offline listening. Auto-download on WiFi keeps your library fresh.",
    gradient: ["#3a1a3a", "#230f23"],
  },
  {
    id: "resume",
    iconName: "play-circle",
    iconSet: "ionicons",
    title: "Pick Up Where You Left Off",
    subtitle: "Your playback position is saved automatically across sessions and devices.",
    gradient: ["#3a2a1a", "#231c0f"],
  },
];

function FollowStep({ onComplete }: { onComplete: () => void }) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const isSmall = height < SMALL_HEIGHT;
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
          {
            paddingTop: Platform.OS === "web" ? 67 : insets.top + (isSmall ? 8 : 16),
            paddingBottom: isSmall ? 10 : 20,
            paddingHorizontal: isSmall ? 20 : 32,
          },
        ]}
      >
        <MaterialCommunityIcons name="playlist-check" size={isSmall ? 28 : 40} color={colors.accent} />
        <Text style={[styles.followTitle, { color: colors.text, fontSize: isSmall ? 19 : 24, marginTop: isSmall ? 6 : 12 }]}>
          Follow Some Shiurim
        </Text>
        <Text style={[styles.followSubtitle, { color: colors.textSecondary, fontSize: isSmall ? 12 : 14 }]}>
          Choose shiurim to follow. You can always change this later.
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={activeFeeds}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.feedList, { paddingBottom: isSmall ? 80 : 100, gap: isSmall ? 6 : 10 }]}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            const isFollowed = followedIds.has(item.id);
            return (
              <Pressable
                onPress={() => toggleFollow(item.id)}
                style={[
                  styles.feedItem,
                  {
                    padding: isSmall ? 8 : 12,
                    borderRadius: isSmall ? 10 : 14,
                    gap: isSmall ? 8 : 12,
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
                  style={[styles.feedImage, isSmall ? { width: 40, height: 40, borderRadius: 8 } : {}]}
                  contentFit="cover"
                />
                <View style={styles.feedInfo}>
                  <Text
                    style={[styles.feedTitle, { color: colors.text, fontSize: isSmall ? 13 : 15 }]}
                    numberOfLines={1}
                  >
                    {item.title}
                  </Text>
                  <Text
                    style={[styles.feedAuthor, { color: colors.textSecondary, fontSize: isSmall ? 11 : 13 }]}
                    numberOfLines={1}
                  >
                    {item.author || "Unknown Speaker"}
                  </Text>
                </View>
                <View
                  style={[
                    styles.followBadge,
                    isSmall ? { width: 26, height: 26, borderRadius: 13 } : {},
                    {
                      backgroundColor: isFollowed ? colors.accent : "transparent",
                      borderColor: isFollowed ? colors.accent : colors.border,
                    },
                  ]}
                >
                  {isFollowed ? (
                    <Ionicons name="checkmark" size={isSmall ? 14 : 18} color="#fff" />
                  ) : (
                    <Ionicons name="add" size={isSmall ? 14 : 18} color={colors.textSecondary} />
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
            paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + (isSmall ? 8 : 16),
            paddingHorizontal: isSmall ? 12 : 20,
          },
        ]}
      >
        <Pressable
          onPress={onComplete}
          style={[styles.getStartedBtn, { backgroundColor: colors.accent, paddingVertical: isSmall ? 12 : 16 }]}
        >
          <Text style={[styles.getStartedText, { fontSize: isSmall ? 14 : 17 }]}>
            {followedIds.size > 0
              ? `Get Started (${followedIds.size} following)`
              : "Skip & Get Started"}
          </Text>
          <Ionicons name="arrow-forward" size={isSmall ? 16 : 20} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

function PageIndicator({ total, current }: { total: number; current: number }) {
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

function OnboardingPage({ item, width, isSmall, topPadding }: { item: PageData; width: number; isSmall: boolean; topPadding: number }) {
  const iconSize = isSmall ? 40 : 64;
  const containerSize = isSmall ? 80 : 120;

  return (
    <LinearGradient
      colors={item.gradient}
      style={[styles.page, { width }]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
    >
      <View
        style={[
          styles.pageContent,
          {
            paddingTop: topPadding,
            paddingHorizontal: isSmall ? 24 : 40,
          },
        ]}
      >
        <View style={[styles.iconContainer, { width: containerSize, height: containerSize, borderRadius: containerSize / 2, marginBottom: isSmall ? 20 : 36 }]}>
          {item.iconSet === "material" ? (
            <MaterialCommunityIcons name={item.iconName as any} size={iconSize} color="#fff" />
          ) : (
            <Ionicons name={item.iconName as any} size={iconSize} color="#fff" />
          )}
        </View>
        <Text style={[styles.pageTitle, { fontSize: isSmall ? 22 : 28, marginBottom: isSmall ? 10 : 16 }]}>
          {item.title}
        </Text>
        <Text style={[styles.pageSubtitle, { fontSize: isSmall ? 14 : 16, lineHeight: isSmall ? 20 : 24, maxWidth: isSmall ? 280 : 340 }]}>
          {item.subtitle}
        </Text>
      </View>
    </LinearGradient>
  );
}

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isSmall = height < SMALL_HEIGHT;
  const contentWidth = Platform.OS === "web" ? Math.min(width, 480) : width;
  const [currentPage, setCurrentPage] = useState(0);
  const [showFollowStep, setShowFollowStep] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const completeOnboarding = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    router.replace("/(tabs)");
  }, []);

  const goToNext = useCallback(() => {
    lightHaptic();
    if (currentPage < PAGE_DATA.length - 1) {
      const next = currentPage + 1;
      setCurrentPage(next);
      flatListRef.current?.scrollToIndex({ index: next, animated: true });
    } else {
      setShowFollowStep(true);
    }
  }, [currentPage]);

  const handleScroll = useCallback((e: any) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / contentWidth);
    if (idx >= 0 && idx < PAGE_DATA.length) {
      setCurrentPage(idx);
    }
  }, [contentWidth]);

  if (showFollowStep) {
    return <FollowStep onComplete={completeOnboarding} />;
  }

  const page = PAGE_DATA[currentPage];
  const topPadding = Platform.OS === "web" ? 67 : insets.top + (isSmall ? 16 : 40);

  return (
    <View style={styles.container}>
      <FlatList
        ref={flatListRef}
        data={PAGE_DATA}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        keyExtractor={(item) => item.id}
        getItemLayout={(_, index) => ({
          length: contentWidth,
          offset: contentWidth * index,
          index,
        })}
        snapToInterval={contentWidth}
        decelerationRate="fast"
        style={{ flex: 1 }}
        renderItem={({ item }) => (
          <OnboardingPage item={item} width={contentWidth} isSmall={isSmall} topPadding={topPadding} />
        )}
      />

      <LinearGradient
        colors={page.gradient}
        style={[
          styles.bottomBar,
          {
            paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + (isSmall ? 10 : 20),
            paddingTop: isSmall ? 12 : 20,
          },
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      >
        <PageIndicator total={PAGE_DATA.length} current={currentPage} />

        <View style={styles.bottomActions}>
          <Pressable onPress={completeOnboarding} style={styles.skipBtn}>
            <Text style={[styles.skipText, { fontSize: isSmall ? 13 : 15 }]}>Skip</Text>
          </Pressable>

          <Pressable onPress={goToNext} style={[styles.nextBtn, isSmall ? { paddingVertical: 10, paddingHorizontal: 20 } : {}]}>
            <Text style={[styles.nextText, { fontSize: isSmall ? 14 : 16 }]}>
              {currentPage === PAGE_DATA.length - 1 ? "Choose Shiurim" : "Next"}
            </Text>
            <Ionicons name="arrow-forward" size={isSmall ? 16 : 18} color="#fff" />
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
    maxWidth: 480,
  },
  iconContainer: {
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  pageTitle: {
    fontWeight: "800" as const,
    color: "#fff",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  pageSubtitle: {
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
  },
  bottomBar: {
    paddingHorizontal: 24,
  },
  indicators: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
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
    fontWeight: "600" as const,
    color: "#fff",
  },
  followContainer: {
    flex: 1,
  },
  followHeader: {
    alignItems: "center",
  },
  followTitle: {
    fontWeight: "700" as const,
    textAlign: "center",
  },
  followSubtitle: {
    textAlign: "center",
    marginTop: 6,
    lineHeight: 18,
    maxWidth: 300,
  },
  feedList: {
    paddingHorizontal: 16,
  },
  feedItem: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
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
    fontWeight: "600" as const,
  },
  feedAuthor: {
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
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.05)",
  },
  getStartedBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
  },
  getStartedText: {
    fontWeight: "700" as const,
    color: "#fff",
  },
});
