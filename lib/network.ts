import { Platform } from "react-native";

export async function isOnWifi(): Promise<boolean> {
  if (Platform.OS === "web") return true;
  try {
    const Network = require("expo-network");
    const state = await Network.getNetworkStateAsync();
    return state.type === Network.NetworkStateType.WIFI;
  } catch {
    return false;
  }
}
