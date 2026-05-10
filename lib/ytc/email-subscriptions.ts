// YTC: shiur-update email subscription preferences.
//
// Lets a user opt in to per-rebbe and per-tag email alerts when a new
// shiur matching their picks is uploaded. The website's
// /api/notify-new-shiur reads from `subscriptions/{uid}` and emails
// every user whose `rebbeim` or `tags` overlap with the new shiur.
//
// Schema verified against the website source
// (github.com/abbrach1/YTC-ALUMNI-MAIN-WEBSITE → app/subscriptions/page.tsx
// and app/api/notify-new-shiur/route.ts):
//
//   subscriptions/{user.uid}:
//     {
//       userId:    string,    // duplicate of user.uid
//       email:     string,    // raw user.email at write time
//       rebbeim:   string[],  // raw speaker names from Shiur.rebbe
//       tags:      string[],  // tag strings from Shiur.tags
//       updatedAt: string,    // ISO 8601 timestamp
//     }
//
// IMPORTANT — naming differences from this app's other prefs:
//   - The collection is TOP-LEVEL (`subscriptions/`), NOT nested under
//     `users/{uid}/preferences/...`. The server-side route reads the
//     entire collection in one getDocs() call.
//   - The picks field is `tags`, not `topics`. The website uses `tags`
//     because that's the field name on the Shiur doc itself, and the
//     match logic compares set-equal.
//   - There is NO `enabled` master switch on the doc. Empty arrays mean
//     "no emails". The settings UI mirrors that — no master toggle, just
//     the picks themselves.
//
// Available rebbeim/tags options come from `settings/shiurOptions`
// (admin-curated list), NOT from scanning the shiurim collection. We
// expose `getShiurOptions()` for the screen to use.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { addLog } from "@/lib/error-logger";
import { getYtcFirebase } from "@/lib/ytc/firebase";

const LOCAL_KEY = "@ytc_email_subs:v2";

export interface ShiurEmailSubs {
  /** uid; "" if no user (cache-only state). */
  userId: string;
  /** Raw user email at write time. */
  email: string;
  /** Picked rebbeim — raw Shiur.rebbe values. */
  rebbeim: string[];
  /** Picked tags — raw Shiur.tags values. */
  tags: string[];
  /** ISO 8601 timestamp of last write. */
  updatedAt: string;
}

const DEFAULT_SUBS: ShiurEmailSubs = {
  userId: "",
  email: "",
  rebbeim: [],
  tags: [],
  updatedAt: "",
};

export interface ShiurOptions {
  rebbeim: string[];
  tags: string[];
  // Older settings/shiurOptions docs may not have this field — readers
  // default to []. Used by the upload screen's series picker.
  series: string[];
}

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

/** Fetch the current prefs from cache → AsyncStorage → defaults. */
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

/** Pull the user's picks from Firestore into the local cache. Called
 *  on screen mount and on YTC unlock so a website-side change shows
 *  up here. No-ops if the user isn't signed in. */
export async function hydrateSubs(): Promise<void> {
  try {
    const { auth, db } = await getYtcFirebase();
    const user = auth.currentUser;
    if (!user) return;
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, "subscriptions", user.uid));
    if (!snap.exists()) {
      // No website-side subscription doc yet — keep whatever the local
      // cache has but stamp the userId/email so the next write writes
      // the correct identity.
      const next: ShiurEmailSubs = {
        ...(await getSubs()),
        userId: user.uid,
        email: user.email ?? "",
      };
      _cached = next;
      await persistLocal(next);
      emit();
      return;
    }
    const data = snap.data() as Partial<ShiurEmailSubs>;
    _cached = {
      userId: typeof data.userId === "string" ? data.userId : user.uid,
      email: typeof data.email === "string" ? data.email : (user.email ?? ""),
      rebbeim: Array.isArray(data.rebbeim) ? data.rebbeim : [],
      tags: Array.isArray(data.tags) ? data.tags : [],
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    };
    await persistLocal(_cached);
    emit();
  } catch (e: any) {
    addLog("warn", `YTC email-subs hydrate failed: ${e?.message || e}`, undefined, "ytc-email-subs");
  }
}

/** Write the prefs through to Firestore. Mirrors the website's
 *  app/subscriptions/page.tsx setDoc shape exactly so a save from the
 *  app produces a doc indistinguishable from a save on the site. */
export async function setSubs(patch: Partial<Pick<ShiurEmailSubs, "rebbeim" | "tags">>): Promise<ShiurEmailSubs> {
  const prev = await getSubs();
  const { auth } = await getYtcFirebase();
  const user = auth.currentUser;
  const userId = user?.uid ?? prev.userId;
  const email = user?.email ?? prev.email;
  const next: ShiurEmailSubs = {
    userId,
    email,
    rebbeim: patch.rebbeim !== undefined ? patch.rebbeim : prev.rebbeim,
    tags: patch.tags !== undefined ? patch.tags : prev.tags,
    updatedAt: new Date().toISOString(),
  };
  _cached = next;
  await persistLocal(next);
  emit();
  // Fire-and-forget Firestore write.
  (async () => {
    try {
      if (!user) return;
      const { db } = await getYtcFirebase();
      const { doc, setDoc } = await import("firebase/firestore");
      await setDoc(doc(db, "subscriptions", user.uid), {
        userId: user.uid,
        email: user.email ?? next.email,
        rebbeim: next.rebbeim,
        tags: next.tags,
        updatedAt: next.updatedAt,
      });
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

/** Toggle one tag in the picks. Returns the new prefs. */
export async function toggleTag(tag: string): Promise<ShiurEmailSubs> {
  const prev = await getSubs();
  const has = prev.tags.includes(tag);
  const tags = has ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag];
  return setSubs({ tags });
}

/** Fetch the admin-curated list of rebbeim + tags shown in the picker.
 *  Source: `settings/shiurOptions` — same doc the website uses. We
 *  intentionally do NOT derive from the shiurim collection because:
 *  (1) the website doesn't, so we'd drift, and (2) it's a single 1KB
 *  doc read vs scanning ~800 shiur docs. */
export async function getShiurOptions(): Promise<ShiurOptions> {
  try {
    const { db } = await getYtcFirebase();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, "settings", "shiurOptions"));
    if (!snap.exists()) return { rebbeim: [], tags: [], series: [] };
    const data = snap.data() as Partial<ShiurOptions>;
    return {
      rebbeim: Array.isArray(data.rebbeim) ? data.rebbeim : [],
      tags: Array.isArray(data.tags) ? data.tags : [],
      series: Array.isArray(data.series) ? data.series : [],
    };
  } catch (e: any) {
    addLog("warn", `YTC shiurOptions fetch failed: ${e?.message || e}`, undefined, "ytc-email-subs");
    return { rebbeim: [], tags: [], series: [] };
  }
}
