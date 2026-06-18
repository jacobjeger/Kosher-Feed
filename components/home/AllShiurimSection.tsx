import React, { useCallback } from "react";
import { View, FlatList, StyleSheet, Platform } from "react-native";
import { router } from "expo-router";
import PodcastCard from "@/components/PodcastCard";
import SectionHeader from "./SectionHeader";
import type { Feed } from "@/lib/types";

interface Props {
  feeds: Feed[];
  feedsWithNew: Set<string>;
  colors: any;
}

export default React.memo(function AllShiurimSection({ feeds, feedsWithNew, colors }: Props) {
  // renderItem stabilized on [feedsWithNew] so it only recomputes when the
  // new-episode set changes. Inline arrow was breaking child memoization.
  const renderItem = useCallback(({ item }: { item: Feed }) => (
    <PodcastCard feed={item} size="small" hasNewEpisodes={feedsWithNew.has(item.id)} />
  ), [feedsWithNew]);
  const keyExtractor = useCallback((item: Feed) => item.id, []);
  const onSeeAll = useCallback(() => router.push("/all-shiurim"), []);

  if (feeds.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader
        title="All Shiurim"
        colors={colors}
        onSeeAll={onSeeAll}
      />
      <FlatList
        horizontal
        data={feeds}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, alignItems: "flex-start" }}
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={3}
        removeClippedSubviews={Platform.OS !== "web"}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    marginBottom: 28,
  },
});
