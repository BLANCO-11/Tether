"use client";

import type { ReactNode } from "react";
import { usePermissions } from "@/lib/permissions";
import type { Permission } from "@/lib/types";
import { grantAdviceFor, missingPermissionCopy, unreadableCopy } from "@/lib/permission-copy";

/**
 * A control that stays VISIBLE and says why it is unavailable.
 *
 * ⚠ **Disabled-with-a-reason, not hidden — and the distinction is deliberate.** A hidden
 * control is indistinguishable from a control that does not exist, so a person who needs
 * it has nothing to ask for and nobody to ask. This renders the control disabled, names
 * the permission that is missing, and says **who can grant it** — which is the difference
 * between a dead end and a next step.
 *
 * Use `Can` to hide; use this for the controls somebody would reasonably go looking for.
 *
 * ⚠ **The third state renders as the third state.** When the check could not run the
 * control is left ENABLED with a note saying the check did not run — because the server
 * is the thing that refuses, and disabling on a failed check would deny access on the
 * strength of a network error.
 */
export function PermissionGate({
  permission,
  children,
  /** What the control is for, e.g. "add a credential". Used in the explanation. */
  action,
}: {
  permission: Permission;
  children: ReactNode;
  action?: string;
}) {
  const { can, data } = usePermissions();
  const state = can(permission);

  if (state === "allowed") return <>{children}</>;

  if (state === "unreadable") {
    return (
      <span className="inline-flex flex-col gap-1">
        {children}
        <span className="text-xs text-amber-700" data-testid="permission-unreadable">
          {unreadableCopy()}
        </span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex flex-col gap-1 opacity-60"
      data-testid="permission-denied"
      aria-disabled="true"
    >
      <span className="pointer-events-none select-none" inert={"" as unknown as boolean}>
        {children}
      </span>
      <span className="text-xs text-slate-600">
        {missingPermissionCopy(permission, action)} {grantAdviceFor(data)}
      </span>
    </span>
  );
}
