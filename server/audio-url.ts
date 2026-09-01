// Canonicalising a third-party enclosure URL into something a phone can play.
//
// Publishers put whatever they like in <enclosure url="...">, and a large
// slice of the back catalogue predates HTTPS. Android has refused cleartext
// HTTP since targetSdk 28 unless the manifest opts back in, and ours does not
// (the merged release manifest carries no usesCleartextTraffic and no
// networkSecurityConfig at targetSdk 36) — so every stored `http://` audio URL
// fails on device before a byte leaves the phone. It is not a slow load or a
// bad CDN; the platform never dials out. 1,600 episodes across 11 feeds were
// in that state, including 157 of the 353 Rabbi Orlofsky Show episodes, which
// is what "only random stuff works" looks like from the listener's side.
//
// Every one of those hosts serves the identical path over TLS, so the fix is
// to store the URL the way the phone can actually fetch it. Applied at ingest
// (server/rss.ts) so it holds for anything new, and backfilled over existing
// rows by scripts/fix-cleartext-audio-urls.ts.
//
// The equivalent rules also ship to already-installed apps through
// /api/config's audioProxyRules, so a device fixes a stale URL itself without
// waiting for a refresh. Keep the two in step: the regex pair in
// DEFAULT_AUDIO_PROXY_RULES (server/routes.ts) mirrors what this file does.

/**
 * Bucket names containing a dot break virtual-hosted S3 over TLS: the
 * wildcard cert covers `*.s3.amazonaws.com`, which does not match a host with
 * further dots to its left, so `bucket.with.dots.s3.amazonaws.com` fails the
 * handshake outright (ERR_TLS_CERT_ALTNAME_INVALID) rather than 404ing. The
 * path-style form `s3.amazonaws.com/bucket.with.dots/key` serves the same
 * object under a cert that does match. Group 2 keeps whatever regional
 * endpoint the publisher used.
 */
const S3_DOTTED_VHOST =
  /^https?:\/\/([^/]+\.[^/]+)\.(s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com)\/(.*)$/i;

/**
 * Stored enclosure URL -> the URL we should hand a player.
 *
 * Deliberately narrow. It only rewrites what is known-broken on device and
 * known-fixable, and returns everything else byte-for-byte: custom schemes
 * (yt://, and the platform adapters' own), server-relative paths, and every
 * URL that is already https.
 */
export function normalizeAudioUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return url;

  const s3 = url.match(S3_DOTTED_VHOST);
  if (s3) {
    const [, bucket, endpoint, key] = s3;
    return `https://${endpoint}/${bucket}/${key}`;
  }

  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;

  return url;
}

/** True when normalizeAudioUrl would change this URL. */
export function needsAudioUrlNormalization(raw: string): boolean {
  return normalizeAudioUrl(raw) !== raw.trim();
}
