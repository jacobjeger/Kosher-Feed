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
import { isReactNativeFirebaseAvailable } from "@/lib/ytc/push-availability";

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

      // Hard gate: skip ALL react-native-firebase work if the native
      // side isn't linked. Older APKs that received today's OTA bundle
      // don't have the native module, and require()-ing the package
      // there can cause side-effect throws that black-screen the YTC
      // modal. NativeModules.RNFBAppModule presence is a clean proxy
      // for "is the package usable here?".
      if (!isReactNativeFirebaseAvailable()) {
        addLog("info", "YTC push: native module not linked in this build, skipping", undefined, "ytc-push");
        return;
      }

      // Lazy import — module load shouldn't block YTC mount, and we
      // tolerate the package being unavailable.
      //
      // v22 migration: react-native-firebase deprecated the namespaced
      // `messaging().onMessage(...)` style in favor of the Firebase Web
      // modular API: `onMessage(getMessaging(), handler)`. The old
      // signature still works but logs a warning per call. Pull the
      // modular helpers off the module exports.
      let mod: any;
      try {
        mod = require("@react-native-firebase/messaging");
      } catch (e: any) {
        addLog("warn", `RN Firebase messaging unavailable: ${e?.message || e}`, undefined, "ytc-push");
        return;
      }
      const getMessaging = mod.getMessaging ?? mod.default?.getMessaging;
      const onMessage = mod.onMessage ?? mod.default?.onMessage;
      const onNotificationOpenedApp = mod.onNotificationOpenedApp ?? mod.default?.onNotificationOpenedApp;
      const getInitialNotification = mod.getInitialNotification ?? mod.default?.getInitialNotification;
      // Fall back to the old namespaced API if this APK ships an older
      // native package that doesn't yet export the modular helpers.
      // Don't crash either way.
      const messagingInstance = (() => {
        try { return getMessaging ? getMessaging() : null; } catch { return null; }
      })();

      // Cold-start tap: read once.
      if (!consumedInitialRef.current) {
        consumedInitialRef.current = true;
        try {
          const initial = messagingInstance && getInitialNotification
            ? await getInitialNotification(messagingInstance)
            : await (mod.default ?? mod)().getInitialNotification();
          if (initial?.data) consumeYtcNotification(initial.data).catch(() => {});
        } catch {}
      }

      // Warm taps.
      try {
        const off = messagingInstance && onNotificationOpenedApp
          ? onNotificationOpenedApp(messagingInstance, (m: any) => {
              if (m?.data) consumeYtcNotification(m.data).catch(() => {});
            })
          : (mod.default ?? mod)().onNotificationOpenedApp((m: any) => {
              if (m?.data) consumeYtcNotification(m.data).catch(() => {});
            });
        cleanup.push(() => off?.());
      } catch {}

      // Foreground messages: show a local notification ourselves so
      // the user actually sees them while in-app. expo-notifications
      // handles the channel routing.
      try {
        const handler = async (m: any) => {
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
        };
        const off = messagingInstance && onMessage
          ? onMessage(messagingInstance, handler)
          : (mod.default ?? mod)().onMessage(handler);
        cleanup.push(() => off?.());
      } catch {}
    })();

    return () => { cleanup.forEach((fn) => { try { fn(); } catch {} }); };
  }, []);

  return null;
}
