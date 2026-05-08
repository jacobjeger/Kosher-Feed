// YTC: shiur-update email subscription preferences.
//
// Lets a user opt in to per-rebbe and per-topic email alerts when a
// new shiur matching their picks is uploaded. The server-side trigger
// (Firebase function on shiurim collection writes) reads this doc to
// decide which users to email.
//
// Firestore doc shape (mirrors the saved-shiurim / playback-positions
// pattern this project uses for user prefs):
//
//   users/{uid}/preferences/shiurEmailSubscriptions:
//     {
//       enabled:     boolean,    // master toggle
//       rebbeim:     string[],   // raw speaker names from Shiur.rebbe
//       topics:      string[],   // tag strings from Shiur.tags
//       email:       string,     // duplicate of the user's email at
//                                // write time so the server function
//                                // can dispatch without a second
//                                // auth lookup
//       lastUpdated: number,     // ms epoch
//       syncedAt:    number,     // ms epoch
//     }
//
// IMPORTANT: this path is speculative — it follows the conventions
// the rest of this codebase uses for per-user prefs, but the YTC
// website backend was updated server-side with this feature and we
// don't have its source on this machine. If the website writes a
// different doc/collection, change the constants below to match
// (the rest of this module + the screen don't care about the path).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { addLog } from "@/lib/error-logger";
import { getYtcFirebase } from "@/lib/ytc/firebase";

const LOCAL_KEY = "@ytc_email_subs:v1";
const COLLECTION = "users";
const SUBCOLLECTION = "preferences";
const DOC_ID = "shiurEmailSubscriptions";

export interface ShiurEmailSubs {
  enabled: boolean;
  rebbeim: string[];
  topics: string[];
  email: string;
  lastUpdated: number;
}

const DEFAULT_SUBS: ShiurEmailSubs = {
  enabled: false,
  rebbeim: [],
  topics: [],
  email: "",
  lastUpdated: 0,
};

let _cached: ShiurEmailSubs | null = null;

type Listener = (s: ShiurEmailSubs) => void;
const listeners = new Set<Listener>();
function emit() {
  const s = _cached ?? DEFAULT_SUBS;
  listeners.forEach((fn) => { try { fn(s); } catch {} });
}
export function onSubsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

async function persistLocal(s: ShiurEmailSubs): Promise<void> {
  try { await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(s)); } catch {}
}

/** Fetch the current prefs. Returns the cached value if loaded; else
 *  reads from AsyncStorage; else returns the default (everything off). */
export async function getSubs(): Promise<ShiurEmailSubs> {
  if (_cached) return _cached;
  let next: ShiurEmailSubs;
  try {
    const raw = await AsyncStorage.getItem(LOCAL_KEY);
    next = raw ? { ...DEFAULT_SUBS, ...JSON.parse(raw) } : { ...DEFAULT_SUBS };
  } catch {
    next = { ...DEFAULT_SUBS };
  }
  _cached = next;
  return next;
}

/** Pull the user's prefs from Firestore into the local cache. Called
 *  on the email-subscriptions screen mount and on YTC unlock so a
 *  user's website-side picks land in the app. */
export async function hydrateSubs(): Promise<void> {
  try {
    const { auth, db } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return;
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, COLLECTION, user.uid, SUBCOLLECTION, DOC_ID));
    if (!snap.exists()) return;
    const data = snap.data() as Partial<ShiurEmailSubs>;
    _cached = {
      enabled: data.enabled ?? false,
      rebbeim: Array.isArray(data.rebbeim) ? data.rebbeim : [],
      topics: Array.isArray(data.topics) ? data.topics : [],
      email: typeof data.email === "string" ? data.email : (user.email ?? ""),
      lastUpdated: typeof data.lastUpdated === "number" ? data.lastUpdated : 0,
    };
    await persistLocal(_cached);
    emit();
  } catch (e: any) {
    addLog("warn", `YTC email-subs hydrate failed: ${e?.message || e}`, undefined, "ytc-email-subs");
  }
}

/** Write the prefs through to Firestore. AsyncStorage is updated
 *  optimistically so the UI is instant; sync is fire-and-forget and
 *  failures are logged but not surfaced. */
export async function setSubs(patch: Partial<ShiurEmailSubs>): Promise<ShiurEmailSubs> {
  const prev = await getSubs();
  const next: ShiurEmailSubs = {
    ...prev,
    ...patch,
    lastUpdated: Date.now(),
  };
  _cached = next;
  await persistLocal(next);
  emit();
  // Fire-and-forget Firestore write.
  (async () => {
    try {
      const { auth, db } = await getYtcFirebase();
      const user = auth.currentUser;
      if (!user) return;
      const { doc, setDoc } = await import("firebase/firestore");
      await setDoc(
        doc(db, COLLECTION, user.uid, SUBCOLLECTION, DOC_ID),
        {
          enabled: next.enabled,
          rebbeim: next.rebbeim,
          topics: next.topics,
          // Always stamp the auth email so the server function has the
          // current address even if the user changed it on the website.
          email: user.email ?? next.email,
          lastUpdated: next.lastUpdated,
          syncedAt: Date.now(),
        },
        { merge: true },
      );
    } catch (e: any) {
      addLog("warn", `YTC email-subs sync failed: ${e?.message || e}`, undefined, "ytc-email-subs");
    }
  })();
  return next;
}

/** Toggle one rebbe in the picks. Returns the new prefs. */
export async function toggleRebbe(name: string): Promise<ShiurEmailSubs> {
  const prev = await getSubs();
  const has = prev.rebbeim.includes(name);
  const rebbeim = has ? prev.rebbeim.filter((r) => r !== name) : [...prev.rebbeim, name];
  return setSubs({ rebbeim });
}

/** Toggle one topic in the picks. Returns the new prefs. */
export async function toggleTopic(tag: string): Promise<ShiurEmailSubs> {
  const prev = await getSubs();
  const has = prev.topics.includes(tag);
  const topics = has ? prev.topics.filter((t) => t !== tag) : [...prev.topics, tag];
  return setSubs({ topics });
}
