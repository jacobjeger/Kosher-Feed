import { Platform, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryFunction, keepPreviousData, focusManager, onlineManager } from "@tanstack/react-query";

// React Native integration for TanStack Query. Without this, focusManager
// assumes the app is *permanently focused* (there's no `document` on native),
// so every `refetchInterval` keeps firing even when the app is backgrounded —
// the root cause of the app burning mobile data in the background (e.g.
// BackgroundSync's 30-min feed/latest-episode polls). Wiring focus to AppState
// pauses interval refetches while backgrounded (refetchIntervalInBackground is
// false by default). New-episode notifications are unaffected: they arrive via
// server FCM push, and BackgroundSync still re-checks on AppState → active.
if (Platform.OS !== "web") {
  focusManager.setEventListener((handleFocus) => {
    const sub = AppState.addEventListener("change", (status) => {
      handleFocus(status === "active");
    });
    return () => sub.remove();
  });

  // onlineManager: stop firing fetches while the device is offline. Falls back
  // to "assume online" if expo-network isn't available so we never wedge.
  onlineManager.setEventListener((setOnline) => {
    try {
      const Network = require("expo-network");
      const sub = Network.addNetworkStateListener((state: any) => {
        setOnline(!!state.isConnected && state.isInternetReachable !== false);
      });
      return () => { try { sub?.remove?.(); } catch {} };
    } catch {
      setOnline(true);
      return () => {};
    }
  });
}

const apiFetch: typeof globalThis.fetch =
  Platform.OS === "web"
    ? globalThis.fetch.bind(globalThis)
    : require("expo/fetch").fetch;

// Use the brand domain (shiurpod.com) instead of the *.railway.app subdomain
// for kosher-phone compatibility. Many kosher Android filters allowlist
// known brand domains but treat unknown *.railway.app subdomains as
// untrusted, causing TypeError: Network request failed and
// UnknownHostException on every API call. shiurpod.com points to the same
// Railway origin, just behind Cloudflare. Override via EXPO_PUBLIC_API_URL
// for staging or local-tunnel testing.
const PRODUCTION_API_URL = process.env.EXPO_PUBLIC_API_URL || "https://shiurpod.com";
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_PREFIX = "shiurpod_cache_";

export function getApiUrl(): string {
  // Web: always same-origin (Express serves both frontend and API)
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.location.origin;
  }

  // Native development
  const host = process.env.EXPO_PUBLIC_DOMAIN;
  if (__DEV__ && host) {
    const cleanHost = host.replace(/:5000$/, "").replace(/:443$/, "");
    return `https://${cleanHost}`;
  }

  // Native production
  return PRODUCTION_API_URL;
}

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return apiFetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

async function cacheResponse(key: string, data: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

async function getCachedResponse<T>(key: string, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > maxAgeMs) return null;
    return data as T;
  } catch {
    return null;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  route: string,
  data?: unknown | undefined,
): Promise<Response> {
  const baseUrl = getApiUrl();
  const url = new URL(route, baseUrl);

  const res = await fetchWithTimeout(url.toString(), {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const baseUrl = getApiUrl();
    const cacheKey = queryKey.join("/");
    const url = new URL(cacheKey as string, baseUrl);

    try {
      const res = await fetchWithTimeout(url.toString(), {
        credentials: "include",
      });

      if (unauthorizedBehavior === "returnNull" && res.status === 401) {
        return null;
      }

      await throwIfResNotOk(res);
      const data = await res.json();
      cacheResponse(cacheKey, data);
      return data;
    } catch (error: any) {
      const cached = await getCachedResponse(cacheKey);
      if (cached) {
        return cached;
      }
      throw error;
    }
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
      // Keep previous data visible while refetching — prevents screens from
      // flashing to skeleton when switching between cached tabs.
      placeholderData: keepPreviousData,
    },
    mutations: {
      retry: 1,
    },
  },
});
