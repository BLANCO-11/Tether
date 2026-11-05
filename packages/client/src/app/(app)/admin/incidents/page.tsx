// src/app/(app)/admin/incidents/page.tsx — real incident list, create and status transitions.
"use client";

import { useState } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { DataTable } from "@/components/ui/DataTable";
import { StatusPill } from "@/components/ui/Badge";
import { RowMenu } from "@/components/ui/RowMenu";
import { Modal } from "@/components/ui/Modal";
import { Field, Input } from "@/components/ui/Field";
import { Choice } from "@/components/ui/Choice";
import { useAsync } from "@/lib/hooks";
import { listIncidents, createIncident, transitionIncident } from "@/lib/api";
import { fmtWhen } from "@/lib/stats";
import type { FAIncident, FAIncidentSeverity, FAIncidentStatus } from "@/lib/foundry-client";
import { AdminGate, ADMIN_EYEBROW } from "@/components/admin/AdminGate";
import { Plus } from "@/components/ui/icons";

const TITLE = "Incidents";

const INCIDENT_STATUSES: FAIncidentStatus[] = [
  "reported",
  "triaged",
  "investigating",
  "contained",
  "recovering",
  "monitoring",
  "resolved",
  "post-incident-review",
  "closed",
];

const SEVERITIES: FAIncidentSeverity[] = ["sev1", "sev2", "sev3"];

const EMPTY_TITLE = "No incidents have been opened in this workspace.";

function severityTone(severity: FAIncidentSeverity): "danger" | "warn" | "neutral" {
  if (severity === "sev1") return "danger";
  if (severity === "sev2") return "warn";
  return "neutral";
}

function statusTone(status: FAIncidentStatus): "ok" | "warn" | "neutral" {
  if (status === "closed" || status === "resolved") return "ok";
  if (status === "contained" || status === "monitoring") return "warn";
  return "neutral";
}

export default function AdminIncidentsPage() {
  return (
    <AdminGate title={TITLE} needsWorkspace="incidents">
      {({ workspaceId }) => <IncidentsBody workspaceId={workspaceId!} />}
    </AdminGate>
  );
}

function IncidentsBody({ workspaceId }: { workspaceId: string }) {
  const incidents = useAsync(() => listIncidents(workspaceId), [workspaceId]);
  const [modalOpen, setModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows: FAIncident[] = incidents.data ?? [];

  async function transition(id: string, next: FAIncidentStatus) {
    setActionError(null);
    try {
      await transitionIncident(workspaceId, id, next);
      incidents.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Page measure="wide">
      <PageHeader
        eyebrow={ADMIN_EYEBROW}
        title={TITLE}
        purpose="Track, contain and review incidents — including emergency access."
        actions={[{ label: "Open incident", onClick: () => setModalOpen(true), icon: <Plus s={15} /> }]}
      />
      <Zone name="notices">
        {actionError && <Notice tone="danger" title="That did not go through">{actionError}</Notice>}
      </Zone>
      <Zone name="content">
        {!incidents.data && !incidents.error ? (
          <div className="pane p-4"><Skeleton rows={4} /></div>
        ) : incidents.error ? (
          <Notice tone="warn" title="Could not load incidents">
            The incident list could not be read, so this is not “no incidents” — the check did not run.{" "}
            {incidents.error}
          </Notice>
        ) : rows.length === 0 ? (
          <EmptyState title={EMPTY_TITLE} />
        ) : (
          <DataTable
            set="incident"
            caption="Incidents in this workspace"
            heads={{
              identity: "Incident",
              meaning: "Title",
              state: "Severity · Status",
              time: "Opened",
              subject: "Owner",
              actions: "Actions",
            }}
            empty={EMPTY_TITLE}
            rows={rows.map((incident) => ({
              key: incident.id,
              cells: {
                identity: <span className="font-mono text-xs">{incident.id}</span>,
                meaning: <span className="min-w-0 truncate">{incident.title}</span>,
                state: (
                  <span className="flex flex-wrap items-center gap-1">
                    <StatusPill status={severityTone(incident.severity)}>{incident.severity}</StatusPill>
                    <StatusPill status={statusTone(incident.status)}>{incident.status}</StatusPill>
                  </span>
                ),
                time: <span className="text-xs text-muted">{fmtWhen(incident.openedAt, Date.now())}</span>,
                subject: <span className="text-xs text-muted">{incident.ownerSubject ?? "—"}</span>,
                actions: (
                  <RowMenu
                    actions={INCIDENT_STATUSES.filter((s) => s !== incident.status).map((s) => ({
                      label: s,
                      onClick: () => void transition(incident.id, s),
                    }))}
                  />
                ),
              },
            }))}
          />
        )}
      </Zone>
      <Zone name="related">
        <p className="text-xs text-muted">
          Nothing is paused yet — containment is your next decision. Opening an incident does not imply anything was
          automatically contained.
        </p>
      </Zone>
      {modalOpen && (
        <CreateIncidentModal
          workspaceId={workspaceId}
          openCount={rows.filter((i) => i.status !== "closed").length}
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            incidents.reload();
          }}
        />
      )}
    </Page>
  );
}

function CreateIncidentModal({
  workspaceId,
  openCount,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  openCount: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const [incidentId, setIncidentId] = useState(`INC-${yyyy}-${mm}-${String(openCount + 1).padStart(4, "0")}`);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<FAIncidentSeverity>("sev2");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || !incidentId.trim() || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      await createIncident(workspaceId, { id: incidentId.trim(), title: title.trim(), severity });
      onCreated();
    } catch (e) {
      // 409 is the expected refusal once 5 incidents are open — the server's
      // words say that, so they are rendered verbatim.
      setFormError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Open incident">
      <div className="space-y-4">
        <Field label="Title" hint="What happened, in one line.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Unusual HRIS access" />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-text">Severity</span>
          {SEVERITIES.map((s) => (
            <Choice
              key={s}
              selected={severity === s}
              onClick={() => setSeverity(s)}
              title={s}
              body={s === "sev1" ? "Critical — core function down or data at risk." : s === "sev2" ? "Major — degraded or at-risk function." : "Minor — contained, track and review."}
            />
          ))}
        </div>
        <Field label="Incident ID" hint="Pre-filled from the date and the open count; edit it if you need to.">
          <Input value={incidentId} onChange={(e) => setIncidentId(e.target.value)} className="font-mono" />
        </Field>
        {formError && <p className="text-sm text-danger">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!title.trim() || !incidentId.trim() || saving}>
            {saving ? "Opening…" : "Open incident"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
