import React from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { lightHaptic } from "@/lib/haptics";
import SectionHeader from "./SectionHeader";
import type { Feed } from "@/lib/types";

const MaggidShiurCard = React.memo(function MaggidShiurCard({ author, feeds, colors }: { author: string; feeds: Feed[]; colors: any }) {
  const imageUrl = feeds[0]?.imageUrl;
  return (
    <Pressable
      style={[styles.maggidCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
      onPress={() => { lightHaptic(); router.push({ pathname: "/maggid-shiur/[author]" as any, params: { author, feedIds: feeds.map(f => f.id).join(",") } }); }}
    >
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.maggidAvatar} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      ) : (
        <View style={[styles.maggidAvatar, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="person" size={24} color={colors.textSecondary} />
        </View>
      )}
      <Text style={[styles.maggidName, { color: colors.text }]} numberOfLines={2}>{author}</Text>
      <Text style={[styles.maggidCount, { color: colors.textSecondary }]}>{feeds.length} {feeds.length === 1 ? "shiur" : "shiurim"}</Text>
    </Pressable>
  );
});

interface Props {
  maggidShiurim: { author: string; feeds: Feed[] }[];
  colors: any;
}

export default React.memo(function MaggidShiurSection({ maggidShiurim, colors }: Props) {
  if (maggidShiurim.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader
        title="Maggidei Shiur"
        colors={colors}
        onSeeAll={() => router.push("/all-maggidei-shiur")}
      />
      <FlatList
        horizontal
        data={maggidShiurim}
        keyExtractor={(item) => item.author}
        renderItem={({ item }) => <MaggidShiurCard author={item.author} feeds={item.feeds} colors={colors} />}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20 }}
        initialNumToRender={6}
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
  maggidCard: {
    width: 110,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginRight: 12,
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  maggidAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    marginBottom: 8,
  },
  maggidName: {
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center" as const,
    lineHeight: 16,
    marginBottom: 2,
  },
  maggidCount: {
    fontSize: 11,
    textAlign: "center" as const,
  },
});
