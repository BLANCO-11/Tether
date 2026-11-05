import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceMemberCapabilities } from "../db/schema.js";
import {
  WORKSPACE_PERMISSIONS,
  isWorkspacePermission,
  type WorkspacePermission,
} from "../auth/permissions.js";
import { effectivePermissionsService } from "./effective-permissions.service.js";

/**
 * ⚠ **THIS SERVICE IS NOW A VIEW OVER THE PERMISSION CATALOGUE, NOT A SECOND ONE.**
 *
 * It used to own seven invented capability strings and its own `ROLE_CAPS`. There were
 * **two** `ROLE_CAPS` in this repo — this one and `packages/client/src/lib/capabilities.ts`
 * — and they **disagreed** about whether an `approver` may publish. Neither was wrong on
 * its own; there were simply two, and nothing could tell you which one decided anything.
 *
 * The seven strings are gone. Migration 0065 renamed the five that were permissions
 * (`edit-workflows` → `flows.write`, `publish` → `flows.arm`, `approve` → `flows.approve`,
 * `resources` → `resources.read`, `real-data` → `realdata.use`) and DROPPED the two that
 * were **roles wearing a capability's clothes** — `admin` and `platform-admin` (INV-10).
 * A capability is a thing you may do; those two were statements about who somebody is,
 * and they are re-expressed as a preset assignment and a platform role.
 *
 * ⚠ **`getCapabilities` DELEGATES to the resolver.** It does not re-derive anything.
 * Two computations of "what may this person do" is exactly what this feature exists to
 * end, and the second one always loses quietly — it is the one nothing is tested against.
 *
 * ⚠ **THIS SERVICE HAS THREE READERS, NOT ONE**: `routes/break-glass.ts`,
 * `routes/me.ts` (which serves `capabilities[]` to the browser and therefore decides what
 * the sidebar renders) and `services/catalogue.service.ts`. Changing what it returns
 * changes all three.
 */
export const CAPABILITIES = WORKSPACE_PERMISSIONS;
export type Capability = WorkspacePermission;

export function isValidCapability(c: string): c is Capability {
  return isWorkspacePermission(c);
}

export const workspaceMemberCapabilitiesService = {
  CAPABILITIES,

  async list(workspaceId: string, subject: string): Promise<Capability[]> {
    const rows = await db
      .select()
      .from(workspaceMemberCapabilities)
      .where(
        and(
          eq(workspaceMemberCapabilities.workspaceId, workspaceId),
          eq(workspaceMemberCapabilities.subject, subject),
        ),
      );
    return rows.map((r) => r.capability as Capability);
  },
  /**
   * Every explicit grant in a workspace, for the admin surface.
   * Role-provided capabilities are NOT here — the caller unions with ROLE_CAPS.
   * Workspace-scoped: every read filters WHERE workspace_id = ?.
   */
  async listAll(
    workspaceId: string,
  ): Promise<
    Array<{ subject: string; capability: Capability; grantedBy: string; createdAt: Date }>
  > {
    const rows = await db
      .select()
      .from(workspaceMemberCapabilities)
      .where(eq(workspaceMemberCapabilities.workspaceId, workspaceId))
      .orderBy(asc(workspaceMemberCapabilities.subject), asc(workspaceMemberCapabilities.capability));
    return rows.map((r) => ({
      subject: r.subject,
      capability: r.capability as Capability,
      grantedBy: r.grantedBy,
      createdAt: r.createdAt,
    }));
  },

  /**
   * What this person may do in this workspace.
   *
   * ⚠ **One computation.** Delegates to the resolver, which unions the membership
   * preset, custom roles, individual grants and anything a platform role confers (D-9),
   * and short-circuits for the allowlist before reading anything. Re-deriving any of
   * that here would be a second answer to the same question, and the second answer is
   * always the one nothing is tested against.
   */
  async getCapabilities(opts: {
    workspaceId: string;
    subject: string;
    email?: string | null;
  }): Promise<Capability[]> {
    const eff = await effectivePermissionsService.forWorkspace(
      { subject: opts.subject, email: opts.email ?? null },
      opts.workspaceId,
    );
    return [...eff.permissions];
  },

  async hasCapability(opts: {
    workspaceId: string;
    subject: string;
    email?: string | null;
    capability: Capability;
  }): Promise<boolean> {
    const caps = await this.getCapabilities(opts);
    return caps.includes(opts.capability);
  },

  async grant(opts: {
    workspaceId: string;
    subject: string;
    capability: Capability;
    grantedBy: string;
  }): Promise<void> {
    if (!isValidCapability(opts.capability))
      throw Object.assign(new Error(`unknown capability ${opts.capability}`), { statusCode: 400 });
    await db
      .insert(workspaceMemberCapabilities)
      .values({
        workspaceId: opts.workspaceId,
        subject: opts.subject,
        capability: opts.capability,
        grantedBy: opts.grantedBy,
      })
      .onConflictDoNothing();
  },

  async revoke(opts: { workspaceId: string; subject: string; capability: Capability }): Promise<void> {
    await db
      .delete(workspaceMemberCapabilities)
      .where(
        and(
          eq(workspaceMemberCapabilities.workspaceId, opts.workspaceId),
          eq(workspaceMemberCapabilities.subject, opts.subject),
          eq(workspaceMemberCapabilities.capability, opts.capability),
        ),
      );
  },
};
