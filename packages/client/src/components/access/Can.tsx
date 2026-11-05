"use client";

import type { ReactNode } from "react";
import { usePermissions } from "@/lib/permissions";
import type { Permission } from "@/lib/types";

/**
 * Render `children` only when the server says this person holds `permission`.
 *
 * ⚠ **THREE STATES, AND `unreadable` IS NOT `denied`.** When the check could not run,
 * this renders `unreadable` — which defaults to rendering the children **with** the
 * `whenUnreadable` note rather than silently hiding them. Hiding on unreadable would make
 * a broken permissions endpoint look exactly like a correctly-restricted screen, and the
 * person would have no way to tell "you may not" from "we could not find out".
 *
 * ⚠ **HIDING IS NEVER THE ENFORCEMENT.** The server refuses regardless; every
 * workspace-scoped route carries a guard. This decides what a person is OFFERED, so that
 * they are not handed a control that will refuse them.
 */
export function Can({
  permission,
  children,
  fallback = null,
  whenUnreadable,
}: {
  permission: Permission;
  children: ReactNode;
  /** Rendered when the server says no. `null` means render nothing. */
  fallback?: ReactNode;
  /**
   * Rendered when the check could not run. Defaults to the children — because the
   * server will refuse if they are not entitled, and an empty screen tells them
   * nothing at all.
   */
  whenUnreadable?: ReactNode;
}) {
  const { can } = usePermissions();
  const state = can(permission);
  if (state === "allowed") return <>{children}</>;
  if (state === "denied") return <>{fallback}</>;
  return <>{whenUnreadable ?? children}</>;
}

/**
 * The same decision as a hook, for the cases where a component needs the answer rather
 * than a subtree — a disabled attribute, a filtered list, a column.
 */
export function useCan(permission: Permission) {
  const { can, why } = usePermissions();
  const state = can(permission);
  return {
    state,
    allowed: state === "allowed",
    denied: state === "denied",
    unreadable: state === "unreadable",
    why: why(permission),
  };
}

/**
 * The same three states for a **platform** permission.
 *
 * ⚠ **Do not reach for `useCan` here.** A platform permission is never in the workspace
 * union, so `useCan("platform.roles.write")` answers `denied` for somebody holding all
 * eleven — see `canPlatform`'s note in `lib/permissions.tsx`. A separate hook rather than
 * a flag on `useCan` so the wrong one is a different call, not a forgotten argument: an
 * optional input is how one consumer silently gets a different answer from another.
 *
 * There is no `why` — provenance is computed for the workspace union, and a platform
 * permission's source is the platform role itself, which `data.platformRoles` names.
 */
export function useCanPlatform(permission: Permission) {
  const { canPlatform } = usePermissions();
  const state = canPlatform(permission);
  return {
    state,
    allowed: state === "allowed",
    denied: state === "denied",
    unreadable: state === "unreadable",
  };
}
