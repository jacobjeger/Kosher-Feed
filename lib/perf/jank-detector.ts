// JS-thread jank detector.
//
// Ticks every 200ms via setInterval. If the next tick lands more than
// JANK_THRESHOLD_MS late, the JS thread was blocked for that long —
// emit a `js_jank_ms` metric tagged with whatever marker code had set
// (so we know what was running) plus the breadcrumb trail.
//
// Markers: callers wrap suspect hot paths with `markJank('label')` /
// `clearJank()`. If a freeze happens while a marker is set, the metric
// shows the label. Idle freezes (no marker) get reported as 'unknown'
// — still useful because the breadcrumbs in the payload pin down the
// nearest navigation / fetch.
//
// Async helper `withJankMark` wraps a Promise so the marker auto-clears
// on settle (even on throw).
import { AppState } from "react-native";
import { addMetric } from "@/lib/telemetry/metrics";
import { addBreadcrumb, getBreadcrumbs } from "@/lib/telemetry/breadcrumbs";

const TICK_MS = 200;
const JANK_THRESHOLD_MS = 500;
// Backgrounded apps freeze the JS thread; the next tick after resume
// reports an artificial gap (we saw a 966-second value in prod that was
// just the device sleeping overnight). Skip reports beyond this cap and
// for the first second after resume — any real JS-thread block over a
// minute would have already crashed the app via the ANR watchdog.
const MAX_PLAUSIBLE_JANK_MS = 60_000;
const POST_RESUME_GRACE_MS = 1_000;

let lastTick = 0;
let currentMark: string | null = null;
let markStartedAt = 0;
let installed = false;
// Background marker: updated on every pathname change so any jank that
// fires without an explicit short-lived mark is at least attributed to
// the current route. Explicit markJank() takes priority while active.
let routeMark: string | null = null;

export function markJank(label: string): void {
  currentMark = label;
  markStartedAt = Date.now();
}

export function clearJank(): void {
  currentMark = null;
  markStartedAt = 0;
}

export function setJankRoute(route: string | null): void {
  routeMark = route;
}

export async function withJankMark<T>(label: string, fn: () => Promise<T>): Promise<T> {
  markJank(label);
  try {
    return await fn();
  } finally {
    clearJank();
  }
}

// Track app foreground/background so we can ignore wakeup gaps. Set
// during install — value is "active" by default until we hear otherwise.
let appStateActive = true;
let resumedAt = 0;

export function installJankDetector(): void {
  if (installed) return;
  installed = true;
  lastTick = Date.now();
  resumedAt = Date.now();
  // Whenever the app foregrounds, mark a grace window so the wake-up
  // tick doesn't get reported as a real freeze.
  try {
    AppState.addEventListener("change", (state) => {
      const wasActive = appStateActive;
      appStateActive = state === "active";
      if (!wasActive && appStateActive) {
        resumedAt = Date.now();
        lastTick = Date.now(); // reset so the next tick measures from now
      }
    });
  } catch {}
  setInterval(() => {
    const now = Date.now();
    const delta = now - lastTick;
    lastTick = now;
    const blockedFor = delta - TICK_MS;
    if (blockedFor < JANK_THRESHOLD_MS) return;
    // Skip if the app isn't foreground — backgrounded JS may not tick.
    if (!appStateActive) return;
    // Skip if we just resumed — the gap is wake-up, not real jank.
    if (now - resumedAt < POST_RESUME_GRACE_MS) return;
    // Cap at MAX_PLAUSIBLE_JANK_MS — anything bigger is almost certainly
    // a stale tick after deep sleep (we saw a 966-second value that was
    // an overnight idle, not a real freeze).
    if (blockedFor > MAX_PLAUSIBLE_JANK_MS) return;
    const mark = currentMark ?? (routeMark ? `route:${routeMark}` : "unknown");
    const markAge = currentMark ? now - markStartedAt : 0;
    // eslint-disable-next-line no-console
    console.warn(`[jank] +${blockedFor}ms while=${mark} (${markAge}ms in)`);
    addBreadcrumb("system", `jank ${blockedFor}ms while=${mark}`);
    addMetric("js_jank_ms", {
      valueNum: blockedFor,
      valueText: mark,
      metadata: {
        markAgeMs: markAge,
        breadcrumbs: getBreadcrumbs().slice(-10),
      },
      forceSample: true,
    });
  }, TICK_MS);
}
