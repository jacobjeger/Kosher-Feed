// YTC: tab bar entry. Tapping the tab pushes /ytc as a fullScreenModal
// (see app/_layout.tsx Stack registration). The component itself never
// renders — `tabBarButton` in app/(tabs)/_layout.tsx overrides the press
// handler so the user is redirected before this screen mounts.
//
// We still need a file at this path because expo-router's typed routes
// require every Tabs.Screen name to map to a real file. A second-line
// safety net (useFocusEffect) re-fires the redirect if a user lands here
// some other way (e.g. deep-link, restored navigation state).
import { useFocusEffect, router } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

export default function YtcTabPlaceholder() {
  useFocusEffect(useCallback(() => {
    router.replace("/ytc" as any);
  }, []));
  return <View />;
}
