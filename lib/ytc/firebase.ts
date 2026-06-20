// YTC: lazy Firebase service. ALL access goes through getYtcFirebase().
// Never import firebase/* directly outside this file. The lazy init keeps
// Firebase out of the cold-start bundle for users who never unlock — every
// import here is a dynamic `import()` so Metro / Hermes only resolves them
// when getYtcFirebase() is first called (which is gated on the user
// navigating into /ytc, not on app start).
//
// Firestore queries are ported verbatim from
// /tmp/ytc-source/expo-app/services/firebase.ts; only the entry point
// (lazy-init wrapper around initializeApp) and the export shape changed.
//
// Bundle audit (Phase 8): cold-start the app without unlocking, search the
// Metro bundle for `firebase/app` and the apiKey string. Both must appear
// in async chunks only — never in the root bundle. If either does, this
// module is being eagerly imported somewhere upstream.

// Type-only imports are erased at compile time; safe to leave at top-level.
import type { FirebaseApp } from "firebase/app";
import type { Auth, User } from "firebase/auth";
import type { Firestore, DocumentSnapshot } from "firebase/firestore";
import type { Shiur } from "@/types/ytc";

// Public client config — identical across all YTC variants. Safe to commit;
// the actual security boundary is Firestore rules + auth approval check.
const firebaseConfig = {
  apiKey: "AIzaSyB-j6Itt_DKVLOm5BGsuygVUD6YoPKQyS8",
  authDomain: "toras-chaim-shiurim.firebaseapp.com",
  projectId: "toras-chaim-shiurim",
  storageBucket: "toras-chaim-shiurim.firebasestorage.app",
  messagingSenderId: "95643621522",
  appId: "1:95643621522:ios:a75e5f1bdfaba692986e4b",
};

type Initialized = { app: FirebaseApp; auth: Auth; db: Firestore };
let _initialized: Initialized | null = null;
let _initPromise: Promise<Initialized> | null = null;

export async function getYtcFirebase(): Promise<Initialized> {
  if (_initialized) return _initialized;
  if (!_initPromise) {
    _initPromise = (async () => {
      // Heavy bundle eval on first call — Firebase SDK is several MB
      // and Hermes parses it synchronously. Mark each lazy import so
      // jank during cold-init attributes to the specific module.
      const { markJank, clearJank } = require("@/lib/perf/jank-detector");
      markJank("ytc:firebase-import:app");
      const { initializeApp, getApps } = await import("firebase/app");
      clearJank();
      markJank("ytc:firebase-import:auth");
      const authMod: any = await import("firebase/auth");
      clearJank();
      markJank("ytc:firebase-import:firestore");
      const { getFirestore } = await import("firebase/firestore");
      clearJank();
      markJank("ytc:firebase-init");
      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

      // Auth persistence on React Native:
      //
      // `getAuth()` defaults to MEMORY-only persistence on RN — every
      // app cold start wipes the session, forcing the user to sign in
      // again. That was the actual cause of the "made me re-log in"
      // report after the new APK install.
      //
      // The fix is `initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) })`,
      // which Firebase exposes specifically for React Native via the
      // package's `react-native` field (Metro resolves
      // `firebase/auth` → `@firebase/auth/dist/rn/index.js` which
      // exports `getReactNativePersistence`). Once persistence is
      // wired up, the auth-state listener (subscribeAuth) emits the
      // saved user immediately on next launch instead of null.
      //
      // Subsequent calls in the same JS context must use `getAuth(app)`
      // — `initializeAuth` throws if called twice. We try it first and
      // fall back to getAuth on the "already-initialized" error.
      let auth: Auth;
      try {
        const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
        if (typeof authMod.getReactNativePersistence === "function" && typeof authMod.initializeAuth === "function") {
          auth = authMod.initializeAuth(app, {
            persistence: authMod.getReactNativePersistence(AsyncStorage),
          });
        } else {
          // Older Firebase or non-RN platform — fall back to default.
          auth = authMod.getAuth(app);
        }
      } catch (e: any) {
        // initializeAuth throws "auth/already-initialized" when this
        // file evaluates twice in the same RN runtime. That's safe —
        // the previous initializeAuth() set up persistence; we just
        // need the existing instance.
        auth = authMod.getAuth(app);
      }

      _initialized = { app, auth, db: getFirestore(app) };
      clearJank();
      return _initialized;
    })();
  }
  return _initPromise;
}

/** Sign out only if Firebase was already initialized. Used by lib/ytc/unlock.lock(). */
export async function firebaseSignOutIfInitialized(): Promise<void> {
  if (!_initialized) return;
  const { signOut } = await import("firebase/auth");
  try { await signOut(_initialized.auth); } catch {}
}

