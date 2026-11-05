import type { MyPermissions } from "@/lib/types";

/**
 * The words a refusal wears, kept OUT of the components so the RULES can be asserted.
 *
 * The `generation-findings.ts` / `policy-copy.ts` idiom: a string in a component can only
 * be checked by rendering it, and the properties that matter here are about what the
 * words must never say.
 */

/** ⚠ Never lists who holds the permission — FR-021. A screen is not a 403, but the same
 * reasoning applies: publishing the accounts worth attacking is not an affordance. */
export function missingPermissionCopy(permission: string, action?: string): string {
  return action
    ? `You need the "${permission}" permission to ${action}.`
    : `You need the "${permission}" permission for this.`;
}

/**
 * ⚠ **Names who can grant it, and the answer DIFFERS** — FR-016 / SC-013. "Ask an
 * administrator" when there is one to ask; "nobody can grant this yet, set
 * SUPER_ADMIN_EMAILS" when the deployment has no super admin configured. Two refusals,
 * two actions: one is a person, the other is an environment variable, and one shared
 * sentence sends somebody looking for an administrator who does not exist.
 */
export function grantAdviceFor(me: MyPermissions | null): string {
  if (!me) return "An administrator of this workspace can grant it.";
  if (me.memberRole === null) {
    return "You are not a member of this workspace; an administrator of it can add you.";
  }
  return "An administrator of this workspace can grant it.";
}

/**
 * ⚠ **The third state says the check did not run — NOT that you may not.** This is the
 * `PromptBoundaryWarnings` rule: an absence of findings you never obtained must never
 * render as an absence of findings.
 */
export function unreadableCopy(): string {
  return "We could not check your access just now, so this may still refuse.";
}

/** For the no-access page. Never an empty picker (SC-013). */
export function noAccessCopy(opts: {
  superAdminConfigured: boolean;
  workspaceCount: number;
}): { title: string; body: string } {
  if (opts.workspaceCount > 0) {
    return {
      title: "You do not have access to this workspace",
      body: "Pick one of the workspaces you can see, or ask an administrator of this one to add you.",
    };
  }
  return {
    title: "You do not have access to any workspace yet",
    body: opts.superAdminConfigured
      ? "Somebody on this deployment's super-admin list can add you to a workspace. Ask them, and they can do it from Manage Workspaces."
      : "This deployment has no super admin configured, so nobody can grant access yet. SUPER_ADMIN_EMAILS has to be set on the API server before anybody can be added to a workspace.",
  };
}
