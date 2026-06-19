// Client helper that rewrites an arbitrary podcast-artwork URL into a call
// to our /api/images/resize proxy at a specific target width. The proxy
// returns a WebP, sized to that width, with a year-long Cache-Control so
// Cloudflare's edge handles persistence — the origin sees one request per
// (url, width) globally.
//
// Why this matters: source artwork is typically 1400×1400 (iTunes spec).
// expo-image decodes at source resolution, so a single small thumbnail
// was eating ~7.8MB of decoded bitmap RAM. Resizing to 320px brings that
// down to ~0.4MB — a ~20× reduction that eliminates the mid-scroll GC
// spike measured on the Schok F1 (2026-06-18 frame trace).

import { Platform } from "react-native";
import { getApiUrl } from "@/lib/query-client";

// Standard widths the app uses. Pick the closest *2 to the display size for
// retina-ish sharpness. New callsites should choose from this menu rather
// than passing arbitrary numbers, so Cloudflare cache hit-rate stays high.
export const IMG_THUMB = 192;   // 64-96px avatars (MaggidShiur, all-maggidei-shiur)
export const IMG_CARD  = 320;   // 120-160px podcast cards (Popular, AllShiurim, ContinueListening, search results, category/all-shiurim rows)
export const IMG_HERO  = 720;   // featured carousel + full-screen artwork (player, podcast detail, queue)

const PASSTHROUGH = (url: string) =>
  url.startsWith("data:") ||
  url.startsWith("file:") ||
  url.startsWith("blob:") ||
  url.startsWith("/api/images/") ||      // static brand assets we already serve
  url.includes("/api/images/resize") ||  // already proxied
  url.includes("/cdn-cgi/image/");       // already through CF image resizing

/**
 * Wrap a remote image URL so it's served through our resize proxy at the
 * given target width. Returns null for null/empty inputs. Returns the URL
 * unchanged for local URIs (data:/file:/blob:), our own static assets,
 * or URLs already going through a resizer.
 *
 * Web platforms intentionally bypass the proxy — browsers handle decoded
 * bitmap caching themselves and we'd just be adding a hop.
 */
export function resizedImageUrl(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  if (Platform.OS === "web") return url;
  if (PASSTHROUGH(url)) return url;
  const base = getApiUrl();
  return `${base}/api/images/resize?url=${encodeURIComponent(url)}&w=${width}&f=webp`;
}

// Local bundled fallback logos. Server's addDefaultImage sets
// feed.imageUrl to https://shiurpod.com/api/images/{ou-torah-logo,kol-
// halashon-logo}.png for KH / OU-network feeds with no artwork. These
// two URLs alone accounted for ~54 of ~262 Glide loads in the Moshe
// Greer 2026-06-16 session — each went through DATA_DISK_CACHE
// (200ms–1.4s on Schok F1) because Glide's memory cache was getting
// evicted under pressure. The PNGs already exist in assets/images/,
// so we substitute the bundled asset at render time and avoid network
// + disk-cache entirely.
const KH_LOGO_LOCAL = require("@/assets/images/kol-halashon-logo.png");
const OU_LOGO_LOCAL = require("@/assets/images/ou-torah-logo.png");

function isLocalDefaultLogo(url: string): "kh" | "ou" | null {
  // Match by suffix so we catch both staging and production hosts.
  if (url.endsWith("/api/images/kol-halashon-logo.png")) return "kh";
  if (url.endsWith("/api/images/ou-torah-logo.png")) return "ou";
  return null;
}

/**
 * Resolve a feed/episode image URL to an expo-image `source` value.
 * Use this INSTEAD of `{ uri: resizedImageUrl(url, w) }` at the Image
 * call site, so the bundled OU / KH fallbacks short-circuit to a
 * require()'d asset (instant, no disk-cache pressure) while other URLs
 * still go through the resize proxy.
 *
 * Return type is `any` to satisfy expo-image's polymorphic `source`
 * prop (string | object | number) without forcing every call site to
 * import expo-image's ImageSource type.
 */
export function feedImageSource(url: string | null | undefined, width: number): any {
  if (!url) return null;
  const local = isLocalDefaultLogo(url);
  if (local === "kh") return KH_LOGO_LOCAL;
  if (local === "ou") return OU_LOGO_LOCAL;
  const resized = resizedImageUrl(url, width);
  return resized ? { uri: resized } : null;
}