export async function subscribeAuth(cb: (user: User | null) => void): Promise<() => void> {
  const { auth } = await getYtcFirebase();
  const { onAuthStateChanged } = await import("firebase/auth");
  return onAuthStateChanged(auth, cb);
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

export async function signInEmailPassword(email: string, password: string): Promise<User> {
  const { auth } = await getYtcFirebase();
  const { signInWithEmailAndPassword } = await import("firebase/auth");
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function createUserEmailPassword(email: string, password: string): Promise<User> {
  const { auth } = await getYtcFirebase();
  const { createUserWithEmailAndPassword } = await import("firebase/auth");
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  return credential.user;
}

/**
 * Multi-step approval check (verbatim from ytcalumni1/expo-app/services/
 * firebase.ts). Returns approved=true if the email is in alumniDatabase
 * (primary) OR approvedEmails (by doc id OR by 'email' field).
 * admin=true if the email is in the admins collection.
 *
 * Throws on Firestore network errors. The previous version swallowed them
 * and returned {approved:false, admin:false}, which caused the offline
 * cold-start bug where already-verified users were sent to /pending. Callers
 * that need offline tolerance (YtcAuthContext) catch the throw and fall back
 * to the cached result. Callers that are inherently online (handleYtcSignup,
 * which just succeeded at createUserWithEmailAndPassword) wrap with a
 * default.
 */
export async function checkUserApproval(email: string): Promise<{ approved: boolean; admin: boolean }> {
  const normalizedEmail = email.toLowerCase();
  const { db } = await getYtcFirebase();
  const { doc, getDoc, collection, query, where, getDocs } = await import("firebase/firestore");

  let approved = false;
  let admin = false;
  const alumniDoc = await getDoc(doc(db, "alumniDatabase", normalizedEmail));
  if (alumniDoc.exists()) approved = true;
  if (!approved) {
    const approvedDoc = await getDoc(doc(db, "approvedEmails", normalizedEmail));
    if (approvedDoc.exists()) approved = true;
  }
  if (!approved) {
    const q = query(collection(db, "approvedEmails"), where("email", "==", normalizedEmail));
    const snap = await getDocs(q);
    if (!snap.empty) approved = true;
  }
  const adminDoc = await getDoc(doc(db, "admins", normalizedEmail));
  if (adminDoc.exists()) admin = true;
  return { approved, admin };
}

/**
 * Real-time listener on shiurUploaders/{emailLower}. Doc presence is the
 * permission — fields are informational. Returns the unsubscribe.
 *
 * The caller (YtcAuthContext) ORs this with isAdmin to derive canUpload.
 * Snapshot errors keep the last-known value (the listener will retry on
 * its own when the network returns).
 */
export async function subscribeShiurUploader(
  emailLower: string,
  cb: (exists: boolean) => void,
): Promise<() => void> {
  const { db } = await getYtcFirebase();
  const { doc, onSnapshot } = await import("firebase/firestore");
  const ref = doc(db, "shiurUploaders", emailLower);
  return onSnapshot(
    ref,
    (snap) => cb(snap.exists()),
    (err) => {
      console.warn("YTC shiurUploader listener error:", err);
    },
  );
}

export async function submitAccessRequest(email: string, name: string): Promise<void> {
  const { db } = await getYtcFirebase();
  const { addDoc, collection, serverTimestamp } = await import("firebase/firestore");
  await addDoc(collection(db, "accessRequests"), {
    email, name,
    requestedAt: serverTimestamp(),
    status: "pending",
  });
}

/**
 * End-to-end YTC sign-up: mirrors the website's lib/auth-context.tsx
 * signup flow at github.com/abbrach1/YTC-ALUMNI-MAIN-WEBSITE so users
 * get the same emails + accessRequests doc shape regardless of
 * whether they signed up on web or in the app.
 *
 * Steps:
 *   1. Create the Firebase Auth user.
 *   2. Probe alumniDatabase / approvedEmails / admins to determine
 *      auto-approval state (checkUserApproval).
 *   3. setDoc accessRequests/{lowercaseEmail} with the canonical
 *      shape (firstName, lastName, fullName, graduationYear, status,
 *      autoApproved, approvalSource, approvedAt).
 *   4. POST /api/send-signup-notification — admin notification
 *      email regardless of approval state.
 *   5. If auto-approved, POST /api/send-welcome-email — the welcome
 *      email to the new user.
 *
 * Steps 4 + 5 are fire-and-forget: the user is signed up and seeing
 * the right screen even if Resend is down.
 */
const YTC_API_BASE = "https://alumni.ytchaim.com";

export async function handleYtcSignup(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  graduationYear?: string | null;
}): Promise<{ approved: boolean; admin: boolean }> {
  const trimmedEmail = input.email.trim();
  const lowerEmail = trimmedEmail.toLowerCase();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const fullName = `${firstName} ${lastName}`.trim();
  const graduationYear = input.graduationYear ?? null;

  // 1. Create the auth user (throws on duplicate / weak password etc.;
  //    caller maps codes to user-friendly messages via friendlyAuthError).
  await createUserEmailPassword(trimmedEmail, input.password);

  // 2. Determine approval state via the same checks the website runs.
  //    checkUserApproval now throws on network errors (so YtcAuthContext can
  //    fall back to its cache); but signup just succeeded at create-user, so
  //    the network is up — and even if Firestore probing fails, we'd rather
  //    proceed with manual-review defaults than block the signup flow.
  let approved = false;
  let admin = false;
  try {
    ({ approved, admin } = await checkUserApproval(trimmedEmail));
  } catch (e) {
    console.warn("[ytc-signup] approval probe failed, defaulting to manual-review:", e);
  }
  const approvalSource = approved
    ? (admin ? "admin" : "alumni-database")
    : "manual-review";
  const nowIso = new Date().toISOString();

  // 3. Write the canonical accessRequests doc (setDoc with email-as-id
  //    so a user can re-sign up if they ever delete and recreate).
  try {
    const { db } = await getYtcFirebase();
    const { doc, setDoc } = await import("firebase/firestore");
    const docData: Record<string, any> = {
      email: lowerEmail,
      firstName, lastName, fullName,
      graduationYear,
      requestedAt: nowIso,
      status: approved ? "approved" : "pending",
      autoApproved: approved,
      approvalSource,
    };
    if (approved) docData.approvedAt = nowIso;
    await setDoc(doc(db, "accessRequests", lowerEmail), docData);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error("[ytc-signup] accessRequests write failed:", e?.message || e);
  }

  // 4. Admin notification (always).
  fetch(`${YTC_API_BASE}/api/send-signup-notification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userEmail: lowerEmail,
      userName: fullName,
      graduationYear,
      isApproved: approved,
      isAdmin: admin,
      approvalSource,
    }),
  }).catch(() => {});

  // 5. Welcome email — only when auto-approved. Manual-review users get
  //    a welcome email later, when an admin approves them on the
  //    website (which fires /api/send-approval-email server-side).
  if (approved) {
    fetch(`${YTC_API_BASE}/api/send-welcome-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: lowerEmail, userName: fullName }),
    }).catch(() => {});
  }

  return { approved, admin };
}

