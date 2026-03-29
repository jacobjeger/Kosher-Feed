import { useEffect } from "react";
import { BackHandler, Platform } from "react-native";

/**
 * Registers a hardware back button handler on Android.
 * The handler should return `true` to indicate the event was consumed.
 * No-op on iOS/web.
 */
export function useBackHandler(handler: () => boolean) {
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const sub = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => sub.remove();
  }, [handler]);
}
