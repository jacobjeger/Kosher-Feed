import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { getDeviceId } from "@/lib/device-id";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { addLog } from "@/lib/error-logger";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PUSH_TOKEN_KEY = "@shiurpod_push_token";

async function getExpoPushTokenWithRetry(maxRetries = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tokenData = await Notifications.getExpoPushTokenAsync();
      return tokenData.data;
    } catch (e) {
      const msg = (e as any)?.message || String(e);
      const isConnectionError = msg.includes("connection abort") || msg.includes("ECONNRESET") || msg.includes("network") || msg.includes("timeout");
      addLog("warn", `Push token attempt ${attempt}/${maxRetries} failed: ${msg}`, undefined, "push");
      if (!isConnectionError || attempt === maxRetries) {
        throw e;
      }
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return null;
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

    const token = await getExpoPushTokenWithRetry(3);
    if (!token) {
      addLog("warn", "Could not obtain push token after retries", undefined, "push");
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
      await apiRequest("POST", "/api/push-token", { deviceId, token, platform });
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
  } catch (e) {
    addLog("error", `initPushNotifications failed: ${(e as any)?.message || e}`, (e as any)?.stack, "push");
  }
}
