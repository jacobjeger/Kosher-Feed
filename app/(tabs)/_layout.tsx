import { Tabs, usePathname } from "expo-router";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { Platform, StyleSheet, View, Text, Pressable, Dimensions, Image, InteractionManager, AppState } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState, useEffect, useCallback, useRef } from "react";
import Colors from "@/constants/colors";
import { router } from "expo-router";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { setErrorContext } from "@/lib/error-logger";
// YTC: conditional 6th tab — only shown when the admin has set an
// unlock code AND this device has unlocked it. Hidden by default so
// the feature stays invisible to all other users (kill-switch + opt-in).
import { useRemoteConfig } from "@/contexts/RemoteConfigContext";
import { useYtcUnlocked, prewarmYtcDataIfPossible } from "@/lib/ytc/unlock";
import { ytcColors } from "@/constants/ytcColors";

/** Tab bar button that navigates on D-pad focus (Android) */
function DpadTabButton({ children, onPress, accessibilityState, ...rest }: any) {
  // On focus: call the tab bar's onPress synchronously (React will batch
  // state updates with the focus state change). Previously tried a rAF
  // defer to let the ring paint first, but that added a visible frame
  // of delay.
  const handleFocus = useCallback((e: any) => {
    if (Platform.OS === "android" && !accessibilityState?.selected && typeof onPress === "function") {
      try { onPress(e); } catch {}
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

  // Settings intentionally removed from web — downloads, haptics, push
  // toggles, etc. are irrelevant in a browser. Users manage those in the
  // mobile app. Keeping rightNavItems empty means the right side of the
  // nav is just the spacer.
  const rightNavItems: Array<{ label: string; route: string; icon: any }> = [];

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
          <Pressable
            onPress={() => {
              if (typeof window !== "undefined") window.location.href = "/";
            }}
            style={({ hovered }: any) => [
              webStyles.websiteLink,
              { backgroundColor: hovered ? (isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent" },
            ]}
          >
            <Ionicons name="globe-outline" size={16} color={colors.textSecondary} style={{ marginRight: 6 }} />
            <Text style={[webStyles.websiteLinkText, { color: colors.textSecondary }]}>Website</Text>
          </Pressable>
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
  // YTC: tab visibility gate.
  //  - admin must have set an unlock code (kill switch)
  //  - this device must have unlocked locally
  // Both false → tab is hidden via href: null. Settings remains the
  // unlock entry point; once unlocked, the tab appears.
  const remoteConfig = useRemoteConfig();
  const ytcEnabled = !!(remoteConfig.config.ytcUnlockCode as string | null | undefined);
  const ytcUnlocked = useYtcUnlocked();
  const showYtcTab = !isWeb && ytcEnabled && ytcUnlocked;

  // App-boot pre-warm: if the user was unlocked from a previous
  // session, fan out YTC's public Firestore reads so the cache layer
  // (lib/ytc/firebase.ts cached()) returns instantly when they tap /ytc.
  //
  // CRITICAL: defer this past first paint/interactions. Running it
  // immediately on a cold start blocks the single JS thread — the
  // Firebase SDK lazy-import is still synchronous CPU work even after
  // trimming fetchShiurim() out of the fan-out (see unlock.ts comment).
  //
  // Trigger: AppState 'background'/'inactive' OR a 30s fallback timer,
  // whichever comes first. The 2s setTimeout we used to have fired
  // while the home was still settling in on slow hardware. With the
  // new trigger, on Schok F1 hardware the pre-warm runs either while
  // the user has stepped out of the app (zero perceived cost) or 30s
  // after launch (well past the user's first interactions).
  useEffect(() => {
    if (!showYtcTab) return;
    let fired = false;
    const fire = () => { if (fired) return; fired = true; prewarmYtcDataIfPossible(); };
    let fallback: ReturnType<typeof setTimeout> | null = null;
    let appStateSub: { remove: () => void } | null = null;
    const task = InteractionManager.runAfterInteractions(() => {
      fallback = setTimeout(fire, 30_000);
      appStateSub = AppState.addEventListener("change", (state) => {
        if (state === "background" || state === "inactive") fire();
      });
    });
    return () => {
      task.cancel();
      if (fallback) clearTimeout(fallback);
      appStateSub?.remove();
    };
  }, [showYtcTab]);

  useKeyboardShortcuts();
  const pathname = usePathname();
  useEffect(() => { setErrorContext(pathname || "home"); }, [pathname]);

  // YTC tab: prevent multi-tap from stacking multiple /ytc modals.
  // Same family as the MiniPlayer double-tap bug — the tabBarButton's
  // onPress fires router.push synchronously, and on slow hardware the
  // pathname doesn't flip to "/ytc" before a second tap lands.
  const lastYtcPushAtRef = useRef(0);
  const openYtc = useCallback(() => {
    if (pathname?.startsWith("/ytc")) return;
    const now = Date.now();
    if (now - lastYtcPushAtRef.current < 800) return;
    lastYtcPushAtRef.current = now;
    router.push("/ytc" as any);
  }, [pathname]);

  const showTopNav = isDesktopWeb;
  const showBottomTabs = !isDesktopWeb;

  return (
    <>
      {showTopNav && <WebNavBar />}
      <Tabs
        screenOptions={{
          headerShown: false,
          animation: "none" as any,
          // Default lazy mount + no freeze. Freezing blurred tabs caused a
          // visible "thaw" on return; no-freeze keeps already-visited tabs
          // instantly responsive.
          lazy: true,
          // Hide tab labels — icons alone are enough on a 480px-wide screen
          // and gives the icons more room to render with the focus ring.
          tabBarShowLabel: false,
          tabBarActiveTintColor: colors.tint,
          tabBarInactiveTintColor: colors.tabIconDefault,
          tabBarStyle: showTopNav
            ? { display: "none" as const }
            : {
                position: "absolute" as const,
                backgroundColor: isIOS ? "transparent" : isDark ? "#0a0f1a" : "#f8f9fc",
                borderTopWidth: 0,
                elevation: 0,
                ...(isWeb
                  ? { height: 56, paddingBottom: 34 }
                  : {
                      // Size the bar explicitly. React Navigation's default
                      // centers the icons in a 49pt row and stacks the full
                      // home-indicator inset beneath them, which left a big
                      // empty band under the icons on iOS. Keep a slim
                      // clearance instead so the icons sit near the bottom.
                      height: 50 + safeAreaInsets.bottom,
                      paddingTop: 6,
                      paddingBottom: Math.max(safeAreaInsets.bottom - 8, 6),
                    }),
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
            // Hidden on ALL web (browser can't do persistent downloads
            // and settings is stripped from web entirely).
            href: isWeb ? null : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "cloud-download" : "cloud-download-outline"} size={22} color={color} />
            ),
            // expo-router throws on web if href and tabBarButton are both set —
            // only attach the D-pad button when the tab is actually rendered.
            ...(isDesktopWeb ? {} : { tabBarButton: (props: any) => <DpadTabButton {...props} /> }),
          }}
        />
        {/* YTC: 6th tab. Always-rendered Tabs.Screen (otherwise the
             route doesn't resolve at runtime), but href is null when
             the feature is disabled or this device is locked → tab is
             hidden from the bar. tabBarButton overrides the default
             tab-switch behaviour: tapping pushes /ytc as a
             fullScreenModal instead of swapping the tab content (the
             actual screen file at app/(tabs)/ytc.tsx is a no-op
             redirect). Gold tint marks it visually distinct from the
             rest of the bar — this is a "guest" surface, not a peer. */}
        <Tabs.Screen
          name="ytc"
          options={{
            title: "YTC",
            href: showYtcTab ? undefined : null,
            tabBarIcon: ({ focused }) => (
              <View style={{
                width: 30, height: 30, borderRadius: 15,
                backgroundColor: ytcColors.cream,
                alignItems: "center", justifyContent: "center",
                borderWidth: focused ? 1.5 : 0,
                borderColor: ytcColors.gold,
              }}>
                <Image
                  source={require("@/assets/images/ytc-logo.png")}
                  style={{ width: 26, height: 26 }}
                  resizeMode="contain"
                />
              </View>
            ),
            tabBarButton: showYtcTab
              ? (props: any) => (
                  <DpadTabButton
                    {...props}
                    onPress={openYtc}
                  />
                )
              : undefined,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            // Hidden on ALL web (browser can't do persistent downloads
            // and settings is stripped from web entirely).
            href: isWeb ? null : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "settings" : "settings-outline"} size={22} color={color} />
            ),
            ...(isDesktopWeb ? {} : { tabBarButton: (props: any) => <DpadTabButton {...props} /> }),
          }}
        />
      </Tabs>
      {/* MiniPlayer is rendered at the root via <MiniPlayerHost /> so it
          appears on every screen (podcast detail, category, stats, etc.),
          not just the 5 tab routes. */}
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
  websiteLink: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    ...(Platform.OS === "web" ? { transition: "background-color 0.15s ease" as any, cursor: "pointer" as any } : {}),
  },
  websiteLinkText: {
    fontSize: 13,
    fontWeight: "600" as const,
  },
});
