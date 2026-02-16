import AsyncStorage from "@react-native-async-storage/async-storage";

const LOG_KEY = "APP_ERROR_LOGS";
const MAX_LOGS = 200;

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
          const shortUrl = url.length > 120 ? url.substring(0, 120) + "..." : url;
          addLog(
            res.status >= 500 ? "error" : "warn",
            `HTTP ${res.status} ${res.statusText} — ${shortUrl}`,
            undefined,
            "fetch"
          );
        }
        return res;
      } catch (err: any) {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0] instanceof Request
              ? args[0].url
              : String(args[0]);
        const shortUrl = url.length > 120 ? url.substring(0, 120) + "..." : url;
        addLog("error", `Network error: ${err?.message || "Unknown"} — ${shortUrl}`, err?.stack, "fetch");
        throw err;
      }
    };
  }

  addLog("info", "Error logger initialized", undefined, "system");
}
