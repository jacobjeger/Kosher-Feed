import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

const apiFetch: typeof globalThis.fetch =
  Platform.OS === "web"
    ? globalThis.fetch.bind(globalThis)
    : require("expo/fetch").fetch;

const PRODUCTION_API_URL = "https://kosher-feed.replit.app";
const REQUEST_TIMEOUT_MS = 12000;
const CACHE_PREFIX = "shiurpod_cache_";

export function getApiUrl(): string {
  const host = process.env.EXPO_PUBLIC_DOMAIN;

  if (Platform.OS === "web" && typeof window !== "undefined") {
    if (host) {
      const protocol = window.location.protocol || "https:";
      return `${protocol}//${host}`;
    }
    return window.location.origin;
  }

  if (__DEV__ && host) {
    return `https://${host}`;
  }

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

async function getCachedResponse<T>(key: string, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<T | null> {
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
    },
    mutations: {
      retry: 1,
    },
  },
});
