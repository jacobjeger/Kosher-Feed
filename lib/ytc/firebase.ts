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

export async function fetchShiurim() {
  const { db } = await getYtcFirebase();
  const { collection, query, orderBy, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc")));
  return snap.docs.map(docToShiur).filter(Boolean);
}

export async function fetchMostRecentShiur() {
  const { db } = await getYtcFirebase();
  const { collection, query, orderBy, limit, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc"), limit(1)));
  return snap.docs[0] ? docToShiur(snap.docs[0]) : null;
}

export async function incrementPlayCount(shiurId: string) {
  const { db } = await getYtcFirebase();
  const { doc, updateDoc, increment } = await import("firebase/firestore");
  try { await updateDoc(doc(db, "shiurim", shiurId), { playCount: increment(1) }); } catch {}
}

// ─── Events ─────────────────────────────────────────────────────────────────

export async function fetchEvents() {
  const { db } = await getYtcFirebase();
  const { collection, query, orderBy, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(query(collection(db, "events"), orderBy("date", "asc")));
  return snap.docs.map(docToEvent).filter(Boolean);
}

export async function fetchUpcomingEvents(eventLimit = 3) {
  const { db } = await getYtcFirebase();
  const { collection, query, where, orderBy, limit, getDocs } = await import("firebase/firestore");
  const today = new Date().toISOString().split("T")[0];
  const snap = await getDocs(
    query(collection(db, "events"), where("date", ">=", today), orderBy("date", "asc"), limit(eventLimit)),
  );
  return snap.docs.map(docToEvent).filter(Boolean);
}

// ─── Announcements ──────────────────────────────────────────────────────────

export async function fetchAnnouncements() {
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
}

// ─── Carousel ───────────────────────────────────────────────────────────────

export async function fetchCarouselImages() {
  const { db } = await getYtcFirebase();
  const { collection, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(collection(db, "carouselImages"));
  return snap.docs
    .map((d) => {
      const data = d.data();
      return { id: d.id, url: data.url ?? "", caption: data.caption as string | undefined, order: data.order ?? 0 };
    })
    .sort((a, b) => a.order - b.order);
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export async function fetchRebbeim() {
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
}

export async function fetchApprovedAlumni() {
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
}
