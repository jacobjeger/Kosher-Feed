import React from "react";
import { View, Text, StyleSheet } from "react-native";
import EpisodeItem from "@/components/EpisodeItem";
import type { Feed, Episode } from "@/lib/types";

interface Props {
  items: { episode: Episode; feed: Feed }[];
  colors: any;
  isOnline: boolean;
}

export default React.memo(function RecentlyListenedSection({ items, colors, isOnline }: Props) {
  if (items.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>Recently Listened</Text>
      <View style={{ paddingHorizontal: 20 }}>
        {items.map(({ episode, feed }) => (
          <EpisodeItem key={episode.id} episode={episode} feed={feed} showFeedTitle isOnline={isOnline} />
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    marginBottom: 22,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700" as const,
    paddingHorizontal: 20,
    marginBottom: 10,
  },
});
