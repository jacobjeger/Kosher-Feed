import React, { useRef, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, Platform, Animated as RNAnimated, PanResponder, InteractionManager } from "react-native";
import FocusableView from "@/components/FocusableView";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Ionicons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { useDownloads } from "@/contexts/DownloadsContext";
import { useFavorites } from "@/contexts/FavoritesContext";
import { usePlayedEpisodes } from "@/contexts/PlayedEpisodesContext";
import { usePositions } from "@/contexts/PositionsContext";
import Colors from "@/constants/colors";
import { cardShadow } from "@/constants/shadows";
import type { Episode, Feed } from "@/lib/types";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";
import { getApiUrl } from "@/lib/query-client";

interface Props {
  episode: Episode;
  feed: Feed;
  showFeedTitle?: boolean;
  isOnline?: boolean;
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

const SWIPE_THRESHOLD = 80;

function EpisodeItem({ episode, feed, showFeedTitle, isOnline = true }: Props) {
  const { playEpisode, currentEpisode, playback, pause, resume, queue, addToQueue, removeFromQueue } = useAudioPlayer();
  const { downloadEpisode, isDownloaded, isDownloading, downloadProgress } = useDownloads();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { isPlayed, togglePlayed } = usePlayedEpisodes();
  const { getPosition } = usePositions();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [expanded, setExpanded] = React.useState<boolean>(false);

  const isCurrentlyPlaying = currentEpisode?.id === episode.id;
  const canDownload = !episode.noDownload;
  const offlineUnavailable = !isOnline && !isDownloaded(episode.id);
  const downloaded = isDownloaded(episode.id);
  const downloading = isDownloading(episode.id);
  const progress = downloading ? downloadProgress.get(episode.id) || 0 : 0;
  const isInQueue = queue.some((item) => item.episodeId === episode.id);
  const favorited = isFavorite(episode.id);
  const played = isPlayed(episode.id);
  const savedPos = getPosition(episode.id);
  const savedProgress = savedPos && savedPos.durationMs > 0 ? { positionMs: savedPos.positionMs, durationMs: savedPos.durationMs } : null;

  const translateX = useRef(new RNAnimated.Value(0)).current;
  const isNative = Platform.OS !== "web";

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
        router.push("/player");
        InteractionManager.runAfterInteractions(() => {
          playEpisode(episode, feed).catch(console.error);
        });
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

  const handleToggleQueue = async () => {
    try {
      lightHaptic();
      if (isInQueue) {
        await removeFromQueue(episode.id);
      } else {
        await addToQueue(episode.id, feed.id);
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

  const panResponder = useMemo(() => {
    if (!isNative) return null;
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gestureState) => {
        return Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5;
      },
      onPanResponderMove: (_evt, gestureState) => {
        translateX.setValue(gestureState.dx);
      },
      onPanResponderRelease: (_evt, gestureState) => {
        if (gestureState.dx > SWIPE_THRESHOLD) {
          handleToggleQueue();
        } else if (gestureState.dx < -SWIPE_THRESHOLD) {
          if (canDownload && !downloaded && !downloading) {
            handleDownload();
          }
        }
        RNAnimated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          tension: 120,
          friction: 10,
        }).start();
      },
      onPanResponderTerminate: () => {
        RNAnimated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          tension: 120,
          friction: 10,
        }).start();
      },
    });
  }, [isNative, downloaded, downloading, isInQueue]);

  const cardContent = (
    <>
      <View style={styles.mainRow}>
        <View>
          <FocusableView
            focusRadius={10}
            onPress={offlineUnavailable ? undefined : handlePlay}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[
              styles.playBtn,
              {
                backgroundColor: offlineUnavailable
                  ? (isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)")
                  : isCurrentlyPlaying ? colors.accent : colors.accentLight,
                opacity: offlineUnavailable ? 0.5 : 1,
              },
            ]}
          >
            <Ionicons
              name={isCurrentlyPlaying && playback.isPlaying ? "pause" : "play"}
              size={18}
              color={offlineUnavailable ? colors.textSecondary : (isCurrentlyPlaying ? "#fff" : colors.accent)}
              style={isCurrentlyPlaying && playback.isPlaying ? undefined : { marginLeft: 2 }}
            />
          </FocusableView>
          {!isOnline && downloaded && (
            <View style={styles.offlineAvailableBadge}>
              <Ionicons name="checkmark-circle" size={14} color={colors.success} />
            </View>
          )}
        </View>
        <Pressable onPress={handleToggleExpand} style={styles.info}>
          {showFeedTitle && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={[styles.feedTitle, { color: colors.accent }]} numberOfLines={1}>
                {feed.title}
              </Text>
              {feed.sourceNetwork && (
                <View style={styles.networkTag}>
                  <Text style={styles.networkTagText}>{feed.sourceNetwork}</Text>
                </View>
              )}
            </View>
          )}
          <Text style={[styles.title, { color: colors.text, opacity: played ? 0.6 : 1 }]} numberOfLines={expanded ? undefined : 2}>
            {episode.title}
          </Text>
          <View style={styles.metaRow}>
            {episode.publishedAt && (
              <Text style={[styles.metaText, { color: colors.textTertiary }]}>
                {formatDate(episode.publishedAt)}
              </Text>
            )}
            {episode.duration && (
              <Text style={[styles.metaText, { color: colors.textTertiary }]}>
                {formatDuration(episode.duration)}
              </Text>
            )}
            {!expanded && savedProgress && !played && (
              <Text style={[styles.metaText, { color: colors.accent }]}>
                {Math.round((savedProgress.positionMs / savedProgress.durationMs) * 100)}% · {formatRemainingTime(savedProgress.positionMs, savedProgress.durationMs)}
              </Text>
            )}
            {!expanded && played && (
              <Text style={[styles.metaText, { color: colors.success }]}>Completed</Text>
            )}
            {offlineUnavailable && (
              <View style={styles.offlineBadge}>
                <Ionicons name="cloud-offline-outline" size={10} color="#fff" />
                <Text style={styles.offlineBadgeText}>Offline</Text>
              </View>
            )}
          </View>
        </Pressable>
        <View style={styles.actionsRow}>
          {canDownload && isNative && (
            <FocusableView
              focusRadius={8}
              onPress={(e) => { e.stopPropagation(); handleDownload(); }}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              style={styles.actionBtn}
            >
              {downloading ? (
                <View style={styles.downloadingIndicator}>
                  <Text style={[styles.progressText, { color: colors.accent }]}>{Math.round(progress * 100)}%</Text>
                </View>
              ) : downloaded ? (
                <Ionicons name="checkmark-circle" size={18} color={colors.success} />
              ) : (
                <Feather name="download" size={17} color={colors.textSecondary} />
              )}
            </FocusableView>
          )}
          <FocusableView
            focusRadius={8}
            onPress={(e) => { e.stopPropagation(); handleToggleQueue(); }}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            style={styles.actionBtn}
          >
            {isInQueue ? (
              <Ionicons name="list-circle" size={18} color={colors.accent} />
            ) : (
              <Ionicons name="add-circle-outline" size={18} color={colors.textSecondary} />
            )}
          </FocusableView>
          <FocusableView
            focusRadius={8}
            onPress={(e) => { e.stopPropagation(); handleToggleFavorite(); }}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            style={styles.actionBtn}
          >
            <Ionicons
              name={favorited ? "star" : "star-outline"}
              size={17}
              color={favorited ? colors.accent : colors.textSecondary}
            />
          </FocusableView>
          {!isNative && canDownload && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                if (episode.id) {
                  const downloadUrl = `${window.location.origin}/api/episodes/${episode.id}/download`;
                  window.open(downloadUrl, "_blank");
                }
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.actionBtn}
            >
              <Feather name="download" size={17} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
      </View>
      {expanded && (
        <View style={styles.expandedSection}>
          {episode.description && (
            <Text style={[styles.episodeDescription, { color: colors.textSecondary }]}>
              {episode.description}
            </Text>
          )}
          {episode.adminNotes && (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.cardBorder }}>
              <Ionicons name="information-circle-outline" size={14} color={colors.accent} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, fontWeight: "600", color: colors.accent, marginBottom: 2 }}>Note</Text>
                <Text style={{ fontSize: 12, lineHeight: 17, color: colors.textSecondary }}>{episode.adminNotes}</Text>
              </View>
            </View>
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
    </>
  );

  const progressBar = savedProgress && !played && savedProgress.durationMs > 0 ? (
    <View style={{ height: 3, backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)", borderBottomLeftRadius: 12, borderBottomRightRadius: 12, overflow: "hidden" }}>
      <View style={{ height: 3, width: `${Math.min(Math.round((savedProgress.positionMs / savedProgress.durationMs) * 100), 100)}%` as any, backgroundColor: colors.accent, borderRadius: 3 }} />
    </View>
  ) : null;

  if (!isNative || !panResponder) {
    return (
      <View
        style={[
          styles.container,
          { backgroundColor: colors.surface, borderColor: colors.cardBorder },
        ]}
      >
        {cardContent}
        {progressBar}
      </View>
    );
  }

  const queueActionBg = isInQueue ? colors.danger : "#2979FF";
  const downloadActionBg = downloaded ? colors.success : colors.success;

  const rightActionOpacity = translateX.interpolate({
    inputRange: [0, SWIPE_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });

  const leftActionOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, borderColor: colors.cardBorder },
      ]}
    >
      <View style={styles.swipeActionsContainer}>
        <RNAnimated.View style={[styles.swipeActionLeft, { backgroundColor: queueActionBg, opacity: rightActionOpacity }]}>
          <Ionicons name={isInQueue ? "remove-circle-outline" : "list-outline"} size={22} color="#fff" />
          <Text style={styles.swipeActionText}>
            {isInQueue ? "Remove" : "Queue"}
          </Text>
        </RNAnimated.View>
        <RNAnimated.View style={[styles.swipeActionRight, { backgroundColor: downloadActionBg, opacity: leftActionOpacity }]}>
          <Ionicons name={downloaded ? "checkmark-circle" : "download-outline"} size={22} color="#fff" />
          <Text style={styles.swipeActionText}>
            {downloaded ? "Done" : "Download"}
          </Text>
        </RNAnimated.View>
      </View>
      <RNAnimated.View
        style={[
          { backgroundColor: colors.surface, transform: [{ translateX }] },
        ]}
        {...panResponder.panHandlers}
      >
        {cardContent}
        {progressBar}
      </RNAnimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 6,
    overflow: "hidden",
    ...cardShadow("sm"),
    ...(Platform.OS === "web" ? { transition: "box-shadow 0.2s ease, transform 0.2s ease" as any } : {}),
  },
  mainRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 8,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
    marginTop: 1,
  },
  info: {
    flex: 1,
    gap: 1,
  },
  feedTitle: {
    fontSize: 11,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    flexShrink: 1,
  },
  networkTag: {
    backgroundColor: "rgba(37, 99, 235, 0.85)",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    flexShrink: 0,
  },
  networkTagText: {
    color: "#fff",
    fontSize: 8,
    fontWeight: "600" as const,
  },
  title: {
    fontSize: 14,
    fontWeight: "600" as const,
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: "row" as const,
    gap: 8,
    marginTop: 2,
  },
  metaText: {
    fontSize: 11,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
    flexShrink: 0,
  },
  expandedSection: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    paddingLeft: 50,
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
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
  },
  sourceSheetText: {
    fontSize: 12,
    fontWeight: "600" as const,
  },
  actionBtn: {
    width: 32,
    height: 32,
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
  swipeActionsContainer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "stretch",
    borderRadius: 10,
    overflow: "hidden",
  },
  swipeActionLeft: {
    width: 100,
    justifyContent: "center" as const,
    alignItems: "center" as const,
    paddingHorizontal: 10,
  },
  swipeActionRight: {
    width: 100,
    justifyContent: "center" as const,
    alignItems: "center" as const,
    paddingHorizontal: 10,
    marginLeft: "auto" as any,
  },
  swipeActionText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600" as const,
    marginTop: 2,
  },
  offlineBadge: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 3,
    backgroundColor: "rgba(220, 38, 38, 0.85)",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  offlineBadgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "600" as const,
  },
  offlineAvailableBadge: {
    position: "absolute" as const,
    bottom: -4,
    right: -4,
  },
});

export default React.memo(EpisodeItem, (prev, next) => {
  return prev.episode.id === next.episode.id && 
         prev.feed.id === next.feed.id && 
         prev.showFeedTitle === next.showFeedTitle &&
         prev.isOnline === next.isOnline;
});
