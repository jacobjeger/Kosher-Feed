// Telemetry core — shared queue, batched fetch, AsyncStorage persistence.
//
// Two independent channels:
//   • events  — errors/warns/info → /api/v1/ingest/events (and legacy /api/error-reports/batch via shim)
//   • metrics — perf samples       → /api/v1/ingest/metrics
//
// Both use the same persistence pattern from the old error-logger:
// queue in memory, flush on size threshold OR timer, persist unsent on failure,
// drain pending on init. Uses the un-wrapped fetch (__origFetch) so emitting
// telemetry doesn't recurse through the fetch error wrapper.

import AsyncStorage from "@/lib/kv";
import { Platform } from "react-native";
import { getApiUrl } from "@/lib/query-client";

const EVENTS_PENDING_KEY = "TELEMETRY_PENDING_EVENTS";
const METRICS_PENDING_KEY = "TELEMETRY_PENDING_METRICS";
const EVENTS_FLUSH_INTERVAL = 30_000;
const EVENTS_FLUSH_SIZE = 5;
const METRICS_FLUSH_INTERVAL = 60_000;
const METRICS_FLUSH_SIZE = 20;
const MAX_PERSIST = 50;
const MAX_BATCH = 50;

export interface EventPayload {
  message: string;
  stack?: string | null;
  source?: string | null;
  severity?: "fatal" | "nonfatal" | "warn";
  breadcrumbs?: any[];
  metadata?: Record<string, any> | null;
}

export interface MetricPayload {
  kind: string;
  valueNum?: number | null;
  valueText?: string | null;
  episodeId?: string | null;
  feedId?: string | null;
  networkType?: string | null;
  cdnHost?: string | null;
  metadata?: Record<string, any> | null;
}

let _appVersion: string | null = null;
let _deviceMeta: Record<string, any> | null = null;
let _deviceId: string | null = null;
let _otaInfo: Record<string, any> | null = null;

export function getOtaInfo(): Record<string, any> {
  if (_otaInfo) return _otaInfo;
  // expo-updates is a no-op on web / dev — guard so this never throws.
  _otaInfo = { updateId: null, channel: null, runtimeVersion: null, isEmbeddedLaunch: null, createdAt: null };
  try {
    const Updates = require("expo-updates");
    _otaInfo = {
      updateId: Updates.updateId || null,
      channel: Updates.channel || null,
      runtimeVersion: Updates.runtimeVersion || null,
      isEmbeddedLaunch: typeof Updates.isEmbeddedLaunch === "boolean" ? Updates.isEmbeddedLaunch : null,
      createdAt: Updates.createdAt ? new Date(Updates.createdAt).toISOString() : null,
    };
  } catch {}
  return _otaInfo;
}

export function getAppVersion(): string | null {
  if (_appVersion !== null) return _appVersion;
  try {
    const Constants = require("expo-constants").default;
    _appVersion = Constants.expoConfig?.version || Constants.manifest?.version || null;
    _deviceMeta = {
      osVersion: Platform.Version,
      sdkVersion: Constants.expoConfig?.sdkVersion || null,
      deviceModel: null,
      deviceBrand: null,
      screenWidth: null,
      screenHeight: null,
    };
    // Best-effort device info enrichment (async).
    try {
      const { getDeviceInfo } = require("@/lib/device-profile");
      getDeviceInfo().then((info: any) => {
        _deviceMeta = {
          ..._deviceMeta,
          deviceModel: info.deviceModel || null,
          deviceBrand: info.deviceBrand || null,
          screenWidth: info.screenWidth || null,
          screenHeight: info.screenHeight || null,
          locale: info.locale || null,
          timezone: info.timezone || null,
        };
      }).catch(() => {});
    } catch {}
  } catch {
    _appVersion = null;
  }
  return _appVersion;
}

export function getDeviceMeta(): Record<string, any> | null {
  if (!_deviceMeta) getAppVersion();
  return _deviceMeta;
}

async function getDeviceId(): Promise<string | null> {
  if (_deviceId) return _deviceId;
  try {
    const raw = await AsyncStorage.getItem("@kosher_podcast_device_id");
    _deviceId = raw;
    return raw;
  } catch {
    return null;
  }
}

function origFetch(): typeof fetch {
  return ((globalThis as any).__origFetch || globalThis.fetch) as typeof fetch;
}

