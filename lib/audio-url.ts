import { getApiUrl } from "@/lib/query-client";
import type { AudioProxyRule } from "@/contexts/RemoteConfigContext";

// Default rules baked in as fallback (matches the KH proxy pattern)
const DEFAULT_RULES: AudioProxyRule[] = [
  { match: "https?://srv\\.kolhalashon\\.com/api/files/(?:GetMp3FileToPlay|getLocationOfFileToVideo)/(\\d+)", replace: "/api/audio/kh/$1" },
  // YouTube episodes store a yt://audio/{videoId} placeholder rather than a
  // real URL — googlevideo links expire in ~6h, so the server mints a fresh
  // one per playback behind this proxy path.
  { match: "^yt://audio/([A-Za-z0-9_-]{11})$", replace: "/api/audio/yt/$1" },
  // A dotted bucket name breaks virtual-hosted S3 over TLS — the wildcard
  // cert on *.s3.amazonaws.com does not cover a host with more dots to its
  // left, so the handshake fails outright. Path-style serves the same object
  // under a cert that matches. Must precede the cleartext rule below, which
  // would otherwise claim these first and leave the broken hostname in place.
  {
    match: "^https?://([^/]+\\.[^/]+)\\.(s3(?:[.-][a-z0-9-]+)*\\.amazonaws\\.com)/(.*)$",
    replace: "https://$2/$1/$3",
  },
  // Android has refused cleartext since targetSdk 28 and our manifest does not
  // opt back in, so an http:// episode never leaves the phone — it is not slow,
  // it is unreachable. Every host in the catalogue serves the same path over
  // TLS, so upgrade the scheme rather than surface a dead episode. Keep last:
  // it matches any http:// URL, so a more specific rule must come first.
  { match: "^http://(.*)$", replace: "https://$1" },
];

let _rules: AudioProxyRule[] = DEFAULT_RULES;
let _compiledRules: { regex: RegExp; replace: string }[] | null = null;

export function setAudioProxyRules(rules: AudioProxyRule[]) {
  _rules = rules && rules.length > 0 ? rules : DEFAULT_RULES;
  _compiledRules = null; // invalidate compiled cache
}

function getCompiledRules() {
  if (!_compiledRules) {
    _compiledRules = _rules.map(r => {
      try { return { regex: new RegExp(r.match), replace: r.replace }; }
      catch { return null; }
    }).filter(Boolean) as { regex: RegExp; replace: string }[];
  }
  return _compiledRules;
}

export function resolveAudioUrl(audioUrl: string): string {
  const baseUrl = getApiUrl();
  for (const rule of getCompiledRules()) {
    const match = audioUrl.match(rule.regex);
    if (match) {
      // Build replacement: $1, $2 etc. refer to capture groups
      let result = rule.replace;
      for (let i = 1; i < match.length; i++) {
        // Substitute literally. String.replace treats $&, $', $` and $n in the
        // REPLACEMENT as patterns, and the replacement here is captured URL
        // text — a path containing one of those would come out mangled. The
        // Kotlin mirror of this loop in ShiurPodAutoService is already literal
        // on both sides; a function replacer matches it.
        const group = match[i] || "";
        result = result.replace(`$${i}`, () => group);
      }
      // If replacement is a relative path, prepend base URL
      if (result.startsWith("/")) {
        return baseUrl + result;
      }
      return result;
    }
  }
  // Server-relative audio (stored YouTube MP3s are saved as
  // /api/media/yt/{id}.mp3) must be absolutised against the API host. A bare
  // path works in the browser because it resolves against the page origin, but
  // the native player needs a full URI and fails silently without one.
  if (audioUrl.startsWith("/")) {
    return baseUrl + audioUrl;
  }
  return audioUrl;
}
