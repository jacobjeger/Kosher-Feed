// YTC: tabs layout for the auth-gated section. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/_layout.tsx with the in-file
// MiniPlayer wrapper REMOVED — shiurpod's <MiniPlayerHost> renders
// globally above tab bars on all routes including this one.
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.gold,
        tabBarInactiveTintColor: Colors.navyOpacity50,
        tabBarStyle: {
          backgroundColor: Colors.white,
          borderTopColor: Colors.creamDark,
          borderTopWidth: 1,
          height: 56,
          paddingBottom: 6,
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
