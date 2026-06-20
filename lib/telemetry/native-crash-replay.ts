// Reads the sidecar file written by the native uncaught-exception handler
// (plugins/withNativeCrashCapture.js) on the previous launch, POSTs it to
// /api/v1/ingest/native-crash, and removes the file.
//
// Safe to call before any other telemetry init — uses its own URL build and
// AsyncStorage read for the device id, doesn't depend on the queue.

import { Platform } from "react-native";
import AsyncStorage from "@/lib/kv";
import { getApiUrl } from "@/lib/query-client";

const FILENAME = "last_native_crash.json";

export async function replayNativeCrashIfAny(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const FileSystem = require("expo-file-system");
    const dir: string | null = FileSystem.documentDirectory || null;
    if (!dir) return;
    const uri = dir + FILENAME;
    const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }));
    if (!info?.exists) return;

    let raw = "";
    try { raw = await FileSystem.readAsStringAsync(uri); } catch { return; }
    if (!raw) {
      try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
      return;
    }

    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.substring(0, 500) }; }

    let deviceId: string | null = null;
    try { deviceId = await AsyncStorage.getItem("@kosher_podcast_device_id"); } catch {}

    let appVersion: string | null = null;
    try {
      const Constants = require("expo-constants").default;
      appVersion = Constants.expoConfig?.version || Constants.manifest?.version || null;
    } catch {}

    const body = {
      deviceId,
      platform: Platform.OS,
      appVersion,
      exceptionName: parsed.exceptionName || null,
      message: parsed.message || parsed.exceptionName || "Native crash",
      stack: parsed.stack || null,
      metadata: { thread: parsed.thread || null, ts: parsed.ts || null },
    };
    const url = new URL("/api/v1/ingest/native-crash", getApiUrl()).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
    }
    // Best effort — if it fails (offline, server down), the file stays and
    // we retry on next launch. That's the right behavior; native crashes
    // are too important to drop.
  } catch {}
}
