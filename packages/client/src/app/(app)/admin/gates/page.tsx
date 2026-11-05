// src/app/(app)/admin/gates/page.tsx — Admin → Release gates, honest read plus enable/disable.
"use client";

import { useState } from "react";
import { useAsync } from "@/lib/hooks";
import { listReleaseGates, setReleaseGateEnabled } from "@/lib/api";
import type { FAReleaseGate } from "@/lib/foundry-client";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/ui/Confirm";
import { DataTable } from "@/components/ui/DataTable";
import { StatusPill } from "@/components/ui/Badge";
import { AdminGate, ADMIN_EYEBROW } from "@/components/admin/AdminGate";

const TITLE = "Release gates";
const EMPTY_TITLE = "No release gates configured.";

export default function AdminGatesPage() {
  return (
    <AdminGate title={TITLE} needsWorkspace="release gates">
      {({ workspaceId }) => <GatesBody workspaceId={workspaceId!} />}
    </AdminGate>
  );
}

function GatesBody({ workspaceId }: { workspaceId: string }) {
  const gates = useAsync(() => listReleaseGates(workspaceId), [workspaceId]);
  const [confirmGate, setConfirmGate] = useState<FAReleaseGate | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows: FAReleaseGate[] = gates.data ?? [];

  async function toggle(gate: FAReleaseGate) {
    setActionError(null);
    try {
      await setReleaseGateEnabled(workspaceId, gate.id, !gate.enabled);
      setConfirmGate(null);
      gates.reload();
    } catch (e) {
      setConfirmGate(null);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Page measure="wide">
      <PageHeader eyebrow={ADMIN_EYEBROW} title={TITLE} purpose="What must be true before a workflow can be approved." />
      <Zone name="notices">
        {actionError && <Notice tone="danger" title="That did not go through">{actionError}</Notice>}
      </Zone>
      <Zone name="content">
        {!gates.data && !gates.error ? (
          <div className="pane p-4"><Skeleton rows={4} /></div>
        ) : gates.error ? (
          <Notice tone="warn" title="Could not load gates">
            The gate list could not be read, so this is not “no gates configured” — the check did not run.{" "}
            {gates.error}
          </Notice>
        ) : rows.length === 0 ? (
          <EmptyState title={EMPTY_TITLE} />
        ) : (
          <DataTable
            set="gate"
            caption="Release gates in this workspace"
            heads={{
              identity: "Gate",
              meaning: "Satisfied by",
              state: "Enforcement",
              actions: "Actions",
            }}
            empty={EMPTY_TITLE}
            rows={rows.map((g) => ({
              key: g.id,
              cells: {
                identity: <span className="font-medium">{g.name}</span>,
                meaning: <span className="text-xs text-muted">{g.satisfiedBy}</span>,
                state: (
                  <StatusPill status={g.enabled ? "ok" : "neutral"}>
                    {g.enabled ? "enforced" : "not enforced"}
                  </StatusPill>
                ),
                actions: (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmGate(g)}>
                    {g.enabled ? "Turn off" : "Turn on"}
                  </Button>
                ),
              },
            }))}
          />
        )}
      </Zone>
      <Confirm
        open={!!confirmGate}
        title={confirmGate ? `${confirmGate.enabled ? "Turn off" : "Turn on"} ${confirmGate.name}?` : "Change gate?"}
        body={
          confirmGate?.enabled
            ? "Publishing will no longer be blocked by this gate."
            : "Publishing will be blocked until this gate is satisfied."
        }
        confirmLabel={confirmGate?.enabled ? "Turn off" : "Turn on"}
        onConfirm={() => confirmGate && void toggle(confirmGate)}
        onClose={() => setConfirmGate(null)}
      />
    </Page>
  );
}
