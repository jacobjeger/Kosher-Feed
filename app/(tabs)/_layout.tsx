import { Tabs, usePathname } from "expo-router";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { Platform, StyleSheet, View, Text, Pressable } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React from "react";
import Colors from "@/constants/colors";
import MiniPlayer from "@/components/MiniPlayer";
import { router } from "expo-router";

function WebNavBar() {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const pathname = usePathname();

  const navItems = [
    { label: "Home", route: "/", icon: "home" as const },
    { label: "Following", route: "/following", icon: "heart" as const },
    { label: "Favorites", route: "/favorites", icon: "star" as const },
  ];

  const isActive = (route: string) => {
    if (route === "/") return pathname === "/" || pathname === "/index";
    return pathname === route;
  };

  return (
    <View style={[webStyles.navBar, { backgroundColor: isDark ? "#0f172a" : "#ffffff", borderBottomColor: isDark ? "#1e293b" : "#e2e8f0" }]}>
      <View style={webStyles.navInner}>
        <Pressable onPress={() => router.push("/")} style={webStyles.logoArea}>
          <View style={[webStyles.logoIcon, { backgroundColor: colors.accent }]}>
            <Ionicons name="headset" size={18} color="#fff" />
          </View>
          <Text style={[webStyles.logoText, { color: colors.text }]}>ShiurPod</Text>
        </Pressable>

        <View style={webStyles.navLinks}>
          {navItems.map((item) => {
            const active = isActive(item.route);
            return (
              <Pressable
                key={item.route}
                onPress={() => router.push(item.route as any)}
                style={[
                  webStyles.navLink,
                  active && { borderBottomColor: colors.accent, borderBottomWidth: 2 },
                ]}
              >
                <Text
                  style={[
                    webStyles.navLinkText,
                    { color: active ? colors.accent : colors.textSecondary },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={{ width: 120 }} />
      </View>
    </View>
  );
}

export default function TabLayout() {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const isWeb = Platform.OS === "web";
  const isIOS = Platform.OS === "ios";
  const safeAreaInsets = useSafeAreaInsets();

  return (
    <>
      {isWeb && <WebNavBar />}
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.tint,
          tabBarInactiveTintColor: colors.tabIconDefault,
          tabBarStyle: isWeb
            ? { display: "none" as const }
            : {
                position: "absolute" as const,
                backgroundColor: isIOS ? "transparent" : isDark ? "#0a0f1a" : "#f8f9fc",
                borderTopWidth: 0,
                elevation: 0,
              },
          tabBarBackground: () =>
            isIOS ? (
              <BlurView
                intensity={100}
                tint={isDark ? "dark" : "light"}
                style={StyleSheet.absoluteFill}
              />
            ) : null,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Home",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "home" : "home-outline"} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="following"
          options={{
            title: "Following",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "heart" : "heart-outline"} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="favorites"
          options={{
            title: "Favorites",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "star" : "star-outline"} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="downloads"
          options={{
            title: "Downloads",
            href: isWeb ? null : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "cloud-download" : "cloud-download-outline"} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            href: isWeb ? null : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "settings" : "settings-outline"} size={22} color={color} />
            ),
          }}
        />
      </Tabs>
      {isWeb ? (
        <View style={webStyles.miniPlayerWeb}>
          <MiniPlayer />
        </View>
      ) : (
        <View style={{ position: "absolute", bottom: (Platform.OS === "ios" ? 80 : 56) + safeAreaInsets.bottom, left: 0, right: 0 }}>
          <MiniPlayer />
        </View>
      )}
    </>
  );
}

const webStyles = StyleSheet.create({
  navBar: {
    borderBottomWidth: 1,
    paddingHorizontal: 24,
    zIndex: 100,
  },
  navInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    maxWidth: 1200,
    marginHorizontal: "auto" as any,
    width: "100%" as any,
    height: 60,
  },
  logoArea: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logoIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    fontSize: 20,
    fontWeight: "700" as const,
    letterSpacing: -0.5,
  },
  navLinks: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  navLink: {
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  navLinkText: {
    fontSize: 15,
    fontWeight: "500" as const,
  },
  miniPlayerWeb: {
    position: "fixed" as any,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 200,
  },
});
