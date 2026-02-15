import React from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import type { Feed } from "@/lib/types";
import { router } from "expo-router";

interface Props {
  feed: Feed;
  size?: "small" | "large";
}

export default function PodcastCard({ feed, size = "small" }: Props) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  const isLarge = size === "large";

  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        isLarge ? styles.containerLarge : styles.containerSmall,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.9 : 1 },
      ]}
      onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
    >
      {feed.imageUrl ? (
        <Image
          source={{ uri: feed.imageUrl }}
          style={isLarge ? styles.imageLarge : styles.imageSmall}
          contentFit="cover"
        />
      ) : (
        <View style={[isLarge ? styles.imageLarge : styles.imageSmall, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={isLarge ? 32 : 24} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.info}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {feed.title}
        </Text>
        {feed.author && (
          <Text style={[styles.author, { color: colors.textSecondary }]} numberOfLines={1}>
            {feed.author}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  containerSmall: {
    width: 150,
    marginRight: 12,
  },
  containerLarge: {
    width: "100%" as any,
    flexDirection: "row",
    marginBottom: 10,
  },
  imageSmall: {
    width: "100%" as any,
    height: 150,
    borderTopLeftRadius: 11,
    borderTopRightRadius: 11,
  },
  imageLarge: {
    width: 72,
    height: 72,
    borderTopLeftRadius: 11,
    borderBottomLeftRadius: 11,
  },
  info: {
    padding: 10,
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 17,
  },
  author: {
    fontSize: 11,
  },
});
