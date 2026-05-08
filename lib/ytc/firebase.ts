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
      const { initializeApp, getApps } = await import("firebase/app");
      const { getAuth } = await import("firebase/auth");
      const { getFirestore } = await import("firebase/firestore");
      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
      _initialized = { app, auth: getAuth(app), db: getFirestore(app) };
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
 */
export async function checkUserApproval(email: string): Promise<{ approved: boolean; admin: boolean }> {
  const normalizedEmail = email.toLowerCase();
  const { db } = await getYtcFirebase();
  const { doc, getDoc, collection, query, where, getDocs } = await import("firebase/firestore");

  let approved = false;
  let admin = false;
  try {
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
  } catch (e) {
    // Approval failures should not crash the app; YtcAuthContext will
    // route the user to /pending if approved stays false.
    console.warn("YTC approval check error:", e);
  }
  return { approved, admin };
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
  const { approved, admin } = await checkUserApproval(trimmedEmail);
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
  const { collection, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(collection(db, "alumniContactSubmissions"));
  for (const d of snap.docs) {
    const data = d.data() as any;
    if (data?.email === userEmail) {
      return {
        id: d.id,
        name: (data.name ?? "") as string,
        email: (data.email ?? null) as string | null,
        phone: (data.phone ?? null) as string | null,
        location: (data.location ?? "") as string,
        status: (data.status ?? "pending") as "pending" | "approved" | "rejected",
      };
    }
  }
  return null;
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

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_PREFIX = "@ytc_cache:v1:";
type CacheEntry<T> = { data: T; ts: number };
const _mem = new Map<string, CacheEntry<any>>();
const _inflight = new Map<string, Promise<any>>();

async function readDisk<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function writeDisk<T>(key: string, entry: CacheEntry<T>): Promise<void> {
  try { await AsyncStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(entry)); } catch {}
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
      const data = await fn();
      const entry: CacheEntry<T> = { data, ts: Date.now() };
      _mem.set(key, entry);
      writeDisk(key, entry); // fire-and-forget — disk persistence is best-effort
      return data;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);
  return promise;
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

export async function fetchShiurim() {
  return cached("shiurim", TTL_LIST, async () => {
    const { db } = await getYtcFirebase();
    const { collection, query, orderBy, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc")));
    return snap.docs.map(docToShiur).filter(Boolean);
  });
}

export async function fetchMostRecentShiur() {
  return cached("mostRecentShiur", TTL_RECENT, async () => {
    const { db } = await getYtcFirebase();
    const { collection, query, orderBy, limit, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc"), limit(1)));
    return snap.docs[0] ? docToShiur(snap.docs[0]) : null;
  });
}

/** Admin-pinned "featured shiur". Returns null when disabled or unset.
 *  Schema (matches iOS): settings/featuredShiur { enabled, shiurId }. */
export async function fetchFeaturedShiur() {
  return cached("featuredShiur", TTL_RECENT, async () => {
    const { db } = await getYtcFirebase();
    const { doc, getDoc } = await import("firebase/firestore");
    const settingsSnap = await getDoc(doc(db, "settings", "featuredShiur"));
    if (!settingsSnap.exists()) return null;
    const data = settingsSnap.data() as { enabled?: boolean; shiurId?: string };
    if (!data.enabled || !data.shiurId) return null;
    const shiurSnap = await getDoc(doc(db, "shiurim", data.shiurId));
    return docToShiur(shiurSnap);
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

export async function fetchEvents() {
  return cached("events", TTL_LIST, async () => {
    const { db } = await getYtcFirebase();
    const { collection, query, orderBy, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(query(collection(db, "events"), orderBy("date", "asc")));
    return snap.docs.map(docToEvent).filter(Boolean);
  });
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
    const { collection, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(collection(db, "alumniContactSubmissions"));
    return snap.docs
      .filter((d) => d.data().status === "approved")
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