/**
 * Upload a simcha image to Firebase Storage and return its download URL.
 * Path matches the website's user-facing flow: simcha-images/{ts}-{filename}.
 * Pass either a local file URI (RN ImagePicker result) or a remote URL.
 */
export async function uploadSimchaImage(localUri: string, filename: string): Promise<string> {
  const { app } = await getYtcFirebase();
  const { getStorage, ref, uploadBytes, getDownloadURL } = await import("firebase/storage");
  const storage = getStorage(app);
  // RN's fetch() can resolve a local file: URI into a Blob the SDK uploads.
  const res = await fetch(localUri);
  const blob = await res.blob();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `simcha-images/${Date.now()}-${safe}`;
  const r = ref(storage, path);
  await uploadBytes(r, blob);
  return getDownloadURL(r);
}

/**
 * Submit a simcha for admin moderation. Writes to simchaSubmissions
 * (NOT events) — admin approval creates the public events doc later.
 * Mirrors the website's app/events/events-content.tsx flow.
 */
export async function submitSimcha(input: {
  fullName: string;
  simchaType: string;
  date: string;
  connection: string;
  message: string;
  imageUrl?: string | null;
  submittedBy: string; // user email
}): Promise<void> {
  const { db } = await getYtcFirebase();
  const { addDoc, collection } = await import("firebase/firestore");
  // submittedAt: ISO string (NOT serverTimestamp). The website + admin
  // pages do `new Date(submittedAt)` which silently breaks for the
  // Firestore Timestamp object that serverTimestamp() resolves to.
  await addDoc(collection(db, "simchaSubmissions"), {
    fullName: input.fullName,
    simchaType: input.simchaType,
    date: input.date,
    connection: input.connection,
    message: input.message,
    imageUrl: input.imageUrl ?? null,
    submittedBy: input.submittedBy,
    submittedAt: new Date().toISOString(),
    status: "new",
  });
}

