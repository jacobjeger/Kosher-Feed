import React, { useMemo, useState, useCallback } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, TextInput, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import type { Feed, MaggidShiur } from "@/lib/types";
import { router } from "expo-router";
import { lightHaptic } from "@/lib/haptics";
import { safeGoBack } from "@/lib/safe-back";
import { ErrorBoundary } from "@/components/ErrorBoundary";

interface SpeakerGroup {
  author: string;
  feeds: Feed[];
  imageUrl?: string;
}

const SpeakerCard = React.memo(function SpeakerCard({ speaker, colors }: { speaker: SpeakerGroup; colors: any }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
      ]}
      onPress={() => {
        lightHaptic();
        router.push({
          pathname: "/maggid-shiur/[author]",
          params: { author: speaker.author, feedIds: speaker.feeds.map(f => f.id).join(",") },
        });
      }}
    >
      {speaker.imageUrl ? (
        <Image source={{ uri: speaker.imageUrl }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      ) : (
        <View style={[styles.avatar, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="person" size={28} color={colors.textSecondary} />
        </View>
      )}
      <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>{speaker.author}</Text>
      <Text style={[styles.count, { color: colors.textSecondary }]}>
        {speaker.feeds.length} {speaker.feeds.length === 1 ? "shiur" : "shiurim"}
      </Text>
    </Pressable>
  );
});

function AllMaggideiShiurInner() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [search, setSearch] = useState("");

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const maggidQuery = useQuery<MaggidShiur[]>({ queryKey: ["/api/feeds/maggid-shiur"] });
  const allFeeds = feedsQuery.data || [];
  const maggidData = maggidQuery.data || [];

  const speakers = useMemo(() => {
    const groups: SpeakerGroup[] = maggidData.map(m => ({
      author: m.author,
      feeds: m.feeds || allFeeds.filter(f => f.author?.toLowerCase() === m.author.toLowerCase()),
      imageUrl: m.imageUrl,
    }));
    const sorted = groups.sort((a, b) => a.author.localeCompare(b.author));
    if (!search.trim()) return sorted;
    const q = search.toLowerCase().trim();
    return sorted.filter(s => s.author.toLowerCase().includes(q));
  }, [maggidData, allFeeds, search]);

  const renderItem = useCallback(({ item }: { item: SpeakerGroup }) => (
    <SpeakerCard speaker={item} colors={colors} />
  ), [colors]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 12 : insets.top + 8 }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Maggidei Shiur</Text>
        <View style={{ width: 34 }} />
      </View>

      <View style={[styles.searchContainer, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.textSecondary} style={{ marginLeft: 14 }} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search speakers..."
          placeholderTextColor={colors.textSecondary}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} style={styles.searchClear}>
            <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>

      <Text style={[styles.countText, { color: colors.textSecondary }]}>
        {speakers.length} {speakers.length === 1 ? "speaker" : "speakers"}
      </Text>

      <FlatList
        data={speakers}
        keyExtractor={(item) => item.author}
        renderItem={renderItem}
        numColumns={3}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 20 }}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={Platform.OS !== "web"}
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={40} color={colors.textSecondary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {search.trim() ? `No results for "${search}"` : "No speakers found"}
            </Text>
          </View>
        }
      />
    </View>
  );
}

export default function AllMaggideiShiur() {
  return (
    <ErrorBoundary>
      <AllMaggideiShiurInner />
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
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700" as const,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    height: 44,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 0,
    height: 44,
  },
  searchClear: {
    padding: 10,
  },
  countText: {
    fontSize: 12,
    fontWeight: "500" as const,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  gridRow: {
    gap: 12,
    marginBottom: 12,
  },
  card: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    alignItems: "center" as const,
    paddingVertical: 16,
    paddingHorizontal: 8,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    marginBottom: 10,
  },
  name: {
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center" as const,
    lineHeight: 17,
    marginBottom: 2,
  },
  count: {
    fontSize: 11,
    textAlign: "center" as const,
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
