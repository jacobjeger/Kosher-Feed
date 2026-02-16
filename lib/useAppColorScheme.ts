import { useColorScheme } from "react-native";
import { useSettings } from "@/contexts/SettingsContext";

export function useAppColorScheme(): "light" | "dark" {
  const systemScheme = useColorScheme();
  const { settings } = useSettings();

  if (settings.darkModeOverride === "light") return "light";
  if (settings.darkModeOverride === "dark") return "dark";
  return systemScheme === "dark" ? "dark" : "light";
}