/**
 * Submit (or update) the user's entry in the alumni contact directory.
 *
 * Matches the website's pattern (verified against
 * github.com/abbrach1/YTC-ALUMNI-MAIN-WEBSITE → app/contacts/contacts-content.tsx
 * and components/first-login-popup.tsx):
 *
 *   New record  → addDoc(collection("alumniContactSubmissions"), …)  // auto-ID
 *   Edit record → setDoc(doc("alumniContactSubmissions", existingDocId), …)
 *
 * We do NOT use lowercased email as a doc ID here. Earlier versions of
 * this file did, but that diverges from the website's auto-ID pattern
 * and led to duplicate docs (one per surface) plus the user-visible
 * "Add yourself" misfire when a user had submitted from the site only.
 *
 * Lookup of "does the user already have a record" is by EMAIL match,
 * not doc-ID — matches the website's `data.email === user.email` scan
 * in contacts-content.tsx. We accept the matching record's id from the
 * caller (so contacts.tsx can pass through what it already has cached
 * from fetchApprovedAlumni / fetchMyAlumniContact) instead of re-scanning.
 */
export async function submitAlumniContact(input: {
  /** Existing doc ID if editing, else null/undefined for a new record. */
  existingId?: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  location: string;
  submittedBy: string; // user email — used as fallback identity stamp
}): Promise<void> {
  const { db } = await getYtcFirebase();
  const { doc, setDoc, addDoc, collection, serverTimestamp } = await import("firebase/firestore");
  if (input.existingId) {
    const ref = doc(db, "alumniContactSubmissions", input.existingId);
    // Edit — match the website's setDoc(merge:true-style) shape: keep the
    // original submittedAt + status, stamp updatedAt.
    await setDoc(ref, {
      name: input.name,
      email: input.email,
      phone: input.phone,
      location: input.location,
      submittedBy: input.submittedBy,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } else {
    await addDoc(collection(db, "alumniContactSubmissions"), {
      name: input.name,
      email: input.email,
      phone: input.phone,
      location: input.location,
      submittedBy: input.submittedBy,
      submittedAt: new Date().toISOString(),
      status: "pending",
    });
  }
}

/**
 * Find the current user's existing alumni-contact submission, if any.
 *
 * Mirrors the website's lookup: scan the collection for the first doc
 * where `data.email === userEmail`. Case-sensitive — the website does
 * `data.email === user.email` directly, no normalization, so we match
 * that to avoid edge cases where the website finds a record but we
 * don't (or vice versa).
 *
 * The caller passes the *raw* user.email (NOT a lowercased version). The
 * old API was `fetchMyAlumniContact(emailLower)` doing a doc-ID lookup;
 * that was wrong — see submitAlumniContact's header comment for context.
 */
export async function fetchMyAlumniContact(userEmail: string | null | undefined) {
  if (!userEmail) return null;
  const { db } = await getYtcFirebase();
  // Previously: `getDocs(collection(...))` downloaded the ENTIRE
  // alumniContactSubmissions collection and scanned client-side for an
  // email match. Measured 2.3s of JS-thread block on Schok F1 (per the
  // ytc:fetch:alumniContactSubmissions jank metric). Replaced with a
  // server-side equality filter — Firestore returns 0–1 docs, decode is
  // trivial. Single-field equality query, no composite index needed.
  const { collection, getDocs, query, where, limit } = await import("firebase/firestore");
  const snap = await getDocs(query(
    collection(db, "alumniContactSubmissions"),
    where("email", "==", userEmail),
    limit(1),
  ));
  const d = snap.docs[0];
  if (!d) return null;
  const data = d.data() as any;
  return {
    id: d.id,
    name: (data.name ?? "") as string,
    email: (data.email ?? null) as string | null,
    phone: (data.phone ?? null) as string | null,
    location: (data.location ?? "") as string,
    status: (data.status ?? "pending") as "pending" | "approved" | "rejected",
  };
}

// ─── Caching ────────────────────────────────────────────────────────────────
//
// Aggressive two-layer cache so every YTC screen loads instantly after
// the very first fetch. Without this every tab switch / app reopen
// re-fetched from Firestore and the section felt sluggish.
//
// Layer 1: in-memory Map<key, {data, ts}> — instant hits during a session.
// Layer 2: AsyncStorage — survives cold start so the FIRST tap on the
//   YTC tab after relaunch shows data immediately while a background
//   refresh updates it.
//
// Stale-while-revalidate semantics: cached data is returned right away
// whether fresh or stale. If stale, a background refetch fires; the
// next call (or the next render that subscribes via the cache key)
// gets the new data. Pull-to-refresh handlers should call
// invalidateYtcCache() to force the next read to bypass the cache.
//
// Long TTLs intentionally — rebbeim and alumni rarely change, so a 24h
// TTL is fine and gives true offline-after-first-load behavior.

import AsyncStorage from "@/lib/kv";
import { markJank, clearJank } from "@/lib/perf/jank-detector";

const STORAGE_PREFIX = "@ytc_cache:v1:";
type CacheEntry<T> = { data: T; ts: number };
const _mem = new Map<string, CacheEntry<any>>();
const _inflight = new Map<string, Promise<any>>();

async function readDisk<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    // JSON.parse of a large cached blob (e.g. 800-doc shiurim) can block
    // the JS thread for hundreds of ms on slow eMMC. Mark so the jank
    // detector attributes any freeze here to "ytc:cache-parse:<key>".
    markJank(`ytc:cache-parse:${key}`);
    try {
      return JSON.parse(raw);
    } finally {
      clearJank();
    }
  } catch { return null; }
}

