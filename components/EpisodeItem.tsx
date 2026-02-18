import React from "react";
import { View, Text, Pressable, StyleSheet, Linking, Alert, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Ionicons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { useFavorites } from "@/contexts/FavoritesContext";
import { usePlayedEpisodes } from "@/contexts/PlayedEpisodesContext";
import { usePositions } from "@/contexts/PositionsContext";
import Colors from "@/constants/colors";
import type { Episode, Feed } from "@/lib/types";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";
import { getApiUrl } from "@/lib/query-client";

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
  const monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days === 0) return `Today \u00B7 ${monthDay}`;
  if (days === 1) return `Yesterday \u00B7 ${monthDay}`;
  if (days < 7) return `${days}d ago \u00B7 ${monthDay}`;
  if (days < 30) return `${Math.floor(days / 7)}w ago \u00B7 ${monthDay}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatRemainingTime(positionMs: number, durationMs: number): string {
  if (durationMs <= 0) return "";
  const remainingMs = durationMs - positionMs;
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes} min left`;
}

function EpisodeItem({ episode, feed, showFeedTitle }: Props) {
  const { playEpisode, currentEpisode, playback, pause, resume, queue, addToQueue, removeFromQueue } = useAudioPlayer();
  const { downloadEpisode, isDownloaded, isDownloading, downloadProgress } = useDownloads();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { isPlayed, togglePlayed, markAsPlayed, markAsUnplayed } = usePlayedEpisodes();
  const { getPosition } = usePositions();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [expanded, setExpanded] = React.useState<boolean>(false);

  const isCurrentlyPlaying = currentEpisode?.id === episode.id;
  const downloaded = isDownloaded(episode.id);
  const downloading = isDownloading(episode.id);
  const progress = downloading ? downloadProgress.get(episode.id) || 0 : 0;
  const isInQueue = queue.some((item) => item.episodeId === episode.id);
  const favorited = isFavorite(episode.id);
  const played = isPlayed(episode.id);
  const savedPos = getPosition(episode.id);
  const savedProgress = savedPos && savedPos.durationMs > 0 ? { positionMs: savedPos.positionMs, durationMs: savedPos.durationMs } : null;

  const handlePlay = async () => {
    try {
      lightHaptic();
      if (isCurrentlyPlaying) {
        if (playback.isPlaying) {
          await pause();
        } else {
          await resume();
        }
        router.push("/player");
      } else {
        await playEpisode(episode, feed);
        router.push("/player");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDownload = async () => {
    try {
      if (downloaded || downloading) return;
      mediumHaptic();
      await downloadEpisode(episode, feed);
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddToQueue = async () => {
    try {
      if (isInQueue) return;
      lightHaptic();
      await addToQueue(episode.id, feed.id);
      if (Platform.OS !== "web") {
        Alert.alert("Added to Queue", episode.title);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleExpand = () => {
    lightHaptic();
    setExpanded(prev => !prev);
  };

  const handleToggleFavorite = async () => {
    try {
      lightHaptic();
      await toggleFavorite(episode.id);
    } catch (e) {
      console.error(e);
    }
  };

  const handleOpenSourceSheet = async () => {
    if (episode.sourceSheetUrl) {
      await Linking.openURL(episode.sourceSheetUrl);
    }
  };

  const handleLongPress = () => {
    mediumHaptic();
    if (Platform.OS === "web") {
      setExpanded(true);
      return;
    }
    const actions: { text: string; onPress: () => void; style?: "destructive" | "cancel" }[] = [];
    if (!isInQueue) {
      actions.push({ text: "Add to Queue", onPress: handleAddToQueue });
    } else {
      actions.push({ text: "Remove from Queue", onPress: async () => { lightHaptic(); await removeFromQueue(episode.id); } });
    }
    if (!played) {
      actions.push({ text: "Mark as Played", onPress: () => { lightHaptic(); markAsPlayed(episode.id); } });
    } else {
      actions.push({ text: "Mark as Unplayed", onPress: () => { lightHaptic(); markAsUnplayed(episode.id); } });
    }
    if (!favorited) {
      actions.push({ text: "Add to Favorites", onPress: handleToggleFavorite });
    } else {
      actions.push({ text: "Remove from Favorites", onPress: handleToggleFavorite });
    }
    if (!downloaded && !downloading) {
      actions.push({ text: "Download", onPress: handleDownload });
    }
    actions.push({ text: "Cancel", style: "cancel", onPress: () => {} });
    Alert.alert(episode.title, undefined, actions);
  };

  return (
    <Pressable
      onLongPress={handleLongPress}
      delayLongPress={400}
      style={[
        styles.container,
        { backgroundColor: colors.surface, borderColor: colors.cardBorder },
      ]}
    >
      <View style={styles.topSection}>
        <Pressable onPress={handlePlay} style={[styles.playIcon, { backgroundColor: isCurrentlyPlaying ? colors.accent : colors.accentLight }]}>
          <Ionicons
            name={isCurrentlyPlaying && playback.isPlaying ? "pause" : "play"}
            size={16}
            color={isCurrentlyPlaying ? "#fff" : colors.accent}
          />
        </Pressable>
        <Pressable onPress={handleToggleExpand} style={styles.info}>
          {showFeedTitle && (
            <Text style={[styles.feedTitle, { color: colors.accent }]} numberOfLines={1}>
              {feed.title}
            </Text>
          )}
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: colors.text, flex: 1, opacity: played ? 0.6 : 1 }]} numberOfLines={expanded ? undefined : 2}>
              {episode.title}
            </Text>
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textSecondary}
              style={styles.expandIcon}
            />
          </View>
        </Pressable>
      </View>
      <View style={styles.bottomRow}>
        <View style={styles.metaSection}>
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
        <View style={styles.actionsRow}>
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              handleToggleFavorite();
            }}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            style={styles.actionBtn}
          >
            <Ionicons
              name={favorited ? "star" : "star-outline"}
              size={20}
              color={favorited ? colors.accent : colors.textSecondary}
            />
          </Pressable>
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              handleAddToQueue();
            }}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            style={styles.actionBtn}
          >
            {isInQueue ? (
              <Ionicons name="list-circle" size={20} color={colors.accent} />
            ) : (
              <Ionicons name="add-circle-outline" size={20} color={colors.textSecondary} />
            )}
          </Pressable>
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              if (Platform.OS === "web") {
                if (episode.id) {
                  const downloadUrl = `${getApiUrl()}/api/episodes/${episode.id}/download`;
                  const link = document.createElement("a");
                  link.href = downloadUrl;
                  link.style.display = "none";
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                }
              } else {
                handleDownload();
              }
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.downloadBtn}
          >
            {Platform.OS !== "web" && downloading ? (
              <View style={styles.downloadingIndicator}>
                <Text style={[styles.progressText, { color: colors.accent }]}>
                  {Math.round(progress * 100)}%
                </Text>
              </View>
            ) : Platform.OS !== "web" && downloaded ? (
              <Ionicons name="checkmark-circle" size={22} color={colors.success} />
            ) : (
              <Feather name="download" size={20} color={colors.textSecondary} />
            )}
          </Pressable>
        </View>
      </View>
      {expanded && (
        <View style={styles.expandedSection}>
          {episode.description && (
            <Text style={[styles.episodeDescription, { color: colors.textSecondary }]}>
              {episode.description}
            </Text>
          )}
          {episode.sourceSheetUrl && (
            <Pressable
              onPress={handleOpenSourceSheet}
              style={[styles.sourceSheetLink, { borderTopColor: colors.cardBorder }]}
            >
              <Ionicons name="open-outline" size={14} color={colors.accent} />
              <Text style={[styles.sourceSheetText, { color: colors.accent }]}>
                View Source Sheet
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => { lightHaptic(); togglePlayed(episode.id); }}
            style={[styles.sourceSheetLink, { borderTopColor: colors.cardBorder }]}
          >
            <Ionicons name={played ? "checkmark-circle" : "checkmark-circle-outline"} size={14} color={played ? colors.success : colors.accent} />
            <Text style={[styles.sourceSheetText, { color: played ? colors.success : colors.accent }]}>
              {played ? "Mark as Unplayed" : "Mark as Played"}
            </Text>
          </Pressable>
        </View>
      )}
      {(savedProgress || played) && (
        <View style={styles.progressTextContainer}>
          {played ? (
            <View style={styles.progressTextRow}>
              <Ionicons name="checkmark-circle" size={14} color={colors.success} />
              <Text style={[styles.progressTextLabel, { color: colors.success }]}>Completed</Text>
            </View>
          ) : savedProgress ? (
            <View style={styles.progressTextRow}>
              <Ionicons name="time-outline" size={14} color={colors.accent} />
              <Text style={[styles.progressTextLabel, { color: colors.accent }]}>
                {Math.round((savedProgress.positionMs / savedProgress.durationMs) * 100)}% listened · {formatRemainingTime(savedProgress.positionMs, savedProgress.durationMs)}
              </Text>
            </View>
          ) : null}
        </View>
      )}
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
  topSection: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 10,
  },
  playIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 2,
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
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontWeight: "600" as const,
    lineHeight: 19,
  },
  expandIcon: {
    marginTop: 2,
  },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingLeft: 58,
  },
  metaSection: {
    flexDirection: "row" as const,
    gap: 10,
    flex: 1,
  },
  metaText: {
    fontSize: 12,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  expandedSection: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingLeft: 58,
  },
  episodeDescription: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 4,
  },
  sourceSheetLink: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  sourceSheetText: {
    fontSize: 12,
    fontWeight: "600" as const,
  },
  actionBtn: {
    width: 34,
    height: 34,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
  },
  downloadBtn: {
    width: 42,
    height: 42,
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
  progressTextContainer: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    paddingLeft: 58,
  },
  progressTextRow: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 6,
  },
  progressTextLabel: {
    fontSize: 11,
    fontWeight: "500" as const,
  },
});

export default React.memo(EpisodeItem);
