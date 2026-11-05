"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { foundryApi } from "@/lib/foundry-client";
import { UNRESOLVED_WORKSPACE } from "@/lib/workspace-choice";
import type { MyPermissions, Permission, PermissionProvenance } from "@/lib/types";

/**
 * What the SERVER says this person may do here.
 *
 * ## ⚠ THREE STATES, AND THE THIRD IS THE WHOLE POINT
 *
 * `allowed` · `denied` · **`unreadable`**. Not two.
 *
 * A check that could not run is **neither answer**, and rendering it as "denied" is the
 * failure this repo has now written down three times: `listPromptBoundaryWarnings`
 * catching everything and returning `{items: []}` renders as *"no flagged content"* when
 * the truth is *"the check did not run"*; `/organization`'s fourth state exists for the
 * same reason; and the deleted `faFallback` answered every server failure with fabricated
 * rows. **We could not check** must never render as **you may not**, and it must never
 * render as **you may**.
 *
 * ## ⚠ THIS IS NOT THE ENFORCEMENT, AND IT CANNOT BE
 *
 * The server refuses regardless. Every workspace-scoped route carries a guard spliced
 * from `auth/route-permissions.ts`, and a browser that lied to itself about what it holds
 * would get a 403 at the wire. What this buys is that a person is not offered a control
 * that will refuse them — an affordance question, not a security one.
 *
 * ## ⚠ NEVER READ THE SIGN-IN SESSION
 *
 * `session.user.roles` says `["superadmin","admin"]` for the local account, from a
 * password check in `packages/client/src/auth.ts`, while the server decides from its own
 * environment and its own tables. Reading it would be a second authority that can
 * disagree with the only one that refuses anything — and it disagrees in the worse
 * direction: a page that renders over routes that all 403.
 * `ui-honesty-check.sh` asserts the absence of that read.
 */

export type PermissionState = "allowed" | "denied" | "unreadable";

export interface PermissionsValue {
  /** `null` while loading; the server's answer once it arrives. */
  data: MyPermissions | null;
  loading: boolean;
  /** Set when the check itself could not run. NOT a refusal. */
  error: Error | null;
  /** The three-state answer, for a WORKSPACE permission. */
  can: (permission: Permission) => PermissionState;
  /**
   * The three-state answer, for a **platform** permission.
   *
   * ⚠ **`can` CANNOT ANSWER THIS AND MUST NOT BE ASKED TO.** `data.permissions` is the
   * workspace-tier union for one workspace; a platform permission is never in it, so
   * `can("platform.roles.write")` returns `denied` for a super admin who holds all
   * eleven. That is the wrong answer in the dangerous direction — it hides a control
   * from exactly the person entitled to use it, and reads as "you may not" rather than
   * "wrong question".
   *
   * It reads `data.platformPermissions`, which the server has always sent on this same
   * payload. No second computation, no client-side policy: this is still the server's
   * answer, just the other half of it.
   */
  canPlatform: (permission: Permission) => PermissionState;
  /** Why they hold it, for a screen that explains itself. `[]` if they do not. */
  why: (permission: Permission) => PermissionProvenance[];
  /** Re-ask the server. */
  refresh: () => void;
}

const PermissionsContext = createContext<PermissionsValue | null>(null);

/**
 * ⚠ **60 seconds, and SC-005 is why.** A revocation must take effect promptly without a
 * sign-out. The server is already correct on the very next request — this only bounds how
 * long a *control* stays on screen after the answer behind it changed.
 *
 * ⚠ Deliberately not a long-lived cache. A stale authorisation answer that survives a
 * revocation is the failure mode that matters, and the fix people reach for when the
 * window is long is to reload the page, which is not a fix.
 */
const REFRESH_MS = 60_000;

export function PermissionsProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null | undefined;
  children: ReactNode;
}) {
  const [data, setData] = useState<MyPermissions | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  // ⚠ The app layout hands this the workspace CONTEXT value, which is the
  // `UNRESOLVED_WORKSPACE` placeholder (`ws_it`) until the resolver answers. It is not a
  // workspace and not a uuid: asking about it sent `GET /workspaces/ws_it/me/permissions`
  // on every full page load (and every 60 s while resolution failed), each one a 400
  // `invalid input syntax for type uuid` in the server log. Treat it as "no workspace yet".
  const subject = workspaceId === UNRESOLVED_WORKSPACE ? null : workspaceId;

  useEffect(() => {
    if (!subject) {
      // ⚠ No workspace is NOT "denied" and NOT "unreadable" — there is nothing to ask
      // about yet. `can()` reports `unreadable` for it, which is the honest answer:
      // we do not know, because we have not asked.
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    foundryApi
      .myPermissions(subject)
      .then((r) => {
        if (cancelled || !active.current) return;
        setData(r as unknown as MyPermissions);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled || !active.current) return;
        // ⚠ The answer is DISCARDED, not replaced with an empty one. An empty list would
        // render as "you may do nothing", which is a claim we are not entitled to make.
        setData(null);
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled && active.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subject, tick]);

  useEffect(() => {
    if (!subject) return;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [subject]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const value = useMemo<PermissionsValue>(() => {
    const held = new Set<string>(data?.permissions ?? []);
    const heldPlatform = new Set<string>(data?.platformPermissions ?? []);
    return {
      data,
      loading,
      error,
      can: (permission) => {
        // ⚠ Order matters. An unreadable check is unreadable even though `held` is
        // empty — reporting "denied" here is precisely the lie this file exists to
        // prevent.
        if (error) return "unreadable";
        if (!data) return "unreadable";
        return held.has(permission) ? "allowed" : "denied";
      },
      // ⚠ Same order, same reason. A super admin's `platformPermissions` is the whole
      // platform tier because the server short-circuits it, so no special case for the
      // allowlist belongs here — adding one would be a second authority deciding an
      // access question in the browser, which FR-031 forbids.
      canPlatform: (permission) => {
        if (error) return "unreadable";
        if (!data) return "unreadable";
        return heldPlatform.has(permission) ? "allowed" : "denied";
      },
      why: (permission) => data?.provenance?.[permission] ?? [],
      refresh,
    };
  }, [data, loading, error, refresh]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

/**
 * ⚠ Outside a provider this returns `unreadable`, never `denied`.
 *
 * A component rendered somewhere the provider was forgotten must not quietly hide every
 * control and look like a correctly-restricted screen. Unreadable is visible; denied is
 * indistinguishable from working.
 */
export function usePermissions(): PermissionsValue {
  const ctx = useContext(PermissionsContext);
  if (ctx) return ctx;
  return {
    data: null,
    loading: false,
    error: new Error("usePermissions was called outside a PermissionsProvider"),
    can: () => "unreadable",
    canPlatform: () => "unreadable",
    why: () => [],
    refresh: () => {},
  };
}
