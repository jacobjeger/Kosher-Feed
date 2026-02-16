import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Platform, ScrollView, ActivityIndicator } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { safeGoBack } from "@/lib/safe-back";
import { useQuery } from "@tanstack/react-query";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";

interface TopFeed {
  feedId: string;
  title: string;
  listenTime: number;
}

interface StatsData {
  totalListeningTime: number;
  episodesPlayed: number;
  currentStreak: number;
  longestStreak: number;
  topFeeds: TopFeed[];
}

function formatListeningTime(totalSeconds: number): { hours: number; minutes: number } {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return { hours, minutes };
}

function formatFeedTime(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(seconds / 60);
  return `${m}m`;
}

export default function StatsScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  const { data: stats, isLoading } = useQuery<StatsData>({
    queryKey: ["/api/stats", deviceId],
    enabled: !!deviceId,
  });

  const maxListenTime = stats?.topFeeds?.length
    ? Math.max(...stats.topFeeds.map((f) => f.listenTime))
    : 0;

  const time = stats ? formatListeningTime(stats.totalListeningTime) : { hours: 0, minutes: 0 };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === "web" ? 67 : 8) }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Your Stats</Text>
        <View style={{ width: 28 }} />
      </View>

      {isLoading || !deviceId ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading stats...</Text>
        </View>
      ) : !stats || (stats.totalListeningTime === 0 && stats.episodesPlayed === 0) ? (
        <View style={styles.emptyState}>
          <Ionicons name="stats-chart-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No Stats Yet</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            Start listening to shiurim to see your stats here
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollContent}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.heroCard, { backgroundColor: colors.accent }]}>
            <MaterialCommunityIcons name="headphones" size={28} color="rgba(255,255,255,0.7)" />
            <Text style={styles.heroLabel}>Total Listening Time</Text>
            <View style={styles.heroTimeRow}>
              <Text style={styles.heroNumber}>{time.hours}</Text>
              <Text style={styles.heroUnit}>hr</Text>
              <Text style={styles.heroNumber}>{time.minutes}</Text>
              <Text style={styles.heroUnit}>min</Text>
            </View>
          </View>

          <View style={styles.cardRow}>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
              <View style={[styles.iconCircle, { backgroundColor: colors.accentLight }]}>
                <Ionicons name="play-circle" size={22} color={colors.accent} />
              </View>
              <Text style={[styles.statNumber, { color: colors.text }]}>{stats.episodesPlayed}</Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Episodes</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
              <View style={[styles.iconCircle, { backgroundColor: isDark ? "rgba(16,185,129,0.15)" : "rgba(16,185,129,0.1)" }]}>
                <Ionicons name="flame" size={22} color={colors.success} />
              </View>
              <Text style={[styles.statNumber, { color: colors.text }]}>{stats.currentStreak}</Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Day Streak</Text>
            </View>
          </View>

          <View style={[styles.streakCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
            <View style={styles.streakRow}>
              <View style={styles.streakInfo}>
                <Ionicons name="trophy" size={20} color="#f59e0b" />
                <Text style={[styles.streakTitle, { color: colors.text }]}>Longest Streak</Text>
              </View>
              <Text style={[styles.streakValue, { color: colors.accent }]}>
                {stats.longestStreak} {stats.longestStreak === 1 ? "day" : "days"}
              </Text>
            </View>
          </View>

          {stats.topFeeds && stats.topFeeds.length > 0 && (
            <View style={styles.topFeedsSection}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Top Shiurim</Text>
              {stats.topFeeds.map((feed, index) => {
                const barWidth = maxListenTime > 0 ? (feed.listenTime / maxListenTime) * 100 : 0;
                return (
                  <View
                    key={feed.feedId}
                    style={[styles.feedItem, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
                  >
                    <View style={styles.feedRank}>
                      <Text style={[styles.feedRankText, { color: colors.accent }]}>{index + 1}</Text>
                    </View>
                    <View style={styles.feedInfo}>
                      <Text style={[styles.feedTitle, { color: colors.text }]} numberOfLines={1}>
                        {feed.title}
                      </Text>
                      <View style={styles.feedBarContainer}>
                        <View
                          style={[
                            styles.feedBar,
                            {
                              width: `${Math.max(barWidth, 5)}%` as any,
                              backgroundColor: colors.accent,
                              opacity: 1 - index * 0.15,
                            },
                          ]}
                        />
                      </View>
                    </View>
                    <Text style={[styles.feedTime, { color: colors.textSecondary }]}>
                      {formatFeedTime(feed.listenTime)}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700" as const,
  },
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  loadingText: {
    fontSize: 15,
    fontWeight: "500" as const,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
  },
  emptySubtitle: {
    fontSize: 15,
    fontWeight: "500" as const,
    textAlign: "center" as const,
    lineHeight: 22,
  },
  scrollContent: {
    flex: 1,
    paddingHorizontal: 20,
  },
  heroCard: {
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  heroLabel: {
    fontSize: 14,
    fontWeight: "600" as const,
    color: "rgba(255,255,255,0.8)",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
  },
  heroTimeRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
    marginTop: 4,
  },
  heroNumber: {
    fontSize: 48,
    fontWeight: "800" as const,
    color: "#ffffff",
  },
  heroUnit: {
    fontSize: 18,
    fontWeight: "600" as const,
    color: "rgba(255,255,255,0.7)",
    marginRight: 8,
  },
  cardRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  statNumber: {
    fontSize: 32,
    fontWeight: "800" as const,
  },
  statLabel: {
    fontSize: 13,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  streakCard: {
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    marginBottom: 24,
  },
  streakRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  streakInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  streakTitle: {
    fontSize: 16,
    fontWeight: "600" as const,
  },
  streakValue: {
    fontSize: 18,
    fontWeight: "700" as const,
  },
  topFeedsSection: {
    gap: 10,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700" as const,
    marginBottom: 4,
  },
  feedItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 14,
    gap: 12,
    borderWidth: 1,
  },
  feedRank: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  feedRankText: {
    fontSize: 15,
    fontWeight: "800" as const,
  },
  feedInfo: {
    flex: 1,
    gap: 6,
  },
  feedTitle: {
    fontSize: 15,
    fontWeight: "600" as const,
  },
  feedBarContainer: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(0,0,0,0.05)",
    overflow: "hidden" as const,
  },
  feedBar: {
    height: 6,
    borderRadius: 3,
  },
  feedTime: {
    fontSize: 13,
    fontWeight: "600" as const,
    minWidth: 40,
    textAlign: "right" as const,
  },
});
