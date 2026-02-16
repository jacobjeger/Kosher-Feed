import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, Pressable, StyleSheet, Platform, Alert, ScrollView, Share, PanResponder, Animated as RNAnimated, Dimensions } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Image } from "expo-image";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { safeGoBack } from "@/lib/safe-back";
import Slider from "@react-native-community/slider";
import { useAudioPlayer, usePlaybackPosition } from "@/contexts/AudioPlayerContext";
import Colors from "@/constants/colors";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";
import { getBookmarks, addBookmark, removeBookmark, type Bookmark } from "@/lib/bookmarks";
import { useSettings } from "@/contexts/SettingsContext";
import { useFavorites } from "@/contexts/FavoritesContext";

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTimerRemaining(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

const SLEEP_OPTIONS = [15, 30, 45, 60, "endOfEpisode" as const, "cancel" as const];

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const isSmallScreen = SCREEN_HEIGHT < 750;
const artworkMaxSize = isSmallScreen ? 140 : 220;

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const {
    currentEpisode, currentFeed, playback,
    pause, resume, seekTo, skip, setRate, stop,
    sleepTimer, setSleepTimer, cancelSleepTimer,
    episodeCompleted, clearEpisodeCompleted,
  } = useAudioPlayer();
  const position = usePlaybackPosition();
  const { settings } = useSettings();
  const { toggleFavorite, isFavorite } = useFavorites();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [webSleepIndex, setWebSleepIndex] = useState(0);

  const swipeAnim = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    if (episodeCompleted) {
      clearEpisodeCompleted();
      safeGoBack();
    }
  }, [episodeCompleted, clearEpisodeCompleted]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 20 && Math.abs(gestureState.dy) < 20;
      },
      onPanResponderMove: (_, gestureState) => {
        swipeAnim.setValue(gestureState.dx);
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx < -50) {
          lightHaptic();
          skip(settings.skipForwardSeconds);
        } else if (gestureState.dx > 50) {
          lightHaptic();
          skip(-settings.skipBackwardSeconds);
        }
        RNAnimated.spring(swipeAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 100,
          friction: 10,
        }).start();
      },
      onPanResponderTerminate: () => {
        RNAnimated.spring(swipeAnim, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  useEffect(() => {
    if (currentEpisode) {
      getBookmarks(currentEpisode.id).then(setBookmarks).catch(() => {});
    }
  }, [currentEpisode?.id]);

  const handleAddBookmark = useCallback(async () => {
    if (!currentEpisode || !currentFeed) return;
    lightHaptic();
    const note = `Bookmark at ${formatTime(position.positionMs)}`;
    const bm = await addBookmark({
      episodeId: currentEpisode.id,
      feedId: currentFeed.id,
      positionMs: position.positionMs,
      note,
    });
    setBookmarks(prev => [...prev, bm]);
    setBookmarkSaved(true);
    setTimeout(() => setBookmarkSaved(false), 1500);
  }, [currentEpisode, currentFeed, position.positionMs]);

  const handleRemoveBookmark = useCallback(async (id: string) => {
    lightHaptic();
    await removeBookmark(id);
    setBookmarks(prev => prev.filter(b => b.id !== id));
  }, []);

  const handleSleepTimerPress = useCallback(() => {
    lightHaptic();
    if (Platform.OS === "web") {
      const option = SLEEP_OPTIONS[webSleepIndex];
      const nextIndex = (webSleepIndex + 1) % SLEEP_OPTIONS.length;
      setWebSleepIndex(nextIndex);

      if (option === "cancel") {
        cancelSleepTimer();
      } else if (option === "endOfEpisode") {
        setSleepTimer("endOfEpisode");
      } else {
        setSleepTimer(option as number);
      }
    } else {
      Alert.alert(
        "Sleep Timer",
        sleepTimer.active
          ? `Timer active: ${sleepTimer.mode === "endOfEpisode" ? "End of Episode" : formatTimerRemaining(sleepTimer.remainingMs)}`
          : "Stop playback after:",
        [
          { text: "15 min", onPress: () => setSleepTimer(15) },
          { text: "30 min", onPress: () => setSleepTimer(30) },
          { text: "45 min", onPress: () => setSleepTimer(45) },
          { text: "60 min", onPress: () => setSleepTimer(60) },
          { text: "End of Episode", onPress: () => setSleepTimer("endOfEpisode") },
          ...(sleepTimer.active ? [{ text: "Cancel Timer", style: "destructive" as const, onPress: () => cancelSleepTimer() }] : []),
          { text: "Dismiss", style: "cancel" as const },
        ]
      );
    }
  }, [sleepTimer, setSleepTimer, cancelSleepTimer, webSleepIndex]);

  const getSkipBackwardIcon = (): string => {
    switch (settings.skipBackwardSeconds) {
      case 10:
        return "replay-10";
      case 5:
        return "replay-5";
      case 30:
      default:
        return "replay-30";
    }
  };

  const getSkipForwardIcon = (): string => {
    switch (settings.skipForwardSeconds) {
      case 10:
        return "forward-10";
      case 5:
        return "forward-5";
      case 30:
      default:
        return "forward-30";
    }
  };

  const handleShareEpisode = useCallback(async () => {
    if (!currentEpisode || !currentFeed) return;
    try {
      lightHaptic();
      const timestamp = position.positionMs > 5000 ? ` at ${formatTime(position.positionMs)}` : "";
      await Share.share({
        message: `Listen to "${currentEpisode.title}" from ${currentFeed.title}${timestamp}`,
        url: currentEpisode.audioUrl,
      });
    } catch (e) {
    }
  }, [currentEpisode, currentFeed, position.positionMs]);

  const handleToggleFavorite = useCallback(async () => {
    if (!currentEpisode) return;
    lightHaptic();
    await toggleFavorite(currentEpisode.id);
  }, [currentEpisode, toggleFavorite]);

  if (!currentEpisode || !currentFeed) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => safeGoBack()} hitSlop={12}>
            <Ionicons name="chevron-down" size={28} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.emptyState}>
          <Ionicons name="musical-notes-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No episode playing</Text>
        </View>
      </View>
    );
  }

  const progress = position.durationMs > 0 ? (isSeeking ? seekValue : position.positionMs) / position.durationMs : 0;
  const currentRateIndex = RATES.indexOf(playback.playbackRate);

  const cycleRate = async () => {
    lightHaptic();
    const nextIndex = (currentRateIndex + 1) % RATES.length;
    await setRate(RATES[nextIndex]);
  };

  const sleepButtonLabel = sleepTimer.active
    ? sleepTimer.mode === "endOfEpisode"
      ? "EoE"
      : formatTimerRemaining(sleepTimer.remainingMs)
    : null;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === "web" ? 67 : 8) }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={12}>
          <Ionicons name="chevron-down" size={28} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.textSecondary }]}>Now Playing</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={[styles.artworkContainer, isSmallScreen && styles.artworkContainerSmall]}>
        <RNAnimated.View 
          {...panResponder.panHandlers}
          style={{ transform: [{ translateX: swipeAnim }] }}
        >
          {currentFeed.imageUrl ? (
            <Image
              source={{ uri: currentFeed.imageUrl }}
              style={[styles.artwork, { maxWidth: artworkMaxSize }]}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={currentFeed.imageUrl}
              transition={0}
            />
          ) : (
            <View style={[styles.artwork, { maxWidth: artworkMaxSize, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="mic" size={isSmallScreen ? 48 : 80} color={colors.textSecondary} />
            </View>
          )}
        </RNAnimated.View>
      </View>

      <View style={[styles.infoSection, isSmallScreen && styles.infoSectionSmall]}>
        <Text style={[styles.episodeTitle, { color: colors.text }, isSmallScreen && styles.episodeTitleSmall]} numberOfLines={2}>
          {currentEpisode.title}
        </Text>
        <Text style={[styles.feedName, { color: colors.accent }]} numberOfLines={1}>
          {currentFeed.title}
        </Text>
      </View>

      <View style={[styles.sliderSection, isSmallScreen && styles.sliderSectionSmall]}>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={1}
          value={progress}
          onSlidingStart={() => setIsSeeking(true)}
          onValueChange={(val) => setSeekValue(val * position.durationMs)}
          onSlidingComplete={async (val) => {
            await seekTo(val * position.durationMs);
            setIsSeeking(false);
          }}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.border}
          thumbTintColor={colors.accent}
        />
        <View style={styles.timeRow}>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>
            {formatTime(isSeeking ? seekValue : position.positionMs)}
          </Text>
          <Text style={[styles.timeText, { color: colors.textSecondary }]}>
            -{formatTime(Math.max(0, position.durationMs - (isSeeking ? seekValue : position.positionMs)))}
          </Text>
        </View>
      </View>

      <View style={[styles.controls, isSmallScreen && styles.controlsSmall]}>
        <Pressable
          onPress={cycleRate}
          style={[styles.rateBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Text style={[styles.rateText, { color: colors.text }]}>
            {playback.playbackRate}x
          </Text>
        </Pressable>

        <Pressable
          onPress={() => { lightHaptic(); skip(-settings.skipBackwardSeconds); }}
          hitSlop={8}
          style={styles.skipBtn}
        >
          <MaterialIcons name={getSkipBackwardIcon()} size={isSmallScreen ? 28 : 32} color={colors.text} />
        </Pressable>

        <Pressable
          onPress={() => {
            mediumHaptic();
            playback.isPlaying ? pause() : resume();
          }}
          style={[styles.playBtn, isSmallScreen && styles.playBtnSmall, { backgroundColor: colors.accent }]}
        >
          <Ionicons
            name={playback.isPlaying ? "pause" : "play"}
            size={isSmallScreen ? 28 : 32}
            color="#fff"
            style={playback.isPlaying ? undefined : { marginLeft: 3 }}
          />
        </Pressable>

        <Pressable
          onPress={() => { lightHaptic(); skip(settings.skipForwardSeconds); }}
          hitSlop={8}
          style={styles.skipBtn}
        >
          <MaterialIcons name={getSkipForwardIcon()} size={isSmallScreen ? 28 : 32} color={colors.text} />
        </Pressable>

        <Pressable
          onPress={() => { lightHaptic(); stop(); safeGoBack(); }}
          hitSlop={8}
          style={[styles.rateBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons name="stop" size={18} color={colors.danger} />
        </Pressable>
      </View>

      <View style={styles.secondaryControls}>
        <Pressable
          onPress={handleSleepTimerPress}
          style={[
            styles.secondaryBtn,
            { backgroundColor: sleepTimer.active ? colors.accentLight : colors.surfaceAlt },
          ]}
        >
          <Ionicons
            name="moon-outline"
            size={18}
            color={sleepTimer.active ? colors.accent : colors.textSecondary}
          />
          {sleepButtonLabel ? (
            <Text style={[styles.secondaryBtnText, { color: colors.accent }]}>
              {sleepButtonLabel}
            </Text>
          ) : null}
        </Pressable>

        <Pressable
          onPress={handleAddBookmark}
          style={[styles.secondaryBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons
            name={bookmarkSaved ? "checkmark" : "bookmark-outline"}
            size={18}
            color={bookmarkSaved ? colors.success : colors.textSecondary}
          />
        </Pressable>

        <Pressable
          onPress={handleShareEpisode}
          style={[styles.secondaryBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons
            name="share-outline"
            size={18}
            color={colors.textSecondary}
          />
        </Pressable>

        <Pressable
          onPress={handleToggleFavorite}
          style={[styles.secondaryBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons
            name={isFavorite(currentEpisode.id) ? "star" : "star-outline"}
            size={18}
            color={isFavorite(currentEpisode.id) ? colors.accent : colors.textSecondary}
          />
        </Pressable>

        <Pressable
          onPress={() => { lightHaptic(); router.push("/queue"); }}
          style={[styles.secondaryBtn, { backgroundColor: colors.surfaceAlt }]}
        >
          <Ionicons name="list" size={18} color={colors.textSecondary} />
        </Pressable>
      </View>

      {bookmarks.length > 0 && (
        <View style={styles.bookmarksSection}>
          <Text style={[styles.bookmarksTitle, { color: colors.textSecondary }]}>Bookmarks</Text>
          {bookmarks
            .sort((a, b) => a.positionMs - b.positionMs)
            .map((bm) => (
              <Pressable
                key={bm.id}
                style={[styles.bookmarkItem, { backgroundColor: colors.surfaceAlt }]}
                onPress={() => {
                  lightHaptic();
                  seekTo(bm.positionMs);
                }}
              >
                <Ionicons name="bookmark" size={14} color={colors.accent} />
                <Text style={[styles.bookmarkNote, { color: colors.text }]} numberOfLines={1}>
                  {bm.note}
                </Text>
                <Text style={[styles.bookmarkTime, { color: colors.textSecondary }]}>
                  {formatTime(bm.positionMs)}
                </Text>
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    handleRemoveBookmark(bm.id);
                  }}
                  hitSlop={8}
                >
                  <Ionicons name="close" size={16} color={colors.textSecondary} />
                </Pressable>
              </Pressable>
            ))}
        </View>
      )}

      <View style={{ height: insets.bottom + 20 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: "600" as const,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  artworkContainer: {
    alignItems: "center",
    paddingHorizontal: 40,
    paddingVertical: 8,
    justifyContent: "center",
  },
  artworkContainerSmall: {
    paddingVertical: 4,
    paddingHorizontal: 60,
  },
  artwork: {
    width: "100%" as any,
    maxWidth: 220,
    aspectRatio: 1,
    borderRadius: 16,
  },
  infoSection: {
    paddingHorizontal: 20,
    gap: 2,
    marginBottom: 8,
  },
  infoSectionSmall: {
    marginBottom: 4,
  },
  episodeTitle: {
    fontSize: 18,
    fontWeight: "700" as const,
    lineHeight: 23,
  },
  episodeTitleSmall: {
    fontSize: 16,
    lineHeight: 20,
  },
  feedName: {
    fontSize: 15,
    fontWeight: "600" as const,
  },
  sliderSection: {
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  sliderSectionSmall: {
    marginBottom: 8,
  },
  slider: {
    width: "100%" as any,
    height: 36,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: -4,
  },
  timeText: {
    fontSize: 12,
    fontWeight: "500" as const,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 24,
    paddingBottom: 10,
  },
  controlsSmall: {
    gap: 12,
    paddingBottom: 6,
  },
  rateBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  rateText: {
    fontSize: 13,
    fontWeight: "700" as const,
  },
  skipBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  playBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  playBtnSmall: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  secondaryControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 20,
  },
  secondaryBtnText: {
    fontSize: 12,
    fontWeight: "600" as const,
  },
  bookmarksSection: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 8,
  },
  bookmarksTitle: {
    fontSize: 12,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  bookmarkItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  bookmarkNote: {
    flex: 1,
    fontSize: 13,
    fontWeight: "500" as const,
  },
  bookmarkTime: {
    fontSize: 12,
    fontWeight: "500" as const,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: "500" as const,
  },
});
