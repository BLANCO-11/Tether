// src/components/admin/MemberDrawer.tsx — one member's workspace access, in a drawer.
//
// ⚠ **THIS WAS MOVED, NOT REWRITTEN.** It is the `<aside>` that used to be a permanent
// 420px column beside `MembersPanel`'s table (both since moved — it opens from Advanced on `/admin/roles`): the grants read, the catalogue read, the
// role `<select>`, the per-permission checkboxes, the impact preview, the last-admin
// warning, Save and Remove. Every refusal, caveat and three-state branch in here was put
// in deliberately — a rewrite would have lost them silently, one at a time, with nothing
// going red.
//
// What changed is where it lives and when it exists. The column was on screen whether or
// not anybody had chosen a member, so the panel's default state was a table beside an
// empty box reading "Select a member to edit their role" — a permanent instruction
// occupying a third of the page.
//
// ── ⚠ INV-9 — NO PLATFORM ROLE AND NO `platform.*` PERMISSION APPEARS HERE ───────────
//
// This drawer is about one person's access to ONE WORKSPACE. A platform role is held
// against the deployment, not against a workspace, and it is the same for every
// workspace a person opens — so rendering it here would say, once per workspace, that
// somebody's platform access is a property of this workspace. Worse, the role `<select>`
// and the checkboxes beside it are writable: a platform role sitting among them reads as
// something this form can change, and it is not.
//
// Holders of a platform role are listed on `/admin/roles` and given on a person's page — the
// place the question "who administers this deployment" is asked. `allPermissions` filters
// `tier === "workspace"` and the test asserts the rendered output carries no `platform.`
// key, **with a control** proving the scan can find a permission key at all.
//
// ── ⚠ INV-3 — THE ROLE DROPDOWN OFFERS THE THREE PRESETS ONLY ────────────────────────
//
// A custom role is held ALONGSIDE a preset, not instead of one; the resolver is a union
// with no subtraction. Putting a custom role in this dropdown would say they are
// alternatives, and then switching somebody back to their preset would silently drop the
// custom role they also hold. Custom roles are granted under Advanced on `/admin/roles`, by
// `RoleHolders`, where adding one is visibly an addition.

"use client";

import { useMemo, useState } from "react";
import {
  grantMember,
  revokeMember,
  listMemberCapabilities,
  grantMemberCapability,
  revokeMemberCapability,
} from "@/lib/api";
import type { WorkspaceMember, WorkspaceRole } from "@/lib/types";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Notice } from "@/components/ui/Notice";
import {
  usePermissionCatalogue,
  presetPermissions,
  labelFor,
  permissionDiff,
  groupByPreset,
} from "@/components/access/permission-catalogue";
import { PermissionBand } from "@/components/access/PermissionBand";
import { useCan } from "@/components/access/Can";
import { missingPermissionCopy, unreadableCopy } from "@/lib/permission-copy";
import { WORKSPACE_ROLES, roleLabel } from "@/lib/role-labels";

/** ⚠ INV-3. The three PRESETS, and nothing else ever goes in this array. */
const ROLES: readonly WorkspaceRole[] = WORKSPACE_ROLES;

