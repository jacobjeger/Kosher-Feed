import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { getDeviceId } from "@/lib/device-id";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { addLog } from "@/lib/error-logger";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PUSH_TOKEN_KEY = "@shiurpod_push_token";
const TOKEN_FETCH_TIMEOUT_MS = 10000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export async function registerPushToken(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") {
      addLog("info", "Push notification permission not granted", undefined, "push");
      return null;
    }

    let token: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const tokenData = await withTimeout(
          Notifications.getExpoPushTokenAsync(),
          TOKEN_FETCH_TIMEOUT_MS,
          "getExpoPushTokenAsync"
        );
        token = tokenData.data;
        break;
      } catch (e) {
        const msg = (e as any)?.message || String(e);
        addLog("warn", `Push token attempt ${attempt}/2 failed: ${msg}`, undefined, "push");
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (!token) {
      addLog("warn", "Could not obtain push token after retries, will try again later", undefined, "push");
      return null;
    }

    const deviceId = await getDeviceId();
    const platform = Platform.OS;

    const previousToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (previousToken === token) {
      addLog("info", "Push token unchanged, skipping re-registration", undefined, "push");
      return token;
    }

    try {
      await withTimeout(
        apiRequest("POST", "/api/push-token", { deviceId, token, platform }),
        8000,
        "push-token-register"
      );
      await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
      addLog("info", `Push token registered: ${token.substring(0, 20)}...`, undefined, "push");
    } catch (e) {
      addLog("warn", `Push token server registration failed (will retry later): ${(e as any)?.message || e}`, undefined, "push");
    }
    return token;
  } catch (e) {
    addLog("error", `Push token registration failed: ${(e as any)?.message || e}`, (e as any)?.stack, "push");
    return null;
  }
}

export async function initPushNotifications(): Promise<void> {
  if (Platform.OS === "web") return;

  try {
    await registerPushToken();
  } catch (_e) {
  }
}

export function getNotificationData(response: Notifications.NotificationResponse): {
  episodeId?: string;
  feedId?: string;
  type?: string;
} {
  const data = response.notification.request.content.data as Record<string, any> | undefined;
  if (!data) return {};
  return {
    episodeId: data.episodeId as string | undefined,
    feedId: data.feedId as string | undefined,
    type: data.type as string | undefined,
  };
}
