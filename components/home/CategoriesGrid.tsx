import React from "react";
import { View, FlatList, StyleSheet, Platform } from "react-native";
import { router } from "expo-router";
import PodcastCard from "@/components/PodcastCard";
import SectionHeader from "./SectionHeader";
import { lightHaptic } from "@/lib/haptics";
import type { Feed, Category } from "@/lib/types";

const CategorySection = React.memo(function CategorySection({ category, feeds, colors }: { category: Category; feeds: Feed[]; colors: any }) {
  if (feeds.length === 0) return null;
  return (
    <View style={styles.section}>
      <SectionHeader
        title={category.name}
        colors={colors}
        onSeeAll={() => { lightHaptic(); router.push({ pathname: "/category/[id]" as any, params: { id: category.id, name: category.name } }); }}
      />
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
    marginBottom: 28,
  },
});
