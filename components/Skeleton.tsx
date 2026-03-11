import React, { useEffect } from "react";
import { View, StyleSheet, Platform } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";

function SkeletonPulse({ style }: { style?: any }) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const translateX = useSharedValue(-1);

  useEffect(() => {
    translateX.value = withRepeat(
      withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value * 200 }],
  }));

  return (
    <View style={[{ backgroundColor: colors.surfaceAlt, borderRadius: 8, overflow: "hidden" }, style]}>
      <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
        <LinearGradient
          colors={[
            "transparent",
            isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.5)",
            "transparent",
          ]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[StyleSheet.absoluteFill, { width: 200 }]}
        />
      </Animated.View>
    </View>
  );
}

export function ContinueCardSkeleton() {
  return (
    <View style={skeletonStyles.continueCard}>
      <SkeletonPulse style={skeletonStyles.continueImage} />
      <View style={skeletonStyles.continueInfo}>
        <SkeletonPulse style={{ height: 12, width: "90%", borderRadius: 4 }} />
        <SkeletonPulse style={{ height: 10, width: "60%", borderRadius: 4 }} />
        <SkeletonPulse style={{ height: 3, width: "100%", borderRadius: 2, marginTop: 4 }} />
      </View>
    </View>
  );
}

export function TrendingCardSkeleton() {
  return (
    <View style={skeletonStyles.trendingCard}>
      <SkeletonPulse style={skeletonStyles.trendingRank} />
      <SkeletonPulse style={skeletonStyles.trendingImage} />
      <View style={skeletonStyles.trendingInfo}>
        <SkeletonPulse style={{ height: 10, width: "40%", borderRadius: 4 }} />
        <SkeletonPulse style={{ height: 14, width: "80%", borderRadius: 4 }} />
        <SkeletonPulse style={{ height: 10, width: "30%", borderRadius: 4 }} />
      </View>
      <SkeletonPulse style={{ width: 32, height: 32, borderRadius: 16 }} />
    </View>
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
      <SkeletonPulse style={skeletonStyles.episodePlayBtn} />
      <View style={skeletonStyles.episodeInfo}>
        <SkeletonPulse style={skeletonStyles.episodeTitle} />
        <SkeletonPulse style={skeletonStyles.episodeMeta} />
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
        <View style={{ flexDirection: "row", paddingHorizontal: 20 }}>
          <ContinueCardSkeleton />
          <ContinueCardSkeleton />
        </View>
      </View>
      <View style={skeletonStyles.section}>
        <SkeletonPulse style={skeletonStyles.sectionTitle} />
        {Array.from({ length: 3 }).map((_, i) => (
          <TrendingCardSkeleton key={i} />
        ))}
      </View>
      <View style={skeletonStyles.section}>
        <SkeletonPulse style={skeletonStyles.sectionTitle} />
        <FeedRowSkeleton />
      </View>
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  continueCard: {
    width: 145,
    borderRadius: 14,
    overflow: "hidden",
    marginRight: 12,
  },
  continueImage: {
    width: "100%" as any,
    height: 85,
    borderRadius: 0,
  },
  continueInfo: {
    padding: 10,
    gap: 6,
  },
  trendingCard: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    borderRadius: 14,
    paddingRight: 12,
    paddingVertical: 10,
    marginBottom: 10,
    marginHorizontal: 20,
    gap: 10,
  },
  trendingRank: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginLeft: 12,
  },
  trendingImage: {
    width: 52,
    height: 52,
    borderRadius: 10,
  },
  trendingInfo: {
    flex: 1,
    gap: 4,
  },
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
    padding: 10,
    marginBottom: 6,
    gap: 8,
    alignItems: "center" as const,
  },
  episodePlayBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  episodeInfo: {
    flex: 1,
    gap: 6,
  },
  episodeTitle: {
    height: 14,
    width: "90%" as any,
    borderRadius: 4,
  },
  episodeMeta: {
    height: 11,
    width: "50%" as any,
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
    marginLeft: 20,
  },
});
