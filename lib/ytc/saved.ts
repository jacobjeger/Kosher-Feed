// YTC: bookmarked shiurim. Maintains a Set<shiurId> in AsyncStorage with
// a write-through sync to Firebase under
// users/{uid}/preferences/savedShiurim — the same shape the website's
// lib/firebase-saved-shiurim.ts uses, so a user can save on the website
// and have it appear in the mobile app (and vice versa).
//
// Firebase doc shape (matches website):
//   { savedShiurIds: string[], lastUpdated: number, syncedAt: number }
//
// The local AsyncStorage cache is the read-path source of truth so the
// UI is instant. Sync is fire-and-forget; failures are logged via
// addLog. On YTC unlock / cold start, we hydrate from Firebase so a
// user's web-saves land in the app.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { addLog } from "@/lib/error-logger";
import { getYtcFirebase } from "@/lib/ytc/firebase";

const LOCAL_KEY = "@ytc_saved_shiurim:v1";

let _cached: Set<string> | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();
function emit() { listeners.forEach((fn) => { try { fn(); } catch {} }); }
export function onSavedShiurimChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

async function ensureLoaded(): Promise<Set<string>> {
  if (_cached) return _cached;
  try {
    const raw = await AsyncStorage.getItem(LOCAL_KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    _cached = new Set(ids);
  } catch {
    _cached = new Set();
  }
  return _cached;
}

async function persistLocal(set: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(Array.from(set)));
  } catch {}
}

async function syncToFirebase(set: Set<string>): Promise<void> {
  try {
    const { auth, db } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return;
    const { doc, setDoc } = await import("firebase/firestore");
    const now = Date.now();
    await setDoc(
      doc(db, "users", user.uid, "preferences", "savedShiurim"),
      { savedShiurIds: Array.from(set), lastUpdated: now, syncedAt: now },
      { merge: true },
    );
  } catch (e: any) {
    addLog("warn", `YTC saved sync failed: ${e?.message || e}`, undefined, "ytc-saved");
  }
}

/** Load from Firebase into the local cache. Called once on home mount. */
export async function hydrateSavedShiurim(): Promise<void> {
  try {
    const { auth, db } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return;
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, "users", user.uid, "preferences", "savedShiurim"));
    if (!snap.exists()) return;
    const data = snap.data() as { savedShiurIds?: string[]; lastUpdated?: number };
    const remoteIds = new Set(data.savedShiurIds ?? []);
    // Merge local + remote so a multi-device user keeps everything.
    // Subsequent sync writes the merged set back.
    const local = await ensureLoaded();
    let changed = false;
    for (const id of remoteIds) {
      if (!local.has(id)) { local.add(id); changed = true; }
    }
    if (changed) {
      await persistLocal(local);
      emit();
      // Push merged state back so other devices see the union.
      syncToFirebase(local).catch(() => {});
    }
  } catch (e: any) {
    addLog("warn", `YTC saved hydrate failed: ${e?.message || e}`, undefined, "ytc-saved");
  }
}

export async function isSaved(shiurId: string): Promise<boolean> {
  const set = await ensureLoaded();
  return set.has(shiurId);
}

export async function getAllSavedIds(): Promise<string[]> {
  const set = await ensureLoaded();
  return Array.from(set);
}

export async function toggleSaved(shiurId: string): Promise<boolean> {
  const set = await ensureLoaded();
  const nowSaved = !set.has(shiurId);
  if (nowSaved) set.add(shiurId);
  else set.delete(shiurId);
  await persistLocal(set);
  emit();
  syncToFirebase(set).catch(() => {});
  return nowSaved;
}

export async function clearAllSaved(): Promise<void> {
  _cached = new Set();
  try { await AsyncStorage.removeItem(LOCAL_KEY); } catch {}
  emit();
  syncToFirebase(new Set()).catch(() => {});
}
