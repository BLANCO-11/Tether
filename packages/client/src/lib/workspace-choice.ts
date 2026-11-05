// src/lib/workspace-choice.ts — where the person's choice of workspace is kept.
// platform-coherence Phase 1.1/1.5, I-103, D-113.
//
// ── ⚠ THIS IS STORAGE, NOT RESOLUTION ───────────────────────────────────────
//
// It reads and writes one localStorage key and decides nothing. The single
// answer to "which workspace am I in" is `resolveWorkspaceId()` in
// `lib/foundry-client.ts`, which consults this as its first and strongest
// source. Nothing else may read the key.
//
// ── Why the split exists at all ─────────────────────────────────────────────
//
// Until Phase 1 there were TWO implementations of workspace identity that did
// not know about each other (I-103):
//
//   • `lib/workspace.tsx`'s `activeWorkspaceId()` read this key. It had **zero**
//     consumers outside its own file, while its header claimed it scoped "every
//     list/create call".
//   • `resolveWorkspaceId()` read `/api/foundry-config` and cached the answer in
//     a module-level `_wsId` that was never invalidated. It had **58** call
//     sites in `lib/api.ts`.
//
// So the topbar switcher wrote here, the app layout re-keyed `<main>` on the new
// id, every page visibly remounted and refetched — and every refetch resolved to
// the workspace that was pinned at page load. A switch that appears to work.
// Worse than a display bug: `createTool`, `registerDatasource`, `createSecret`
// and 53 others resolve the same way, so **a tool added after a switch landed in
// the workspace you switched away from**, with the topbar naming the other one
// throughout.
//
// The reason it is a separate module rather than a function on either side is
// import direction: `lib/workspace.tsx` imports `foundry-client.ts` for
// `listWorkspaces`, so `foundry-client.ts` cannot import it back. A leaf module
// both can depend on is the only shape with one copy of the key in it.
//
// ⚠ `ui-honesty-check.sh` asserts the key literal appears in exactly this one
// file. The number is the check — a second reader would work perfectly and
// report nothing, which is precisely how I-103 survived review.

/**
 * The id the workspace context holds for the sliver of time before
 * `resolveWorkspaceId()` has answered.
 *
 * ── ⚠ IT IS NOT A WORKSPACE AND MUST NEVER REACH A REQUEST ──────────────────
 *
 * It exists so the first server and client renders agree (hydration), and
 * `lib/workspace.tsx` used to state that it "reaches no request" because every
 * scoped call in `lib/api.ts` awaits the resolver instead of reading it.
 *
 * That was true of the scoped calls and false of the one place a page passes the
 * context value as an ARGUMENT: six admin pages call `getMe(workspaceId)` on
 * first render. On 2026-09-08 that sent `GET /api/me?workspaceId=ws_it`,
 * Postgres refused the non-uuid, and the API server — which does not catch a
 * rejected route promise — **died, fifteen times**. See
 * `packages/server/src/middleware/async-routes.ts`.
 *
 * It lives HERE, in the leaf module, for the import direction already recorded
 * below: `lib/api.ts` must be able to recognise it without importing the React
 * provider. `getMe` is the one guard, because `getMe(workspaceId)` is the only
 * place the raw context value is passed to anything — asserted by a test.
 */
export const UNRESOLVED_WORKSPACE = "ws_it";

/** The one localStorage key. Nothing outside this file may name it. */
const KEY = "foundry.workspace";

/**
 * The workspace the person last picked, or null if they never have.
 *
 * ⚠ Null is a real answer and is not a fallback. A caller must fall through to
 * its own precedence rather than substituting a default here — a default in the
 * storage layer is a second opinion about identity, which is the defect this
 * module exists to remove.
 */
export function storedWorkspaceChoice(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v && v.trim() ? v : null;
  } catch {
    // Storage can be disabled outright (private mode, a locked-down policy).
    // That is "no choice recorded", not an error worth breaking a page over.
    return null;
  }
}

/** Record an explicit choice. Called by the switcher and by nothing else. */
export function storeWorkspaceChoice(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* see above — a switch that cannot be remembered still works for this page */
  }
}

/**
 * Forget the choice.
 *
 * ⚠ Used when the stored id resolves to nothing — a workspace deleted from
 * another tab, or a browser profile carried to a different deployment. Leaving
 * it would pin the UI at a dead id and every scoped call would 404 with the
 * topbar still naming it.
 */
export function clearWorkspaceChoice(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
