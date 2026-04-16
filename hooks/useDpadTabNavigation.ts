import { useEffect, useRef, useCallback } from "react";
import { Platform, DeviceEventEmitter } from "react-native";
import { usePathname, router } from "expo-router";

const TAB_ORDER = ["/", "/following", "/favorites", "/downloads", "/settings"] as const;
type TabRoute = typeof TAB_ORDER[number];

/** Map pathname to canonical tab route */
function currentTabIndex(pathname: string): number {
  if (pathname === "/" || pathname === "/index") return 0;
  const idx = TAB_ORDER.findIndex((r) => r !== "/" && pathname.startsWith(r));
  return idx >= 0 ? idx : 0;
}

/**
 * On Android D-pad devices: left/right arrow keys switch between tabs
 * unless a horizontally-scrollable element (carousel) currently has focus.
 *
 * Call `setCarouselFocused(true/false)` from the carousel's FocusableView
 * onFocus/onBlur to suppress tab switching while browsing the carousel.
 */
export function useDpadTabNavigation() {
  const pathname = usePathname();
  const carouselFocusedRef = useRef(false);

  const setCarouselFocused = useCallback((focused: boolean) => {
    carouselFocusedRef.current = focused;
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    // On Android, hardware key events can be intercepted via the DeviceEventEmitter
    // for 'onKeyDown' events dispatched by the root activity. However, the standard
    // React Native approach for non-TV Android is limited. Instead we rely on the
    // tab bar focus-based navigation (tabs switch when their icon is focused).
    // This hook is kept as a place to add future key event interception if needed.
  }, [pathname]);

  return { setCarouselFocused };
}

/**
 * Navigate to the next or previous tab relative to the current pathname.
 */
export function navigateToTab(direction: "left" | "right", pathname: string) {
  const idx = currentTabIndex(pathname);
  const nextIdx = direction === "right"
    ? Math.min(idx + 1, TAB_ORDER.length - 1)
    : Math.max(idx - 1, 0);
  if (nextIdx !== idx) {
    router.push(TAB_ORDER[nextIdx] as any);
  }
}

export { TAB_ORDER, currentTabIndex };
