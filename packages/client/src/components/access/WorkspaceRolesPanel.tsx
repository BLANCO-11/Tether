// src/components/access/WorkspaceRolesPanel.tsx — custom roles for one workspace.
//
// ⚠ **THIS IS THE BODY OF `app/(app)/organization/roles/page.tsx`**, extracted so it can
// be a tab on `/admin/members` (since 2026-10-30: Advanced on `/admin/roles`). The page is DELETED, not left unlinked: a page with no
// door is the defect closed on 2026-09-13, where the whole platform tier was seeded,
// enforced and measured while being unreachable. Leaving these alive with nothing
// linking to them would re-create it one week later.
//
// The reasoning came with it and is not summarised:
//
// ⚠ **THE PRESETS ARE LISTED BESIDE THE CUSTOM ROLES**, with `builtin` and no id. A
// screen showing only custom roles implies a workspace with none has no roles at all,
// when in fact everybody in it holds one.
//
// ⚠ **Retiring, never deleting** (INV-7), and the confirmation CARRIES THE COUNT the
// server sent. "Are you sure?" with no number is a dialog people learn to click through.

"use client";

import { useState } from "react";
import { useAsync } from "@/lib/hooks";
import { useWorkspace } from "@/lib/workspace";
/**
 * ⚠ **`@/lib/api`, NEVER the raw client here.** These three calls took the
 * workspace-context value straight to the wire, and on first render that value is
 * the `UNRESOLVED_WORKSPACE` placeholder — so the roles read failed and the
 * built-in roles rendered as "could not be read" until something remounted the
 * page. `@/lib/api`'s wrappers translate it through `scopedWorkspace`; see the
 * block above `listWorkspaceRoles` there, and `workspace-placeholder.test.ts`,
 * whose CONTROL names these three functions.
 */
import { listWorkspaceRoles, createWorkspaceRole, retireWorkspaceRole } from "@/lib/api";
import { RoleEditor } from "@/components/access/RoleEditor";
import { PermissionGate } from "@/components/access/PermissionGate";
import { RoleHolders } from "@/components/access/RoleHolders";
import { useCan } from "@/components/access/Can";
import { useToast } from "@/lib/toast";
import type { WorkspaceRoleSummary } from "@/lib/types";

/** `workspaceId` names the workspace (the Roles page passes one from its URL); without it, the active one. */
export function WorkspaceRolesPanel({ workspaceId: given }: { workspaceId?: string } = {}) {
  const active = useWorkspace().workspaceId;
  const workspaceId = given ?? active;
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const canWrite = useCan("roles.write");

  const roles = useAsync<WorkspaceRoleSummary[]>(
    () => listWorkspaceRoles(workspaceId),
    [workspaceId],
  );

  const create = async (input: { name: string; description: string; permissions: string[] }) => {
    setBusy(true);
    try {
      await createWorkspaceRole(workspaceId, input);
      setCreating(false);
      roles.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const retire = async (role: WorkspaceRoleSummary) => {
    if (!role.id) return;
    try {
      await retireWorkspaceRole(workspaceId, role.id, false);
      roles.reload();
    } catch (e) {
      // ⚠ The server's refusal carries the assignee COUNT. Re-ask with that number in
      // the question rather than a bare "are you sure".
      const message = e instanceof Error ? e.message : String(e);
      if (/confirm=true/i.test(message)) {
        if (window.confirm(message)) {
          await retireWorkspaceRole(workspaceId, role.id, true);
          roles.reload();
        }
        return;
      }
      toast.error(message);
    }
  };

  return (
    <div>
      <p className="mb-4 text-xs text-muted">
        Built-in roles and any this workspace has composed from the permission catalogue.
      </p>
        {roles.loading ? <p className="text-sm text-muted">Reading roles…</p> : null}

        {/* ⚠ Three states. An unreadable list says so; it never renders as "no roles". */}
        {roles.error ? (
          <p className="text-sm text-warn">
            The roles could not be read, so none are shown — the check did not run. This is
            not a statement that this workspace has none.
          </p>
        ) : null}

        {roles.data ? (
          <ul className="space-y-3" data-testid="role-list">
            {roles.data.map((r) => (
              <li key={r.id ?? r.name} className="rounded border border-line p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text">
                    {r.name}{" "}
                    {r.builtin ? (
                      <span className="text-xs text-dim">built-in</span>
                    ) : r.retiredAt ? (
                      <span className="text-xs text-dim">retired</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted">
                    {r.assignees} {r.assignees === 1 ? "person" : "people"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">{r.permissions.join(" · ")}</p>
                {/* ⚠ Custom roles only. A built-in preset has no assignment table —
                    everybody holding it holds it through their membership row, which
                    the member panel owns. Offering an "add" here for a preset would be
                    a second way to write the same thing, disagreeing with the first. */}
                {!r.builtin ? (
                  <RoleHolders workspaceId={workspaceId} role={r} onChanged={roles.reload} />
                ) : null}
                {!r.builtin && !r.retiredAt ? (
                  <PermissionGate permission="roles.write" action="retire this role">
                    <button className="mt-2 text-xs underline" onClick={() => retire(r)}>
                      Retire
                    </button>
                  </PermissionGate>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-6">
          {creating ? (
            <RoleEditor busy={busy} onSave={create} onCancel={() => setCreating(false)} />
          ) : (
            <PermissionGate permission="roles.write" action="compose a role">
              <button
                className="rounded bg-accent px-3 py-1 text-sm text-white"
                onClick={() => setCreating(true)}
                disabled={!canWrite.allowed && !canWrite.unreadable}
              >
                Compose a role
              </button>
            </PermissionGate>
          )}
        </div>
    </div>
  );
}
