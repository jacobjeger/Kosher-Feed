import { useEffect } from "react";
import { router } from "expo-router";
import { View } from "react-native";

export default function NotFoundScreen() {
  useEffect(() => {
    router.replace("/(tabs)");
  }, []);

  return <View style={{ flex: 1 }} />;
}
