import React from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import PodcastCard from "@/components/PodcastCard";
import { lightHaptic } from "@/lib/haptics";
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
      <View style={styles.sectionHeaderRowSpaced}>
        <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0, marginBottom: 0 }]}>All Shiurim</Text>
        <Pressable
          onPress={() => { lightHaptic(); router.push("/all-shiurim"); }}
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
        renderItem={({ item }) => <PodcastCard feed={item} size="small" hasNewEpisodes={feedsWithNew.has(item.id)} />}
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
