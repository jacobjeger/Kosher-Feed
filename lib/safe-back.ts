import { router } from "expo-router";

export function safeGoBack() {
  try {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(tabs)");
    }
  } catch {
    try {
      router.replace("/(tabs)");
    } catch {}
  }
}
