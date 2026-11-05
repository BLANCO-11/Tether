"use client";

import Link from "next/link";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { approveFlowRevision, getFlowActivation, getFlowReadiness, getFlowRunAs, listMembers, rearmFlowApproval, requestFlowReview, revokeFlowApproval, runFlowLive, setFlowActivation, setFlowOwner, setFlowRunAs, setMyAccount, setFlowEditing, switchOffFlow, switchOnFlow, withdrawFlowReview } from "@/lib/api";
import type { FASelfEnable } from "@/lib/foundry-client";
import type { FlowActivation, FlowReadiness, FlowRunAs, FlowRunAsChoice } from "@/lib/foundry-client";
import { Confirm } from "@/components/ui/Confirm";
import { MoveDialog, placeKey } from "@/components/workspace/MoveDialog";
import { WherePill } from "@/components/workspace/WherePill";
import { runsAsSummary } from "@/lib/runs-as-summary";
import { listProjects } from "@/lib/api";
import { resolveWorkspaceId } from "@/lib/foundry-client";
import { roleLabel } from "@/lib/role-labels";
import type { WorkspaceMember } from "@/lib/types";
import { Modal } from "@/components/ui/Modal";
import { Field, Select } from "@/components/ui/Field";
import { describeCron } from "@/lib/cron";
import { fmtWhen, startOfDay } from "@/lib/stats";
import { isRunningUnattended, offReason } from "@/lib/flow-views";
import { useToast } from "@/lib/toast";
import { conditionText } from "@/components/pi-builder/PiDagCanvas";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { MainAside } from "@/components/layout/MainAside";
import { MetricTile, Sparkline } from "@/components/ui/MetricTile";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tag } from "@/components/ui/Badge";
import { Check, Code, Database, Fork, Pencil, RefreshCw, Wrench } from "@/components/ui/icons";
import { allSteps, kindOf, type PiStep, type PiWorkflow } from "@/lib/pi-builder";
import type { FlowSummary } from "@/lib/types";

type RunRow = { id: string; status: string; engineStatus: string | null; startedAt: string | null };

/**
 * The flow page for a Pi-built workflow (2026-10-10). Clicking one used to jump straight into the builder, because the
 * compiled-flow page reads a Kestra model a Pi bundle does not have. This is the overview a person expects first:
 * what it asks for, what each step does, how its runs went — with Edit as the way into the builder.
 *
 * Approving, turning off and running live (pi-runtime P5) act on Foundry's runner, never Kestra: approval binds to the
 * draft revision exactly as for a compiled flow, and Run now runs the APPROVED revision on production data.
 *
 * ── 2026-10-11 restyle (docs/design/README.md) ──────────────────────────────────────────────────────────────────
 *
 * ⚠ The header carries NO purpose line. `flow.description` is the builder prompt a person typed, verbatim — shown
 * under the title it read as a chat message pinned to the page, and "Built with Forge." in its place was filler. The
 * title, the Status tile and the steps say what the workflow is.
 *
 * ── 2026-10-26 ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Five compact tiles lead the page — Runs, Succeeded, Failed (each with a 7-day trend, the dashboard's MetricTile),
 * Last run, and Status. Status is a tag (Live / Changes pending / Draft / Turned off), not a control, plus the ONE
 * action the workflow is waiting for; it replaced the header's status pill (which read `flow.status` and could
 * disagree with the page) and the aside's status card. The aside is Run now (only while live), then Details.
 */
/** How a relative date input reads — the server's RELATIVE_DATES, worked out from the day the run starts. */
export const RELATIVE_WORDS: Record<string, string> = {
  today: "today",
  yesterday: "yesterday",
  this_week_start: "the start of this week",
  last_week_start: "the start of last week",
  last_week_end: "the end of last week",
  this_month_start: "the start of this month",
  last_month_start: "the start of last month",
  last_month_end: "the end of last month",
};

/** A run's outcome in plain words — a dot plus a word, never colour alone, never the engine's spelling. */
type Outcome = "succeeded" | "failed" | "waiting" | "running";
const OUTCOME: Record<Outcome, { label: string; dot: string }> = {
  succeeded: { label: "Succeeded", dot: "bg-ok" },
  failed: { label: "Failed", dot: "bg-danger" },
  waiting: { label: "Waiting for approval", dot: "bg-warn" },
  running: { label: "Running", dot: "live-dot bg-accent" },
};
export function outcomeOf(r: RunRow): Outcome {
  const s = (r.engineStatus ?? r.status).toLowerCase();
  if (s === "success" || s === "succeeded") return "succeeded";
  if (s === "failed" || s === "killed" || s === "cancelled" || s === "warning") return "failed";
  if (s === "paused") return "waiting";
  return "running";
}

