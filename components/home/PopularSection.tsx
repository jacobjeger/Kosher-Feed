import React from "react";
import { View, FlatList, StyleSheet, Platform } from "react-native";
import PodcastCard from "@/components/PodcastCard";
import SectionHeader from "./SectionHeader";
import type { Feed } from "@/lib/types";

interface Props {
  feeds: Feed[];
  colors: any;
}

export default React.memo(function PopularSection({ feeds, colors }: Props) {
  if (feeds.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title="Popular Shiurim" icon="trending-up" iconColor="#8b5cf6" colors={colors} />
      <FlatList
        horizontal
        data={feeds}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <PodcastCard feed={item} size="small" />}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, alignItems: "flex-start" }}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
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
