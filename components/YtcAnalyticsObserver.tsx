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
import { useYtcAuth } from "@/contexts/YtcAuthContext";

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
  const { user, isLoading: authLoading } = useYtcAuth();
  const prevWebPathRef = useRef<string | null>(null);
  // Hold the most-recent path that fired while we were still
  // pre-auth — when auth resolves to a signed-in user, we replay it
  // so the user gets credit for the home view they actually saw.
  // Without this, the user opening YTC from a cold start always logs
  // their first page view as anon (the auth state hasn't resolved by
  // the time the home pathname renders).
  const pendingReplayRef = useRef<{ webPath: string; referrer: string | null } | null>(null);

  useEffect(() => {
    const webPath = ytcPathToWebPath(pathname);
    if (!webPath) {
      prevWebPathRef.current = null;
      pendingReplayRef.current = null;
      return;
    }
    const referrer = prevWebPathRef.current;
    prevWebPathRef.current = webPath;

    // Auth-gate routes (login/pending) are pre-auth by definition —
    // those legitimately fire as anon. Inside-the-app routes wait
    // for auth before firing if the user hasn't arrived yet.
    const isAuthGate = webPath === "/login" || webPath === "/pending";
    if (isAuthGate || user) {
      trackScreenView(webPath, referrer).catch(() => {});
      pendingReplayRef.current = null;
    } else if (authLoading) {
      // Auth not yet resolved — queue this view for replay once we
      // know who the user is.
      pendingReplayRef.current = { webPath, referrer };
    } else {
      // Auth resolved + user is null (signed-out viewing an in-app
      // path somehow). Fire as anon.
      trackScreenView(webPath, referrer).catch(() => {});
    }
  }, [pathname, user, authLoading]);

  // Flush queued pageview once auth lands.
  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    const queued = pendingReplayRef.current;
    if (!queued) return;
    pendingReplayRef.current = null;
    trackScreenView(queued.webPath, queued.referrer).catch(() => {});
  }, [user, authLoading]);

  return null;
}
