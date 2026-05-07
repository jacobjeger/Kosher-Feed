// YTC: push notification host. Mounted under YtcAuthProvider in
// app/ytc/_layout.tsx. Owns the @react-native-firebase/messaging
// lifecycle hooks for the YTC mini-app.
//
//   - onMessage: foreground — show a local in-app notification via
//     expo-notifications (so the OS-side handler doesn't suppress it
//     while the app is open).
//   - setBackgroundMessageHandler: data-only payloads in background.
//     Backend sends notification+data, so the OS handles display
//     automatically; we just log.
//   - getInitialNotification + onNotificationOpenedApp: deep-link tap
//     handlers.
//
// All wrapped in try/catch + Platform.OS guard. No-ops on iOS / when
// the native module isn't linked.

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { addLog } from "@/lib/error-logger";
import { consumeYtcNotification } from "@/lib/ytc/notification-handler";

const CHANNEL_ID = "ytc_general";

export function YtcPushHost() {
  const consumedInitialRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    let cleanup: Array<() => void> = [];
    (async () => {
      // Notification channel — idempotent.
      try {
        await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
          name: "Toras Chaim Shiurim",
          description: "Shiur and announcement notifications",
          importance: Notifications.AndroidImportance.HIGH,
        });
      } catch (e: any) {
        addLog("warn", `YTC push channel create failed: ${e?.message || e}`, undefined, "ytc-push");
      }

      // Lazy import — module load shouldn't block YTC mount, and we
      // tolerate the package being unavailable.
      let messaging: any;
      try {
        const mod = require("@react-native-firebase/messaging");
        messaging = mod.default ?? mod.messaging ?? mod;
      } catch (e: any) {
        addLog("warn", `RN Firebase messaging unavailable: ${e?.message || e}`, undefined, "ytc-push");
        return;
      }

      // Cold-start tap: read once.
      if (!consumedInitialRef.current) {
        consumedInitialRef.current = true;
        try {
          const initial = await messaging().getInitialNotification();
          if (initial?.data) consumeYtcNotification(initial.data).catch(() => {});
        } catch {}
      }

      // Warm taps.
      try {
        const off = messaging().onNotificationOpenedApp((m: any) => {
          if (m?.data) consumeYtcNotification(m.data).catch(() => {});
        });
        cleanup.push(() => off?.());
      } catch {}

      // Foreground messages: show a local notification ourselves so
      // the user actually sees them while in-app. expo-notifications
      // handles the channel routing.
      try {
        const off = messaging().onMessage(async (m: any) => {
          try {
            const title = m?.notification?.title ?? "YTC";
            const body = m?.notification?.body ?? "";
            await Notifications.scheduleNotificationAsync({
              content: {
                title, body,
                data: m?.data ?? {},
              },
              trigger: { channelId: CHANNEL_ID } as any,
            });
          } catch {}
        });
        cleanup.push(() => off?.());
      } catch {}
    })();

    return () => { cleanup.forEach((fn) => { try { fn(); } catch {} }); };
  }, []);

  return null;
}
