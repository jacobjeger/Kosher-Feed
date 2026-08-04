// The canonical public origin for anything that outlives a request.
//
// This exists because getting it wrong is PERMANENT. Feed URLs, enclosure URLs
// and <item><link> values are fetched by subscribers' podcast apps for years.
// A vendor hostname baked into a published feed cannot be taken back: if we
// ever leave Railway, every one of those subscriptions dies with no way to
// reach the listeners.
//
// The trap this guards against is real and was live: EXPO_PUBLIC_API_URL on
// Railway is set to https://kosher-feed-production.up.railway.app, not
// shiurpod.com. Anything that resolved a "public base URL" from that variable
// silently produced feeds pointing at the vendor host.
//
// Request headers are also not trustworthy for this. Host/x-forwarded-host is
// whatever the caller connected to — fetching the feed through the Railway
// domain would otherwise regenerate and CACHE it with Railway URLs inside,
// poisoning what everyone else is served.

const FALLBACK = "https://shiurpod.com";

/** Hostnames that must never appear in a persisted public URL. */
const VENDOR_HOST_RE = /(\.railway\.app|\.up\.railway\.app|\.r2\.dev|\.vercel\.app|\.onrender\.com|localhost|127\.0\.0\.1)/i;

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function usable(url: string | undefined | null): string | null {
  if (!url) return null;
  const u = normalise(url);
  if (!/^https?:\/\//i.test(u)) return null;
  if (VENDOR_HOST_RE.test(u)) return null;
  return u;
}

/**
 * The origin to embed in feeds, enclosures and links.
 *
 * Deliberately ignores the request: this value gets persisted, so it must be
 * the same no matter which hostname served the call.
 */
export function canonicalBaseUrl(): string {
  // Explicit override wins, but still has to survive the vendor-host check —
  // setting PUBLIC_BASE_URL to a railway domain is a mistake, not an intent.
  const explicit = usable(process.env.PUBLIC_BASE_URL);
  if (explicit) return explicit;

  // Railway sets this to the custom domain (shiurpod.com), unlike
  // EXPO_PUBLIC_API_URL which points at the vendor host.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) {
    const withScheme = usable(`https://${railwayDomain}`);
    if (withScheme) return withScheme;
  }

  return FALLBACK;
}

/** True if this URL would be unsafe to persist in a published feed. */
export function isVendorHost(url: string): boolean {
  return VENDOR_HOST_RE.test(url);
}
