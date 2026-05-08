// YTC: tabs layout for the auth-gated section. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/_layout.tsx with the in-file
// MiniPlayer wrapper REMOVED — shiurpod's <MiniPlayerHost> renders
// globally above tab bars on all routes including this one.
//
// "Audio player tab gray-out" (Batch G, option b): when a YTC shiur
// is currently playing, the bar visually dims to convey "you're
// focused on a shiur" — but tabs stay tappable. Color tokens swap to
// muted variants; tabs aren't disabled.
//
// Active-tab pill: matches the Swift screenshot — the active tab gets
// a gold rounded-rect background BEHIND THE ICON ONLY (not the whole
// tab area). Inactive icons + labels are gray; active label is gold.
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View, StyleSheet, Platform } from "react-native";
import { ytcColors as StaticColors } from "@/constants/ytcColors";
import { useYtcColors, useYtcTheme } from "@/contexts/YtcThemeContext";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { isYtcEpisodeId } from "@/lib/ytc/audio-adapter";

// Pill that wraps the active tab's icon. Gold rounded-rect that
// matches the screenshot — only the active tab's icon gets it.
function TabIcon({ name, color, size, focused }: { name: any; color: string; size: number; focused: boolean }) {
  return (
    <View style={[pillStyles.iconWrap, focused && pillStyles.iconWrapActive]}>
      <Ionicons
        name={name}
        size={size - 2}
        color={focused ? StaticColors.navy : color}
      />
    </View>
  );
}

const pillStyles = StyleSheet.create({
  iconWrap: {
    paddingHorizontal: 18,
    paddingVertical: 4,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapActive: {
    backgroundColor: StaticColors.gold,
  },
});

export default function TabLayout() {
  const { currentEpisode, playback } = useAudioPlayer();
  const Colors = useYtcColors();
  const { resolved } = useYtcTheme();
  const isDark = resolved === "dark";
  const ytcAudioActive =
    !!currentEpisode && isYtcEpisodeId(currentEpisode.id) && !!playback.isPlaying;
  // Tab bar surface colors flip with theme + further dim when audio is playing.
  const baseBg = isDark ? Colors.surface : "#FFFFFF";
  const playingBg = Colors.surfaceAlt;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ytcAudioActive ? Colors.goldOpacity30 : Colors.gold,
        tabBarInactiveTintColor: ytcAudioActive ? Colors.navyOpacity30 : (isDark ? Colors.textFaint : Colors.navyOpacity50),
        tabBarStyle: {
          backgroundColor: ytcAudioActive ? playingBg : baseBg,
          borderTopColor: Colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          // Slightly taller to fit the gold pill comfortably without
          // crowding the label.
          height: 64,
          paddingTop: 6,
          paddingBottom: 8,
          opacity: ytcAudioActive ? 0.65 : 1,
          // Tighter shadow on iOS — keeps the bar feeling distinct
          // without the heavy default Material shadow on Android.
          ...Platform.select({
            ios: {
              shadowColor: StaticColors.black,
              shadowOffset: { width: 0, height: -1 },
              shadowOpacity: 0.04,
              shadowRadius: 4,
            },
            default: {},
          }),
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginTop: 2 },
        // Increase the gap between the icon's pill and the label.
        tabBarIconStyle: { marginBottom: 0 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="home" color={color} size={size} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="shiurim"
        options={{
          title: "Shiurim",
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="headset" color={color} size={size} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="events"
        options={{
          title: "Events",
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="calendar" color={color} size={size} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: "Contacts",
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="people" color={color} size={size} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
