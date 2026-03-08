import React from "react";
import { View, Text, FlatList, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import PodcastCard from "@/components/PodcastCard";
import type { Feed } from "@/lib/types";

interface Props {
  feeds: Feed[];
  colors: any;
}

export default React.memo(function RecommendedSection({ feeds, colors }: Props) {
  if (feeds.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Ionicons name="sparkles" size={18} color={colors.accent} />
        <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0 }]}>Recommended for You</Text>
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

const styles = StyleSheet.create({
  section: {
    marginBottom: 22,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
    paddingHorizontal: 20,
    marginBottom: 10,
  },
});
