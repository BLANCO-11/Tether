"use client";

// Individual permissions for one member of one workspace — the Advanced half of the Roles page (admin simplify,
// phase 6). Choosing a member opens `MemberDrawer`, which holds every rule about per-person grants; this only chooses
// whom. The caller wraps it in a `PermissionsProvider` for the same workspace, so the drawer's gates answer for it.

import { useState } from "react";
import { Select } from "@/components/ui/Field";
import { MemberDrawer } from "@/components/admin/MemberDrawer";
import { useAsync } from "@/lib/hooks";
import { listMembers } from "@/lib/api";
import { roleLabel } from "@/lib/role-labels";

export function IndividualPermissions({ workspaceId }: { workspaceId: string }) {
  const members = useAsync(() => listMembers(workspaceId), [workspaceId]);
  const [open, setOpen] = useState<string | null>(null);
  const list = members.data ?? [];
  const member = list.find((m) => m.subject === open) ?? null;

  if (members.error) return <p className="text-caption text-warn">The members could not be read. ({members.error})</p>;
  if (!members.data) return <p className="text-caption text-muted">Reading members…</p>;
  if (list.length === 0) return <p className="text-caption text-muted">Nobody is in this workspace yet.</p>;
  return (
    <>
      <Select value="" onChange={(e) => setOpen(e.target.value || null)} aria-label="Individual permissions for" className="w-72">
        <option value="">Choose a member…</option>
        {list.map((m) => (
          <option key={m.subject} value={m.subject}>{`${m.email || m.subject} · ${roleLabel(m.role)}`}</option>
        ))}
      </Select>
      <MemberDrawer
        workspaceId={workspaceId}
        member={member}
        members={list}
        onClose={() => setOpen(null)}
        onChanged={members.reload}
      />
    </>
  );
}
