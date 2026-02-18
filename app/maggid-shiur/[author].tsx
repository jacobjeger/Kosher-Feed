import React from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { safeGoBack } from "@/lib/safe-back";
import Colors from "@/constants/colors";
import type { Feed } from "@/lib/types";
import { lightHaptic } from "@/lib/haptics";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
import PodcastCard from "@/components/PodcastCard";

function MaggidShiurDetailInner() {
  const { author, feedIds } = useLocalSearchParams<{ author: string; feedIds: string }>();
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const allFeeds = feedsQuery.data || [];

  const feedIdList = feedIds?.split(",") || [];
  const authorFeeds = allFeeds.filter(f => feedIdList.includes(f.id));

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 : insets.top + 8, borderBottomColor: colors.border }]}>
        <Pressable onPress={() => { lightHaptic(); safeGoBack(); }} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {author || "Speaker"}
        </Text>
        <View style={{ width: 32 }} />
      </View>

      <FlatList
        data={authorFeeds}
        keyExtractor={(item) => item.id}
        numColumns={2}
        contentContainerStyle={styles.gridContent}
        columnWrapperStyle={styles.gridRow}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [
              styles.feedCard,
              { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
            ]}
            onPress={() => { lightHaptic(); router.push(`/podcast/${item.id}`); }}
          >
            {item.imageUrl ? (
              <Image source={{ uri: item.imageUrl }} style={styles.feedImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
            ) : (
              <View style={[styles.feedImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
                <Ionicons name="mic" size={32} color={colors.textSecondary} />
              </View>
            )}
            <View style={styles.feedInfo}>
              <Text style={[styles.feedTitle, { color: colors.text }]} numberOfLines={2}>
                {item.title}
              </Text>
              {item.description ? (
                <Text style={[styles.feedDesc, { color: colors.textSecondary }]} numberOfLines={2}>
                  {stripHtml(item.description)}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="person-outline" size={40} color={colors.textSecondary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No shiurim found for this speaker.</Text>
          </View>
        }
        contentInsetAdjustmentBehavior="never"
      />
    </View>
  );
}

export default function MaggidShiurDetail() {
  return (
    <ErrorBoundary>
      <MaggidShiurDetailInner />
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700" as const,
    textAlign: "center" as const,
  },
  gridContent: {
    padding: 16,
  },
  gridRow: {
    gap: 12,
    marginBottom: 12,
  },
  feedCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  feedImage: {
    width: "100%" as any,
    aspectRatio: 1,
  },
  feedInfo: {
    padding: 10,
    gap: 4,
  },
  feedTitle: {
    fontSize: 14,
    fontWeight: "600" as const,
    lineHeight: 18,
  },
  feedDesc: {
    fontSize: 12,
    lineHeight: 16,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 14,
    textAlign: "center" as const,
  },
});
