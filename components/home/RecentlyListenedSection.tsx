import React from "react";
import { View, StyleSheet } from "react-native";
import EpisodeItem from "@/components/EpisodeItem";
import SectionHeader from "./SectionHeader";
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
      <SectionHeader title="Recently Listened" colors={colors} />
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
    marginBottom: 28,
  },
});
