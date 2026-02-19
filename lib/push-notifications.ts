import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { getDeviceId } from "@/lib/device-id";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { addLog } from "@/lib/error-logger";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PUSH_TOKEN_KEY = "@shiurpod_push_token";
const PUSH_PROVIDER_KEY = "@shiurpod_push_provider";
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

async function tryGetPushyToken(): Promise<string | null> {
  try {
    const Pushy = require("pushy-react-native");
    Pushy.listen();
    const token = await withTimeout(
      new Promise<string>((resolve, reject) => {
        Pushy.register()
          .then((deviceToken: string) => resolve(deviceToken))
          .catch((err: any) => reject(err));
      }),
      TOKEN_FETCH_TIMEOUT_MS,
      "Pushy.register"
    );
    return token;
  } catch (e) {
    addLog("warn", `Pushy registration failed: ${(e as any)?.message || e}`, (e as any)?.stack, "push");
    return null;
  }
}

export async function registerPushToken(verbose = false): Promise<{ token: string | null; steps: string[] }> {
  const steps: string[] = [];
  const log = (level: "info" | "warn" | "error", msg: string, stack?: string) => {
    steps.push(`[${level.toUpperCase()}] ${msg}`);
    addLog(level, msg, stack, "push");
  };

  if (Platform.OS === "web") {
    log("info", "Push notifications not supported on web");
    return { token: null, steps };
  }

  try {
    log("info", `Platform: ${Platform.OS}, Version: ${Platform.Version}`);

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    log("info", `EAS Project ID: ${projectId || "NOT FOUND"}`);
    log("info", `App ID: ${Constants.expoConfig?.ios?.bundleIdentifier || Constants.expoConfig?.android?.package || "unknown"}`);

    log("info", "Checking notification permissions...");
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    log("info", `Current permission status: ${existingStatus}`);

    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      log("info", "Requesting notification permissions...");
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
      log("info", `Permission after request: ${finalStatus}`);
    }

    if (finalStatus !== "granted") {
      log("warn", `Push notification permission denied (status: ${finalStatus})`);
      return { token: null, steps };
    }

    let token: string | null = null;
    let provider: string = "expo";

    log("info", "Permission granted, trying FCM (Expo push token) first...");
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        log("info", `FCM token fetch attempt ${attempt}/2 (projectId: ${projectId || "none"})...`);
        const tokenData = await withTimeout(
          Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined),
          TOKEN_FETCH_TIMEOUT_MS,
          "getExpoPushTokenAsync"
        );
        token = tokenData.data;
        provider = "expo";
        log("info", `Got FCM/Expo push token: ${token}`);
        break;
      } catch (e) {
        const msg = (e as any)?.message || String(e);
        const stack = (e as any)?.stack;
        log("error", `FCM token attempt ${attempt}/2 failed: ${msg}`, stack);
        if (attempt < 2) {
          log("info", "Waiting 3 seconds before retry...");
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (!token) {
      log("info", "FCM failed, trying Pushy as backup...");
      const pushyToken = await tryGetPushyToken();
      if (pushyToken) {
        token = pushyToken;
        provider = "pushy";
        log("info", `Got Pushy token: ${token}`);
      } else {
        log("error", "Both FCM and Pushy failed — no push token available");
        return { token: null, steps };
      }
    }

    const deviceId = await getDeviceId();
    log("info", `Device ID: ${deviceId}, Provider: ${provider}`);

    const previousToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    const previousProvider = await AsyncStorage.getItem(PUSH_PROVIDER_KEY);
    if (previousToken === token && previousProvider === provider && !verbose) {
      log("info", "Push token unchanged, skipping re-registration");
      return { token, steps };
    }

    try {
      const apiUrl = getApiUrl();
      log("info", `Registering ${provider} token with server at ${apiUrl}/api/push-token...`);
      await withTimeout(
        apiRequest("POST", "/api/push-token", { deviceId, token, platform: Platform.OS, provider }),
        8000,
        "push-token-register"
      );
      await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
      await AsyncStorage.setItem(PUSH_PROVIDER_KEY, provider);
      log("info", `Push token (${provider}) successfully registered with server`);
    } catch (e) {
      const msg = (e as any)?.message || String(e);
      log("error", `Server registration failed: ${msg}`, (e as any)?.stack);
    }

    return { token, steps };
  } catch (e) {
    const msg = (e as any)?.message || String(e);
    log("error", `Push registration failed: ${msg}`, (e as any)?.stack);
    return { token: null, steps };
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
