// YTC: pathname → screen-view tracker. Mounted in app/ytc/_layout.tsx.
// Renders nothing.
//
// Maps expo-router paths to web-style routes so YTC analytics align
// with the web's pageViews collection. Anything outside the YTC subtree
// is ignored (the user has navigated AWAY from YTC, not within it).
//
// Dedupe + referrer tracking happens inside lib/ytc/analytics.ts; this
// component only observes path changes.

import { useEffect, useRef } from "react";
import { usePathname } from "expo-router";
import { trackScreenView } from "@/lib/ytc/analytics";

/** Convert an expo-router path inside /ytc/* to the web-style path the
 *  YTC website's pageViews schema expects. Returns null when the path
 *  is outside the YTC subtree. */
function ytcPathToWebPath(pathname: string): string | null {
  if (!pathname.startsWith("/ytc")) return null;
  // Strip the /ytc prefix; the embedded mini-app's "/" is the home.
  let p = pathname.slice(4) || "/";
  // expo-router path groups like /ytc/(tabs)/shiurim leak as
  // "/(tabs)/shiurim" through usePathname() in older versions; usually
  // the parens are stripped, but normalize just in case.
  p = p.replace(/\/\([^)]+\)/g, "");
  if (p === "" || p === "/") return "/";
  // /ytc/(tabs) home itself maps to "/"
  if (p === "/(tabs)" || p === "/(tabs)/index") return "/";
  return p;
}

export function YtcAnalyticsObserver() {
  const pathname = usePathname();
  const prevWebPathRef = useRef<string | null>(null);

  useEffect(() => {
    const webPath = ytcPathToWebPath(pathname);
    if (!webPath) {
      // Left the YTC subtree — clear referrer so a future re-entry
      // doesn't carry a stale "previous YTC path".
      prevWebPathRef.current = null;
      return;
    }
    const referrer = prevWebPathRef.current;
    prevWebPathRef.current = webPath;
    // Fire-and-forget. The analytics module dedupes within 30s.
    trackScreenView(webPath, referrer).catch(() => {});
  }, [pathname]);

  return null;
}
