import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import type { Episode, Feed } from "@/lib/types";
import { addLog } from "@/lib/error-logger";

const SEEN_EPISODES_KEY = "@kosher_shiurim_seen_episodes";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function getSeenEpisodeIds(): Promise<Set<string>> {
  try {
    const data = await AsyncStorage.getItem(SEEN_EPISODES_KEY);
    if (data) return new Set(JSON.parse(data));
  } catch {}
  return new Set();
}

async function markEpisodesSeen(ids: string[]) {
  try {
    const seen = await getSeenEpisodeIds();
    ids.forEach(id => seen.add(id));
    const arr = Array.from(seen);
    if (arr.length > 1000) {
      await AsyncStorage.setItem(SEEN_EPISODES_KEY, JSON.stringify(arr.slice(-1000)));
    } else {
      await AsyncStorage.setItem(SEEN_EPISODES_KEY, JSON.stringify(arr));
    }
  } catch {}
}

export async function requestNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === "web") {
    try {
      if ("Notification" in window) {
        const result = await Notification.requestPermission();
        addLog("info", `Web notification permission request result: ${result}`, undefined, "notifications");
        return result === "granted";
      }
      addLog("warn", "Web Notification API not available", undefined, "notifications");
    } catch (e) {
      addLog("error", `Web notification permission request failed: ${(e as any)?.message || e}`, undefined, "notifications");
    }
    return false;
  }

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    addLog("info", `Native notification permission: existing=${existingStatus}, final=${finalStatus}`, undefined, "notifications");
    return finalStatus === "granted";
  } catch (e) {
    addLog("error", `Native notification permission request failed: ${(e as any)?.message || e}`, undefined, "notifications");
  }
  return false;
}

export async function checkNotificationPermission(): Promise<boolean> {
  if (Platform.OS === "web") {
    try {
      if ("Notification" in window) {
        return Notification.permission === "granted";
      }
    } catch {}
    return false;
  }

  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === "granted";
  } catch {}
  return false;
}

export async function checkForNewEpisodes(
  subscribedFeeds: Feed[],
  allEpisodes: Episode[]
): Promise<Episode[]> {
  const seen = await getSeenEpisodeIds();
  const subscribedFeedIds = new Set(subscribedFeeds.map(f => f.id));

  const subscribedEpisodes = allEpisodes.filter(ep => subscribedFeedIds.has(ep.feedId));
  const newEpisodes = subscribedEpisodes.filter(ep => !seen.has(ep.id));

  addLog("info", `checkForNewEpisodes: ${allEpisodes.length} total eps, ${subscribedEpisodes.length} from subscribed feeds, ${seen.size} seen, ${newEpisodes.length} new`, undefined, "notifications");

  if (newEpisodes.length > 0) {
    await markEpisodesSeen(newEpisodes.map(e => e.id));
  }

  return newEpisodes;
}

export async function sendLocalNotification(episode: Episode, feed: Feed) {
  addLog("info", `Sending notification: "${episode.title}" from "${feed.title}" (platform=${Platform.OS})`, undefined, "notifications");

  if (Platform.OS === "web") {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(`New from ${feed.title}`, {
          body: episode.title,
          icon: feed.imageUrl || undefined,
        });
        addLog("info", `Web notification sent for "${episode.title}"`, undefined, "notifications");
      } else {
        addLog("warn", `Web notification skipped: permission=${typeof Notification !== "undefined" ? Notification.permission : "N/A"}`, undefined, "notifications");
      }
    } catch (e) {
      addLog("error", `Web notification failed: ${(e as any)?.message || e}`, undefined, "notifications");
    }
    return;
  }

  try {
    await setupNotificationChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `New from ${feed.title}`,
        body: episode.title,
        data: { episodeId: episode.id, feedId: episode.feedId },
        sound: "default",
        ...(Platform.OS === "android" ? { channelId: "new-episodes" } : {}),
      } as any,
      trigger: null,
    });
    addLog("info", `Native notification scheduled for "${episode.title}"`, undefined, "notifications");
  } catch (e) {
    addLog("error", `Notification failed for "${episode.title}": ${(e as any)?.message || e}`, (e as any)?.stack, "notifications");
  }
}

export async function notifyNewEpisodes(newEpisodes: Episode[], feeds: Feed[]) {
  if (newEpisodes.length === 0) return;

  const feedMap = new Map(feeds.map(f => [f.id, f]));

  const grouped = new Map<string, Episode[]>();
  for (const ep of newEpisodes) {
    const existing = grouped.get(ep.feedId) || [];
    existing.push(ep);
    grouped.set(ep.feedId, existing);
  }

  const feedIds = Array.from(grouped.keys());
  for (const feedId of feedIds) {
    const episodes = grouped.get(feedId);
    if (!episodes) continue;
    const feed = feedMap.get(feedId);
    if (!feed) continue;

    if (episodes.length === 1) {
      await sendLocalNotification(episodes[0], feed);
    } else {
      if (Platform.OS === "web") {
        try {
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification(feed.title, {
              body: `${episodes.length} new episodes available`,
              icon: feed.imageUrl || undefined,
            });
          }
        } catch {}
      } else {
        try {
          await setupNotificationChannel();
          await Notifications.scheduleNotificationAsync({
            content: {
              title: feed.title,
              body: `${episodes.length} new episodes available`,
              data: { feedId: feed.id },
              sound: "default",
              ...(Platform.OS === "android" ? { channelId: "new-episodes" } : {}),
            } as any,
            trigger: null,
          });
        } catch (e) {
          addLog("error", `Grouped notification failed for "${feed.title}" (${episodes.length} eps): ${(e as any)?.message || e}`, (e as any)?.stack, "notifications");
        }
      }
    }
  }
}

export async function initializeSeenEpisodes(episodes: Episode[]) {
  const seen = await getSeenEpisodeIds();
  if (seen.size === 0 && episodes.length > 0) {
    await markEpisodesSeen(episodes.map(e => e.id));
  }
}

export async function setupNotificationChannel() {
  if (Platform.OS === "android") {
    try {
      await Notifications.setNotificationChannelAsync("new-episodes", {
        name: "New Episodes",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#FF231F7C",
        sound: "default",
      });
    } catch (e) {
      addLog("error", `Notification channel setup failed: ${(e as any)?.message || e}`, (e as any)?.stack, "notifications");
    }
  }
}
