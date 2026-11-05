// src/app/(app)/runs/[id]/page.tsx — S-21 Live execution trace + S-33 Run detail failure (dual-state)
// S-21: measure wide, header Live execution trace + Running chip, TraceList + Scenario
// S-33: measure page, header CONTRACTOR TIMESHEET CHASE / RUN-2026-08-08-0714 + Failed chip, FigureStrip + Canvas replay on .dot-grid
// Keeps existing run read (openFlowStream) else honest empty — pack verbatim where data exists.
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { openFlowStream, isLive } from "@/lib/flow-stream";
import { fmtDuration } from "@/lib/stats";
import type { FlowExecutionDetail, StepRun } from "@/lib/types";
import { Page, Zone } from "@/components/layout/Page";
import { MainAside } from "@/components/layout/MainAside";
import { PageHeader, type HeaderAction } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { StatusPill } from "@/components/ui/Badge";
import { FigureStrip, type StripFigure } from "@/components/ui/FigureStrip";
import { TraceList, ScenarioPanel, MockCaveat } from "@/components/flow/TraceList";
import { RunOutput } from "@/components/flow/RunOutput";
import { StepEvidence } from "@/components/flow/StepEvidence";
import { ToolActivity } from "@/components/flow/ToolActivity";

/**
 * ⚠ SIX `PACK_*` CONSTANTS WERE DELETED FROM HERE, AND WHAT THEY DID IS WORTH
 * KNOWING BEFORE ANYTHING LIKE THEM COMES BACK (`UXI-032`).
 *
 * The failed branch below used to begin `if (isFailed)` and then **discard
 * `run.steps` entirely**, rendering instead a fixed ten-step story: a
 * contractor-timesheet chase failing at step 4 with
 * `Connection timeout after 30000ms — leave-db-prod.internal:5432`, beside
 * figures ("78 of 142 employees"), an audit trail, and run facts including
 * `Duration: 3m 37s`. The eyebrow fell back to `"Contractor timesheet chase"`.
 *
 * So **any** failed run of **any** flow told the same invented story, with a
 * plausible hostname and a plausible timeout — on the one screen a person opens
 * *because* something broke. It is the most misleading surface this audit found:
 * every other fabrication wastes trust, this one sends somebody to debug a
 * database that is not theirs.
 *
 * `StepRun` carries everything needed to tell the truth — `error` ("the field
 * the whole step-detail panel exists to show"), `status`, `ref`, `kind`,
 * `attempt`, `durationMs`, `request`, `responseCode`, `readFrom`, `logs`. Where
 * a field is null the answer is to render nothing, never to fill it in.
 */

/** Which database this run's steps actually read (Stage 4), off `readFrom`. */
function readLabel(steps: StepRun[]): string {
  const read = steps.map((s) => s.readFrom).filter((v): v is "sandbox" | "production" => v != null);
  if (read.length === 0) return "Nothing";
  return read.includes("production") ? "Production" : "Sandbox";
}

/** One evidence row, rendered only when there is a value. An absent field draws nothing. */
function EvidenceRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono text-text">{value}</dd>
    </div>
  );
}

/** One run fact. ⚠ Renders "Not recorded" rather than a plausible-looking value. */
function FactRow({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-dim">{label}</dt>
      <dd className={value ? (mono ? "font-mono text-text" : "text-text") : "text-dim"}>
        {value ?? "Not recorded"}
      </dd>
    </div>
  );
}

function SafetyBadge({ value }: { value: "real" | "masked" }) {
  const cls = value === "real" ? "border-danger-line bg-danger-bg text-danger" : "border-line bg-surface-2 text-muted";
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${cls}`}>{value}</span>;
}

function ReplayRow({
  n,
  title,
  line,
  ran,
  failed,
  selected,
  onSelect,
}: {
  n: number;
  title: string;
  line: string;
  ran: boolean;
  failed?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const isNever = !ran;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border bg-surface p-4 text-left transition ${isNever ? "border-dashed border-line" : failed ? "border-danger-line" : "border-line"} ${selected ? "ring-1 ring-accent" : ""}`}
      aria-selected={selected}
    >
      <div className="flex gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs font-medium ${failed ? "bg-danger text-white" : isNever ? "bg-surface-2 text-muted" : "bg-ok text-white"}`}
          aria-hidden
        >
          {failed ? "\u2717" : isNever ? "\u00b7" : "\u2713"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-caption text-dim">{n}</span>
            <span className="text-sm font-medium text-text">{title}</span>
          </div>
          <p className={`mt-1 text-xs ${failed ? "font-mono text-danger" : isNever ? "text-dim" : "text-muted"}`}>{line}</p>
        </div>
      </div>
    </button>
  );
}

