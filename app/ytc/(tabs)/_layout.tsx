// YTC: tabs layout for the auth-gated section. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/_layout.tsx with the in-file
// MiniPlayer wrapper REMOVED — shiurpod's <MiniPlayerHost> renders
// globally above tab bars on all routes including this one.
//
// "Audio player tab gray-out" (Batch G, option b): when a YTC shiur
// is currently playing, the bar visually dims to convey "you're
// focused on a shiur" — but tabs stay tappable. Color tokens swap to
// muted variants; tabs aren't disabled.
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useYtcColors, useYtcTheme } from "@/contexts/YtcThemeContext";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { isYtcEpisodeId } from "@/lib/ytc/audio-adapter";

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
          borderTopWidth: 1,
          height: 56,
          paddingBottom: 6,
          opacity: ytcAudioActive ? 0.65 : 1,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} /> }} />
      <Tabs.Screen name="shiurim" options={{ title: "Shiurim", tabBarIcon: ({ color, size }) => <Ionicons name="headset" size={size} color={color} /> }} />
      <Tabs.Screen name="events" options={{ title: "Events", tabBarIcon: ({ color, size }) => <Ionicons name="calendar" size={size} color={color} /> }} />
      <Tabs.Screen name="contacts" options={{ title: "Contacts", tabBarIcon: ({ color, size }) => <Ionicons name="people" size={size} color={color} /> }} />
    </Tabs>
  );
}
