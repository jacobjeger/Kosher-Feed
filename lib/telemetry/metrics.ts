// Perf metric capture — `addMetric(kind, payload)` plus helpers.
//
// Sampling is per-kind: high-volume kinds (screen mounts, nav transitions)
// are subsampled; rare/critical kinds (playback stalls, cold start) are
// always-emit. Bump SAMPLE_RATES if a particular kind needs more density
// during an active investigation.

import { useEffect, useRef } from "react";
import { Platform, InteractionManager } from "react-native";
import { enqueueMetric, getOtaInfo, type MetricPayload } from "./core";
import { addBreadcrumb } from "./breadcrumbs";

const SAMPLE_RATES: Record<string, number> = {
  // playback signals — keep them all, this is what we're hunting
  playback_start_ms: 1.0,
  playback_stall_ms: 1.0,
  playback_underrun: 1.0,
  playback_retry: 1.0,
  playback_error: 1.0,
  playback_seek_ms: 0.5,
  // app launch / nav
  cold_start_ms: 1.0,
  screen_mount_ms: 0.25,
  nav_transition_ms: 0.5,
  // network
  fetch_slow_ms: 1.0,
  // downloads
  download_throughput_kbps: 0.5,
  download_duration_ms: 0.5,
};

const DEFAULT_RATE = 0.3;

let _netType: string | null = null;
let _netCheckedAt = 0;

async function getNetworkType(): Promise<string | null> {
  // Cache for 10s so we're not hammering NetInfo on every metric.
  if (_netType && Date.now() - _netCheckedAt < 10_000) return _netType;
  try {
    const Network = require("expo-network");
    const state = await Network.getNetworkStateAsync();
    let type = "unknown";
    if (state) {
      if (state.type === Network.NetworkStateType.WIFI) type = "wifi";
      else if (state.type === Network.NetworkStateType.CELLULAR) type = "cellular";
      else if (state.type === Network.NetworkStateType.NONE) type = "none";
      else type = String(state.type || "unknown").toLowerCase();
    }
    _netType = type;
    _netCheckedAt = Date.now();
    return type;
  } catch {
    return null;
  }
}

export function getCdnHost(audioUrl: string | null | undefined): string | null {
  if (!audioUrl) return null;
  try {
    const u = new URL(audioUrl);
    return u.hostname;
  } catch {
    return null;
  }
}

export interface AddMetricInput {
  valueNum?: number | null;
  valueText?: string | null;
  episodeId?: string | null;
  feedId?: string | null;
  audioUrl?: string | null;       // convenience: auto-extracts cdnHost
  networkType?: string | null;
  cdnHost?: string | null;
  metadata?: Record<string, any> | null;
  forceSample?: boolean;
}

export function addMetric(kind: string, input: AddMetricInput = {}) {
  const rate = SAMPLE_RATES[kind] ?? DEFAULT_RATE;
  if (!input.forceSample && rate < 1 && Math.random() > rate) return;

  const payload: MetricPayload = {
    kind,
    valueNum: input.valueNum ?? null,
    valueText: input.valueText ?? null,
    episodeId: input.episodeId ?? null,
    feedId: input.feedId ?? null,
    cdnHost: input.cdnHost ?? getCdnHost(input.audioUrl ?? undefined) ?? null,
    networkType: input.networkType ?? null,
    metadata: input.metadata ?? null,
  };

  // Tag with network type lazily — don't block the metric, just attach when we can.
  if (!payload.networkType) {
    getNetworkType().then(t => {
      payload.networkType = t;
      enqueueMetric(payload);
    }).catch(() => {
      enqueueMetric(payload);
    });
  } else {
    enqueueMetric(payload);
  }

  // Mirror to breadcrumbs so error reports near the same time get context.
  if (kind.startsWith("playback_") || kind === "cold_start_ms") {
    addBreadcrumb("playback", `${kind}=${input.valueNum ?? input.valueText ?? ""}`);
  }
}

// One-shot per-launch heartbeat. valueText carries the OTA updateId so the
// admin can answer "how many devices are on the latest OTA?" with a single
// COUNT(DISTINCT device_id) GROUP BY value_text. Idempotent across the same
// process — guards against accidental re-emit.
let _otaEmitted = false;
export function emitOtaHeartbeat() {
  if (_otaEmitted) return;
  _otaEmitted = true;
  const ota = getOtaInfo();
  addMetric("ota_active", {
    valueText: ota.updateId || "embedded",
    metadata: {
      channel: ota.channel,
      runtimeVersion: ota.runtimeVersion,
      isEmbeddedLaunch: ota.isEmbeddedLaunch,
      createdAt: ota.createdAt,
    },
    forceSample: true,
  });
}

// Hook: emit screen_mount_ms = mount → "interactions complete" (the first
// frame post-recompose where the JS thread is idle). Drop in at the top of a
// screen component:  useScreenMountMetric("home");
export function useScreenMountMetric(screenName: string) {
  const mountedAtRef = useRef(Date.now());
  const reportedRef = useRef(false);
  useEffect(() => {
    const startedAt = mountedAtRef.current;
    const handle = InteractionManager.runAfterInteractions(() => {
      if (reportedRef.current) return;
      reportedRef.current = true;
      addMetric("screen_mount_ms", {
        valueNum: Date.now() - startedAt,
        valueText: screenName,
        metadata: { screen: screenName },
      });
      addBreadcrumb("nav", `mount ${screenName} (${Date.now() - startedAt}ms)`);
    });
    return () => { handle?.cancel?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// Convenience builder used by AudioPlayerContext.
export function playbackMetric(kind:
  | "playback_start_ms"
  | "playback_stall_ms"
  | "playback_underrun"
  | "playback_retry"
  | "playback_error"
  | "playback_seek_ms",
  episodeId: string | null,
  feedId: string | null,
  audioUrl: string | null,
  valueNum?: number,
  extra?: Record<string, any>,
) {
  addMetric(kind, {
    valueNum: typeof valueNum === "number" ? valueNum : null,
    episodeId,
    feedId,
    audioUrl,
    metadata: extra,
  });
}
