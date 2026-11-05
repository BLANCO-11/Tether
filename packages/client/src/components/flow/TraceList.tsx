// src/components/flow/TraceList.tsx — S-21 Live execution trace list.
// Pack verbatim: status square (tick/pulsing/failed/ordinal), label, outcome, mono duration.
// Measure wide, two-column handled by caller (MainAside); this is the left pane only.
"use client";

import type { StepRun } from "@/lib/types";
import { fmtDuration } from "@/lib/stats";

type Props = {
  steps: StepRun[];
  // When true, header shows live qualifier and pulsing marks are animated.
  live?: boolean;
};

/**
 * The step's own label, and there is deliberately no fallback table.
 *
 * ⚠ This function used to substitute `FLAGSHIP_LABELS[ordinal]` whenever
 * `stepId.length > 20` — i.e. for any UUID — so a real run rendered ANOTHER
 * workflow's step names as its own (`UXI-024`). Two sibling tables did the same
 * for outcomes and durations, supplying "4,812 swipe records read for 142
 * employees" to a step that reported nothing.
 *
 * A step's real label is its `ref` (the tool or named query it calls, joined
 * server-side from the revision the execution actually ran) and its `stepId`
 * otherwise. **Never invent one.** A step nobody can name renders as its id,
 * which is ugly and true.
 */
function labelFor(step: StepRun): string {
  return step.ref ?? step.stepId;
}

function outcomeFor(step: StepRun): string | null {
  // Running/paused/created have no outcome per S-21.
  if (step.status === "running" || step.status === "paused" || step.status === "created") return null;
  if (step.status === "failed") {
    // Business language failure outcome — first line of error, not row count.
    if (step.error) return step.error.split("\n")[0] ?? null;
    return null;
  }
  // For success/warning/cancelled/skipped, prefer output business summary via error/log, else generic outcome.
  // Do not invent row counts — use whatever the step already reports.
  if (step.output) {
    const body = step.output.body;
    if (typeof body === "string" && body !== "[redacted]" && body.length > 0) {
      try {
        const parsed = JSON.parse(body) as { results?: unknown[]; succeeded?: number };
        if (typeof parsed.succeeded === "number") return null; // avoid bare count; handled above
      } catch {
        // fall through
      }
      // Show first 120 chars as outcome where it is business language
      if (body.length < 200) return body.slice(0, 120);
    }
    const value = step.output.value;
    if (typeof value === "string" && value.length > 0) return value.slice(0, 120);
  }
  return null;
}


function StatusSquare({ status, ordinal }: { status: StepRun["status"]; ordinal: number }) {
  if (status === "success" || status === "warning") {
    return (
      <span
        data-testid={`status-square-${ordinal}`}
        aria-label="done"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-ok bg-ok-bg text-xs text-ok"
      >
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        data-testid={`status-square-${ordinal}`}
        aria-label="failed"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-danger-line bg-danger-bg text-xs text-danger"
      >
        ✕
      </span>
    );
  }
  /**
   * ⚠ `paused` is its OWN mark, and it used to share `running`'s pulsing dot.
   *
   * A paused run is waiting on a person — gate 3's whole point is that somebody
   * is being asked something. Drawn as running, it is indistinguishable from a
   * run that is working, so nobody goes and answers it and the run sits there
   * holding an M3 slot. It also must not pulse: the pack's rule is that
   * animation means live activity, and a run waiting on a human is the opposite.
   */
  if (status === "paused") {
    return (
      <span
        data-testid={`status-square-${ordinal}`}
        aria-label="waiting for a person"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-warn-line bg-warn-bg text-xs text-warn"
      >
        ⏸
      </span>
    );
  }
  if (status === "running") {
    return (
      <span
        data-testid={`status-square-${ordinal}`}
        aria-label="running"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-accent-line bg-accent-bg text-accent"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      </span>
    );
  }
  // pending: cancelled, skipped, created, etc. — ordinal number
  return (
    <span
      data-testid={`status-square-${ordinal}`}
      aria-label="pending"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-2 text-xs text-muted"
    >
      {ordinal}
    </span>
  );
}


