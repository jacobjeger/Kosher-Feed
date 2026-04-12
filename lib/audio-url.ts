import { getApiUrl } from "@/lib/query-client";
import type { AudioProxyRule } from "@/contexts/RemoteConfigContext";

// Default rules baked in as fallback (matches the KH proxy pattern)
const DEFAULT_RULES: AudioProxyRule[] = [
  { match: "https?://srv\\.kolhalashon\\.com/api/files/(?:GetMp3FileToPlay|getLocationOfFileToVideo)/(\\d+)", replace: "/api/audio/kh/$1" },
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
        result = result.replace(`$${i}`, match[i] || "");
      }
      // If replacement is a relative path, prepend base URL
      if (result.startsWith("/")) {
        return baseUrl + result;
      }
      return result;
    }
  }
  return audioUrl;
}
