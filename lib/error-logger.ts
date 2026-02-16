import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getApiUrl } from "@/lib/query-client";

const LOG_KEY = "APP_ERROR_LOGS";
const PENDING_REPORTS_KEY = "APP_PENDING_ERROR_REPORTS";
const MAX_LOGS = 200;
const REPORT_BATCH_INTERVAL = 30000;
const REPORT_LEVELS: Set<string> = new Set(["error"]);

export interface LogEntry {
  id: string;
  level: "error" | "warn" | "info";
  message: string;
  stack?: string;
  timestamp: number;
  source?: string;
}

let logs: LogEntry[] = [];
let listeners: Set<() => void> = new Set();
let initialized = false;
let pendingReports: LogEntry[] = [];
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let isSendingReports = false;
let deviceIdCache: string | null = null;

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

export function subscribeLogs(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getLogsSnapshot(): LogEntry[] {
  return logs;
}

export function addLog(
  level: LogEntry["level"],
  message: string,
  stack?: string,
  source?: string
) {
  const entry: LogEntry = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
    level,
    message: message.substring(0, 2000),
    stack: stack?.substring(0, 3000),
    timestamp: Date.now(),
    source,
  };
  logs = [entry, ...logs].slice(0, MAX_LOGS);
  notifyListeners();
  persistLogs();

  if (REPORT_LEVELS.has(level) && source !== "fetch") {
    queueForServerReport(entry);
  }
}

function queueForServerReport(entry: LogEntry) {
  pendingReports.push(entry);
  if (pendingReports.length >= 10) {
    flushReportsToServer();
  } else if (!reportTimer) {
    reportTimer = setTimeout(() => {
      reportTimer = null;
      flushReportsToServer();
    }, REPORT_BATCH_INTERVAL);
  }
}

async function getDeviceIdForReport(): Promise<string | null> {
  if (deviceIdCache) return deviceIdCache;
  try {
    const raw = await AsyncStorage.getItem("@shiurpod_device_id");
    deviceIdCache = raw;
    return raw;
  } catch {
    return null;
  }
}

async function flushReportsToServer() {
  if (isSendingReports || pendingReports.length === 0) return;
  isSendingReports = true;

  const batch = pendingReports.splice(0, 20);

  try {
    const deviceId = await getDeviceIdForReport();
    const baseUrl = getApiUrl();
    const url = new URL("/api/error-reports/batch", baseUrl).toString();

    const reports = batch.map(entry => ({
      deviceId,
      level: entry.level,
      message: entry.message,
      stack: entry.stack || null,
      source: entry.source || null,
      platform: Platform.OS,
      appVersion: null,
    }));

    const origFetch = (globalThis as any).__origFetch || globalThis.fetch;
    const res = await origFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reports }),
    });

    if (!res.ok) {
      await savePendingReports(batch);
    }
  } catch {
    await savePendingReports(batch);
  } finally {
    isSendingReports = false;
    if (pendingReports.length > 0) {
      flushReportsToServer();
    }
  }
}

async function savePendingReports(entries: LogEntry[]) {
  try {
    const raw = await AsyncStorage.getItem(PENDING_REPORTS_KEY);
    let existing: LogEntry[] = [];
    if (raw) {
      try { existing = JSON.parse(raw); } catch {}
    }
    const combined = [...existing, ...entries].slice(-50);
    await AsyncStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify(combined));
  } catch {}
}

async function retryPendingReports() {
  try {
    const raw = await AsyncStorage.getItem(PENDING_REPORTS_KEY);
    if (!raw) return;
    const entries: LogEntry[] = JSON.parse(raw);
    if (entries.length === 0) return;
    await AsyncStorage.removeItem(PENDING_REPORTS_KEY);
    for (const entry of entries) {
      pendingReports.push(entry);
    }
    flushReportsToServer();
  } catch {}
}

async function persistLogs() {
  try {
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(0, 50)));
  } catch {}
}

async function loadLogs() {
  try {
    const data = await AsyncStorage.getItem(LOG_KEY);
    if (data) {
      logs = JSON.parse(data);
      notifyListeners();
    }
  } catch {}
}

export async function clearLogs() {
  logs = [];
  notifyListeners();
  try {
    await AsyncStorage.removeItem(LOG_KEY);
  } catch {}
}

export function initErrorLogger() {
  if (initialized) return;
  initialized = true;

  loadLogs();
  setTimeout(retryPendingReports, 10000);

  const origError = console.error;
  const origWarn = console.warn;

  console.error = (...args: any[]) => {
    origError.apply(console, args);
    const msg = args
      .map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === "object") {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" ");

    if (
      msg.includes("useNativeDriver") ||
      msg.includes("shadow*") ||
      msg.includes("pointerEvents is deprecated") ||
      msg.includes("expo-notifications")
    ) {
      return;
    }

    const stack =
      args.find((a) => a instanceof Error)?.stack || new Error().stack;
    addLog("error", msg, stack, "console.error");
  };

  console.warn = (...args: any[]) => {
    origWarn.apply(console, args);
    const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    if (
      msg.includes("useNativeDriver") ||
      msg.includes("shadow*") ||
      msg.includes("pointerEvents is deprecated") ||
      msg.includes("expo-notifications") ||
      msg.includes("should be updated for best compatibility")
    ) {
      return;
    }
    addLog("warn", msg, undefined, "console.warn");
  };

  if (typeof globalThis !== "undefined") {
    const origHandler = (globalThis as any).onunhandledrejection;
    (globalThis as any).onunhandledrejection = (event: any) => {
      const reason = event?.reason;
      const msg =
        reason instanceof Error ? reason.message : String(reason || "Unknown promise rejection");
      const stack = reason instanceof Error ? reason.stack : undefined;
      addLog("error", msg, stack, "unhandled-promise");
      if (origHandler) origHandler(event);
    };
  }

  if (typeof ErrorUtils !== "undefined") {
    const origHandler = (ErrorUtils as any).getGlobalHandler?.();
    (ErrorUtils as any).setGlobalHandler?.((error: Error, isFatal?: boolean) => {
      addLog(
        "error",
        `${isFatal ? "[FATAL] " : ""}${error.message}`,
        error.stack,
        "global-error"
      );
      if (origHandler) origHandler(error, isFatal);
    });
  }

  const origFetch = globalThis.fetch;
  (globalThis as any).__origFetch = origFetch;
  if (origFetch) {
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      try {
        const res = await origFetch(...args);
        if (!res.ok && res.status >= 400) {
          const url =
            typeof args[0] === "string"
              ? args[0]
              : args[0] instanceof Request
                ? args[0].url
                : String(args[0]);
          if (!url.includes("/api/error-reports")) {
            const shortUrl = url.length > 120 ? url.substring(0, 120) + "..." : url;
            addLog(
              res.status >= 500 ? "error" : "warn",
              `HTTP ${res.status} ${res.statusText} — ${shortUrl}`,
              undefined,
              "fetch"
            );
          }
        }
        return res;
      } catch (err: any) {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0] instanceof Request
              ? args[0].url
              : String(args[0]);
        if (!url.includes("/api/error-reports")) {
          const shortUrl = url.length > 120 ? url.substring(0, 120) + "..." : url;
          addLog("error", `Network error: ${err?.message || "Unknown"} — ${shortUrl}`, err?.stack, "fetch");
        }
        throw err;
      }
    };
  }

  addLog("info", "Error logger initialized", undefined, "system");
}
