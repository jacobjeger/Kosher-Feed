// Error capture — global handlers + reportError API.
// Mirrors the old lib/error-logger.ts wire-up but emits through the new
// telemetry core (which posts to /api/v1/ingest/events).

import { Platform } from "react-native";
import { enqueueEvent, drainPersistedOnInit } from "./core";
import { addBreadcrumb, getBreadcrumbs } from "./breadcrumbs";

let _currentScreen = "unknown";
let _currentAction = "idle";

export function setErrorContext(screen: string, action?: string) {
  _currentScreen = screen;
  if (action) _currentAction = action;
}

export function getErrorContext() {
  return { screen: _currentScreen, action: _currentAction };
}

export type ReportSeverity = "fatal" | "nonfatal" | "warn";

export function reportError(opts: {
  message: string;
  stack?: string | null;
  source?: string;
  severity?: ReportSeverity;
  metadata?: Record<string, any>;
}) {
  const ctx = getErrorContext();
  enqueueEvent({
    message: opts.message.substring(0, 2000),
    stack: opts.stack ? opts.stack.substring(0, 5000) : null,
    source: opts.source || null,
    severity: opts.severity || "nonfatal",
    breadcrumbs: getBreadcrumbs(),
    metadata: {
      ...(opts.metadata || {}),
      screen: ctx.screen,
      action: ctx.action,
    },
  });
}

// In-memory log buffer that the existing admin/debug screens already read.
export interface LogEntry {
  id: string;
  level: "error" | "warn" | "info";
  message: string;
  stack?: string;
  timestamp: number;
  source?: string;
}

const MAX_LOGS = 200;
let logs: LogEntry[] = [];
let listeners: Set<() => void> = new Set();

function notify() { listeners.forEach(fn => fn()); }

export function subscribeLogs(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getLogsSnapshot(): LogEntry[] { return logs; }
export async function clearLogs() {
  logs = [];
  notify();
  try {
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.removeItem("APP_ERROR_LOGS");
  } catch {}
}

function persistLogs() {
  try {
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    AsyncStorage.setItem("APP_ERROR_LOGS", JSON.stringify(logs.slice(0, 50))).catch(() => {});
  } catch {}
}

// Push-registration breadcrumbs (token fetch, permission state, FCM/Expo
// handshake steps) flow through console.warn for logcat visibility and used
// to dominate the admin error feed. Drop at capture time; real push errors
// (severity === fatal/nonfatal explicitly via reportError) bypass this filter.
function isPushNoise(msg: string): boolean {
  return /\[push\]|\[fcm\]|\[expo-push\]|expo push token|fcm token|push token|notification permissions/i.test(msg);
}

const NOISE_PATTERNS = [
  "useNativeDriver", "shadow*", "pointerEvents is deprecated",
  "expo-notifications", "should be updated for best compatibility",
  // expo-router passes iOS-only Stack.Screen props on every nav transition;
  // RNScreens warns once per prop per screen. 70+ duplicate lines in
  // Moshe's log (2026-06-16 session) — pure noise from a library default,
  // not anything we can fix in our code.
  "[RNScreens]:",
];

function isNoisyMsg(msg: string): boolean {
  if (!msg) return false;
  if (isPushNoise(msg)) return true;
  return NOISE_PATTERNS.some(p => msg.includes(p));
}

function addLogLocal(level: LogEntry["level"], message: string, stack?: string, source?: string) {
  const entry: LogEntry = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
    level, message: message.substring(0, 2000),
    stack: stack?.substring(0, 3000),
    timestamp: Date.now(),
    source,
  };
  logs = [entry, ...logs].slice(0, MAX_LOGS);
  notify();
  persistLogs();
}

// Public addLog — back-compat with the old lib/error-logger.ts surface.
// Errors/warns also flow to the server pipe (except push-registration noise
// and 4xx fetch warnings, which the old code also dropped).
export function addLog(level: LogEntry["level"], message: string, stack?: string, source?: string) {
  addLogLocal(level, message, stack, source);
  if (level === "info") return;
  const isFetchWarn = source === "fetch" && level === "warn";
  const isPushInfo = (source === "push" || source === "notifications") && level !== "error";
  if (isFetchWarn || isPushInfo) return;
  enqueueEvent({
    message,
    stack,
    source: source || null,
    severity: level === "error" ? "nonfatal" : "warn",
    breadcrumbs: getBreadcrumbs(),
    metadata: { ...getErrorContext() },
  });
}

export function logEvent(event: string, details?: Record<string, any>) {
  const detailStr = details ? " " + JSON.stringify(details) : "";
  addLogLocal("info", `[EVENT] ${event}${detailStr}`, undefined, "app-event");
  addBreadcrumb("ui", event, details);
}

function isNoisyFetchUrl(url: string): boolean {
  return /(^https?:\/\/)?(exp\.host|expo\.dev|expo\.io|fcm\.googleapis\.com|push\.expo\.dev|api\.pushy\.me)\b/.test(url);
}

function isNoisyError(msg: string): boolean {
  if (!msg) return false;
  return /^Aborted$|AbortError|aborted by the user|signal is aborted|Request aborted|Network request was aborted/i.test(msg);
}

