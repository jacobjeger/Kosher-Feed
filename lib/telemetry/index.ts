// Public surface of the telemetry module.
export { initErrorCapture, reportError, setErrorContext, getErrorContext, addLog, logEvent, subscribeLogs, getLogsSnapshot, clearLogs } from "./errors";
export type { LogEntry } from "./errors";
export { addMetric, playbackMetric, getCdnHost, useScreenMountMetric } from "./metrics";
export { addBreadcrumb, getBreadcrumbs } from "./breadcrumbs";
export { drainPersistedOnInit } from "./core";