async function writeDisk<T>(key: string, entry: CacheEntry<T>): Promise<void> {
  try {
    markJank(`ytc:cache-write:${key}`);
    const serialized = JSON.stringify(entry);
    clearJank();
    await AsyncStorage.setItem(STORAGE_PREFIX + key, serialized);
  } catch {}
}

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  // Layer 1: in-memory
  const memHit = _mem.get(key) as CacheEntry<T> | undefined;
  if (memHit) {
    if (now - memHit.ts < ttlMs) return memHit.data;
    // Stale: return immediately, refresh in background.
    refreshInBackground(key, fn);
    return memHit.data;
  }
  // Layer 2: disk (one-time hydration into memory)
  const diskHit = await readDisk<T>(key);
  if (diskHit) {
    _mem.set(key, diskHit);
    if (now - diskHit.ts < ttlMs) return diskHit.data;
    // Stale on disk too — return what we have, refresh in background.
    refreshInBackground(key, fn);
    return diskHit.data;
  }
  // Cold cache: must wait for network. Subsequent calls are instant.
  return fetchAndStore(key, fn);
}

function refreshInBackground<T>(key: string, fn: () => Promise<T>): void {
  if (_inflight.has(key)) return; // already refreshing
  fetchAndStore(key, fn).catch(() => {}); // background; failures don't propagate
}