// The id comes from `useParams()`, not a `params` prop — see `flows/[id]/page.tsx` for why.
export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const technical = searchParams.get("technical") === "1";
  const [run, setRun] = useState<FlowExecutionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const stream = openFlowStream(id, {
      onUpdate: (next) => {
        setRun(next);
        setError(null);
      },
      onError: setError,
      onTransport: () => {},
    });
    return () => stream.close();
  }, [id]);

  const live = useMemo(() => (run ? isLive(run.engineStatus) : false), [run]);

  if (error && !run) {
    return (
      <Page measure="page">
        <PageHeader eyebrow="Runs" title="Run" purpose="This run could not be read." />
        <Zone name="notices">
          <Notice tone="danger" title="Could not load this run">{error}</Notice>
        </Zone>
      </Page>
    );
  }

  if (!run) {
    return (
      <Page measure="page">
        <PageHeader eyebrow="Runs" title="Run" purpose="Loading…" />
      </Page>
    );
  }

  // ⚠ It used another person's own account (sharing-boundaries D4): the server sent its status and nothing it did. Say
  // so, rather than draw an empty run that looks broken.
  if (run.dataHidden) {
    const ended = run.engineStatus === "success" ? "Succeeded" : run.engineStatus === "failed" ? "Failed" : live ? "Running" : "Ended";
    return (
      <Page measure="page">
        <PageHeader
          eyebrow="Runs"
          title={run.flowNameSnapshot ?? run.flowName ?? "Run"}
          badge={<StatusPill status={run.engineStatus === "success" ? "ok" : run.engineStatus === "failed" ? "danger" : "neutral"}>{ended}</StatusPill>}
          purpose={run.durationMs != null ? `Took ${fmtDuration(run.durationMs)}` : undefined}
        />
        <Zone name="notices">
          <Notice tone="info" title="This run used someone's own account">
            It ran on the account of the person who started it. You can see that it ran and how it ended; only they and Admins
            can see what it read and sent.
          </Notice>
        </Zone>
      </Page>
    );
  }

  const isFailed = !live && (run.engineStatus === "failed" || run.engineStatus === "warning" || run.steps.some((s) => s.status === "failed" || s.status === "warning"));
  const isTestRun = run.flowName == null || (run.status?.toLowerCase().includes("test") ?? false) || run.id.toLowerCase().includes("test");
  // Per step where the engine says, and for the whole run when it was started with the production opt-in (a runner
  // step does not record which database it read).
  const isRealData = run.usedProductionData === true || run.steps.some((s) => s.readFrom === "production");

  if (isFailed) {
    // The step that actually failed — the run's own record, not a guess. A run
    // can fail with no failed step (the engine gave up before one ran), and that
    // is a different sentence, so it is not rounded into one.
    const failedStep = run.steps.find((st) => st.status === "failed" || st.status === "warning") ?? null;
    const ordinalOf = (sid: string) => run.steps.findIndex((st) => st.stepId === sid) + 1;
    const labelOf = (st: StepRun) => st.ref ?? st.stepId;
    const cause =
      failedStep?.error ??
      run.engineUnavailable ??
      "This run did not complete. No step recorded a reason, so there is nothing further to show.";
    const noticeTitle = failedStep
      ? `Failed at step ${ordinalOf(failedStep.stepId)} · ${labelOf(failedStep)}`
      : "This run did not complete";
    // ⚠ Only figures the run actually carries. A count nobody recorded is left
    // out, never rendered as 0 — "0 emails sent" and "nobody counted the emails"
    // are different claims and only one of them is true here.
    const ran = run.steps.filter((st) => st.status !== "created" && st.status !== "skipped").length;
    const figures: StripFigure[] = [
      { value: `${ran} of ${run.steps.length}`, label: "Steps that ran" },
      ...(run.durationMs != null ? [{ value: fmtDuration(run.durationMs), label: "Duration" }] : []),
      ...(failedStep && failedStep.attempt > 1
        ? [{ value: String(failedStep.attempt), label: "Attempts on the failed step" }]
        : []),
      { value: readLabel(run.steps), label: "Read from" },
    ];
    // Until a person picks one, the evidence shown is the failed step's — the one they opened the page for.
    const shown = selected ?? (failedStep ? ordinalOf(failedStep.stepId) : null);
    const selectedStep = shown != null ? run.steps[shown - 1] ?? null : null;
    const eyebrow = (run.flowName ?? "Run").toUpperCase();
    const title = run.id;
    const actions = [
      { label: "Technical detail", href: `/runs/${run.id}?technical=1`, variant: "ghost" },
    ] as const;
    return (
      <Page measure="page">
        <PageHeader eyebrow={eyebrow} title={title} badge={<StatusPill status="danger">Failed</StatusPill>} purpose={cause} actions={actions as unknown as [HeaderAction]} />
        <Zone name="notices">
          <Notice tone="danger" title={noticeTitle}>{cause}</Notice>
          {error && <Notice tone="warn" title="Live updates hit a problem">{error}</Notice>}
          {run.engineUnavailable && <Notice tone="warn" title="The engine could not be reached">{run.engineUnavailable}</Notice>}
          {isTestRun && <Notice tone="info" title="This was a test run on a draft.">This was a test run on a draft.</Notice>}
        </Zone>
        <Zone name="content">
          <FigureStrip items={figures} />
          <section className="rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold text-text">Canvas replay</h2>
              <span className="text-xs text-dim">Select a step for its retained evidence</span>
            </div>
            <div className="dot-grid rounded-b-lg p-4">
              {run.steps.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line bg-surface px-4 py-6 text-center text-sm text-muted">
                  This run has no retained step evidence, so there is nothing to replay.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {run.steps.map((st, i) => (
                    <ReplayRow
                      key={st.stepId}
                      n={i + 1}
                      title={labelOf(st)}
                      line={
                        st.status === "failed" || st.status === "warning"
                          ? st.error ?? "Failed, and recorded no reason."
                          : st.status === "created" || st.status === "skipped"
                            ? st.status === "skipped" ? "Not run — an earlier step failed" : "Never started"
                            : st.durationMs != null
                              ? fmtDuration(st.durationMs)
                              : ""
                      }
                      ran={st.status !== "created" && st.status !== "skipped"}
                      failed={st.status === "failed" || st.status === "warning"}
                      selected={shown === i + 1}
                      onSelect={() => setSelected(i + 1)}
                    />
                  ))}
                </div>
              )}
              {selectedStep && (
                <div className="mt-4 rounded-lg border border-line bg-surface p-4">
                  <h3 className="text-sm font-medium text-text">
                    Step {shown} evidence · {labelOf(selectedStep)}
                  </h3>
                  <dl className="mt-2 space-y-1 text-xs">
                    <EvidenceRow label="Status" value={selectedStep.status} />
                    <EvidenceRow label="Kind" value={selectedStep.kind} />
                    <EvidenceRow label="Attempt" value={selectedStep.attempt > 1 ? String(selectedStep.attempt) : null} />
                    <EvidenceRow label="Duration" value={selectedStep.durationMs != null ? fmtDuration(selectedStep.durationMs) : null} />
                    <EvidenceRow label="Read from" value={selectedStep.readFrom} />
                    <EvidenceRow label="Response" value={selectedStep.responseCode != null ? String(selectedStep.responseCode) : null} />
                  </dl>
                  {!selectedStep.error && (selectedStep.status === "created" || selectedStep.status === "skipped") && (
                    <p className="mt-2 text-xs text-dim">
                      {selectedStep.status === "skipped" ? "Not run — an earlier step failed." : "This step never started."}
                    </p>
                  )}
                  <div className="mt-3">
                    <StepEvidence step={selectedStep} />
                  </div>
                </div>
              )}
            </div>
          </section>
        </Zone>
        <Zone name="related">
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-body font-semibold text-text">Run facts</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <FactRow label="Started" value={run.startedAt} />
                <FactRow label="Stopped" value={run.endedAt} />
                <FactRow label="Duration" value={run.durationMs != null ? fmtDuration(run.durationMs) : null} mono />
                <FactRow label="Engine status" value={run.engineStatus} />
                <FactRow label="Foundry status" value={run.status} />
                {run.replayOfId && <FactRow label="Replay of" value={run.replayOfId} mono />}
              </dl>
              {technical && (
                <div className="mt-4 space-y-3">
                  {failedStep?.request ? (
                    <details className="rounded-lg border border-line bg-surface-2 p-3" open>
                      <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-text">
                        <span>Request that failed</span>
                        <SafetyBadge value="masked" />
                      </summary>
                      <pre className="mt-2 overflow-auto rounded bg-surface p-3 font-mono text-xs text-text">
                        {`${failedStep.request.method} ${failedStep.request.uri}`}
                      </pre>
                    </details>
                  ) : (
                    <p className="text-xs text-dim">No request was retained for the failed step.</p>
                  )}
                </div>
              )}
              {failedStep?.output && (
                <div className="mt-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-label text-muted">Retained step output</h3>
                  <RunOutput output={failedStep.output} />
                </div>
              )}
            </section>
            <section className="rounded-lg border border-line bg-surface p-4">
              <details open={technical} className="group">
                <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold text-text">
                  <span>Step logs · for operators</span>
                  <span className="text-muted group-open:rotate-180">▾</span>
                </summary>
                {failedStep && failedStep.logs.length > 0 ? (
                  <ul className="mt-3 space-y-2 text-xs text-muted">
                    {failedStep.logs.map((l, i) => (
                      <li key={i} className="flex gap-2">
                        <span aria-hidden>·</span>
                        <span className="font-mono">{l.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-dim">No logs were retained for this run.</p>
                )}
              </details>
            </section>
          </div>
          {/* ⚠ The only independent evidence that a tool actually fired, scoped
              to this run. `StepDetail` deliberately shows no labelled row for
              it — this record, with labels, is the one rendering. */}
          <div className="mt-4">
            <ToolActivity runId={run.id} />
          </div>
        </Zone>
      </Page>
    );
  }

  if (!live && run.steps.length === 0) {
    const eyebrow = (run.flowName ?? "Run").toUpperCase();
    const actions: HeaderAction[] = [{ label: "Technical detail", href: `/runs/${run.id}?technical=1`, variant: "ghost" }];
    return (
      <Page measure="page">
        <PageHeader eyebrow={eyebrow} title={run.id} badge={<StatusPill status={run.engineStatus === "success" ? "ok" : "neutral"}>{run.engineStatus === "success" ? "Succeeded" : run.engineStatus ?? "Unknown"}</StatusPill>} purpose={`Run ${run.id}`} actions={actions as unknown as [HeaderAction]} />
        <Zone name="notices">
          {isTestRun && <Notice tone="info" title="This was a test run on a draft.">This was a test run on a draft.</Notice>}
          {error && <Notice tone="warn" title="Live updates hit a problem">{error}</Notice>}
        </Zone>
        <Zone name="content">
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">This run has no retained step evidence.</p>
        </Zone>
      </Page>
    );
  }

  // ⚠ Was the literal "TEST RUN · DRAFT V4" for every run on every flow. The
  // run knows its own name; the draft-version half is not on the execution at
  // all, so it is not printed rather than guessed.
  const s21Eyebrow = isTestRun
    ? `TEST RUN \u00b7 ${(run.flowName ?? "DRAFT").toUpperCase()}`
    : (run.flowName ?? "RUN").toUpperCase();
  const s21StatusLabel = live ? "Running" : run.engineStatus === "success" ? "Succeeded" : run.engineStatus === "failed" ? "Failed" : "Stopped";
  const s21BadgeNode = (
    <span data-testid="s21-status-chip" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${live ? "bg-accent-bg-2 text-accent" : run.engineStatus === "success" ? "bg-ok-bg text-ok" : "bg-danger-bg text-danger"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-accent animate-pulse" : run.engineStatus === "success" ? "bg-ok" : "bg-danger"}`} />
      {s21StatusLabel}
    </span>
  );
  /**
   * ⚠ THERE IS NO "Stop test" BUTTON, AND ITS ABSENCE IS DELIBERATE.
   *
   * It used to be `{ label: "Stop test", onClick: () => {}, variant: "danger" }`
   * — a red, primary-looking control on a RUNNING run that did nothing, so a
   * person believed they had halted a run against real data. There is no
   * cancel-execution method in `lib/foundry-client.ts` and no route behind one,
   * so the honest options were to build the backend or to remove the control,
   * and a UI pass does not half-build a backend to fill a card.
   *
   * ⚠ Do not restore it until `POST …/flow-executions/:id/cancel` exists.
   */
  const s21Action: HeaderAction | null = live
    ? null
    : run.engineStatus === "success"
      ? { label: "View results", href: `/runs/${run.id}` }
      : { label: "Run again", href: `/runs/${run.id}` };

  return (
    <Page measure="wide">

      {/* this code line should be in the page header 
      for displaying the view result button 
      
      actions={s21Action ? [s21Action] : undefined}*/}
      <PageHeader eyebrow={s21Eyebrow} title="Live execution trace" badge={s21BadgeNode} purpose="Every step reports what came in, what it did and what came out."  />
      <Zone name="notices" gap="tight">
        {isRealData && <Notice tone="danger" title="This run read production data">A draft run read the tenant\u2019s real database. Anything this flow sends downstream to a model or an external endpoint carried those rows.</Notice>}
        {run.autoTest && <Notice tone="info" title="Automatic test">The builder ran this on its own after a build turn, on test data with the workflow's default inputs.</Notice>}
        {isTestRun && !live && <Notice tone="info" title="This was a test run on a draft.">This was a test run on a draft.</Notice>}
        {error && <Notice tone="warn" title="Live updates hit a problem">{error}</Notice>}
        {run.engineUnavailable && <Notice tone="warn" title="The engine could not be reached">{run.engineUnavailable}</Notice>}
      </Zone>
      <Zone name="content">
        {/* ⚠ The trace + scenario split is `MainAside`, not a page-local grid:
            one shape, one width — a second template is how the bespoke grids
            came back. */}
        <MainAside asideLabel="Scenario" asideWidth="360px" aside={
          <>
            <ScenarioPanel steps={run.steps} inputs={run.inputs} />
            {/* ⚠ Only over a run that actually read fixtures. Over a production
                run this text is not a caveat, it is a false statement about
                where the rows came from. */}
            {run.steps.some((st) => st.readFrom === "sandbox") &&
              !run.steps.some((st) => st.readFrom === "production") && <MockCaveat />}
          </>
        }>
          <div>
            <TraceList steps={run.steps} live={live} />
            {live && <p className="mt-2 text-xs text-dim">Trace advances live</p>}
          </div>
        </MainAside>
      </Zone>
      <Zone name="related">
        {run.steps.some((s) => s.output || s.input || s.logs.length > 0) && (
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-text">Step by step</h2>
            <p className="text-xs text-dim">What each step was given, what it returned — as a table when tabular — and what it printed.</p>
            <div className="space-y-6">
              {run.steps
                .filter((s) => s.output || s.input || s.logs.length > 0)
                .map((st) => {
                  const idx = run.steps.findIndex((x) => x.stepId === st.stepId) + 1;
                  const title = `Step ${idx} · ${st.ref ?? st.stepId} · ${st.status}`;
                  return (
                    <div key={st.stepId} className="space-y-1.5">
                      <h3 className="text-xs font-medium text-muted">{title}</h3>
                      <StepEvidence step={st} />
                    </div>
                  );
                })}
            </div>
          </section>
        )}
        <ToolActivity runId={run.id} />
      </Zone>
      {!live && run.steps.length === 0 && (
        <Zone name="related">
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">This run has no retained step evidence.</p>
        </Zone>
      )}
    </Page>
  );
}
