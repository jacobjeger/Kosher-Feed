import React from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme, Dimensions } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import type { Feed } from "@/lib/types";
import { router } from "expo-router";

interface Props {
  feed: Feed;
  size?: "small" | "medium" | "featured";
}

const SCREEN_WIDTH = Dimensions.get("window").width;

export default function PodcastCard({ feed, size = "small" }: Props) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  if (size === "featured") {
    return (
      <Pressable
        style={({ pressed }) => [
          styles.featuredContainer,
          { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
        ]}
        onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
      >
        {feed.imageUrl ? (
          <Image source={{ uri: feed.imageUrl }} style={styles.featuredImage} contentFit="cover" />
        ) : (
          <View style={[styles.featuredImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
            <Ionicons name="mic" size={48} color={colors.textSecondary} />
          </View>
        )}
        <View style={styles.featuredOverlay}>
          <View style={styles.featuredBadge}>
            <Ionicons name="star" size={10} color="#f59e0b" />
            <Text style={styles.featuredBadgeText}>Featured</Text>
          </View>
        </View>
        <View style={styles.featuredInfo}>
          <Text style={[styles.featuredTitle, { color: colors.text }]} numberOfLines={1}>
            {feed.title}
          </Text>
          {feed.author && (
            <Text style={[styles.featuredAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
              {feed.author}
            </Text>
          )}
          {feed.description && (
            <Text style={[styles.featuredDesc, { color: colors.textSecondary }]} numberOfLines={2}>
              {feed.description}
            </Text>
          )}
        </View>
      </Pressable>
    );
  }

  if (size === "medium") {
    return (
      <Pressable
        style={({ pressed }) => [
          styles.mediumContainer,
          { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
        ]}
        onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
      >
        {feed.imageUrl ? (
          <Image source={{ uri: feed.imageUrl }} style={styles.mediumImage} contentFit="cover" />
        ) : (
          <View style={[styles.mediumImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
            <Ionicons name="mic" size={28} color={colors.textSecondary} />
          </View>
        )}
        <View style={styles.mediumInfo}>
          <Text style={[styles.mediumTitle, { color: colors.text }]} numberOfLines={2}>
            {feed.title}
          </Text>
          {feed.author && (
            <Text style={[styles.mediumAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
              {feed.author}
            </Text>
          )}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      style={({ pressed }) => [
        styles.smallContainer,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
      ]}
      onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.smallImage} contentFit="cover" />
      ) : (
        <View style={[styles.smallImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={24} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.smallInfo}>
        <Text style={[styles.smallTitle, { color: colors.text }]} numberOfLines={2}>
          {feed.title}
        </Text>
        {feed.author && (
          <Text style={[styles.smallAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
            {feed.author}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  featuredContainer: {
    width: SCREEN_WIDTH - 40,
    marginRight: 16,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  featuredImage: {
    width: "100%" as any,
    height: 180,
  },
  featuredOverlay: {
    position: "absolute",
    top: 12,
    left: 12,
  },
  featuredBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  featuredBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  featuredInfo: {
    padding: 14,
    gap: 4,
  },
  featuredTitle: {
    fontSize: 17,
    fontWeight: "700" as const,
  },
  featuredAuthor: {
    fontSize: 13,
  },
  featuredDesc: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },

  mediumContainer: {
    flexDirection: "row",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 10,
  },
  mediumImage: {
    width: 80,
    height: 80,
  },
  mediumInfo: {
    flex: 1,
    padding: 12,
    justifyContent: "center",
    gap: 4,
  },
  mediumTitle: {
    fontSize: 14,
    fontWeight: "600" as const,
    lineHeight: 18,
  },
  mediumAuthor: {
    fontSize: 12,
  },

  smallContainer: {
    width: 140,
    marginRight: 12,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  smallImage: {
    width: "100%" as any,
    height: 140,
  },
  smallInfo: {
    padding: 10,
    gap: 3,
  },
  smallTitle: {
    fontSize: 13,
    fontWeight: "600" as const,
    lineHeight: 16,
  },
  smallAuthor: {
    fontSize: 11,
  },
});
