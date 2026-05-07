// YTC: notification routing + deep-link consumption.
//
// FCM payloads from the YTC backend (see reference_ytc_backend memory)
// always include data.type. Mapping:
//
//   new_shiur     -> /ytc/(tabs)/shiurim   (with shiurId highlight when supplied)
//   simcha        -> /ytc/(tabs)/events
//   announcement  -> /ytc/(tabs)           (announcements live on home)
//   general/custom/fallback -> /ytc/(tabs)
//
// A future data.url field would be honored if its path matches a route
// we know natively. Browser/WebView fallback is OFF (kosher constraint).
//
// Cold-start tap: getInitialNotification() is consulted once on
// YtcPushHost mount.
// Warm tap: onNotificationOpenedApp fires when the user taps and the
// app was backgrounded.
//
// Locked YTC: if the device hasn't unlocked YTC yet, route to
// /ytc-unlock instead of the deep-linked screen.

import { router } from "expo-router";
import { Platform } from "react-native";
import { addLog } from "@/lib/error-logger";
import { isUnlocked } from "@/lib/ytc/unlock";

interface YtcNotificationData {
  type?: string;
  topic?: string;
  shiurId?: string;
  url?: string;
  timestamp?: string;
  [k: string]: any;
}

/** Strip the alumni.ytchaim.com host so callers can compare with relative
 *  routes. Returns null for unknown URLs we don't want to navigate to. */
function urlToInternalRoute(url: string): string | null {
  if (!url) return null;
  let p = url;
  try {
    const u = new URL(url);
    if (u.host.includes("alumni.ytchaim.com")) p = u.pathname + u.search;
    else if (u.protocol.startsWith("http")) {
      // External URL we can't safely render. Drop silently — kosher
      // constraint: no system browser, no WebView fallback.
      return null;
    }
  } catch { /* not a URL — assume relative */ }
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/** Map the website's relative path to a native route. Returns the
 *  expo-router target string if known, null otherwise. */
function mapPathToRoute(p: string): string | null {
  if (p === "/" || p === "") return "/ytc/(tabs)";
  if (p === "/shiurim") return "/ytc/(tabs)/shiurim";
  if (p === "/events" || p === "/simchas") return "/ytc/(tabs)/events";
  if (p === "/contacts") return "/ytc/(tabs)/contacts";
  if (p.startsWith("/shiurim/")) return "/ytc/(tabs)/shiurim";
  if (p.startsWith("/collections/")) {
    // /collections/{id} → native drill-in
    const id = p.split("/")[2];
    if (id) return `/ytc/collections/${id}`;
  }
  return null;
}

/** Single entry point that resolves a notification's deep-link target
 *  and pushes it onto the navigation stack. Idempotent — caller must
 *  ensure it only runs once per notification (the consumed flag in
 *  YtcPushHost handles this). */
export async function consumeYtcNotification(data: YtcNotificationData | null | undefined): Promise<void> {
  if (Platform.OS !== "android") return;
  if (!data) return;
  addLog("info", `YTC notification tap: ${JSON.stringify(data).slice(0, 200)}`, undefined, "ytc-push");

  const unlocked = await isUnlocked();
  if (!unlocked) {
    try { router.push("/ytc-unlock" as any); } catch {}
    return;
  }

  // data.url wins over data.type when present (per reference_ytc_backend).
  if (typeof data.url === "string") {
    const p = urlToInternalRoute(data.url);
    const target = p ? mapPathToRoute(p) : null;
    if (target) {
      try { router.push(target as any); return; } catch {}
    }
    // Unknown URL - drop silently and fall through to type-based mapping.
  }

  switch (data.type) {
    case "new_shiur":
      try { router.push("/ytc/(tabs)/shiurim" as any); } catch {}
      return;
    case "simcha":
      try { router.push("/ytc/(tabs)/events" as any); } catch {}
      return;
    case "announcement":
      try { router.push("/ytc/(tabs)" as any); } catch {}
      return;
    default:
      try { router.push("/ytc/(tabs)" as any); } catch {}
  }
}
