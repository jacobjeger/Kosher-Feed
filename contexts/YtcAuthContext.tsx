// YTC: Firebase auth + approval state, scoped to the /ytc subtree.
// Mounted by app/ytc/_layout.tsx — never by the root layout. That
// scoping is what keeps Firebase out of cold start: this context's
// provider only mounts after the user navigates to /ytc, at which point
// the lazy import in lib/ytc/firebase.ts fires for the first time.
//
// Verbatim port from /tmp/ytc-source/expo-app/contexts/AuthContext.tsx,
// with these changes:
//  - imports come from @/lib/ytc/firebase (lazy wrapper) instead of
//    'firebase/auth' top-level
//  - exposes useYtcAuth (renamed from useAuth so callers can't confuse
//    it with shiurpod's own user state, which doesn't exist but might
//    in the future)
//  - canUpload: derived from isAdmin || shiurUploaders/{email}.exists,
//    via a real-time onSnapshot listener so admin toggles in
//    /admin/users propagate to the app within ~2s.
//  - AsyncStorage-backed cache of {approved, admin, canUpload} per
//    lowercased email, so an offline cold start hydrates from the last
//    known truth instead of resetting to false (which used to send
//    already-verified users to /pending — see issue thread).
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { User } from "firebase/auth";
import {
  subscribeAuth, checkUserApproval, firebaseSignOutIfInitialized,
  subscribeShiurUploader,
  // Pre-warm fetchers — kicked off the moment we know the user is
  // approved. By the time the home screen mounts (1 stack push later),
  // these promises are already resolved or in-flight, so the cache
  // returns instantly. Cuts perceived YTC home load time noticeably
  // because Firestore round-trips overlap with the navigation animation.
  fetchCarouselImages, fetchAnnouncements, fetchUpcomingEvents,
  fetchMostRecentShiur, fetchFeaturedShiur, fetchActiveCollections,
  fetchAlumniPhotos, fetchRebbeim, fetchApprovedAlumni,
} from "@/lib/ytc/firebase";

interface AuthState {
  user: User | null;
  isApproved: boolean;
  isAdmin: boolean;
  // Whether this user can upload shiurim — admins always can; other users
  // have a doc in shiurUploaders/{lowercaseEmail}. Updates in real-time.
  canUpload: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  signOut: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const YtcAuthContext = createContext<AuthContextValue>({
  user: null,
  isApproved: false,
  isAdmin: false,
  canUpload: false,
  isLoading: true,
  signOut: async () => {},
  refreshStatus: async () => {},
});

// Cache schema (per email) — lets an offline cold start show the right
// surface to a previously-verified user instead of routing them through
// /pending.
const CACHE_PREFIX = "@ytc_auth:v1:";
interface AuthCache {
  approved: boolean;
  admin: boolean;
  canUpload: boolean;
  cachedAt: number;
}

async function readAuthCache(emailLower: string): Promise<AuthCache | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_PREFIX + emailLower);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.approved === "boolean" && typeof parsed?.admin === "boolean") {
      return {
        approved: !!parsed.approved,
        admin: !!parsed.admin,
        // canUpload was added later; older cache entries may not have it.
        // Falling back to admin matches the new derivation rule.
        canUpload: typeof parsed.canUpload === "boolean" ? parsed.canUpload : !!parsed.admin,
        cachedAt: typeof parsed.cachedAt === "number" ? parsed.cachedAt : 0,
      };
    }
  } catch {}
  return null;
}

async function writeAuthCache(emailLower: string, c: Omit<AuthCache, "cachedAt">): Promise<void> {
  try {
    await AsyncStorage.setItem(
      CACHE_PREFIX + emailLower,
      JSON.stringify({ ...c, cachedAt: Date.now() }),
    );
  } catch {}
}

async function clearAuthCache(emailLower: string): Promise<void> {
  try { await AsyncStorage.removeItem(CACHE_PREFIX + emailLower); } catch {}
}

