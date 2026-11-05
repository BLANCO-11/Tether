"use client";

import { useState } from "react";
import { endEmergencyAccess, listEmergencyAccess, setWorkspaceRestricted } from "@/lib/api";
import type { EmergencyAccess } from "@/lib/types";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Tag } from "@/components/ui/Badge";
import { Confirm } from "@/components/ui/Confirm";

/**
 * Restricted workspaces (phase 4), for the workspace's own people: whether it is restricted, the switch its admins use,
 * and every emergency access a super admin has opened here — an open one as a banner its admins (or its holder) can
 * end. The server decides who may do each; this shows what it answered.
 *
 * ⚠ Three states for the emergency list, as everywhere: accesses, none, and UNREADABLE — which says the check did not
 * run rather than "nobody has come in".
 */
export const RESTRICTED_EXPLAINED =
  "Only the people its admins add can get in. Platform admins and super admins see its name only; a super admin can get in only through emergency access, which is recorded here and ends on its own.";

export function RestrictionPanel({
  workspaceId,
  workspaceName,
  restricted,
  canChange,
  onChanged,
}: {
  workspaceId: string;
  workspaceName: string | null;
  restricted: boolean;
  /** `members.grant` not known denied. The server still refuses anyone who is not one of its own admins. */
  canChange: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const accesses = useAsync(() => listEmergencyAccess(workspaceId), [workspaceId]);
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const open = (accesses.data ?? []).filter((a) => a.open);
  const past = (accesses.data ?? []).filter((a) => !a.open).slice(0, 5);
  const name = workspaceName ?? "this workspace";

  const change = async (to: boolean) => {
    setBusy(true);
    try {
      await setWorkspaceRestricted(workspaceId, to);
      toast.success(to ? `"${name}" is restricted` : `"${name}" is no longer restricted`);
      onChanged();
    } catch (e) {
      toast.error(`Could not change it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const end = async (a: EmergencyAccess) => {
    try {
      await endEmergencyAccess(workspaceId, a.id);
      toast.success(`Ended ${a.email ?? a.subject}'s emergency access`);
      accesses.reload();
    } catch (e) {
      toast.error(`Could not end it: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section aria-label="Restriction" className="pane space-y-3 p-4">
      {open.map((a) => (
        <Notice key={a.id} tone="warn" title={`${a.email ?? a.subject} has emergency access until ${when(a.expiresAt)}`}>
          Reason given: {a.reason}{" "}
          <Button size="sm" variant="subtle" onClick={() => void end(a)}>
            End it now
          </Button>
        </Notice>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-body font-semibold">Who can get in</h2>
        {restricted ? <Tag>Restricted</Tag> : null}
      </div>
      <p className="text-caption text-muted">
        {restricted ? RESTRICTED_EXPLAINED : "Platform admins can see and manage this workspace's members, and super admins can get in."}
      </p>
      {canChange ? (
        <Button size="sm" variant={restricted ? "ghost" : "subtle"} disabled={busy} onClick={() => setConfirming(!restricted)}>
          {restricted ? "Open it up" : "Restrict this workspace"}
        </Button>
      ) : null}

      {accesses.error ? (
        <p className="text-caption text-warn">Emergency access could not be checked ({accesses.error}).</p>
      ) : past.length ? (
        <div>
          <h3 className="text-caption font-medium text-dim">Earlier emergency access</h3>
          <ul className="mt-1 space-y-1">
            {past.map((a) => (
              <li key={a.id} className="text-caption text-muted">
                {a.email ?? a.subject}, {when(a.startedAt)}
                {a.endedAt ? `, ended by ${a.endedBy ?? "someone"}` : ", expired"}. Reason: {a.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Confirm
        open={confirming !== null}
        title={confirming ? `Restrict "${name}"?` : `Open up "${name}"?`}
        body={
          confirming
            ? `${RESTRICTED_EXPLAINED} Its current members keep exactly what they have.`
            : "Platform admins will be able to see and manage its members again, and super admins will be able to get in without emergency access."
        }
        confirmLabel={confirming ? "Restrict it" : "Open it up"}
        onConfirm={() => void change(confirming === true)}
        onClose={() => setConfirming(null)}
      />
    </section>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
