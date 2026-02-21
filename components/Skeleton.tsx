import React, { useEffect, useRef } from "react";
import { View, StyleSheet, Animated as RNAnimated, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";

function SkeletonPulse({ style }: { style?: any }) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const opacity = useRef(new RNAnimated.Value(0.3)).current;

  useEffect(() => {
    const animation = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        RNAnimated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <RNAnimated.View style={[{ backgroundColor: colors.surfaceAlt, borderRadius: 8, opacity }, style]} />
  );
}

export function FeedCardSkeleton() {
  return (
    <View style={skeletonStyles.feedCard}>
      <SkeletonPulse style={skeletonStyles.feedImage} />
      <SkeletonPulse style={skeletonStyles.feedTitle} />
      <SkeletonPulse style={skeletonStyles.feedSubtitle} />
    </View>
  );
}

export function EpisodeItemSkeleton() {
  return (
    <View style={skeletonStyles.episodeItem}>
      <SkeletonPulse style={skeletonStyles.episodeImage} />
      <View style={skeletonStyles.episodeInfo}>
        <SkeletonPulse style={skeletonStyles.episodeTitle} />
        <SkeletonPulse style={skeletonStyles.episodeMeta} />
        <SkeletonPulse style={skeletonStyles.episodeDesc} />
      </View>
    </View>
  );
}

export function FeedRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <View style={skeletonStyles.feedRow}>
      {Array.from({ length: count }).map((_, i) => (
        <FeedCardSkeleton key={i} />
      ))}
    </View>
  );
}

export function HomeScreenSkeleton() {
  return (
    <View style={skeletonStyles.homeContainer}>
      <SkeletonPulse style={skeletonStyles.searchBar} />
      <SkeletonPulse style={skeletonStyles.carousel} />
      <View style={skeletonStyles.section}>
        <SkeletonPulse style={skeletonStyles.sectionTitle} />
        <FeedRowSkeleton />
      </View>
      <View style={skeletonStyles.section}>
        <SkeletonPulse style={skeletonStyles.sectionTitle} />
        {Array.from({ length: 3 }).map((_, i) => (
          <EpisodeItemSkeleton key={i} />
        ))}
      </View>
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  feedCard: {
    width: 130,
    marginRight: 12,
  },
  feedImage: {
    width: 130,
    height: 130,
    borderRadius: 12,
    marginBottom: 8,
  },
  feedTitle: {
    height: 14,
    width: "80%" as any,
    borderRadius: 4,
    marginBottom: 4,
  },
  feedSubtitle: {
    height: 12,
    width: "60%" as any,
    borderRadius: 4,
  },
  episodeItem: {
    flexDirection: "row" as const,
    padding: 12,
    marginBottom: 8,
    gap: 12,
  },
  episodeImage: {
    width: 56,
    height: 56,
    borderRadius: 8,
  },
  episodeInfo: {
    flex: 1,
    gap: 6,
  },
  episodeTitle: {
    height: 16,
    width: "90%" as any,
    borderRadius: 4,
  },
  episodeMeta: {
    height: 12,
    width: "50%" as any,
    borderRadius: 4,
  },
  episodeDesc: {
    height: 12,
    width: "70%" as any,
    borderRadius: 4,
  },
  feedRow: {
    flexDirection: "row" as const,
    paddingHorizontal: 20,
  },
  homeContainer: {
    padding: 20,
    gap: 24,
  },
  searchBar: {
    height: 44,
    borderRadius: 12,
  },
  carousel: {
    height: 180,
    borderRadius: 20,
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    height: 20,
    width: 150,
    borderRadius: 4,
  },
});