export function YtcAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isApproved: false,
    isAdmin: false,
    canUpload: false,
    isLoading: true,
  });

  // Tracks the latest values seen for the *current* user so the
  // shiurUploader snapshot callback can recompute canUpload from the
  // most recent isAdmin (avoids a stale closure overriding admin=true
  // back to canUpload=false on a transient empty snapshot).
  const liveRef = useRef<{ emailLower: string | null; admin: boolean; uploaderExists: boolean }>({
    emailLower: null,
    admin: false,
    uploaderExists: false,
  });

  // Active shiurUploader unsubscribe so we can detach on user change /
  // sign-out (avoids leaks + cross-account contamination).
  const uploaderUnsubRef = useRef<(() => void) | null>(null);

  const detachUploader = () => {
    if (uploaderUnsubRef.current) {
      try { uploaderUnsubRef.current(); } catch {}
      uploaderUnsubRef.current = null;
    }
  };

  const checkAndSetApproval = async (user: User) => {
    if (!user.email) {
      detachUploader();
      liveRef.current = { emailLower: null, admin: false, uploaderExists: false };
      setState({ user, isApproved: false, isAdmin: false, canUpload: false, isLoading: false });
      return;
    }
    const emailLower = user.email.toLowerCase();

    // 1. Hydrate from cache immediately so the gate doesn't flicker to
    //    /pending on cold start before the network responds.
    const cached = await readAuthCache(emailLower);
    if (cached) {
      liveRef.current = {
        emailLower,
        admin: cached.admin,
        uploaderExists: cached.canUpload && !cached.admin, // best-effort
      };
      setState({
        user,
        isApproved: cached.approved,
        isAdmin: cached.admin,
        canUpload: cached.canUpload,
        isLoading: false,
      });
    }

    // 2. Live check. On error (offline), keep whatever we hydrated from
    //    cache — do NOT reset to false, that's the bug we're fixing.
    let approved = cached?.approved ?? false;
    let admin = cached?.admin ?? false;
    try {
      const live = await checkUserApproval(user.email);
      approved = live.approved;
      admin = live.admin;
      // Also write what we know so far so the next cold start is correct
      // even before the uploader snapshot fires.
      await writeAuthCache(emailLower, {
        approved,
        admin,
        canUpload: admin || (cached?.canUpload && !cached?.admin ? cached.canUpload : false),
      });
    } catch (e) {
      console.warn("YTC approval check failed (using cache):", e);
    }

    liveRef.current = {
      emailLower,
      admin,
      uploaderExists: liveRef.current.uploaderExists,
    };
    setState((prev) => ({
      ...prev,
      user,
      isApproved: approved,
      isAdmin: admin,
      canUpload: admin || prev.canUpload, // admin always implies canUpload; otherwise wait for snapshot
      isLoading: false,
    }));

    // 3. Pre-warm content fetchers once approved.
    if (approved) {
      Promise.all([
        fetchCarouselImages(),
        fetchAnnouncements(),
        fetchUpcomingEvents(3),
        fetchMostRecentShiur(),
        fetchFeaturedShiur(),
        fetchActiveCollections(),
        fetchAlumniPhotos(),
        fetchRebbeim(),
        fetchApprovedAlumni(),
      ]).catch(() => {});
    }

    // 4. Real-time uploader-permission listener. Reattaches on every
    //    user change because the email may have changed.
    detachUploader();
    try {
      const off = await subscribeShiurUploader(emailLower, (exists) => {
        // Recompute canUpload from the latest known admin flag.
        liveRef.current.uploaderExists = exists;
        const adm = liveRef.current.admin;
        const can = adm || exists;
        setState((prev) => {
          // Ignore late callbacks from a previous user (after sign-out / switch).
          if (!prev.user || prev.user.email?.toLowerCase() !== emailLower) return prev;
          if (prev.canUpload === can) return prev;
          return { ...prev, canUpload: can };
        });
        // Persist the new canUpload to cache.
        writeAuthCache(emailLower, { approved, admin: adm, canUpload: can });
      });
      uploaderUnsubRef.current = off;
    } catch (e) {
      console.warn("YTC shiurUploader subscribe failed:", e);
    }
  };

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const off = await subscribeAuth(async (user) => {
        if (cancelled) return;
        if (user) {
          await checkAndSetApproval(user);
        } else {
          detachUploader();
          liveRef.current = { emailLower: null, admin: false, uploaderExists: false };
          setState({ user: null, isApproved: false, isAdmin: false, canUpload: false, isLoading: false });
        }
      });
      if (cancelled) { off(); return; }
      unsub = off;
    })();
    return () => {
      cancelled = true;
      detachUploader();
      if (unsub) unsub();
    };
  }, []);

  const signOut = async () => {
    // Clear the cache entry for the signed-out account so a different
    // user signing in on the same device doesn't see their stale state.
    const emailLower = liveRef.current.emailLower;
    detachUploader();
    if (emailLower) await clearAuthCache(emailLower);
    await firebaseSignOutIfInitialized();
  };
  const refreshStatus = async () => { if (state.user) await checkAndSetApproval(state.user); };

  return (
    <YtcAuthContext.Provider value={{ ...state, signOut, refreshStatus }}>
      {children}
    </YtcAuthContext.Provider>
  );
}

export const useYtcAuth = () => useContext(YtcAuthContext);
