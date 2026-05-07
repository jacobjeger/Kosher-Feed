// YTC: multi-device playback position sync. Mirrors the website's
// users/{uid}/preferences/playbackPositions doc:
//   { positions: { [shiurId: string]: seconds },
//     lastUpdated: number, syncedAt: number }
//
// Why a separate sync (vs reusing AudioPlayerContext.syncPositionToServer):
// shiurpod's syncPositionToServer posts to /api/playback-positions and
// is intentionally gated against ytc:* ids (they have no row in
// shiurpod's DB). YTC's positions live in YTC's Firestore project
// instead.
//
// Subscribe-side: we listen to onPositionsChanged from AudioPlayerContext,
// pluck out YTC entries, and debounce-write to Firestore. The local
// AsyncStorage cache is updated by AudioPlayerContext as the user plays
// — we just mirror it to the cloud.
//
// Hydrate-side: on YTC home mount (and on cold start when a user is
// already signed in), read the Firestore doc and merge entries newer
// than what we have locally. The merge favors the more recent timestamp
// per shiur so a user who paused on phone-A and then continued on
// phone-B doesn't lose progress on either device.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { addLog } from "@/lib/error-logger";
import { onPositionsChanged, loadPositions } from "@/contexts/AudioPlayerContext";
import { getYtcFirebase } from "@/lib/ytc/firebase";

const POSITIONS_KEY = "@kosher_podcast_positions";
const DEBOUNCE_MS = 5_000;

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _started = false;
let _stopFn: (() => void) | null = null;

/** Pluck ytc:* entries from the AsyncStorage positions map and convert
 *  them to the website's { [bareShiurId]: seconds } shape. */
async function buildYtcPositionsForFirestore(): Promise<Record<string, number>> {
  const all = await loadPositions();
  const out: Record<string, number> = {};
  for (const [id, p] of Object.entries(all)) {
    if (!id.startsWith("ytc:")) continue;
    const bare = id.slice(4);
    out[bare] = Math.floor(p.positionMs / 1000);
  }
  return out;
}

async function syncToFirebaseNow(): Promise<void> {
  try {
    const { auth, db } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return;
    const positions = await buildYtcPositionsForFirestore();
    const { doc, setDoc } = await import("firebase/firestore");
    const now = Date.now();
    await setDoc(
      doc(db, "users", user.uid, "preferences", "playbackPositions"),
      { positions, lastUpdated: now, syncedAt: now },
      { merge: true },
    );
  } catch (e: any) {
    addLog("warn", `YTC position sync failed: ${e?.message || e}`, undefined, "ytc-position-sync");
  }
}

/** Idempotent. Subscribes to position changes and starts the debounced
 *  Firestore write loop. Safe to call from useEffect on every mount. */
export function startYtcPositionSync(): void {
  if (_started) return;
  _started = true;
  const off = onPositionsChanged(() => {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      syncToFirebaseNow();
    }, DEBOUNCE_MS);
  });
  _stopFn = () => {
    off();
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  };
}

export function stopYtcPositionSync(): void {
  if (_stopFn) _stopFn();
  _stopFn = null;
  _started = false;
}

/** Pull positions from Firestore into AsyncStorage. Called on YTC home
 *  mount. Merges by recency so multi-device users keep both devices'
 *  progress; the in-app player picks up the latest on next play. */
export async function hydrateYtcPositions(): Promise<void> {
  try {
    const { auth, db } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return;
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, "users", user.uid, "preferences", "playbackPositions"));
    if (!snap.exists()) return;
    const data = snap.data() as { positions?: Record<string, number>; lastUpdated?: number };
    const remote = data.positions ?? {};
    if (!Object.keys(remote).length) return;

    const localRaw = await AsyncStorage.getItem(POSITIONS_KEY);
    const local: Record<string, { episodeId: string; feedId: string; positionMs: number; durationMs: number; updatedAt: string }> =
      localRaw ? JSON.parse(localRaw) : {};

    const remoteAt = data.lastUpdated ?? Date.now();
    let changed = false;
    for (const [bareId, seconds] of Object.entries(remote)) {
      const epId = `ytc:${bareId}`;
      const existing = local[epId];
      const existingMs = existing?.positionMs ?? 0;
      const remoteMs = (seconds || 0) * 1000;
      if (!existing) {
        // No local — write remote unconditionally (durationMs unknown,
        // leave 0; the next playback updates with the real duration).
        local[epId] = {
          episodeId: epId, feedId: "ytc", positionMs: remoteMs, durationMs: 0,
          updatedAt: new Date(remoteAt).toISOString(),
        };
        changed = true;
        continue;
      }
      // Have a local — keep whichever timestamp is newer.
      const localAt = new Date(existing.updatedAt).getTime() || 0;
      if (remoteAt > localAt && Math.abs(remoteMs - existingMs) > 1000) {
        local[epId] = { ...existing, positionMs: remoteMs, updatedAt: new Date(remoteAt).toISOString() };
        changed = true;
      }
    }

    if (changed) {
      await AsyncStorage.setItem(POSITIONS_KEY, JSON.stringify(local));
    }
  } catch (e: any) {
    addLog("warn", `YTC position hydrate failed: ${e?.message || e}`, undefined, "ytc-position-sync");
  }
}
