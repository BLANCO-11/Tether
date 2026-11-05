// src/lib/auth.tsx — the client-side view of the session, backed by Auth.js.
// The rest of the app only ever touches useAuth(); it stays the same shape
// ({ user, ready, signOut }) whether auth is real or (previously) mocked, so
// components didn't change when real sign-in landed. Real config lives in
// src/auth.ts; the actual sign-in screens live in src/app/login.
"use client";

import { createContext, useContext } from "react";
import { SessionProvider, useSession, signOut as authSignOut } from "next-auth/react";
import type { User } from "@/lib/types";

type AuthValue = {
  user: User | null;
  ready: boolean; // true once the session check has settled
  signOut: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

/** Wraps the app: provides the Auth.js session provider + our derived view of it. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AuthBridge>{children}</AuthBridge>
    </SessionProvider>
  );
}

/** Maps the Auth.js session onto Foundry's simple { user, ready, signOut } shape. */
function AuthBridge({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();

  const email = session?.user?.email ?? "";
  // Prefer the account's display name; otherwise derive a friendly one from the
  // email (matches how the old mock built it).
  const name =
    session?.user?.name ??
    (email ? email.split("@")[0].replace(/[._]/g, " ") : "");
  const user: User | null = session?.user ? { name, email } : null;

  const value: AuthValue = {
    user,
    ready: status !== "loading",
    signOut: () => authSignOut({ callbackUrl: "/login" }),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Read the current user and sign-out action. */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
