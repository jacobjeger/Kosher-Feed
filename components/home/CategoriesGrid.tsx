import React from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import PodcastCard from "@/components/PodcastCard";
import { lightHaptic } from "@/lib/haptics";
import type { Feed, Category } from "@/lib/types";

const CategorySection = React.memo(function CategorySection({ category, feeds, colors }: { category: Category; feeds: Feed[]; colors: any }) {
  if (feeds.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRowSpaced}>
        <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0, marginBottom: 0 }]}>{category.name}</Text>
        <Pressable
          onPress={() => { lightHaptic(); router.push({ pathname: "/category/[id]" as any, params: { id: category.id, name: category.name } }); }}
          style={({ pressed }) => [styles.seeAllBtn, { backgroundColor: colors.accentLight, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={[styles.seeAllText, { color: colors.accent }]}>See All</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.accent} />
        </Pressable>
      </View>
      <FlatList
        horizontal
        data={feeds}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <PodcastCard feed={item} size="small" />}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={3}
        removeClippedSubviews={Platform.OS !== "web"}
      />
    </View>
  );
});

interface Props {
  categories: Category[];
  allFeeds: Feed[];
  colors: any;
}

export default React.memo(function CategoriesGrid({ categories, allFeeds, colors }: Props) {
  if (categories.length === 0) return null;

  return (
    <>
      {categories.map(cat => {
        const catFeeds = allFeeds.filter(f =>
          (f.categoryIds && f.categoryIds.includes(cat.id)) || f.categoryId === cat.id
        );
        return <CategorySection key={cat.id} category={cat} feeds={catFeeds} colors={colors} />;
      })}
    </>
  );
});

const styles = StyleSheet.create({
  section: {
    marginBottom: 22,
  },
  sectionHeaderRowSpaced: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  seeAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  seeAllText: {
    fontSize: 13,
    fontWeight: "600" as const,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
    paddingHorizontal: 20,
    marginBottom: 10,
  },
});