// ─── events queue ──────────────────────────────────────────────────────────

const eventQueue: EventPayload[] = [];
let eventTimer: ReturnType<typeof setTimeout> | null = null;
let eventSending = false;

export function enqueueEvent(ev: EventPayload) {
  eventQueue.push(ev);
  if (eventQueue.length >= EVENTS_FLUSH_SIZE) {
    void flushEvents();
  } else if (!eventTimer) {
    eventTimer = setTimeout(() => { eventTimer = null; void flushEvents(); }, EVENTS_FLUSH_INTERVAL);
  }
}

async function flushEvents() {
  if (eventSending || eventQueue.length === 0) return;
  eventSending = true;
  const batch = eventQueue.splice(0, MAX_BATCH);
  try {
    const deviceId = await getDeviceId();
    const appVersion = getAppVersion();
    const meta = getDeviceMeta() || {};
    const ota = getOtaInfo();
    const payload = {
      events: batch.map(e => ({
        ...e,
        deviceId,
        appVersion,
        platform: Platform.OS,
        metadata: { ...(e.metadata || {}), ...meta, ota },
      })),
    };
    const baseUrl = getApiUrl();
    const url = new URL("/api/v1/ingest/events", baseUrl).toString();
    const res = await origFetch()(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) await persistPending(EVENTS_PENDING_KEY, batch);
  } catch {
    await persistPending(EVENTS_PENDING_KEY, batch);
  } finally {
    eventSending = false;
    if (eventQueue.length > 0) void flushEvents();
  }
}

// ─── metrics queue ─────────────────────────────────────────────────────────

const metricQueue: MetricPayload[] = [];
let metricTimer: ReturnType<typeof setTimeout> | null = null;
let metricSending = false;

export function enqueueMetric(m: MetricPayload) {
  metricQueue.push(m);
  if (metricQueue.length >= METRICS_FLUSH_SIZE) {
    void flushMetrics();
  } else if (!metricTimer) {
    metricTimer = setTimeout(() => { metricTimer = null; void flushMetrics(); }, METRICS_FLUSH_INTERVAL);
  }
}

async function flushMetrics() {
  if (metricSending || metricQueue.length === 0) return;
  metricSending = true;
  const batch = metricQueue.splice(0, MAX_BATCH);
  try {
    const deviceId = await getDeviceId();
    const appVersion = getAppVersion();
    const ota = getOtaInfo();
    const payload = {
      metrics: batch.map(m => ({
        ...m,
        deviceId,
        appVersion,
        platform: Platform.OS,
        // Stamp OTA info onto every metric's metadata so the admin can answer
        // "which OTA bundle is this device on" without a separate join.
        metadata: { ...(m.metadata || {}), ota },
      })),
    };
    const baseUrl = getApiUrl();
    const url = new URL("/api/v1/ingest/metrics", baseUrl).toString();
    const res = await origFetch()(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) await persistPending(METRICS_PENDING_KEY, batch);
  } catch {
    await persistPending(METRICS_PENDING_KEY, batch);
  } finally {
    metricSending = false;
    if (metricQueue.length > 0) void flushMetrics();
  }
}

// ─── persistence + drain on init ───────────────────────────────────────────

async function persistPending(key: string, items: any[]) {
  try {
    const raw = await AsyncStorage.getItem(key);
    let existing: any[] = [];
    if (raw) { try { existing = JSON.parse(raw); } catch {} }
    const combined = [...existing, ...items].slice(-MAX_PERSIST);
    await AsyncStorage.setItem(key, JSON.stringify(combined));
  } catch {}
}

async function drainPending(key: string, enqueue: (item: any) => void) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;
    const items: any[] = JSON.parse(raw);
    if (!items.length) return;
    await AsyncStorage.removeItem(key);
    for (const it of items) enqueue(it);
  } catch {}
}

let drained = false;
export function drainPersistedOnInit() {
  if (drained) return;
  drained = true;
  // Stagger so the first request after launch doesn't fight cold-start network setup.
  setTimeout(() => { void drainPending(EVENTS_PENDING_KEY, enqueueEvent); }, 10_000);
  setTimeout(() => { void drainPending(METRICS_PENDING_KEY, enqueueMetric); }, 15_000);
}

// Test/debug helpers (used by admin debug screens, never in normal flow).
export async function _flushNow() {
  await flushEvents();
  await flushMetrics();
}
