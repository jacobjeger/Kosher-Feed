import React from "react";
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
  if (feeds.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader
        title="All Shiurim"
        colors={colors}
        onSeeAll={() => router.push("/all-shiurim")}
      />
      <FlatList
        horizontal
        data={feeds}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <PodcastCard feed={item} size="small" hasNewEpisodes={feedsWithNew.has(item.id)} />}
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
