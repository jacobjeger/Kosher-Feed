import { Tabs, usePathname } from "expo-router";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { Platform, StyleSheet, View, Text, Pressable, Dimensions } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState, useEffect, useCallback } from "react";
import Colors from "@/constants/colors";
import MiniPlayer from "@/components/MiniPlayer";
import { router } from "expo-router";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { setErrorContext } from "@/lib/error-logger";

/** Tab bar button that navigates on D-pad focus (Android) */
function DpadTabButton({ children, onPress, accessibilityState, ...rest }: any) {
  // On focus: just call the tab bar's own onPress (tab-aware navigation,
  // no stack push, no animation queueing). Much faster than router.push.
  const handleFocus = useCallback((e: any) => {
    if (Platform.OS === "android" && !accessibilityState?.selected && typeof onPress === "function") {
      onPress(e);
    }
  }, [onPress, accessibilityState?.selected]);

  return (
    <Pressable
      {...rest}
      onPress={onPress}
      onFocus={handleFocus}
      focusable={Platform.OS === "android"}
      accessibilityState={accessibilityState}
      style={rest.style}
    >
      {children}
    </Pressable>
  );
}

const DESKTOP_BREAKPOINT = 768;

function useIsDesktopWeb() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (Platform.OS !== "web") return false;
    return Dimensions.get("window").width >= DESKTOP_BREAKPOINT;
  });

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const sub = Dimensions.addEventListener("change", ({ window }) => {
      setIsDesktop(window.width >= DESKTOP_BREAKPOINT);
    });
    return () => sub?.remove();
  }, []);

  return Platform.OS === "web" && isDesktop;
}

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

  const rightNavItems = [
    { label: "Settings", route: "/settings", icon: "settings-outline" as const },
  ];

  const isActive = (route: string) => {
    if (route === "/") return pathname === "/" || pathname === "/index";
    return pathname === route;
  };

  return (
    <View style={[webStyles.navBar, { backgroundColor: isDark ? "#0f172a" : "#ffffff", borderBottomColor: isDark ? "#1e293b" : "#e2e8f0" }]}>
      <View style={webStyles.navInner}>
        <Pressable onPress={() => router.push("/")} style={webStyles.logoArea}>
          <View style={[webStyles.logoIcon, { backgroundColor: "#111111" }]}>
            <Text style={{ fontFamily: "serif", fontWeight: "700", fontSize: 11, lineHeight: 13, color: "#fff", textAlign: "center" }}>Shiur</Text>
            <Text style={{ fontFamily: "serif", fontWeight: "700", fontSize: 11, lineHeight: 13, color: "#1D4ED8", textAlign: "center" }}>Pod</Text>
          </View>
          <Text style={[webStyles.logoText, { color: colors.text }]}>
            <Text>Shiur</Text><Text style={{ color: "#1D4ED8" }}>Pod</Text>
          </Text>
        </Pressable>

        <View style={webStyles.navLinks}>
          {navItems.map((item) => {
            const active = isActive(item.route);
            return (
              <Pressable
                key={item.route}
                onPress={() => router.push(item.route as any)}
                style={({ hovered }: any) => [
                  webStyles.navLink,
                  active && { borderBottomColor: colors.accent, borderBottomWidth: 2 },
                  hovered && !active && { backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)" },
                ]}
              >
                <Ionicons
                  name={item.icon}
                  size={16}
                  color={active ? colors.accent : colors.textSecondary}
                  style={{ marginRight: 6 }}
                />
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

        <View style={webStyles.rightNav}>
          {rightNavItems.map((item) => {
            const active = isActive(item.route);
            return (
              <Pressable
                key={item.route}
                onPress={() => router.push(item.route as any)}
                style={({ hovered }: any) => [
                  webStyles.rightNavBtn,
                  { backgroundColor: hovered ? (isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent" },
                ]}
              >
                <Ionicons name={item.icon as any} size={20} color={active ? colors.accent : colors.textSecondary} />
              </Pressable>
            );
          })}
        </View>
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
  const isDesktopWeb = useIsDesktopWeb();

  useKeyboardShortcuts();
  const pathname = usePathname();
  useEffect(() => { setErrorContext(pathname || "home"); }, [pathname]);

  const showTopNav = isDesktopWeb;
  const showBottomTabs = !isDesktopWeb;

  return (
    <>
      {showTopNav && <WebNavBar />}
      <Tabs
        screenOptions={{
          headerShown: false,
          animation: "none" as any,
          // Pre-render all tabs on first mount so D-pad/tap switches are truly
          // instant. Without this, switching to a not-yet-visited tab briefly
          // shows the previous tab's content while the new one mounts.
          lazy: false,
          freezeOnBlur: false,
          detachInactiveScreens: false,
          tabBarActiveTintColor: colors.tint,
          tabBarInactiveTintColor: colors.tabIconDefault,
          tabBarStyle: showTopNav
            ? { display: "none" as const }
            : {
                position: "absolute" as const,
                backgroundColor: isIOS ? "transparent" : isDark ? "#0a0f1a" : "#f8f9fc",
                borderTopWidth: 0,
                elevation: 0,
                ...(isWeb ? { height: 56, paddingBottom: 34 } : {}),
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
            tabBarButton: (props) => <DpadTabButton {...props} />,
          }}
        />
        <Tabs.Screen
          name="following"
          options={{
            title: "Following",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "heart" : "heart-outline"} size={22} color={color} />
            ),
            tabBarButton: (props) => <DpadTabButton {...props} />,
          }}
        />
        <Tabs.Screen
          name="favorites"
          options={{
            title: "Favorites",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "star" : "star-outline"} size={22} color={color} />
            ),
            tabBarButton: (props) => <DpadTabButton {...props} />,
          }}
        />
        <Tabs.Screen
          name="downloads"
          options={{
            title: "Downloads",
            href: isDesktopWeb ? null : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "cloud-download" : "cloud-download-outline"} size={22} color={color} />
            ),
            tabBarButton: (props) => <DpadTabButton {...props} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            href: isDesktopWeb ? null : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "settings" : "settings-outline"} size={22} color={color} />
            ),
            tabBarButton: (props) => <DpadTabButton {...props} />,
          }}
        />
      </Tabs>
      {showTopNav ? (
        <View style={webStyles.miniPlayerWeb}>
          <MiniPlayer />
        </View>
      ) : (
        <View style={{ position: "absolute", bottom: (isWeb ? 56 + 34 : (isIOS ? 80 : 56) + safeAreaInsets.bottom), left: 0, right: 0 }}>
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
    ...(Platform.OS === "web" ? { boxShadow: "0 1px 3px rgba(0,0,0,0.04)" as any } : {}),
  },
  navInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    maxWidth: 1080,
    marginHorizontal: "auto" as any,
    width: "100%" as any,
    height: 64,
  },
  logoArea: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logoIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    fontSize: 20,
    fontWeight: "800" as const,
    letterSpacing: -0.5,
  },
  navLinks: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  navLink: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    borderRadius: 8,
    ...(Platform.OS === "web" ? { transition: "all 0.2s ease" as any, cursor: "pointer" as any } : {}),
  },
  navLinkText: {
    fontSize: 14,
    fontWeight: "600" as const,
  },
  rightNav: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
  },
  rightNavBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    ...(Platform.OS === "web" ? { transition: "background-color 0.15s ease" as any, cursor: "pointer" as any } : {}),
  },
  miniPlayerWeb: {
    position: "fixed" as any,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 200,
  },
});