async function fetchAndStore<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = (async () => {
    try {
      // Mark BEFORE the await so when the network resolves and the JS
      // thread picks back up to run fn()'s post-await code (Firestore
      // doc decoding, .map work, etc.), any jank is attributed to this
      // specific fetch. Cleared in finally.
      markJank(`ytc:fetch:${key}`);
      const data = await fn();
      const entry: CacheEntry<T> = { data, ts: Date.now() };
      _mem.set(key, entry);
      writeDisk(key, entry); // fire-and-forget — disk persistence is best-effort
      return data;
    } finally {
      clearJank();
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);
  return promise;
}

/**
 * Synchronous read of the in-memory cache. Returns null if the entry
 * doesn't exist or isn't hydrated into memory yet. Use this to seed
 * initial useState in a screen so it can render with data on first
 * paint without a spinner flash, when an earlier load (or pre-warm)
 * has populated the cache.
 *
 * Does NOT touch disk and does NOT check TTL — callers should still
 * call the regular fetcher afterwards to validate freshness.
 */
export function peekYtcCacheMem<T>(key: string): T | null {
  const hit = _mem.get(key);
  return hit ? (hit.data as T) : null;
}

/**
 * Force-invalidate cached data so the next call hits the network.
 * Pull-to-refresh handlers in /ytc screens call this before re-fetching.
 * Pass no argument to clear EVERYTHING (used on sign-out).
 */
export async function invalidateYtcCache(key?: string): Promise<void> {
  if (key) {
    _mem.delete(key);
    _inflight.delete(key);
    try { await AsyncStorage.removeItem(STORAGE_PREFIX + key); } catch {}
    return;
  }
  _mem.clear();
  _inflight.clear();
  try {
    const all = await AsyncStorage.getAllKeys();
    const ours = all.filter((k) => k.startsWith(STORAGE_PREFIX));
    if (ours.length) await AsyncStorage.multiRemove(ours);
  } catch {}
}

// TTL choices:
// - Shiurim, events, announcements, carousel: 30 min — they update
//   weekly at most, but a half-hour is a safe daily-use freshness window.
// - Rebbeim, alumni: 24 hours — rarely change, big payoff for caching.
// - Most-recent-shiur: 5 min — home screen shows it prominently and a
//   missing newest shiur is more noticeable than a stale list.
const TTL_RECENT = 5 * 60 * 1000;
const TTL_LIST = 30 * 60 * 1000;
const TTL_DIRECTORY = 24 * 60 * 60 * 1000;

// ─── Doc → typed object helpers ─────────────────────────────────────────────

function docToShiur(d: DocumentSnapshot) {
  if (!d.exists()) return null;
  const data = d.data()!;
  return {
    id: d.id,
    title: data.title ?? "",
    rebbe: data.rebbe ?? "",
    date: data.date ?? "",
    tags: data.tags ?? [],
    audioUrl: data.audioUrl as string | undefined,
    pdfUrl: data.pdfUrl as string | undefined,
    description: data.description as string | undefined,
    playCount: data.playCount as number | undefined,
    downloadCount: data.downloadCount as number | undefined,
    series: data.series as string | undefined,
  };
}

function docToEvent(d: DocumentSnapshot) {
  if (!d.exists()) return null;
  const data = d.data()!;
  return {
    id: d.id,
    eventName: data.eventName ?? "",
    personFamily: data.personFamily ?? "",
    type: data.type ?? "",
    date: data.date ?? "",
    location: data.location ?? "",
    time: data.time as string | undefined,
    imageUrl: data.imageUrl as string | undefined,
    description: data.description as string | undefined,
  };
}

// ─── Shiurim ────────────────────────────────────────────────────────────────
// All fetchers below go through cached() — see the Caching section above.
// Cache key is the fetcher name (extended with arg suffixes when the call
// is parameterized). Keys must stay stable across releases or users will
// see a cold-cache hit on app update; if you need to bust, change the
// STORAGE_PREFIX version number above.

// Size of the "first page" mirror cache. Cold-cache mount on the YTC
// Shiurim tab on a Schok F1 used to read the full ~800-doc blob from
// AsyncStorage and JSON.parse it on the JS thread — 300-800ms of frozen
// UI. By writing a smaller mirror cache containing only the most-recent
// SHIURIM_FIRST_PAGE_SIZE docs, fetchShiurimFirstPage() can read+parse
// in ~20-50ms and unblock the first paint; the full list streams in
// behind it via the normal cached("shiurim") path.
const SHIURIM_FIRST_PAGE_SIZE = 50;

async function _fetchShiurimFromFirestore() {
  const { db } = await getYtcFirebase();
  const { collection, query, orderBy, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc")));
  // The .map(docToShiur) walk of ~800 docs is CPU work that runs
  // synchronously on the JS thread once Firestore resolves. Mark it so
  // any jank lands attributed to "ytc:shiurim:map" instead of "unknown".
  markJank("ytc:shiurim:map");
  const all = snap.docs.map(docToShiur).filter(Boolean);
  clearJank();
  // Mirror the most-recent docs into a separate cache entry so cold
  // mounts can parse just this slice. Fire-and-forget; never blocks
  // the caller waiting for AsyncStorage.
  writeDisk("shiurim:page0", { data: all.slice(0, SHIURIM_FIRST_PAGE_SIZE), ts: Date.now() }).catch(() => {});
  return all;
}

export async function fetchShiurim() {
  return cached("shiurim", TTL_LIST, _fetchShiurimFromFirestore);
}

/**
 * Fast-path reader for the YTC Shiurim tab's first paint. Returns the
 * most-recent ~50 shiurim from a small mirror cache (or in-memory if the
 * full cache is already hydrated). Trades search/filter completeness for
 * speed — the caller should then load the full list via fetchShiurim()
 * behind first paint.
 *
 * Returns [] when nothing is cached on disk yet (truly cold install) —
 * caller falls back to fetchShiurim().
 */
export async function fetchShiurimFirstPage(): Promise<Shiur[]> {
  // Memory cache is the truth if it exists. Slice without touching disk.
  const mem = _mem.get("shiurim") as CacheEntry<Shiur[]> | undefined;
  if (mem) return mem.data.slice(0, SHIURIM_FIRST_PAGE_SIZE);
  // Disk fast-path: small blob, fast parse.
  const fast = await readDisk<Shiur[]>("shiurim:page0");
  if (fast) return fast.data;
  // No fast cache. Don't kick a Firestore fetch from here — let the
  // caller do that via fetchShiurim() so SWR semantics stay centralized.
  return [];
}

/**
 * Incremental refresh — fetches ONLY shiurim with date >= maxCachedDate,
 * merges them into the existing cache by doc id (dedupe), and returns
 * the merged list. Cheap on the wire: a YTC weekday typically yields
 * 0–3 new docs, so this replaces a full ~800-doc query with a tiny one
 * on every tab focus.
 *
 * Uses `>=` instead of `>` so it doesn't miss a new doc that shares its
 * date with an already-cached one — the merge step dedupes by id.
 *
 * NOT designed to catch edits/deletes/backfills of older shiurim;
 * pull-to-refresh still does a full re-fetch for that case.
 *
 * Returns null if no cache to merge into (caller should fall back to
 * fetchShiurim()).
 */
export async function fetchNewShiurimSince(maxCachedDate: string) {
  if (!maxCachedDate) return null;
  const { db } = await getYtcFirebase();
  const { collection, query, where, orderBy, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(query(
    collection(db, "shiurim"),
    where("date", ">=", maxCachedDate),
    orderBy("date", "desc"),
  ));
  const incoming = snap.docs.map(docToShiur).filter(Boolean) as Array<{ id: string; date: string }>;
  const cached = (peekYtcCacheMem<any[]>("shiurim") ?? []);
  const byId = new Map<string, any>(cached.map((s) => [s.id, s]));
  let added = 0;
  for (const s of incoming) {
    if (!byId.has(s.id)) {
      byId.set(s.id, s);
      added++;
    }
  }
  if (added === 0) return { merged: cached, added: 0 };
  const merged = Array.from(byId.values()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const entry = { data: merged, ts: Date.now() };
  _mem.set("shiurim", entry);
  writeDisk("shiurim", entry);
  return { merged, added };
}

export async function fetchMostRecentShiur() {
  return cached("mostRecentShiur", TTL_RECENT, async () => {
    const { db } = await getYtcFirebase();
    const { collection, query, orderBy, limit, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc"), limit(1)));
    return snap.docs[0] ? docToShiur(snap.docs[0]) : null;
  });
}

/** Admin-pinned "featured shiurim". Returns [] when disabled or unset.
 *  Schema: settings/featuredShiur { enabled, shiurIds: string[] }.
 *  Legacy fallback: single `shiurId` (older admin builds). Order is
 *  preserved as the admin arranged it. Matches the website's read at
 *  app/page.tsx. */
export async function fetchFeaturedShiur() {
  return cached("featuredShiur", TTL_RECENT, async () => {
    const { db } = await getYtcFirebase();
    const { doc, getDoc } = await import("firebase/firestore");
    const settingsSnap = await getDoc(doc(db, "settings", "featuredShiur"));
    if (!settingsSnap.exists()) return [];
    const data = settingsSnap.data() as { enabled?: boolean; shiurIds?: unknown; shiurId?: string };
    if (!data.enabled) return [];
    const ids: string[] = Array.isArray(data.shiurIds)
      ? data.shiurIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : data.shiurId
      ? [data.shiurId]
      : [];
    if (ids.length === 0) return [];
    const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, "shiurim", id))));
    return snaps.map(docToShiur).filter(Boolean);
  });
}

export async function incrementPlayCount(shiurId: string) {
  // Not cached — fire-and-forget mutation. The home/list screens read
  // playCount from cached data, so the new count won't show until the
  // shiurim cache hits TTL or the user pulls-to-refresh.
  const { db } = await getYtcFirebase();
  const { doc, updateDoc, increment } = await import("firebase/firestore");
  try { await updateDoc(doc(db, "shiurim", shiurId), { playCount: increment(1) }); } catch {}
}

// ─── Events ─────────────────────────────────────────────────────────────────

async function _fetchEventsFromFirestore() {
  const { db } = await getYtcFirebase();
  const { collection, query, orderBy, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(query(collection(db, "events"), orderBy("date", "asc")));
  return snap.docs.map(docToEvent).filter(Boolean);
}

export async function fetchEvents() {
  return cached("events", TTL_LIST, _fetchEventsFromFirestore);
}

/**
 * Incremental refresh for events. Events are sorted ASC by date, but
 * "new" simchas are typically future-dated — and admins might add a
 * just-happened one yesterday too. We query for any event with
 * date >= today minus a small overlap window so a recent past event
 * added today still gets caught.
 *
 * Like fetchNewShiurimSince, this merges by id into the cache and does
 * NOT catch edits/deletes of older events; pull-to-refresh handles that.
 */
export async function fetchNewEventsSince() {
  const { db } = await getYtcFirebase();
  const { collection, query, where, orderBy, getDocs } = await import("firebase/firestore");
  // 14-day overlap so a simcha added retroactively (e.g., an l'chaim
  // from last week) still gets picked up.
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 14);
  const cutoffIso = cutoffDate.toISOString().split("T")[0];
  const snap = await getDocs(query(
    collection(db, "events"),
    where("date", ">=", cutoffIso),
    orderBy("date", "asc"),
  ));
  const incoming = snap.docs.map(docToEvent).filter(Boolean) as Array<{ id: string; date: string }>;
  const cached = (peekYtcCacheMem<any[]>("events") ?? []);
  const byId = new Map<string, any>(cached.map((e) => [e.id, e]));
  let added = 0;
  for (const e of incoming) {
    if (!byId.has(e.id)) {
      byId.set(e.id, e);
      added++;
    }
  }
  if (added === 0) return { merged: cached, added: 0 };
  const merged = Array.from(byId.values()).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const entry = { data: merged, ts: Date.now() };
  _mem.set("events", entry);
  writeDisk("events", entry);
  return { merged, added };
}

export async function fetchUpcomingEvents(eventLimit = 3) {
  // Cache key includes the limit so different callers don't share an
  // entry. TTL_RECENT (5 min) since the home screen shows them.
  return cached(`upcomingEvents:${eventLimit}`, TTL_RECENT, async () => {
    const { db } = await getYtcFirebase();
    const { collection, query, where, orderBy, limit, getDocs } = await import("firebase/firestore");
    const today = new Date().toISOString().split("T")[0];
    const snap = await getDocs(
      query(collection(db, "events"), where("date", ">=", today), orderBy("date", "asc"), limit(eventLimit)),
    );
    return snap.docs.map(docToEvent).filter(Boolean);
  });
}

// ─── Announcements ──────────────────────────────────────────────────────────

export async function fetchAnnouncements() {
  return cached("announcements", TTL_LIST, async () => {
    const { db } = await getYtcFirebase();
    const { collection, query, where, orderBy, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(
      query(collection(db, "announcements"), where("enabled", "==", true), orderBy("date", "desc")),
    );
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        title: data.title ?? "",
        content: data.content ?? "",
        type: data.type ?? "announcement",
        date: data.date ?? "",
        enabled: data.enabled ?? false,
      };
    });
  });
}

