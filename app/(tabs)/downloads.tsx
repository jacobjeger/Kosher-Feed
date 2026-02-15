import React from "react";
import { View, Text, FlatList, Pressable, StyleSheet, useColorScheme, Platform, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useDownloads } from "@/contexts/DownloadsContext";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import Colors from "@/constants/colors";
import type { DownloadedEpisode, Feed } from "@/lib/types";
import * as Haptics from "expo-haptics";

function DownloadItem({ item }: { item: DownloadedEpisode }) {
  const { playEpisode, currentEpisode, playback, pause, resume } = useAudioPlayer();
  const { removeDownload } = useDownloads();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  const isCurrentlyPlaying = currentEpisode?.id === item.id;

  const fakeFeed: Feed = {
    id: item.feedId,
    title: item.feedTitle,
    rssUrl: "",
    imageUrl: item.feedImageUrl,
    description: null,
    author: null,
    categoryId: null,
    isActive: true,
    lastFetchedAt: null,
    createdAt: "",
  };

  const episodeToPlay = {
    ...item,
    audioUrl: item.localUri || item.audioUrl,
  };

  const handlePlay = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isCurrentlyPlaying) {
      playback.isPlaying ? await pause() : await resume();
    } else {
      await playEpisode(episodeToPlay, fakeFeed);
    }
  };

  const handleRemove = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (Platform.OS === "web") {
      removeDownload(item.id);
      return;
    }
    Alert.alert(
      "Remove Download",
      "This will delete the downloaded episode from your device.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => removeDownload(item.id) },
      ]
    );
  };

  return (
    <Pressable
      style={({ pressed }) => [
        styles.downloadItem,
        { backgroundColor: pressed ? colors.surfaceAlt : colors.surface, borderColor: colors.cardBorder },
      ]}
      onPress={handlePlay}
    >
      <View style={[styles.playIcon, { backgroundColor: isCurrentlyPlaying ? colors.accent : colors.accentLight }]}>
        <Ionicons
          name={isCurrentlyPlaying && playback.isPlaying ? "pause" : "play"}
          size={16}
          color={isCurrentlyPlaying ? "#fff" : colors.accent}
        />
      </View>

      <View style={styles.itemInfo}>
        <Text style={[styles.itemFeed, { color: colors.accent }]} numberOfLines={1}>
          {item.feedTitle}
        </Text>
        <Text style={[styles.itemTitle, { color: colors.text }]} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={[styles.itemMeta, { color: colors.textSecondary }]}>
          Downloaded {new Date(item.downloadedAt).toLocaleDateString()}
        </Text>
      </View>

      <Pressable onPress={handleRemove} hitSlop={10} style={styles.removeBtn}>
        <Feather name="trash-2" size={18} color={colors.danger} />
      </Pressable>
    </Pressable>
  );
}

export default function DownloadsScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { downloads } = useDownloads();

  return (
    <FlatList
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 140, paddingHorizontal: 16 }}
      data={downloads}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={() => (
        <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Downloads</Text>
          {downloads.length > 0 && (
            <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]}>
              {downloads.length} episode{downloads.length !== 1 ? "s" : ""} saved offline
            </Text>
          )}
        </View>
      )}
      renderItem={({ item }) => <DownloadItem item={item} />}
      ListEmptyComponent={() => (
        <View style={styles.emptyState}>
          <Ionicons name="cloud-download-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No Downloads</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            Download episodes to listen offline. Tap the download icon on any episode.
          </Text>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    paddingHorizontal: 4,
    marginBottom: 20,
  },
  downloadItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
    gap: 12,
  },
  playIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  itemInfo: {
    flex: 1,
    gap: 3,
  },
  itemFeed: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  itemMeta: {
    fontSize: 12,
    marginTop: 2,
  },
  removeBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: "700",
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