export function TraceList({ steps, live }: Props) {
  const total = steps.length;
  const completed = steps.filter((s) => s.status === "success" || s.status === "warning").length;

  if (steps.length === 0) {
    return (
      <section className="pane overflow-hidden" data-testid="trace-list">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-text">No steps recorded</h2>
        </div>
        <div className="px-4 py-6 text-sm text-muted">This run has no steps yet.</div>
      </section>
    );
  }

  return (
    <section className="pane overflow-hidden" data-testid="trace-list">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-text">
          {completed} of {total} steps complete
        </h2>
        <span className="text-xs text-dim">{live ? "Trace advances live" : "Trace advances live"}</span>
      </div>

      <div className="flex flex-col gap-2 p-2">
        {steps.map((step, idx) => {
          const ordinal = idx + 1;
          const isDone = step.status === "success" || step.status === "warning";
          const isRunning = step.status === "running" || step.status === "paused";
          const outcome = outcomeFor(step);
          // ⚠ No fallback. A step that reported no outcome renders none, and a
          // step with no duration renders none — the two tables that used to
          // fill those gaps filled them with another workflow's figures.
          const durationText = isDone && step.durationMs != null ? fmtDuration(step.durationMs) : null;

          // Business-language outcome: do not show duration for running/pending per spec.
          // Pending rows show ordinal in square, label only.
          if (step.status === "created" || step.status === "cancelled" || step.status === "skipped") {
            return (
              <div
                key={step.stepId}
                data-testid={`trace-row-${ordinal}`}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3"
              >
                <StatusSquare status={step.status} ordinal={ordinal} />
                <span className="text-sm text-text">{labelFor(step)}</span>
              </div>
            );
          }

          if (isRunning) {
            return (
              <div
                key={step.stepId}
                data-testid={`trace-row-${ordinal}`}
                className={`flex items-center gap-3 rounded-lg border bg-surface px-3 py-3 ${step.status === "paused" ? "border-warn-line" : "border-line"}`}
              >
                <StatusSquare status={step.status} ordinal={ordinal} />
                <span className="text-sm text-text">{labelFor(step)}</span>
                {step.status === "paused" && (
                  <span className="ml-auto shrink-0 text-xs text-warn" data-testid={`trace-paused-${ordinal}`}>
                    Waiting for a person
                  </span>
                )}
              </div>
            );
          }

          // done or failed
          return (
            <div
              key={step.stepId}
              data-testid={`trace-row-${ordinal}`}
              className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-3"
            >
              <StatusSquare status={step.status} ordinal={ordinal} />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${step.status === "failed" ? "text-danger" : "text-text"}`}>
                  {labelFor(step)}
                </p>
                {outcome && (
                  <p className="mt-0.5 text-xs text-dim" data-testid={`trace-outcome-${ordinal}`}>
                    {outcome}
                  </p>
                )}
              </div>
              {durationText && (
                <span className="shrink-0 font-mono text-xs text-muted" data-testid={`trace-duration-${ordinal}`}>
                  {durationText}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The run's own facts, and every one of them is read off the run.
 *
 * ⚠ This panel used to be four hardcoded rows — Source "Mock data", Population
 * "142 employees", Sending "Suppressed", Draft "v4" — rendered beside every run
 * on every flow (`UXI-024`). "Mock data" over a run that read production is the
 * worst of them: it is a safety claim, and it was false exactly when it
 * mattered.
 *
 * `readFrom` is the real answer and it is per STEP, so the panel reports what
 * the run actually did rather than what the flow was configured to do. A run
 * with no `datasource` step read nothing, and says so.
 */
export function ScenarioPanel({
  steps,
  inputs,
}: {
  steps: StepRun[];
  inputs?: Record<string, unknown>;
}) {
  const read = steps.map((s) => s.readFrom).filter((v): v is "sandbox" | "production" => v != null);
  const source =
    read.length === 0
      ? "No datasource step ran"
      : read.includes("production")
        ? "Production data"
        : "Sandbox fixtures";
  const inputRows = Object.entries(inputs ?? {});
  return (
    <section className="pane overflow-hidden" data-testid="scenario-panel">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-text">Scenario</h2>
      </div>
      <dl className="divide-y divide-line px-4 text-sm">
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="text-xs text-dim">Read from</dt>
          <dd className={`text-xs ${read.includes("production") ? "text-danger" : "text-text"}`}>{source}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="text-xs text-dim">Steps</dt>
          <dd className="text-xs text-text">{steps.length}</dd>
        </div>
        {inputRows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-2">
            <dt className="truncate text-xs text-dim">{k}</dt>
            <dd className="truncate font-mono text-xs text-text">{String(v)}</dd>
          </div>
        ))}
      </dl>
      {inputRows.length === 0 && (
        <p className="px-4 pb-3 text-xs text-dim">This run was started with no inputs.</p>
      )}
    </section>
  );
}

/**
 * ⚠ Rendered ONLY over a run that actually read fixtures, and it used to render
 * over every run including one that read production — where "what a mock pass
 * proves" is not a caveat but a false statement about where the rows came from.
 *
 * The sentence itself is right and is kept verbatim: a sandbox run proves
 * EXECUTION, not correctness (`hr_demo` stores attendance 0-100 and
 * `hr_demo_alt` as a 0-1 fraction, and the swap rehearsal found three real bugs
 * on its first run). The caller decides whether it applies.
 */
export function MockCaveat() {
  return (
    <div
      data-testid="mock-caveat"
      className="flex gap-3 rounded-lg border border-warn-line bg-warn-bg p-4"
      role="status"
    >
      <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">What a sandbox pass proves</p>
        <p className="mt-1 text-sm text-muted">
          Shape and workflow logic passed against fixture data. It is not proof that the first
          real run will succeed.
        </p>
      </div>
    </div>
  );
}