// ─── Carousel ───────────────────────────────────────────────────────────────

export async function fetchCarouselImages() {
  return cached("carouselImages", TTL_LIST, async () => {
    const { db } = await getYtcFirebase();
    const { collection, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(collection(db, "carouselImages"));
    return snap.docs
      .map((d) => {
        const data = d.data();
        return { id: d.id, url: data.url ?? "", caption: data.caption as string | undefined, order: data.order ?? 0 };
      })
      .sort((a, b) => a.order - b.order);
  });
}

// ─── Collections ────────────────────────────────────────────────────────────

export async function fetchActiveCollections() {
  return cached("shiurCollections:active", TTL_LIST, async () => {
    const { db } = await getYtcFirebase();
    const { collection, query, where, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(query(collection(db, "shiurCollections"), where("isActive", "==", true)));
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: (data.name ?? "") as string,
          description: (data.description ?? "") as string,
          shiurIds: (data.shiurIds ?? []) as string[],
          isActive: (data.isActive ?? false) as boolean,
          createdAt: (data.createdAt ?? null) as string | null,
        };
      })
      // Newest first; the iOS app sorts the same way.
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  });
}

export async function fetchCollectionById(id: string) {
  // Cache per-id so a deep-link or repeated drill-in doesn't refetch.
  return cached(`shiurCollection:${id}`, TTL_LIST, async () => {
    const { db } = await getYtcFirebase();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, "shiurCollections", id));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      id: snap.id,
      name: (data.name ?? "") as string,
      description: (data.description ?? "") as string,
      shiurIds: (data.shiurIds ?? []) as string[],
      isActive: (data.isActive ?? false) as boolean,
      createdAt: (data.createdAt ?? null) as string | null,
    };
  });
}