let initialized = false;

export function initErrorCapture() {
  if (initialized) return;
  initialized = true;

  // Load persisted logs (in-memory ring buffer for the debug screen).
  try {
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    AsyncStorage.getItem("APP_ERROR_LOGS").then((data: string | null) => {
      if (data) {
        try { logs = JSON.parse(data); notify(); } catch {}
      }
    }).catch(() => {});
  } catch {}

  // Drain pending events/metrics persisted from previous session.
  drainPersistedOnInit();

  // console.error / console.warn
  const origError = console.error;
  const origWarn = console.warn;

  console.error = (...args: any[]) => {
    origError.apply(console, args);
    const msg = args.map(a => a instanceof Error ? a.message : typeof a === "object" ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })() : String(a)).join(" ");
    if (isNoisyMsg(msg)) return;
    const stack = (args.find(a => a instanceof Error) as Error | undefined)?.stack || new Error().stack;
    addLog("error", msg, stack, "console.error");
  };

  console.warn = (...args: any[]) => {
    origWarn.apply(console, args);
    const msg = args.map(a => typeof a === "object" ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })() : String(a)).join(" ");
    if (isNoisyMsg(msg)) return;
    addLog("warn", msg, undefined, "console.warn");
  };

  // Unhandled promise rejection
  if (typeof globalThis !== "undefined") {
    const orig = (globalThis as any).onunhandledrejection;
    (globalThis as any).onunhandledrejection = (event: any) => {
      const reason = event?.reason;
      const msg = reason instanceof Error ? reason.message : String(reason || "Unknown promise rejection");
      const stack = reason instanceof Error ? reason.stack : undefined;
      addLog("error", msg, stack, "unhandled-promise");
      if (orig) orig(event);
    };
  }

  // Global RN error handler — fatal flag from RN tells us when to escalate.
  const EU: any = (globalThis as any).ErrorUtils;
  if (EU?.setGlobalHandler) {
    const orig = EU.getGlobalHandler?.();
    EU.setGlobalHandler((error: any, isFatal?: boolean) => {
      const msg = `${isFatal ? "[FATAL] " : ""}${error?.message || error}`;
      addLogLocal("error", msg, error?.stack, "global-error");
      enqueueEvent({
        message: msg,
        stack: error?.stack,
        source: "global-error",
        severity: isFatal ? "fatal" : "nonfatal",
        breadcrumbs: getBreadcrumbs(),
        metadata: { ...getErrorContext() },
      });
      if (orig) orig(error, isFatal);
    });
  }

  // fetch wrapper — tracks 4xx/5xx + network errors + slow calls (via metrics).
  // Also emits breadcrumb so error reports show the requests around the failure.
  const origFetch = globalThis.fetch;
  (globalThis as any).__origFetch = origFetch;
  if (origFetch) {
    (globalThis as any).fetch = async (...args: Parameters<typeof fetch>) => {
      const startedAt = Date.now();
      const url = typeof args[0] === "string"
        ? args[0]
        : args[0] instanceof Request ? args[0].url : String(args[0]);
      const method = (args[1]?.method || "GET").toUpperCase();
      try {
        const res = await origFetch(...args);
        const elapsed = Date.now() - startedAt;
        addBreadcrumb("fetch", `${method} ${shortUrl(url)} → ${res.status} (${elapsed}ms)`);

        // emit slow-call metric (skip telemetry-own URLs). Cap at 30s — a
        // longer "duration" means the app was suspended mid-fetch and we'd
        // be poisoning p95 with multi-minute values that don't reflect a
        // real user-perceived slow request.
        if (elapsed > 2000 && elapsed < 30_000 && !url.includes("/api/v1/ingest") && !url.includes("/api/error-reports")) {
          try {
            const { addMetric } = require("./metrics");
            addMetric("fetch_slow_ms", { valueNum: elapsed, valueText: `${method} ${shortUrl(url)}` });
          } catch {}
        }

        if (!res.ok && res.status >= 400) {
          if (!url.includes("/api/error-reports") && !url.includes("/api/v1/ingest") && !isNoisyFetchUrl(url)) {
            addLog(
              res.status >= 500 ? "error" : "warn",
              `HTTP ${res.status} ${res.statusText} — ${shortUrl(url)}`,
              undefined,
              "fetch"
            );
          }
        }
        return res;
      } catch (err: any) {
        const elapsed = Date.now() - startedAt;
        addBreadcrumb("fetch", `${method} ${shortUrl(url)} → NETWORK ERROR (${elapsed}ms)`);
        const errMsg = err?.message || "Unknown";
        const shouldSkip = url.includes("/api/error-reports")
          || url.includes("/api/v1/ingest")
          || isNoisyFetchUrl(url)
          || isNoisyError(errMsg);
        if (!shouldSkip) {
          addLog("error", `Network error: ${errMsg} — ${shortUrl(url)}`, err?.stack, "fetch");
        }
        throw err;
      }
    };
  }

  addLogLocal("info", "Telemetry initialized", undefined, "system");
}

function shortUrl(url: string): string {
  return url.length > 120 ? url.substring(0, 120) + "..." : url;
}
