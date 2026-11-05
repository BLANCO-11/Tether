"use client";

import { useState } from "react";
import { useAsync } from "@/lib/hooks";
/**
 * ⚠ **`@/lib/api`, NEVER the raw client.** `workspaceId` arrives as a prop from a
 * caller that read it out of the workspace context, so on first render it can be the
 * `UNRESOLVED_WORKSPACE` placeholder. These wrappers translate it; see the block above
 * `listWorkspaceRoles` in `lib/api.ts`.
 */
import {
  listWorkspaceRoleMembers,
  assignWorkspaceRole,
  unassignWorkspaceRole,
  listMembers,
} from "@/lib/api";
import { useCan } from "@/components/access/Can";
import { useToast } from "@/lib/toast";
import type { WorkspaceRoleSummary } from "@/lib/types";

/**
 * Who holds one custom workspace role, with add and remove.
 *
 * ## ⚠ WHY THIS EXISTS: the role could be composed and given to nobody
 *
 * The roles surface — `/organization/roles` when this was written, the **Roles tab** on
 * `/admin/members`, then Advanced on `/admin/roles` — has created and retired custom roles since Phase 6, and
 * `assignWorkspaceRole` / `unassignWorkspaceRole` have existed in `foundry-client.ts`
 * for just as long with **no callers**. Both member panels hardcoded
 * `ROLES = ["author", "approver", "admin"]`, so a composed role could never be selected
 * anywhere. A role nobody can be given is a role the product does not have.
 *
 * ## ⚠ A CUSTOM ROLE IS ADDITIVE, NOT AN ALTERNATIVE TO THE PRESET
 *
 * This is the reason assignment lives here and **not** as a fourth entry in the member
 * panel's role dropdown. The resolver is a union:
 *
 * ```
 * effective = preset(workspace_members.role) ∪ ⋃ custom roles ∪ grants ∪ conferral
 * ```
 *
 * A membership row carries exactly one preset; custom roles are held *alongside* it,
 * any number of them. Putting them in the same dropdown would say they are alternatives
 * — a person given a custom role would appear to have lost their preset, and somebody
 * would "fix" that by switching them back, silently removing the custom role. The
 * dropdown writes `workspace_members.role`; this writes `workspace_role_assignments`.
 * They are different tables and different questions.
 *
 * ## ⚠ There is no "roles of a member" read, and that is why this is role-centric
 *
 * The server offers `GET …/roles/:roleId/members` and nothing in the other direction,
 * so a person-centric view would need one request per role to answer "what does this
 * person hold". Role-centric needs exactly one per role that is opened. If a
 * member-centric view is ever wanted, the honest way is a server-side read, not N
 * client requests fanned out per member.
 */
export function RoleHolders({
  workspaceId,
  role,
  onChanged,
}: {
  workspaceId: string;
  role: WorkspaceRoleSummary;
  /** Let the parent re-read, so its assignee count cannot drift from this list. */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState("");
  const canGrant = useCan("members.grant");
  const roleId = role.id;

  const holders = useAsync(
    async () => (roleId ? await listWorkspaceRoleMembers(workspaceId, roleId) : []),
    [workspaceId, roleId],
  );
  const members = useAsync(() => listMembers(workspaceId), [workspaceId]);

  // A built-in preset has no id and no assignment table — everybody holding it holds it
  // through their membership row, which the member panel owns.
  if (!roleId) return null;

  const held = new Set((holders.data ?? []).map((h) => h.subject));
  const addable = (members.data ?? []).filter((m) => !held.has(m.subject));

  const add = async () => {
    if (!subject) return;
    setBusy(true);
    try {
      await assignWorkspaceRole(workspaceId, roleId, subject);
      setSubject("");
      holders.reload();
      onChanged?.();
    } catch (e) {
      // ⚠ Verbatim. The server refuses with `role_exceeds_granter` naming the offending
      // permission, and that message is the whole diagnosis.
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: string) => {
    setBusy(true);
    try {
      await unassignWorkspaceRole(workspaceId, roleId, s);
      holders.reload();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 border-t border-line pt-2">
      {holders.loading ? <p className="text-xs text-muted">Reading who holds this…</p> : null}

      {/* ⚠ Three states. "0 people" and "we could not ask" are different facts. */}
      {holders.error ? (
        <p className="text-xs text-warn" data-testid="holders-unreadable">
          Who holds this role could not be read — the check did not run. This is not a
          statement that nobody holds it.
        </p>
      ) : null}

      {holders.data && holders.data.length === 0 ? (
        <p className="text-xs text-muted">Nobody holds this role yet.</p>
      ) : null}

      {holders.data && holders.data.length > 0 ? (
        <ul className="space-y-1" data-testid="holder-list">
          {holders.data.map((h) => {
            const who = (members.data ?? []).find((m) => m.subject === h.subject);
            return (
              <li key={h.subject} className="flex items-center justify-between text-xs">
                {/* An assignment is keyed on the subject; the email is a convenience
                    from the member list and may be absent for somebody no longer a
                    member. Show the subject rather than nothing. */}
                <span className="text-text">{who?.email ?? h.subject}</span>
                {canGrant.denied ? null : (
                  <button className="underline" onClick={() => remove(h.subject)} disabled={busy}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canGrant.denied ? (
        <p className="mt-2 text-xs text-muted">
          You need <code>members.grant</code> to change who holds this role.
        </p>
      ) : role.retiredAt ? (
        // ⚠ Retired, not deleted (INV-7). Existing holders stay visible and removable;
        // nobody new may be added, or a retired role would keep growing.
        <p className="mt-2 text-xs text-muted">
          This role is retired, so nobody new can be given it.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`add-holder-${roleId}`}>
            Add somebody to {role.name}
          </label>
          <select
            id={`add-holder-${roleId}`}
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          >
            <option value="">Add somebody…</option>
            {addable.map((m) => (
              <option key={m.subject} value={m.subject}>
                {m.email}
              </option>
            ))}
          </select>
          <button className="text-xs underline disabled:opacity-50" onClick={add} disabled={busy || !subject}>
            Add
          </button>
          {members.error ? (
            <span className="text-xs text-warn">
              The member list could not be read, so nobody can be picked.
            </span>
          ) : null}
          {members.data && addable.length === 0 && !members.error ? (
            <span className="text-xs text-muted">
              Everybody in this workspace already holds it.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
