import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { addLog } from "@/lib/error-logger";
import type { Episode, Feed } from "@/lib/types";

async function fetchSharedEpisode(episodeId: string): Promise<{ episode: Episode; feed: Feed } | null> {
  try {
    const url = `${getApiUrl()}/api/share/episode/${episodeId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return { episode: data.episode, feed: data.feed };
  } catch (e) {
    addLog("error", `Failed to fetch shared episode: ${(e as any)?.message}`, undefined, "deeplink");
    return null;
  }
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function parseDeepLink(url: string): { episodeId: string; timestamp?: number } | null {
  try {
    // Legacy shiurpod://episode/{id}?t= deep links.
    if (url.includes("/episode/")) {
      const rest = url.split("/episode/")[1];
      if (!rest) return null;
      const [id, queryString] = rest.split("?");
      let timestamp: number | undefined;
      if (queryString) {
        const t = new URLSearchParams(queryString).get("t");
        if (t) timestamp = parseInt(t, 10);
      }
      return { episodeId: id, timestamp };
    }
    // Universal links: episode pages /{speaker}/{title}-{uuid}, and the
    // player deep link /app|/webapp/player?e={id}. Pull the episode id from
    // the ?e= query first, else the trailing UUID in the path.
    let path = url;
    let query = new URLSearchParams(url.split("?")[1] || "");
    try { const u = new URL(url); path = u.pathname; query = u.searchParams; } catch { /* non-URL scheme */ }
    const eParam = query.get("e");
    if (eParam && UUID_RE.test(eParam)) return { episodeId: eParam };
    const m = path.match(UUID_RE);
    if (m) return { episodeId: m[1] };
    return null;
  } catch {
    return null;
  }
}

export function DeepLinkHandler() {
  const { playEpisode, seekTo } = useAudioPlayer();
  const handledRef = useRef<string | null>(null);

  const handleUrl = async (url: string) => {
    if (!url || handledRef.current === url) return;
    handledRef.current = url;

    const parsed = parseDeepLink(url);
    if (!parsed) return;

    addLog("info", `Deep link received: episode ${parsed.episodeId}`, undefined, "deeplink");

    const data = await fetchSharedEpisode(parsed.episodeId);
    if (!data) {
      addLog("error", `Deep link: episode ${parsed.episodeId} not found`, undefined, "deeplink");
      return;
    }

    router.push("/player");
    playEpisode(data.episode, data.feed).then(() => {
      if (parsed.timestamp && parsed.timestamp > 0) {
        setTimeout(() => {
          seekTo(parsed.timestamp!);
        }, 1000);
      }
    }).catch(console.error);
  };

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });

    const subscription = Linking.addEventListener("url", (event) => {
      handleUrl(event.url);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  return null;
}
