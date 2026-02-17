import React, { useMemo, useState, useCallback } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, TextInput, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import type { Feed, Category } from "@/lib/types";
import { lightHaptic } from "@/lib/haptics";
import { safeGoBack } from "@/lib/safe-back";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const ShiurRow = React.memo(function ShiurRow({ feed, colors }: { feed: Feed; colors: any }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surfaceAlt : colors.surface, borderColor: colors.cardBorder },
      ]}
      onPress={() => { lightHaptic(); router.push(`/podcast/${feed.id}`); }}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.rowImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      ) : (
        <View style={[styles.rowImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={22} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.rowInfo}>
        <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>{feed.title}</Text>
        {feed.author ? (
          <Text style={[styles.rowAuthor, { color: colors.textSecondary }]} numberOfLines={1}>{feed.author}</Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </Pressable>
  );
});

function CategoryDetailInner() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [search, setSearch] = useState("");

  const feedsQuery = useQuery<Feed[]>({ queryKey: ["/api/feeds"] });
  const allFeeds = feedsQuery.data || [];

  const categoryFeeds = useMemo(() => {
    const filtered = allFeeds.filter(
      f => (f.categoryIds && f.categoryIds.includes(id!)) || f.categoryId === id
    );
    const sorted = filtered.sort((a, b) => a.title.localeCompare(b.title));
    if (!search.trim()) return sorted;
    const q = search.toLowerCase().trim();
    return sorted.filter(
      f => f.title.toLowerCase().includes(q) || (f.author && f.author.toLowerCase().includes(q))
    );
  }, [allFeeds, id, search]);

  const renderItem = useCallback(({ item }: { item: Feed }) => (
    <ShiurRow feed={item} colors={colors} />
  ), [colors]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 12 : insets.top + 8 }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{name || "Category"}</Text>
        <View style={{ width: 34 }} />
      </View>

      <View style={[styles.searchContainer, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.textSecondary} style={{ marginLeft: 14 }} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search shiurim..."
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
        {categoryFeeds.length} {categoryFeeds.length === 1 ? "shiur" : "shiurim"}
      </Text>

      <FlatList
        data={categoryFeeds}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 20 }}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={Platform.OS !== "web"}
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="search-outline" size={40} color={colors.textSecondary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {search.trim() ? `No results for "${search}"` : "No shiurim in this category"}
            </Text>
          </View>
        }
      />
    </View>
  );
}

export default function CategoryDetail() {
  return (
    <ErrorBoundary>
      <CategoryDetailInner />
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
    flex: 1,
    textAlign: "center" as const,
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 8,
    paddingRight: 14,
  },
  rowImage: {
    width: 56,
    height: 56,
    borderRadius: 12,
    marginLeft: 10,
    marginVertical: 10,
  },
  rowInfo: {
    flex: 1,
    paddingHorizontal: 14,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "600" as const,
  },
  rowAuthor: {
    fontSize: 12,
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
