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
import React, { createContext, useContext, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { subscribeAuth, checkUserApproval, firebaseSignOutIfInitialized } from "@/lib/ytc/firebase";

interface AuthState {
  user: User | null;
  isApproved: boolean;
  isAdmin: boolean;
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
  isLoading: true,
  signOut: async () => {},
  refreshStatus: async () => {},
});

export function YtcAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isApproved: false,
    isAdmin: false,
    isLoading: true,
  });

  const checkAndSetApproval = async (user: User) => {
    if (!user.email) {
      setState({ user, isApproved: false, isAdmin: false, isLoading: false });
      return;
    }
    const { approved, admin } = await checkUserApproval(user.email);
    setState({ user, isApproved: approved, isAdmin: admin, isLoading: false });
  };

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const off = await subscribeAuth(async (user) => {
        if (cancelled) return;
        if (user) await checkAndSetApproval(user);
        else setState({ user: null, isApproved: false, isAdmin: false, isLoading: false });
      });
      if (cancelled) { off(); return; }
      unsub = off;
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  const signOut = async () => { await firebaseSignOutIfInitialized(); };
  const refreshStatus = async () => { if (state.user) await checkAndSetApproval(state.user); };

  return (
    <YtcAuthContext.Provider value={{ ...state, signOut, refreshStatus }}>
      {children}
    </YtcAuthContext.Provider>
  );
}

export const useYtcAuth = () => useContext(YtcAuthContext);