export function MemberDrawer({
  workspaceId,
  member,
  /** Every member of this workspace — needed only to count the admins. */
  members,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  /** `null` closes the drawer. The caller owns which member is open. */
  member: WorkspaceMember | null;
  members: WorkspaceMember[];
  onClose: () => void;
  /** Something was written; the caller reloads its list. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const catalogue = usePermissionCatalogue();
  const grants = useAsync(
    () => (workspaceId ? listMemberCapabilities(workspaceId) : Promise.resolve([])),
    [workspaceId],
  );
  const [pendingRole, setPendingRole] = useState<WorkspaceRole | null>(null);
  const [grantBusy, setGrantBusy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  /**
   * ⚠ **THE WRITE CONTROLS ARE GATED SEPARATELY FROM THE READ.** `members.read` opens
   * this drawer; `members.grant` is what lets anything in it be changed. Denied →
   * disabled with the permission named, never hidden. Unreadable → left ENABLED with a
   * note, because the server is what refuses and disabling on a failed check denies
   * access on the strength of a network error.
   */
  const grantAccess = useCan("members.grant");
  const writeDenied = grantAccess.denied;

  /**
   * ⚠ **`tier === "workspace"` IS INV-9's MECHANISM.** Not a blocklist of `platform.`
   * prefixes — the catalogue already carries the tier, and filtering on the thing the
   * server declares is the version that stays true when a permission is renamed.
   *
   * ⚠ **BANDED BY THE PRESET THAT FIRST CARRIES EACH ONE, not one list of 38.** The
   * presets are built by union, so the flat list threw that away and asked a person to
   * hold `admin ⊇ approver ⊇ author` in their head while reading 38 checkboxes. The
   * banding is derived from the SERVER's `catalogue.presets` — see `groupByPreset`,
   * which also explains why the bands are a partition rather than a filter.
   *
   * ⚠ **Each band is collapsed until somebody opens it**, and the head keeps the count,
   * so the closed drawer answers *"nineteen here, twelve held"* per band rather than
   * showing nothing. See `PermissionBand` for why the body unmounts rather than hiding.
   */
  const groups = useMemo(() => groupByPreset(catalogue.data, "workspace"), [catalogue.data]);

  const explicit: Set<string> = useMemo(() => {
    const set = new Set<string>();
    if (!member) return set;
    for (const g of grants.data ?? []) if (g.subject === member.subject) set.add(g.capability);
    return set;
  }, [grants.data, member]);

  const roleCapsArr: string[] = member ? presetPermissions(catalogue.data, member.role) : [];
  const roleCaps = new Set<string>(roleCapsArr);
  // The effective set: role preset plus any grant added here. A grant only ever adds.
  const effective: string[] = [...new Set<string>([...roleCapsArr, ...explicit])];

  const hasChange = member !== null && pendingRole !== null && pendingRole !== member.role;
  const previewRole: WorkspaceRole = pendingRole ?? member?.role ?? "author";
  const previewTo: string[] = [
    ...new Set<string>([...presetPermissions(catalogue.data, previewRole), ...explicit]),
  ];
  const diff = permissionDiff(effective, previewTo);

  // Until the grants read resolves (or when it fails), only the role bundle is
  // shown — never a silent "no grants".
  const grantsReady = !!grants.data && !grants.error;

  const isLastAdmin =
    member?.role === "admin" && members.filter((m) => m.role === "admin").length === 1;

  const close = () => {
    setPendingRole(null);
    setSavedMsg(null);
    onClose();
  };

  const toggleGrant = async (c: string) => {
    if (!member || roleCaps.has(c) || !grantsReady || grantBusy !== null) return;
    const revoking = explicit.has(c);
    setGrantBusy(c);
    setSavedMsg(null);
    try {
      if (revoking) await revokeMemberCapability(workspaceId, member.subject, c);
      else await grantMemberCapability(workspaceId, member.subject, c);
      grants.reload();
    } catch (e) {
      toast.error(
        `Could not ${revoking ? "revoke" : "grant"} ${labelFor(catalogue.data, c)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setGrantBusy(null);
    }
  };

  const commit = async () => {
    if (!member || !pendingRole || pendingRole === member.role) return;
    // The role is the only thing saved here — explicit grants are written the
    // moment their checkbox is toggled and are untouched by this write.
    setBusy(true);
    try {
      await grantMember(workspaceId, { subject: member.subject, email: member.email, role: pendingRole });
      const g = diff.granted.length;
      const r = diff.removed.length;
      setSavedMsg(
        `Saved role ${roleLabel(pendingRole)} for ${member.email}. Granted ${g}. Removed ${r}. ${member.email} sees the change on their next navigation.`,
      );
      setPendingRole(null);
      onChanged();
    } catch (e) {
      toast.error(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!member) return null;

  return (
    <Drawer
      open
      onClose={close}
      title={member.email}
      subtitle={
        // ⚠ `data-testid` on a span of its own, because "admin" is also an <option> in
        // the role select three feet below — a bare `getByText("admin")` finds two nodes
        // and fails in a way that reads as the subtitle not rendering.
        <span data-testid="member-drawer-role">
          {roleLabel(member.role)}
          {member.grantedBy === "bootstrap" && <span className="ml-2">claimed</span>}
        </span>
      }
      footer={
        <div className="space-y-2">
          <Button className="w-full" disabled={!hasChange || busy || writeDenied} onClick={commit}>
            Save role changes
          </Button>
          {isLastAdmin && hasChange && pendingRole !== "admin" && (
            <p className="text-xs text-warn" data-testid="last-admin-warning">
              This is the workspace’s last admin — demoting them would leave it unrecoverable. Promote
              another admin first.
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || writeDenied}
            onClick={async () => {
              try {
                await revokeMember(workspaceId, member.subject);
                close();
                onChanged();
              } catch (e) {
                toast.error(`Could not remove: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            Remove from workspace
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-muted">
          A capability is the member&apos;s role bundle plus any grant added here. A grant only ever
          adds.{" "}
          {/* ⚠ The bound, stated rather than implied. A custom role is a union member too, and
              this list does not read them — so it must not be presented as the complete
              effective set. Custom roles are given and taken away under Advanced on the Roles page. */}
          Any custom role they also hold adds to this and is managed on the Roles tab.
        </p>

        {writeDenied && (
          <p className="text-xs text-warn" data-testid="members-write-denied">
            {missingPermissionCopy("members.grant", "change anything here")}
          </p>
        )}
        {grantAccess.unreadable && (
          <p className="text-xs text-warn" data-testid="members-write-unreadable">
            {unreadableCopy()}
          </p>
        )}

        {grants.error && (
          <Notice tone="warn" title="Granted capabilities could not be read">
            Granted capabilities could not be read, so only the role bundle is shown — the check did
            not run.{grants.error ? ` (${grants.error})` : ""}
          </Notice>
        )}
        {/*
          ⚠ **THE LIST COMES FROM THE SERVER'S CATALOGUE**, not from a six-entry
          client constant. If the catalogue could not be read this renders nothing
          and says so — never an empty checkbox list, which would read as
          "this workspace has no permissions".
        */}
        {catalogue.error && (
          <Notice tone="warn" title="The permission catalogue could not be read">
            The list of permissions could not be read, so none are shown — the check did not run.
            This is not a statement that there are none.
          </Notice>
        )}

        <div className="space-y-5" data-testid="member-permissions">
          {groups.map((group) => {
            // Held, in THIS band. The count is the thing somebody is actually checking,
            // and it is readable without reading every row under it.
            const held = group.permissions.filter((c) => roleCaps.has(c) || explicit.has(c)).length;
            return (
              <PermissionBand
                key={group.key}
                bandKey={group.key}
                label={group.label}
                hint={group.hint}
                summary={`${held} of ${group.permissions.length}`}
              >
                <div className="space-y-3">
                  {group.permissions.map((c) => {
                    const locked = roleCaps.has(c);
                    const checked = locked || explicit.has(c);
                    const disabled = locked || !grantsReady || grantBusy !== null || writeDenied;
                    return (
                      <div key={c}>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-line"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleGrant(c)}
                            aria-label={labelFor(catalogue.data, c)}
                          />
                          <span>{labelFor(catalogue.data, c)}</span>
                        </label>
                        {locked && (
                          <p className="ml-6 mt-0.5 text-xs text-muted">
                            Comes with this member&apos;s role. Changing the role is what removes it.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </PermissionBand>
            );
          })}
        </div>

        {/* Role — the only thing Save writes */}
        <div className="border-t border-line pt-4">
          <label className="text-xs font-medium text-muted" htmlFor="member-role">
            Role
          </label>
          <select
            id="member-role"
            aria-label="Role"
            disabled={writeDenied}
            className="mt-1 h-9 w-full rounded-md border border-line bg-bg px-2 text-sm disabled:opacity-60"
            value={pendingRole ?? member.role}
            onChange={(e) => {
              setPendingRole(e.target.value as WorkspaceRole);
              setSavedMsg(null);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">
            Saving writes the member&apos;s role only. Grants checked above are saved the moment they
            are checked.
          </p>
        </div>

        {/* Impact preview */}
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          {!hasChange && !savedMsg ? (
            <>
              <p className="text-sm font-medium">No change yet</p>
              <p className="mt-1 text-xs text-muted">
                {member.email} keeps the role they have. Choose a different role to preview its
                effect.
              </p>
            </>
          ) : savedMsg ? (
            <p className="text-sm text-text">{savedMsg}</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="font-medium text-text">Permissions granted</p>
                  <p className="text-muted">
                    {diff.granted.length
                      ? diff.granted.map((c) => labelFor(catalogue.data, c)).join(", ")
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-text">Permissions removed</p>
                  <p className="text-muted">
                    {diff.removed.length
                      ? diff.removed.map((c) => labelFor(catalogue.data, c)).join(", ")
                      : "—"}
                  </p>
                </div>
              </div>
              {/*
                ⚠ "Nav sections gained/lost" and "Controls unlocked/locked" USED TO BE
                HERE and are deliberately gone. They came from `CAP_NAV` and
                `CAP_CONTROLS` in the deleted `lib/capabilities.ts` — client-side
                claims about what a permission unlocks, which the server never made
                and which went stale silently every time a route's permission changed.
                This says less and all of it is true.
              */}
              <p className="text-xs text-muted">
                Named permissions, not counts. This is what the server will answer for them after
                the change; what each one unlocks is decided by the server, route by route.
              </p>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
