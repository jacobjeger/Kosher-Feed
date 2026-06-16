// Ring buffer of recent app events. Attached to error reports so we can see
// "what was happening just before the crash" — the difference between a
// useful and a useless stack trace.
//
// Deliberately small (30 entries) so it serializes cheaply in batches and
// doesn't bloat JSON over slow networks.

export interface Breadcrumb {
  ts: number;
  category: "nav" | "playback" | "fetch" | "ui" | "system";
  message: string;
  data?: Record<string, any>;
}

const BUFFER_SIZE = 30;
const buf: Breadcrumb[] = [];

export function addBreadcrumb(category: Breadcrumb["category"], message: string, data?: Record<string, any>) {
  buf.push({ ts: Date.now(), category, message: message.substring(0, 200), data });
  if (buf.length > BUFFER_SIZE) buf.splice(0, buf.length - BUFFER_SIZE);
}

export function getBreadcrumbs(): Breadcrumb[] {
  return buf.slice();
}

export function clearBreadcrumbs() {
  buf.length = 0;
}
