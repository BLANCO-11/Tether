// src/lib/workspace.tsx — the React face of workspace identity.
// platform-coherence Phase 1.3/1.4, I-103, D-113.
//
// ── ⚠ THIS FILE NO LONGER DECIDES ANYTHING ──────────────────────────────────
//
// It renders the answer `resolveWorkspaceId()` gives and records switches. Every
// scoped call in `lib/api.ts` awaits that same function, so what the topbar shows
// and what a request is scoped to cannot disagree — which is exactly what they
// did before Phase 1 (I-103).
//
// ⚠ The header that used to be here said: *"api.ts (plain functions) reads
// `activeWorkspaceId()` straight from localStorage to scope every list/create
// call."* It did not, and had not since the seam was introduced —
// `activeWorkspaceId()` had **zero** consumers outside this file while 58 call
// sites went through the other resolver. A comment describing a wiring that does
// not exist is worse than no comment: it is why the defect survived review.
// `activeWorkspaceId()` is deleted rather than rewired; `storedWorkspaceChoice()`
// in `lib/workspace-choice.ts` is the storage read, and it is not a resolver.
//
// ⚠ The provider also held a SECOND copy of a bug that had already been fixed
// once: on a first visit it adopted `spaces[0]`, and the server returns
// workspaces `created_at DESC` — "newest wins", the rule whose removal from
// `resolveWorkspaceId` is documented there at length. Deleted with the rest.
"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { adoptWorkspaceId, resolveWorkspaceId } from "@/lib/foundry-client";
import { UNRESOLVED_WORKSPACE, storeWorkspaceChoice } from "@/lib/workspace-choice";

/**
 * A placeholder for the sliver of time before the real workspace has resolved.
 * It exists so the first server and client renders agree.
 *
 * ⚠ **THIS DOCBLOCK USED TO SAY "never sent anywhere", AND THAT WAS FALSE.**
 * It was true of the scoped calls in `lib/api.ts`, which all await the
 * resolver — and false of `getMe(workspaceId)`, which six admin pages call with
 * this value on first render. The consequence was not a wrong workspace: it took
 * the API server down fifteen times. The constant now lives in the leaf module
 * with the full record, and `getMe` translates it; see
 * `lib/workspace-choice.ts` and `packages/server/src/middleware/async-routes.ts`.
 * Kept as an alias because it is imported under this name.
 */
export { UNRESOLVED_WORKSPACE as DEFAULT_WORKSPACE } from "@/lib/workspace-choice";

type WorkspaceValue = {
  workspaceId: string;
  switchWorkspace: (id: string) => void;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/** Wraps the app; holds the active workspace and persists switches. */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaceId, setWorkspaceId] = useState(UNRESOLVED_WORKSPACE);

  /**
   * ⚠ Three acts, and the middle one is the one that was missing.
   *
   *   1. record the choice, so the next page load lands here;
   *   2. `adoptWorkspaceId` — repoint the cache every scoped call reads, NOW.
   *      Without it the switch only takes effect on the next full load, and
   *      the app layout re-keys `<main>` so pages remount and refetch — from
   *      the workspace being switched away from;
   *   3. re-render the shell.
   */
  const switchWorkspace = (id: string) => {
    storeWorkspaceChoice(id);
    adoptWorkspaceId(id);
    setWorkspaceId(id);
  };

  useEffect(() => {
    let live = true;
    // One resolver. Whatever it answers — the stored choice, the deployment's
    // pinned default, the oldest workspace — is what the requests use, so it is
    // what the topbar must show.
    resolveWorkspaceId()
      .then((id) => {
        if (live) setWorkspaceId(id);
      })
      .catch(() => {
        // Leaving the placeholder on screen is the honest outcome: the API is
        // unreachable, and every page under this provider is about to say so in
        // its own error state. Inventing a workspace here would be the one
        // fabrication `ui-honesty-check.sh` exists to prevent.
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <WorkspaceContext.Provider value={{ workspaceId, switchWorkspace }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

/** Read the active workspace and the switch action. */
export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}

/**
 * The active workspace's REAL id, or null while it is still being worked out (2026-10-13). For a component that hands
 * the workspace to its own API calls (the Forge builder, Chats): the context value is the placeholder until the
 * provider resolves, and the placeholder must never reach the server (see the docblock above). Null means "wait".
 */
export function useResolvedWorkspace(): string | null {
  const { workspaceId } = useWorkspace();
  const [resolved, setResolved] = useState<string | null>(workspaceId === UNRESOLVED_WORKSPACE ? null : workspaceId);
  useEffect(() => {
    if (workspaceId !== UNRESOLVED_WORKSPACE) {
      setResolved(workspaceId);
      return;
    }
    let live = true;
    setResolved(null);
    resolveWorkspaceId()
      .then((id) => live && setResolved(id))
      .catch(() => undefined); // no workspace at all: the page keeps waiting, as it does for the provider
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return resolved;
}