// ─── Alumni Spotlight ───────────────────────────────────────────────────────

export async function fetchAlumniPhotos() {
  return cached("alumniPhotos", TTL_LIST, async () => {
    const { db } = await getYtcFirebase();
    const { collection, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(collection(db, "alumniPhotos"));
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          url: (data.url ?? "") as string,
          caption: data.caption as string | undefined,
          name: data.name as string | undefined,
          year: data.year as string | undefined,
          order: (data.order ?? 0) as number,
        };
      })
      .sort((a, b) => a.order - b.order);
  });
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export async function fetchRebbeim() {
  return cached("rebbeim", TTL_DIRECTORY, async () => {
    const { db } = await getYtcFirebase();
    const { collection, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(collection(db, "rebbeim"));
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        name: data.name ?? "",
        title: data.title ?? "",
        email: data.email as string | undefined,
        phone: data.phone as string | undefined,
        photoUrl: data.photoUrl as string | undefined,
      };
    });
  });
}

export async function fetchApprovedAlumni() {
  return cached("approvedAlumni", TTL_DIRECTORY, async () => {
    const { db } = await getYtcFirebase();
    // Previously: getDocs(collection(...)) downloaded the ENTIRE
    // alumniContactSubmissions collection and filtered client-side.
    // Jank metric pinned an 8.7s JS-thread block (10.7s marker age) to
    // ytc:fetch:approvedAlumni — same offender pattern as the
    // fetchMyAlumniContact fix. Use a server-side equality filter so
    // Firestore only returns approved docs.
    const { collection, getDocs, query, where } = await import("firebase/firestore");
    const snap = await getDocs(query(
      collection(db, "alumniContactSubmissions"),
      where("status", "==", "approved"),
    ));
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name ?? "",
          email: data.email as string | undefined,
          phone: data.phone as string | undefined,
          location: data.location ?? "",
          submittedAt: data.submittedAt as any,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}
