import { Platform, ViewStyle } from "react-native";

type Elevation = "sm" | "md" | "lg";

const shadowConfigs = {
  sm: {
    ios: { shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
    android: 2,
    web: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)",
  },
  md: {
    ios: { shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
    android: 4,
    web: "0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06)",
  },
  lg: {
    ios: { shadowOpacity: 0.15, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
    android: 8,
    web: "0 10px 15px rgba(0,0,0,0.1), 0 4px 6px rgba(0,0,0,0.05)",
  },
};

export function cardShadow(elevation: Elevation, shadowColor = "#000"): ViewStyle {
  const config = shadowConfigs[elevation];

  return Platform.select({
    ios: {
      shadowColor,
      shadowOpacity: config.ios.shadowOpacity,
      shadowRadius: config.ios.shadowRadius,
      shadowOffset: config.ios.shadowOffset,
    },
    android: {
      elevation: config.android,
    },
    web: {
      boxShadow: config.web,
    } as any,
    default: {},
  }) as ViewStyle;
}

export default cardShadow;
