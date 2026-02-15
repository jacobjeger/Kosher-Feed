import React from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme } from "react-native";
import { Ionicons, Feather } from "@expo/vector-icons";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import Colors from "@/constants/colors";
import type { Episode, Feed } from "@/lib/types";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";

interface Props {
  episode: Episode;
  feed: Feed;
  showFeedTitle?: boolean;
}

function formatDuration(dur: string | null): string {
  if (!dur) return "";
  if (dur.includes(":")) return dur;
  const secs = parseInt(dur);
  if (isNaN(secs)) return dur;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function EpisodeItem({ episode, feed, showFeedTitle }: Props) {
  const { playEpisode, currentEpisode, playback, pause, resume } = useAudioPlayer();
  const { downloadEpisode, isDownloaded, isDownloading, downloadProgress } = useDownloads();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  const isCurrentlyPlaying = currentEpisode?.id === episode.id;
  const downloaded = isDownloaded(episode.id);
  const downloading = isDownloading(episode.id);
  const progress = downloading ? downloadProgress.get(episode.id) || 0 : 0;

  const handlePlay = async () => {
    lightHaptic();
    if (isCurrentlyPlaying) {
      playback.isPlaying ? await pause() : await resume();
    } else {
      await playEpisode(episode, feed);
    }
  };

  const handleDownload = async () => {
    if (downloaded || downloading) return;
    mediumHaptic();
    await downloadEpisode(episode, feed);
  };

  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        { backgroundColor: pressed ? colors.surfaceAlt : colors.surface, borderColor: colors.cardBorder },
      ]}
      onPress={handlePlay}
    >
      <View style={styles.row}>
        <View style={[styles.playIcon, { backgroundColor: isCurrentlyPlaying ? colors.accent : colors.accentLight }]}>
          <Ionicons
            name={isCurrentlyPlaying && playback.isPlaying ? "pause" : "play"}
            size={16}
            color={isCurrentlyPlaying ? "#fff" : colors.accent}
          />
        </View>
        <View style={styles.info}>
          {showFeedTitle && (
            <Text style={[styles.feedTitle, { color: colors.accent }]} numberOfLines={1}>
              {feed.title}
            </Text>
          )}
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
            {episode.title}
          </Text>
          <View style={styles.meta}>
            {episode.publishedAt && (
              <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                {formatDate(episode.publishedAt)}
              </Text>
            )}
            {episode.duration && (
              <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                {formatDuration(episode.duration)}
              </Text>
            )}
          </View>
        </View>
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            handleDownload();
          }}
          hitSlop={10}
          style={styles.downloadBtn}
        >
          {downloading ? (
            <View style={styles.downloadingIndicator}>
              <Text style={[styles.progressText, { color: colors.accent }]}>
                {Math.round(progress * 100)}%
              </Text>
            </View>
          ) : downloaded ? (
            <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          ) : (
            <Feather name="download" size={20} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
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
  info: {
    flex: 1,
    gap: 3,
  },
  feedTitle: {
    fontSize: 11,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 14,
    fontWeight: "600" as const,
    lineHeight: 19,
  },
  meta: {
    flexDirection: "row" as const,
    gap: 10,
    marginTop: 2,
  },
  metaText: {
    fontSize: 12,
  },
  downloadBtn: {
    width: 36,
    height: 36,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
  },
  downloadingIndicator: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  progressText: {
    fontSize: 10,
    fontWeight: "700" as const,
  },
});