export function PiFlowOverview({
  flow,
  workflow,
  runs,
  onRename,
  onChanged,
  access = { canChange: true, canManage: true, canChangeOwner: false },
  selfEnable = null,
}: {
  flow: FlowSummary;
  workflow: PiWorkflow | null;
  runs: RunRow[];
  onRename: (name: string) => Promise<void>;
  /** After approving or turning off: re-read the flow. */
  onChanged?: () => Promise<unknown> | void;
  /**
   * What the server says this person may do with it (rbac-observability). Without `canChange` there is no Edit and
   * no rename: an Observer, or a Creator looking at somebody else's published workflow, would only be refused.
   */
  access?: {
    canChange: boolean;
    /**
     * Manage it — who sees it, view-only, whose account, switch on/off, ask for approval (sharing-boundaries phase 2).
     * An editor of somebody's shared workflow has `canChange` and not this. Absent: the same as `canChange`.
     */
    canManage?: boolean;
    canChangeOwner: boolean;
  };
  /** Plugins phase 9: may this person switch the draft on themselves, and if not, why — the server's answer. */
  selfEnable?: FASelfEnable | null;
}) {
  const now = Date.now();
  const recent = [...runs].sort((a, b) => ((b.startedAt ?? "") > (a.startedAt ?? "") ? 1 : -1));
  const inputs = Object.entries(workflow?.inputs ?? {});
  const steps = workflow?.steps ?? [];
  const live = isRunningUnattended(flow);

  // ⚠ The rate divides by SETTLED runs (D-14): a run still going is not a failed one.
  const outcomes = runs.map(outcomeOf);
  const succeeded = outcomes.filter((o) => o === "succeeded").length;
  const failed = outcomes.filter((o) => o === "failed").length;
  const settled = succeeded + failed;
  const last = recent[0];
  const lastRun = last?.startedAt ? splitWhen(last.startedAt, now) : { value: "—", when: "" };
  const week = lastSevenDays(runs, now);
  // Whose account each connected service runs as (plugins 8.6) — read with the page, again after a change.
  const [runAs, setRunAs] = useState<FlowRunAs | null>(null);
  const [runAsError, setRunAsError] = useState<string | null>(null);
  const loadRunAs = () =>
    getFlowRunAs(flow.id)
      .then((r) => {
        setRunAs(r);
        setRunAsError(null);
      })
      .catch((e: Error) => setRunAsError(e.message));
  useEffect(() => {
    void loadRunAs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.id, flow.draftRevision, flow.armedRevision]);
  // "Turn on for me" (sharing-boundaries phase 3) — read with the page; a failure hides the card rather than guessing.
  const [activation, setActivation] = useState<FlowActivation | null>(null);
  useEffect(() => {
    getFlowActivation(flow.id)
      .then(setActivation)
      .catch(() => setActivation(null));
  }, [flow.id, flow.armedRevision]);
  // What it still needs before it can run, for this person (phase 4): the approved version when there is one.
  const [readiness, setReadiness] = useState<FlowReadiness | null>(null);
  const loadReadiness = () =>
    getFlowReadiness(flow.id, flow.armedRevision != null ? "approved" : "draft")
      .then(setReadiness)
      .catch(() => setReadiness(null));
  useEffect(() => {
    void loadReadiness();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.id, flow.draftRevision, flow.armedRevision]);
  // A newer version waiting for approval (P4-I1): what IT needs, beside what the running one needs — a reviewer about to
  // approve it must see what approving would leave unable to run.
  const waiting = flow.armedRevision != null && flow.draftRevision != null && flow.draftRevision !== flow.armedRevision;
  const [draftReadiness, setDraftReadiness] = useState<FlowReadiness | null>(null);
  useEffect(() => {
    if (!waiting) return setDraftReadiness(null);
    getFlowReadiness(flow.id, "draft")
      .then(setDraftReadiness)
      .catch(() => setDraftReadiness(null));
  }, [flow.id, flow.draftRevision, flow.armedRevision, waiting]);
  /** The approved version runs on each person's own account: there is no one schedule, only each person's. */
  const eachPerson = (runAs?.services ?? []).some((x) => x.approved?.each);
  const owner = flow.ownerName ?? "its owner";
  // Managing (who sees it, view-only, whose account, switch on/off, ask) — not the same as editing (phase 2).
  const manage = access.canManage ?? access.canChange;
  /** The approved version acts as a person's own account: anyone who runs it acts as them. */
  const actsAsPerson = (runAs?.services ?? []).filter((x) => x.approved?.personal).map((x) => `${owner}'s own ${x.service}`);
  /** The version waiting for approval would. */
  const draftActsAsPerson = (runAs?.services ?? []).filter((x) => x.current?.personal).map((x) => `${owner}'s own ${x.service} (“${x.current!.label}”)`);

  return (
    <Page>
      <PageHeader
        eyebrow="Workflow"
        title={flow.name}
        onRenameTitle={access.canChange ? onRename : undefined}
        badge={flow.version != null ? <Tag>v{flow.version}</Tag> : undefined}
        actions={
          access.canChange
            ? [{ label: "Edit workflow", href: `/flows/${flow.id}/builder`, variant: "ghost", icon: <Pencil s={14} /> }]
            : undefined
        }
      />
      <Zone name="content">
        <MainAside
          asideLabel="Workflow status"
          aside={
            <>
              {live && <RunCard flow={flow} workflow={workflow} actsAs={runAs?.owner ? [] : actsAsPerson} />}
              <section className="pane p-4" aria-labelledby="details-head">
                <h2 id="details-head" className="text-body font-semibold">Details</h2>
                <dl className="mt-3 space-y-2.5">
                  <Detail label="Runs on its own">
                    {workflow?.schedule?.cron
                      ? `${eachPerson ? "For each person who turns it on: " : ""}${describeCron(workflow.schedule.cron) ?? workflow.schedule.cron} (${workflow.schedule.timezone ?? "UTC"})`
                      : "No — on demand"}
                  </Detail>
                  <Detail label="Steps">{allSteps(steps).length}</Detail>
                  <Detail label="Asks for">{inputs.length ? `${inputs.length} value${inputs.length === 1 ? "" : "s"}` : "Nothing"}</Detail>
                  <Detail label="Built with">Forge</Detail>
                  <OwnerDetail flow={flow} canChangeOwner={access.canChangeOwner} onChanged={onChanged} />
                  <VisibilityDetail flow={flow} canManage={manage} canEdit={access.canChange} onChanged={onChanged} />
                  {/* Whose account it acts as, at a glance, in the three words (phase 6); the card below has the detail. */}
                  {runsAsSummary(runAs, owner) && <Detail label="Runs as">{runsAsSummary(runAs, owner)}</Detail>}
                </dl>
              </section>
              {readiness && !readiness.ready && <NeedsCard flowId={flow.id} readiness={readiness} onChanged={setReadiness} />}
              {draftReadiness && !draftReadiness.ready && (
                <NeedsCard flowId={flow.id} readiness={draftReadiness} onChanged={setDraftReadiness} title="The version waiting for approval needs" />
              )}
              {activation && (activation.available || activation.on) && (
                <ForMeCard flowId={flow.id} activation={activation} onChanged={setActivation} />
              )}
              {(runAsError || (runAs && runAs.services.length > 0)) && (
                <RunsAsCard
                  flowId={flow.id}
                  runAs={runAs}
                  error={runAsError}
                  owner={owner}
                  canChange={manage}
                  onChanged={async () => {
                    await loadRunAs();
                    await onChanged?.();
                  }}
                />
              )}
            </>
          }
        >
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
            <MetricTile
              size="sm"
              label="Runs"
              dot="bg-accent"
              value={String(runs.length)}
              href={runs.length ? "/history" : undefined}
              note={<span className="text-dim">{week.runs} in the last 7 days</span>}
              spark={<Sparkline size="sm" values={week.series.map((d) => d.runs)} stroke="text-accent" />}
            />
            <MetricTile
              size="sm"
              label="Succeeded"
              dot="bg-ok"
              value={settled ? `${Math.round((succeeded / settled) * 100)}%` : "—"}
              sub={settled ? `${succeeded} of ${settled}` : undefined}
              note={<span className="text-dim">{settled ? "of finished runs" : "no finished runs yet"}</span>}
              spark={<Sparkline size="sm" values={week.series.filter((d) => d.settled > 0).map((d) => d.succeeded / d.settled)} stroke="text-ok" />}
            />
            <MetricTile
              size="sm"
              label="Failed"
              dot="bg-danger"
              value={String(failed)}
              valueTone={failed ? "text-danger" : undefined}
              note={<span className="text-dim">{failed ? "see recent runs" : "nothing failed"}</span>}
              spark={<Sparkline size="sm" values={week.series.map((d) => d.failed)} stroke="text-danger" />}
            />
            <MetricTile
              size="sm"
              label="Last run"
              dot="bg-muted"
              value={last?.startedAt ? lastRun.value : "—"}
              note={<span className="text-dim">{last ? [lastRun.when, OUTCOME[outcomeOf(last)].label.toLowerCase()].filter(Boolean).join(" · ") : "never run"}</span>}
            />
            <StatusTile
              flow={flow}
              live={live}
              scheduled={!!workflow?.schedule?.cron}
              onChanged={onChanged}
              actsAs={draftActsAsPerson}
              canChange={manage}
              selfEnable={selfEnable}
            />
          </div>

          <section className="pane" aria-labelledby="how-head">
            <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
              <h2 id="how-head" className="text-body font-semibold">How it works</h2>
              {access.canChange && (
                <Link href={`/flows/${flow.id}/builder`} className="ml-auto text-caption text-accent hover:underline">
                  Open canvas
                </Link>
              )}
            </div>
            <div className="p-4">
              {workflow == null ? (
                <p className="text-caption text-muted">This workflow's steps could not be read.</p>
              ) : (
                <>
                  {inputs.length > 0 && (
                    <div className="mb-5">
                      <h3 className="text-caption uppercase tracking-[0.07em] text-dim">Asked before each run</h3>
                      <dl className="mt-2 divide-y divide-line rounded-md border border-line">
                        {inputs.map(([name, d]) => (
                          <div key={name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                            <dt className="font-mono text-caption text-text">{name}</dt>
                            <dd className="min-w-0 flex-1 text-caption text-muted">{d?.description || "—"}</dd>
                            <dd className="text-caption text-dim">
                              {d?.relative ? `defaults to ${RELATIVE_WORDS[d.relative] ?? d.relative}` : String(d?.type ?? "text")}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}
                  {steps.length === 0 ? <p className="text-caption text-muted">No steps yet.</p> : <StepTimeline nodes={steps} />}
                </>
              )}
            </div>
          </section>

          <section className="pane" aria-labelledby="runs-head">
            <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
              <h2 id="runs-head" className="text-body font-semibold">Recent runs</h2>
              {runs.length > 0 && (
                <Link href="/history" className="ml-auto text-caption text-accent hover:underline">History</Link>
              )}
            </div>
            {recent.length === 0 ? (
              <p className="px-4 py-3 text-caption text-muted">No runs yet. Test it from the builder.</p>
            ) : (
              <ul>
                {recent.slice(0, 6).map((r) => {
                  const o = OUTCOME[outcomeOf(r)];
                  return (
                    <li key={r.id} className="border-b border-line last:border-0">
                      <Link href={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${o.dot}`} aria-hidden />
                        <span className="min-w-0 flex-1 text-body text-text">{o.label}</span>
                        <span className="hidden font-mono text-caption text-dim sm:block" title={r.id}>{r.id.slice(0, 8)}</span>
                        <span className="w-28 shrink-0 text-right text-caption tabular-nums text-dim">
                          {r.startedAt ? fmtWhen(r.startedAt, now) : "not started"}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </MainAside>
      </Zone>
    </Page>
  );
}

/**
 * Who sees a workflow, in words, from WHERE IT LIVES (sharing-boundaries): My space — its owner (and Admins); a project
 * — its members; the Workspace — everyone here. Reviewers see one outside those once it is put in front of them.
 */
export function whoCanSee(flow: Pick<FlowSummary, "visibility" | "armedRevision" | "projectId">, projectName?: string | null): string {
  const reviewers = "Reviewers too, once approval is asked for or it is live.";
  if (flow.projectId) return `The members of ${projectName ? `“${projectName}”` : "its project"} and Admins. ${reviewers}`;
  // An older server sends no visibility; then approved meant shared with the workspace.
  const workspace = flow.visibility ? flow.visibility === "public" : flow.armedRevision != null;
  return workspace ? "Everyone in this workspace." : `Only its owner and Admins. ${reviewers}`;
}

/**
 * "Where it lives" — the one place that decides who sees it — and, while others see it, whether they may edit it.
 * Moving it is its manager's (owner or Admin), through the Move dialog that says first who would gain or lose sight of
 * it. An editor of somebody's shared workflow is told they can edit it and its owner manages it.
 */
function VisibilityDetail({
  flow,
  canManage,
  canEdit,
  onChanged,
}: {
  flow: FlowSummary;
  canManage: boolean;
  canEdit: boolean;
  onChanged?: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  // Others see it: the Workspace, or a project.
  const shared = flow.visibility === "public" || !!flow.projectId;
  // The project's name: sent with the list; read here only when it lives in one and the name did not come along.
  const [projectName, setProjectName] = useState<string | null>(flow.projectName ?? null);
  useEffect(() => {
    if (!flow.projectId || flow.projectName) return;
    let live = true;
    listProjects()
      .then((ps) => live && setProjectName(ps.find((p) => p.id === flow.projectId)?.name ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [flow.projectId, flow.projectName]);
  const toggleEditing = async () => {
    setBusy(true);
    try {
      await setFlowEditing(flow.id, !flow.othersMayEdit);
      toast.success(flow.othersMayEdit ? "View-only: only you and Admins edit it now." : "Others who see it and build workflows can edit it now.");
      await onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Detail label="Where it lives">
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <WherePill place={placeKey(flow)} projectName={projectName} />
          <span>{whoCanSee(flow, projectName)}</span>
          {canManage && (
            <button type="button" disabled={busy} onClick={() => setMoving(true)} className="text-caption text-accent hover:underline disabled:opacity-50">
              Move…
            </button>
          )}
        </span>
      </Detail>
      {shared && (
        <Detail label="Who can edit it">
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <span>{flow.othersMayEdit ? (flow.projectId ? "Anyone in the project who builds workflows" : "Anyone in this workspace who builds workflows") : "Only its owner and Admins (view-only for others)"}</span>
            {canManage ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void toggleEditing()}
                className="text-caption text-accent hover:underline disabled:opacity-50"
              >
                {flow.othersMayEdit ? "Make view-only" : "Let members edit"}
              </button>
            ) : canEdit ? (
              <span className="text-caption text-muted">You can edit it. Its owner manages it.</span>
            ) : null}
          </span>
        </Detail>
      )}
      <MoveDialog
        item={moving ? { kind: "flow", id: flow.id } : null}
        name={flow.name}
        current={placeKey(flow)}
        onClose={() => setMoving(false)}
        onMoved={async (_to, out, label) => {
          setMoving(false);
          toast.success(`Moved to ${label}.${out.turnedOff ? " It was switched off until a reviewer approves it." : ""}`);
          await onChanged?.();
        }}
      />
    </>
  );
}

/** The owner row of Details, with "Change" for an Admin. */
function OwnerDetail({
  flow,
  canChangeOwner,
  onChanged,
}: {
  flow: FlowSummary;
  canChangeOwner: boolean;
  onChanged?: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const owner = flow.ownerName ?? (flow.ownerSubject ? "A former member" : "No owner. Admins look after it.");
  return (
    <>
      <Detail label="Owner">
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <span>{owner}</span>
          {canChangeOwner && (
            <button type="button" onClick={() => setOpen(true)} className="text-caption text-accent hover:underline">
              Change
            </button>
          )}
        </span>
      </Detail>
      {canChangeOwner && (
        <OwnerDialog
          open={open}
          flow={flow}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await onChanged?.();
          }}
        />
      )}
    </>
  );
}

/** Pick the member who owns this workflow now. Observers are not offered: they may not change what they own. */
export function OwnerDialog({
  open,
  flow,
  onClose,
  onSaved,
}: {
  open: boolean;
  flow: Pick<FlowSummary, "id" | "name" | "ownerSubject">;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>(flow.ownerSubject ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let gone = false;
    setPicked(flow.ownerSubject ?? "");
    setError(null);
    (async () => {
      try {
        const list = await listMembers(await resolveWorkspaceId());
        if (!gone) setMembers(list.filter((m) => m.role !== "viewer"));
      } catch (e) {
        if (!gone) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      gone = true;
    };
  }, [open, flow.ownerSubject]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setFlowOwner(flow.id, picked || null);
      toast.success(picked ? "Owner changed." : "This workflow has no owner now.");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Change the owner of ${flow.name}`}>
      <div className="space-y-4">
        <p className="text-caption text-muted">
          The owner can edit, test and move it, and always sees it, even in their My space. The change is recorded in the audit
          history.
        </p>
        {loadError ? (
          <p role="alert" className="text-caption text-danger">The members could not be read: {loadError}</p>
        ) : members == null ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <Field label="Owner" hint="Observers are not listed: they cannot change a workflow.">
            <Select value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Owner">
              <option value="">Nobody (Admins look after it)</option>
              {members.map((m) => (
                <option key={m.subject} value={m.subject}>
                  {m.email} · {roleLabel(m.role)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {error && <p role="alert" className="text-caption text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => void save()}
            disabled={busy || members == null || (picked || null) === (flow.ownerSubject ?? null)}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The page while it loads: the same shape — a header, figures, the steps, the status cards — so nothing jumps. */
export function PiFlowOverviewSkeleton() {
  return (
    <Page>
      <Zone name="header" gap="none">
        <Skeleton rows={2} className="w-72" />
      </Zone>
      <Zone name="content">
        <MainAside
          asideLabel="Workflow status"
          aside={
            <>
              <div className="pane p-4"><Skeleton rows={3} /></div>
              <div className="pane p-4"><Skeleton rows={4} /></div>
            </>
          }
        >
          <div className="pane p-4"><Skeleton rows={2} /></div>
          <div className="pane p-4"><Skeleton rows={7} /></div>
        </MainAside>
      </Zone>
    </Page>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-caption text-dim">{label}</dt>
      <dd className="text-right text-caption text-text">{children}</dd>
    </div>
  );
}

/** "load_rows" → "Load rows": a step with no description still reads as words, with its id beneath. */
function humanise(id: string): string {
  const s = id.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : id;
}

/** What a node is, as a hue, a glyph and a word — the canvas's kind tokens, so the two pictures agree. */
function nodeLook(s: PiStep): { colour: string; Icon: (p: { s?: number }) => JSX.Element; word: string } {
  const k = kindOf(s);
  if (k === "loop") return { colour: "var(--k-loop)", Icon: RefreshCw, word: "For each" };
  if (k === "branch") return { colour: "var(--path)", Icon: Fork, word: "Choice" };
  if (k === "approval") return { colour: "var(--k-approval)", Icon: Check, word: "Approval" };
  const uses = s.uses ?? [];
  if (uses.some((u) => u.startsWith("tool:"))) return { colour: "var(--k-tool)", Icon: Wrench, word: "Action" };
  if (uses.some((u) => u.startsWith("read:"))) return { colour: "var(--k-datasource)", Icon: Database, word: "Reads" };
  return { colour: "var(--k-code)", Icon: Code, word: "Works out" };
}

/** What a node says under its title — what it reaches, repeats over, chooses or waits for. */
function nodeLine(s: PiStep): string {
  const k = kindOf(s);
  if (k === "loop") return `Once for each ${s.as ?? "item"} in ${s.foreach} — one failing does not stop the rest`;
  if (k === "branch") return "Exactly one path runs";
  if (k === "approval") return "Nothing after this runs until someone approves";
  const reached = (s.uses ?? []).map((u) => u.replace(/^read:/, "reads ").replace(/^tool:/, "uses "));
  if (reached.length) return reached.join(" · ");
  return s.outputs?.length ? `produces ${s.outputs.join(", ")}` : "produces nothing declared";
}

/**
 * The workflow as a vertical timeline: one marker per node in its kind's hue, loops and choices with what they contain
 * indented on their own rail. Colour is never the only carrier — the kind's word is beside every marker.
 */
function StepTimeline({ nodes, depth = 0 }: { nodes: PiStep[]; depth?: number }) {
  return (
    <ol className={depth ? "mt-3 space-y-4 border-l border-line pl-4" : "relative space-y-4"}>
      {nodes.map((s, i) => {
        const look = nodeLook(s);
        const k = kindOf(s);
        const title = k === "approval" ? s.approval?.title || humanise(s.id) : s.description || humanise(s.id);
        return (
          <li key={s.id} className="relative flex gap-3" style={{ "--kc": look.colour } as CSSProperties}>
            {/* The rail between top-level markers. */}
            {depth === 0 && i < nodes.length - 1 && <span className="absolute left-[13px] top-8 bottom-[-16px] w-px bg-line" aria-hidden />}
            <span className="relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--kc)_16%,var(--surface))] text-[var(--kc)]">
              <look.Icon s={14} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-body text-text">{title}</span>
                <span className="text-caption text-[var(--kc)]">{look.word}</span>
              </div>
              <div className="mt-0.5 text-caption text-muted">{nodeLine(s)}</div>
              {(s.description || k === "approval") && <div className="mt-0.5 font-mono text-[11px] text-dim">{s.id}</div>}
              {s.allow_empty?.length ? (
                <div className="mt-1 text-[11px] text-dim">
                  May be empty: {s.allow_empty.map((a) => `${a.field ? `${a.output}.${a.field}` : a.output} (${a.reason})`).join("; ")}
                </div>
              ) : null}
              {k === "loop" && s.steps?.length ? <StepTimeline nodes={s.steps} depth={depth + 1} /> : null}
              {k === "branch" &&
                (s.branch ?? []).map((arm, j) => (
                  <div key={j} className="mt-3">
                    <div className="text-caption text-muted">
                      <span className="text-[var(--path)]">{arm.else ? "Otherwise" : j === 0 ? "If" : "Else if"}</span>{" "}
                      {arm.else ? null : <span className="font-mono text-text">{conditionText(arm.if)}</span>}
                    </div>
                    {arm.steps?.length ? (
                      <StepTimeline nodes={arm.steps} depth={depth + 1} />
                    ) : (
                      <p className="mt-1 border-l border-line pl-4 text-[11px] text-dim">nothing</p>
                    )}
                  </div>
                ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Where the workflow stands — a tag, not a control (its sentence, incl. a stale reason, is the tag's tooltip) — and the
 * ONE action it is waiting for. Approval is the server's
 * to allow — an approver role, the revision — and a refusal reaches the person as the server's own sentence.
 *
 * Four states: Live; Live with a newer draft ("Changes pending" — the approved version keeps running until the new one
 * is approved); Draft (never approved); Turned off (by a person, or by the staleness sweep, whose reason is shown).
 */
type StatusState = "live" | "pending" | "draft" | "off";
const STATUS_TAG: Record<StatusState, { label: string; cls: string }> = {
  live: { label: "Live", cls: "bg-ok-bg text-ok" },
  pending: { label: "Changes pending", cls: "bg-warn-bg text-warn" },
  draft: { label: "Draft", cls: "border border-line-2 bg-surface-2 text-muted" },
  off: { label: "Turned off", cls: "bg-danger-bg text-danger" },
};

function StatusTile({
  flow,
  live,
  scheduled,
  onChanged,
  actsAs = [],
  canChange = false,
  selfEnable = null,
}: {
  flow: FlowSummary;
  live: boolean;
  scheduled: boolean;
  onChanged?: () => Promise<unknown> | void;
  /** The version to approve acts as a person's own account (8.6): approving says so first. */
  actsAs?: string[];
  /** This person may change the workflow (its owner, or an Admin): they switch it off themselves. */
  canChange?: boolean;
  /** Plugins phase 9: whether this person may switch the draft on themselves, and why not. */
  selfEnable?: FASelfEnable | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const newer = flow.armedRevision == null || flow.draftRevision !== flow.armedRevision;
  const off = offReason(flow);
  const act = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(said);
      await onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Its owner switches on a draft that uses only their own things; anything of the workspace's goes to a reviewer.
  const ownSwitch = selfEnable?.youMay === true;
  const doApprove = () =>
    void (ownSwitch
      ? act(() => switchOnFlow(flow.id, flow.draftRevision), "Switched on — this version now runs for real.")
      : act(() => approveFlowRevision(flow.id, flow.draftRevision), "Approved — this version can now run for real."));
  const approve = () => (actsAs.length ? setConfirming(true) : doApprove());
  // A version its owner switched on comes back on the same way; one a reviewer approved, through the reviewer's route.
  const turnBackOn = () =>
    flow.selfEnabled && selfEnable?.allowed && flow.armedRevision != null && canChange
      ? switchOnFlow(flow.id, flow.armedRevision)
      : rearmFlowApproval(flow.id);
  const turnOff = () => (canChange ? switchOffFlow(flow.id) : revokeFlowApproval(flow.id, "Turned off from the workflow's page."));
  // Why a reviewer approves it, for its owner — the server's words, from what the draft uses.
  const needsReviewer =
    canChange && selfEnable && !selfEnable.youMay && (newer || off?.kind === "stale")
      ? selfEnable.allowed
        ? selfEnable.needsReviewerFor.length
          ? `A reviewer approves it: it ${selfEnable.needsReviewerFor.join("; ")}.`
          : null
        : "In this workspace a reviewer approves every workflow."
      : null;
  const v = flow.version != null ? `v${flow.version}` : "the approved version";
  // Its owner cannot approve their own work: they ask a reviewer, which is also what lets a reviewer see a private
  // workflow (sharing-boundaries). Somebody else — a reviewer, an Admin — approves.
  const asks = flow.mine === true && !ownSwitch;
  const asked = flow.reviewRequestedRevision != null;

  const state: StatusState = live ? (newer ? "pending" : "live") : off ? "off" : "draft";
  let said: string;
  if (state === "live") said = `Runs for real, ${scheduled ? "on its schedule" : "on demand"}.`;
  else if (state === "pending") said = `${v} is live. Your edits need approval.`;
  else if (off?.kind === "stale") said = off.text;
  else if (off) said = "Nothing runs unattended.";
  else said = ownSwitch ? "Runs only as a test until you switch it on." : "Runs only as a test until approved.";
  const tag = STATUS_TAG[state];

  return (
    <MetricTile size="sm" label="Status">
      <span data-testid="flow-status-tag" title={said} className={`mt-1.5 inline-flex w-max cursor-default select-none items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption font-medium ${tag.cls}`}>
        <span className={`h-1.5 w-1.5 rounded-full bg-current ${state === "live" ? "live-dot" : ""}`} aria-hidden />
        {tag.label}
      </span>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
        {off?.kind === "turned_off" && !newer ? (
          <Button size="xs" disabled={busy} onClick={() => void act(turnBackOn, "Turned back on.")}>
            Turn back on
          </Button>
        ) : (newer || off?.kind === "stale") && asks ? (
          asked ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(() => withdrawFlowReview(flow.id), "Request withdrawn.")}>
              Withdraw request
            </Button>
          ) : (
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void act(() => requestFlowReview(flow.id, flow.draftRevision), "Asked. Reviewers can now see it and approve it.")}
            >
              Ask for approval
            </Button>
          )
        ) : newer || off?.kind === "stale" ? (
          <Button size="xs" disabled={busy} onClick={approve}>
            {ownSwitch ? (state === "pending" ? "Switch on changes" : "Switch on") : state === "pending" ? "Approve changes" : "Approve"}
          </Button>
        ) : null}
        {state === "live" && (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(turnOff, "Turned off — it no longer runs for real.")}
          >
            Turn off
          </Button>
        )}
      </div>
      {asks && asked && (newer || off?.kind === "stale") ? (
        <p className="mt-1.5 text-caption text-muted">Approval asked for. Reviewers can see it until they approve it or you withdraw.</p>
      ) : (
        needsReviewer && <p className="mt-1.5 text-caption text-muted">{needsReviewer}</p>
      )}
      <Confirm
        open={confirming}
        title={ownSwitch ? "Switch it on?" : "Approve it?"}
        body={`This version acts as ${actsAs.join(" and ")}. When it runs — on demand, or on a schedule or trigger — it acts as that account.`}
        confirmLabel={ownSwitch ? "Switch on" : "Approve"}
        onConfirm={doApprove}
        onClose={() => setConfirming(false)}
      />
    </MetricTile>
  );
}

/** "14:06 today" → the time as the figure and the day beneath it; an older run shows its date alone. */
function splitWhen(iso: string, now: number): { value: string; when: string } {
  const w = fmtWhen(iso, now);
  if (w.endsWith(" today")) return { value: w.slice(0, -" today".length), when: "today" };
  if (w.startsWith("Yesterday ")) return { value: w.slice("Yesterday ".length), when: "yesterday" };
  return { value: w, when: "" };
}

/** This workflow's runs per day over the last 7 days, oldest first — the tiles' trend lines. */
const DAY = 86_400_000;
function lastSevenDays(runs: RunRow[], now: number) {
  const first = startOfDay(now) - 6 * DAY;
  const series = Array.from({ length: 7 }, () => ({ runs: 0, succeeded: 0, failed: 0, settled: 0 }));
  for (const r of runs) {
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (!(t >= first)) continue;
    const day = series[Math.min(6, Math.round((startOfDay(t) - first) / DAY))]!;
    day.runs += 1;
    const o = outcomeOf(r);
    if (o === "succeeded") day.succeeded += 1;
    if (o === "failed") day.failed += 1;
    if (o === "succeeded" || o === "failed") day.settled += 1;
  }
  return { series, runs: series.reduce((n, d) => n + d.runs, 0) };
}

/** Run the approved version now, on production data — the card exists only while the workflow is live. */
function RunCard({ flow, workflow, actsAs = [] }: { flow: FlowSummary; workflow: PiWorkflow | null; actsAs?: string[] }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const declared = Object.entries(workflow?.inputs ?? {});
  const newer = flow.draftRevision !== flow.armedRevision;
  const [values, setValues] = useState<Record<string, string>>(() =>
    // A date relative to the run day is left blank: the server works it out ("last week's start"). Its `default` is
    // the TEST data's date — prefilled here, a real run would read the test period.
    Object.fromEntries(declared.map(([k, d]) => [k, d?.relative ? "" : d?.default !== undefined ? String(d.default) : ""])),
  );
  const typed = (): Record<string, string | number | boolean> =>
    Object.fromEntries(
      declared
        .filter(([k]) => values[k] !== "")
        .map(([k, d]) => {
          const v = values[k]!;
          const t = String(d?.type ?? "string");
          return [k, t === "integer" || t === "number" ? Number(v) : t === "boolean" ? v === "true" : v];
        }),
    );
  return (
    <section className="pane p-4" aria-labelledby="run-head">
      <h2 id="run-head" className="text-body font-semibold">Run it now</h2>
      <p className="mt-1 text-caption text-dim">Reads production data and delivers its messages.</p>
      {actsAs.length > 0 && (
        <p className="mt-2 rounded-md bg-warn/10 px-2.5 py-1.5 text-caption text-warn" role="note">
          It acts as {actsAs.join(" and ")}: running it uses that person&apos;s account.
        </p>
      )}
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          runFlowLive(flow.id, typed())
            .then((id) => router.push(`/runs/${id}`))
            .catch((err: Error) => {
              toast.error(err.message);
              setBusy(false);
            });
        }}
      >
        {declared.map(([k, d]) => (
          <label key={k} className="block">
            <span className="text-caption text-muted">{d?.description || k}</span>
            <input
              value={values[k] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
              aria-label={k}
              placeholder={d?.relative ? `blank = ${RELATIVE_WORDS[d.relative] ?? d.relative}` : undefined}
              className="mt-1 h-8 w-full rounded-md border border-line bg-bg px-2.5 text-body text-text transition-colors focus:border-accent focus:outline-none"
            />
          </label>
        ))}
        {/* The primary when nothing is waiting to be approved; quiet beside an Approve, so one primary per view. */}
        <Button type="submit" size="sm" variant={newer ? "subtle" : "primary"} disabled={busy} className="w-full">
          Run now — for real
        </Button>
      </form>
    </section>
  );
}

/**
 * "Before it can run" (sharing-boundaries phase 4): each thing the workflow still needs, in the server's words, with who
 * fixes it and where. A choice between this person's own accounts is made right here.
 */
function NeedsCard({ flowId, readiness, onChanged, title = "Before it can run" }: { flowId: string; readiness: FlowReadiness; onChanged: (r: FlowReadiness) => void; title?: string }) {
  const toast = useToast();
  const headId = useId();
  return (
    <section className="pane p-4" aria-labelledby={headId}>
      <h2 id={headId} className="text-body font-semibold">{title}</h2>
      <ul className="mt-2 space-y-3">
        {readiness.needs.map((n, i) => (
          <li key={`${n.cause}-${n.piece ?? n.service}-${i}`} className="text-caption">
            <p className="text-text">{n.message}</p>
            <p className="mt-0.5 text-dim">
              Who fixes it: {n.fixBy}
              {n.href && (
                <>
                  {" · "}
                  <Link href={n.href} className="underline">Go there</Link>
                </>
              )}
            </p>
            {n.cause === "choose_account" && n.piece && (
              <Select
                aria-label={`Your ${n.service} account`}
                className="mt-1"
                value=""
                onChange={async (e) => {
                  try {
                    onChanged(await setMyAccount(flowId, n.piece!, e.target.value));
                    toast.success(`Your runs use that ${n.service} account.`);
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
              >
                <option value="">Choose…</option>
                {(n.options ?? []).map((o) => (
                  <option key={o.connectionId} value={o.connectionId}>{o.label}</option>
                ))}
              </Select>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Turn on for me" (sharing-boundaries phase 3): a shared workflow that runs on each person's own account, run for this
 * person on its schedule, as them. Paused — and said so — when a newer version was approved since they turned it on.
 */
/** Plain schedules a person may pick for their own copy (P3-I4) — words, never a cron box. "" is the workflow's own. */
export const MY_SCHEDULES: ReadonlyArray<{ cron: string; label: string }> = [
  { cron: "0 9 * * *", label: "Every day at 9:00" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 9:00" },
  { cron: "0 9 * * 1", label: "Mondays at 9:00" },
  { cron: "0 9 1 * *", label: "The 1st of each month at 9:00" },
];

function ForMeCard({ flowId, activation, onChanged }: { flowId: string; activation: FlowActivation; onChanged: (a: FlowActivation) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const when = activation.mine ?? activation.schedule;
  // Their own time, in their own timezone; "" keeps the workflow's schedule.
  const [pick, setPick] = useState<string>(activation.mine?.cron ?? "");
  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const set = async (on: boolean, cron: string = pick) => {
    setBusy(true);
    try {
      onChanged(await setFlowActivation(flowId, on ? { on, cron: cron || null, timezone: cron ? timezone : null } : { on }));
      toast.success(on ? "On for you. It runs on your own account." : "Off for you.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pane p-4" aria-labelledby="forme-head">
      <h2 id="forme-head" className="text-body font-semibold">For you</h2>
      <p className="mt-0.5 text-caption text-dim">
        It runs on each person&apos;s own account. Turn it on to have it run for you
        {when ? `, ${describeCron(when.cron) ?? when.cron} (${when.timezone})` : ""}. What your runs do is seen only by you and Admins.
      </p>
      {activation.paused && (
        <p className="mt-2 text-caption text-warn" role="note">{activation.paused}</p>
      )}
      {activation.available && (
        <Field label="When it runs for you">
          <Select
            aria-label="When it runs for you"
            value={pick}
            disabled={busy}
            onChange={(e) => {
              setPick(e.target.value);
              // Already on: the new time applies now.
              if (activation.on && !activation.paused) void set(true, e.target.value);
            }}
          >
            <option value="">{activation.schedule ? `Its schedule: ${describeCron(activation.schedule.cron) ?? activation.schedule.cron} (${activation.schedule.timezone})` : "Its schedule"}</option>
            {MY_SCHEDULES.map((o) => (
              <option key={o.cron} value={o.cron}>
                {o.label} ({timezone})
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="mt-3">
        {!activation.on ? (
          <Button size="sm" disabled={busy || !activation.available} onClick={() => void set(true)}>Turn on for me</Button>
        ) : activation.paused && activation.available ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void set(true)}>Turn on again</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void set(false)}>Turn off</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {!activation.paused && <span className="text-caption text-text">On for you</span>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void set(false)}>Turn off for me</Button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * "Runs as" (plugins 8.6): per connected service, whose account the workflow uses. The owner may change it — to the
 * workspace's connection or their own — which makes a new version to approve; nobody else is offered their account.
 */
function RunsAsCard({
  flowId,
  runAs,
  error,
  owner,
  canChange,
  onChanged,
}: {
  flowId: string;
  runAs: FlowRunAs | null;
  error: string | null;
  owner: string;
  canChange: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const whose = (c: FlowRunAsChoice) =>
    c.each
      ? "each person's own account"
      : c.own
        ? runAs?.owner
          ? "your own account"
          : `${owner}'s own account`
        : c.personal
          ? `${owner}'s own “${c.label}”`
          : `the workspace's “${c.label}”`;
  // "each" stands for the Each-person choice, which has no connection of its own.
  const keyOf = (c: FlowRunAsChoice | null | undefined) => (c?.each ? "each" : (c?.connectionId ?? ""));
  return (
    <section className="pane p-4" aria-labelledby="runas-head">
      <h2 id="runas-head" className="text-body font-semibold">Runs as</h2>
      <p className="mt-0.5 text-caption text-dim">Whose account it uses in each connected service.</p>
      {error && <p className="mt-2 text-caption text-danger">Could not read this: {error}</p>}
      <dl className="mt-3 space-y-3">
        {(runAs?.services ?? []).map((x) => {
          const changed = runAs?.approved && x.approved && x.current && keyOf(x.approved) !== keyOf(x.current);
          return (
            <div key={x.piece}>
              <dt className="text-caption text-dim">{x.service}</dt>
              <dd className="mt-0.5 text-body text-text">
                {canChange && runAs?.owner && x.options.length > 1 ? (
                  <Select
                    aria-label={`${x.service} runs as`}
                    value={keyOf(x.current)}
                    disabled={!!busy}
                    onChange={async (e) => {
                      setBusy(x.piece);
                      try {
                        await setFlowRunAs(flowId, x.piece, e.target.value);
                        toast.success("Changed. Approve this version for live runs to use it.");
                        await onChanged();
                      } catch (err) {
                        toast.error((err as Error).message);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {!x.current && <option value="">Choose…</option>}
                    {x.options.map((o) => (
                      <option key={keyOf(o)} value={keyOf(o)}>
                        {o.each ? "Each person's own account" : o.personal ? `Your own “${o.label}”` : `The workspace's “${o.label}”`}
                      </option>
                    ))}
                  </Select>
                ) : x.current ? (
                  whose(x.current)
                ) : (
                  <span className="text-muted">Not chosen yet — the builder asks before it runs.</span>
                )}
              </dd>
              {changed && (
                <p className="mt-1 text-caption text-dim">
                  The approved version runs as {whose(x.approved!)}; this change needs approving.
                </p>
              )}
              {x.current?.each && (
                <p className="mt-1 text-caption text-dim" role="note">
                  Whoever runs it uses their own {x.service}; anyone who has not connected one is asked to first. What a run did
                  is seen only by the person who ran it and Admins. It cannot run on a schedule or a trigger: there is nobody to act as.
                </p>
              )}
              {x.current?.personal && !x.current.each && runAs?.shared && (
                <p className="mt-1 text-caption text-dim" role="note">
                  Because it uses {owner}&apos;s own {x.service}, others can view it but not edit it.
                </p>
              )}
              {/* My space (sharing-boundaries Q3): nobody else enters it, so there is no choice to make. */}
              {runAs?.mySpace && (
                <p className="mt-1 text-caption text-dim" role="note">
                  It is in My space, so it always uses {runAs.owner ? "your" : `${owner}'s`} own {x.service}. Move it to a project or the Workspace to
                  use the workspace&apos;s {x.service}, or each person&apos;s own.
                </p>
              )}
              {x.approved?.personal && runAs?.approved && (
                <p className="mt-1 text-caption text-warn" role="note">
                  Whenever it runs, on demand or on its schedule or triggers, it acts as {owner}&apos;s own {x.service}.
                </p>
              )}
            </div>
          );
        })}
      </dl>
    </section>
  );
}
