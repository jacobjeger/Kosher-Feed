// Back-compat shim. The original 411-line module has moved to lib/telemetry/*.
// Every existing import (`addLog`, `logEvent`, `setErrorContext`, etc.) still
// works — these are re-exports of the new pipeline that posts to
// /api/v1/ingest/events (and falls back to /api/error-reports/batch for older
// devices via the dual-write at the server). Prefer importing from
// `@/lib/telemetry` in new code.

export {
  addLog,
  logEvent,
  setErrorContext,
  getErrorContext,
  subscribeLogs,
  getLogsSnapshot,
  clearLogs,
  reportError,
} from "@/lib/telemetry/errors";

export type { LogEntry } from "@/lib/telemetry/errors";

import { initErrorCapture } from "@/lib/telemetry/errors";

// Legacy names — used by app/_layout.tsx today.
export function initErrorLogger() { initErrorCapture(); }
export function setupGlobalErrorHandlers() { /* now wired inside initErrorCapture */ }
