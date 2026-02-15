import { Platform } from "react-native";

export async function lightHaptic() {
  if (Platform.OS === "web") return;
  try {
    const Haptics = require("expo-haptics");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch (e) {}
}

export async function mediumHaptic() {
  if (Platform.OS === "web") return;
  try {
    const Haptics = require("expo-haptics");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch (e) {}
}
