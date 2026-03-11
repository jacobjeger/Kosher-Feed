import React, { useState, useRef, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, useWindowDimensions, Animated as RNAnimated, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { cardShadow } from "@/constants/shadows";
import type { Feed } from "@/lib/types";
import { router } from "expo-router";

interface Props {
  feed: Feed;
  size?: "small" | "medium" | "featured";
  hasNewEpisodes?: boolean;
}

function PodcastCard({ feed, size = "small", hasNewEpisodes }: Props) {
  const { width } = useWindowDimensions();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [imgError, setImgError] = useState(false);

  const scaleAnim = useRef(new RNAnimated.Value(1)).current;
  const isNative = Platform.OS !== "web";

  const onPressIn = useCallback(() => {
    if (!isNative) return;
    RNAnimated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true, tension: 150, friction: 8 }).start();
  }, [scaleAnim, isNative]);

  const onPressOut = useCallback(() => {
    if (!isNative) return;
    RNAnimated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 150, friction: 8 }).start();
  }, [scaleAnim, isNative]);

  const networkBadge = feed.sourceNetwork ? (
    <View style={styles.networkBadge}>
      <Ionicons name="globe-outline" size={9} color="#fff" />
      <Text style={styles.networkBadgeText}>{feed.sourceNetwork}</Text>
    </View>
  ) : null;

  if (size === "featured") {
    return (
      <Pressable
        style={({ pressed }) => [
          styles.featuredContainer,
          { width: width - 40, backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
        ]}
        onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
      >
        <View>
          {feed.imageUrl && !imgError ? (
            <Image source={{ uri: feed.imageUrl }} style={styles.featuredImage} contentFit="cover" cachePolicy="memory-disk" onError={() => setImgError(true)} />
          ) : (
            <View style={[styles.featuredImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="mic" size={48} color={colors.textSecondary} />
            </View>
          )}
          {hasNewEpisodes && <View style={styles.newBadge} />}
        </View>
        <View style={styles.featuredOverlay}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <View style={styles.featuredBadge}>
              <Ionicons name="star" size={10} color="#f59e0b" />
              <Text style={styles.featuredBadgeText}>Featured</Text>
            </View>
            {networkBadge}
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
        <View>
          {feed.imageUrl && !imgError ? (
            <Image source={{ uri: feed.imageUrl }} style={styles.mediumImage} contentFit="cover" cachePolicy="memory-disk" onError={() => setImgError(true)} />
          ) : (
            <View style={[styles.mediumImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="mic" size={28} color={colors.textSecondary} />
            </View>
          )}
          {hasNewEpisodes && <View style={styles.newBadge} />}
        </View>
        <View style={styles.mediumInfo}>
          <Text style={[styles.mediumTitle, { color: colors.text }]} numberOfLines={2}>
            {feed.title}
          </Text>
          {feed.author && (
            <Text style={[styles.mediumAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
              {feed.author}
            </Text>
          )}
          {networkBadge}
        </View>
      </Pressable>
    );
  }

  return (
    <RNAnimated.View style={isNative ? { transform: [{ scale: scaleAnim }] } : undefined}>
      <Pressable
        style={({ pressed }) => [
          styles.smallContainer,
          { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.95 : 1 },
        ]}
        onPress={() => router.push({ pathname: "/podcast/[id]", params: { id: feed.id } })}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
      >
        <View>
          {feed.imageUrl && !imgError ? (
            <Image source={{ uri: feed.imageUrl }} style={styles.smallImage} contentFit="cover" cachePolicy="memory-disk" onError={() => setImgError(true)} />
          ) : (
            <View style={[styles.smallImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="mic" size={24} color={colors.textSecondary} />
            </View>
          )}
          {hasNewEpisodes && <View style={styles.newBadge} />}
        </View>
        <View style={styles.smallInfo}>
          <Text style={[styles.smallTitle, { color: colors.text }]} numberOfLines={2}>
            {feed.title}
          </Text>
          {feed.author && (
            <Text style={[styles.smallAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
              {feed.author}
            </Text>
          )}
          {networkBadge}
        </View>
      </Pressable>
    </RNAnimated.View>
  );
}

const styles = StyleSheet.create({
  featuredContainer: {
    marginRight: 16,
    borderRadius: 16,
    borderWidth: Platform.OS === "web" ? 0 : 1,
    overflow: "hidden",
    ...cardShadow("md"),
    ...(Platform.OS === "web" ? { transition: "transform 0.2s ease, box-shadow 0.2s ease" as any, cursor: "pointer" as any } : {}),
  },
  featuredImage: {
    width: "100%" as any,
    height: 160,
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
    borderWidth: Platform.OS === "web" ? 0 : 1,
    overflow: "hidden",
    marginBottom: 10,
    ...cardShadow("sm"),
    ...(Platform.OS === "web" ? { transition: "transform 0.2s ease, box-shadow 0.2s ease" as any, cursor: "pointer" as any } : {}),
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
    width: Platform.OS === "web" ? 150 : 130,
    marginRight: 12,
    borderRadius: 14,
    borderWidth: Platform.OS === "web" ? 0 : 1,
    overflow: "hidden",
    ...cardShadow("sm"),
    ...(Platform.OS === "web" ? { transition: "transform 0.2s ease, box-shadow 0.2s ease" as any, cursor: "pointer" as any } : {}),
  },
  smallImage: {
    width: "100%" as any,
    height: Platform.OS === "web" ? 140 : 120,
  },
  smallInfo: {
    padding: 10,
    gap: 3,
  },
  smallTitle: {
    fontSize: 13,
    fontWeight: "600" as const,
    lineHeight: 17,
  },
  smallAuthor: {
    fontSize: 11,
  },
  networkBadge: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    alignSelf: "flex-start" as const,
    gap: 3,
    backgroundColor: "rgba(37, 99, 235, 0.85)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 2,
  },
  networkBadgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "600" as const,
  },
  newBadge: {
    position: "absolute" as const,
    top: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ef4444",
    borderWidth: 1,
    borderColor: "#fff",
    zIndex: 10,
  },
});

export default React.memo(PodcastCard);
