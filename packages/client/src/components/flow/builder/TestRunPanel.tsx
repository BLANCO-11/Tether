"use client";

// src/components/flow/builder/TestRunPanel.tsx — what a test run actually did.
// T6 · BX-005 (builder programme, closed; record removed 2026-09-11)
//
// ⚠ ONE COMPONENT, BECAUSE IT WAS ONE MODE'S WORTH OF UI AND NONE IN THE OTHER.
//
// The builder has two modes and chat is the DEFAULT. `BuilderShell` (manual)
// rendered the run; `ChatWorkbench` (chat) accepted a `testOutputs` prop,
// destructured it, and referenced it nowhere — so for anybody who did not first
// switch to manual, pressing Test started a real execution and showed nothing at
// all. Reported from use on 2026-09-02, with manual confirmed working in the
// same session. Same shape as `onDiscardDraft` on `BuilderShell` (a prop
// accepted, typed, never rendered) and as `outputOpen` beside it, both since
// removed. ⚠ A typed prop is not a rendered prop, and TypeScript cannot tell.
//
// ── The rule every section below obeys ───────────────────────────────────────
//
// **An absent field draws nothing.** Never a placeholder, never a zero, never an
// empty object standing in for a value the run did not produce. Everything here
// comes off `StepRun`, which is already the server's REDACTED assembly
// (`flow-visibility.service.ts`) — so there is nothing to redact and nothing to
// invent. That rule is why this replaced a loop that wrote
// `{ rows: [{ id: 1, result: "output for <stepId>" }] }` for every step whether
// it had run or not.

import { RunOutput } from "@/components/flow/RunOutput";
import { InspectorSection, InspectorRow } from "@/components/flow/builder/InspectorSection";
import { progressRows, finalOutputStep } from "@/lib/builder-test-run";
import { STATUS_TONE, type CanvasGraph } from "@/lib/canvas-model";
import { fmtDuration } from "@/lib/stats";

export type TestRunPanelProps = {
  /** The graph the run is painted onto — already overlaid by the caller. */
  graph: CanvasGraph;
  /** Per-step output, derived from the streamed steps. Never fabricated. */
  testOutputs?: Record<string, Record<string, unknown>> | null;
  /** True while the run is still going, decided by `engineStatus` (D-13). */
  testing?: boolean;
  /**
   * What can honestly be said right now — "waiting for the engine", "could not
   * find it", an error. ⚠ Shown INSTEAD of output, never beside invented output.
   */
  testNotice?: string | null;
  /** When a node is selected, its own entry gets a section of its own. */
  selectedStepId?: string | null;
};

/** True when there is anything at all to say about a run. */
export function hasTestRun(p: Pick<TestRunPanelProps, "testOutputs" | "testing" | "testNotice">): boolean {
  return Boolean(p.testing || p.testNotice || p.testOutputs);
}

const DOT: Record<string, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
  neutral: "bg-muted",
};

/**
 * The one-line summary strip.
 *
 * ⚠ Every number here is counted, never asserted. "n of m" counts nodes the
 * execution has actually reported on; a node it has said nothing about is not
 * counted as pending, because "not reached yet" and "not in this run" are
 * different facts (see `overlayStatuses`).
 */
function Summary({ graph, testing }: Pick<TestRunPanelProps, "graph" | "testing">) {
  const rows = progressRows(graph);
  const reported = rows.filter((r) => r.status != null);
  const failed = rows.filter((r) => r.status === "failed" || r.status === "warning").length;
  const waiting = rows.filter((r) => r.status === "paused").length;
  const done = rows.filter((r) => r.status === "success").length;

  const tone = failed ? "danger" : waiting ? "warn" : testing ? "accent" : reported.length ? "ok" : "neutral";
  const word = failed
    ? `${failed} failed`
    : waiting
      ? "waiting for a person"
      : testing
        ? "running"
        : reported.length
          ? "finished"
          : "no run yet";

  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]} ${testing && !failed && !waiting ? "animate-pulse" : ""}`}
      />
      <span className="text-caption font-medium text-text">{word}</span>
      {reported.length > 0 && (
        <span className="ml-auto text-caption text-dim">
          {done} of {rows.length} done
        </span>
      )}
    </div>
  );
}

/**
 * Per-node state — a compact row each, not a card each.
 *
 * ⚠ Replaces a list that printed `running…` for EVERY node for as long as the
 * button was busy, in a bordered pulsing box per node. Only a genuinely running
 * node pulses: animation means live activity, and a `paused` node is waiting on
 * a PERSON, which is the opposite.
 */
function Steps({ graph }: { graph: CanvasGraph }) {
  const rows = progressRows(graph);
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" data-testid="test-progress">
      {rows.map((r) => {
        const tone = r.status ? STATUS_TONE[r.status as keyof typeof STATUS_TONE] : "neutral";
        return (
          <li key={r.id} className="flex items-center gap-2">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]} ${r.status === "running" ? "animate-pulse" : ""}`}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-text">{r.id}</span>
            <span className="shrink-0 text-caption text-dim">{r.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The facts a step carries, as rows. Absent fields draw nothing at all. */
function StepFacts({ entry }: { entry: Record<string, unknown> }) {
  const req = entry.request as { uri?: string; method?: string } | undefined;
  return (
    <dl className="flex flex-col gap-1.5">
      <InspectorRow label="State" value={String(entry.status ?? "")} />
      <InspectorRow label="Kind" value={entry.kind as string | undefined} />
      <InspectorRow label="Uses" value={entry.ref as string | undefined} mono />
      <InspectorRow label="Called" value={req ? `${req.method} ${req.uri}` : null} mono />
      <InspectorRow label="Responded" value={entry.responseCode as number | undefined} />
      <InspectorRow
        label="Took"
        value={typeof entry.durationMs === "number" ? fmtDuration(entry.durationMs) : null}
      />
      <InspectorRow label="Attempt" value={entry.attempt as number | undefined} />
      {/* ⚠ D-52 — `production` on a DRAFT run means the test just read the
          tenant's real data, and the person who pressed Test is exactly who
          needs to know. Rendered from the step, never inferred. */}
      <InspectorRow label="Read from" value={entry.readFrom as string | undefined} />
    </dl>
  );
}

export function TestRunPanel({ graph, testOutputs, testing, testNotice, selectedStepId }: TestRunPanelProps) {
  const last = finalOutputStep(graph, testOutputs ?? null);
  const selected = selectedStepId ? testOutputs?.[selectedStepId] : undefined;
  const reported = progressRows(graph).filter((r) => r.status != null).length;

  return (
    <div className="flex min-h-0 flex-col" data-testid="test-run-panel">
      <Summary graph={graph} testing={testing} />

      {/* ⚠ A notice is shown INSTEAD of output. The deleted code answered every
          one of these situations with a full set of successful-looking rows. */}
      {testNotice && (
        <p className="border-b border-line px-4 py-2.5 text-caption text-muted" data-testid="test-notice">
          {testNotice}
        </p>
      )}

      <InspectorSection title="Steps" open count={reported}>
        <Steps graph={graph} />
      </InspectorSection>

      {selectedStepId && (
        <InspectorSection title={`Step — ${selectedStepId}`} open>
          {selected ? (
            <>
              <StepFacts entry={selected} />
              {typeof selected.error === "string" && (
                <p className="rounded-md border border-danger-line bg-danger-bg px-2.5 py-2 text-caption text-danger">
                  {selected.error}
                </p>
              )}
              {selected.output != null && (
                <RunOutput output={selected.output as Record<string, unknown>} title={selectedStepId} />
              )}
            </>
          ) : (
            <p className="text-caption text-muted">
              {testing ? "This step has not reported yet." : "This step produced nothing on the last run."}
            </p>
          )}
        </InspectorSection>
      )}

      {/*
        ⚠ NAMED FOR WHAT IT IS. The heading used to read "Final output" over
        `Object.values(testOutputs)[length - 1]` with the summary "Aggregated
        final output from last test run" — nothing aggregated anything, and
        insertion order is not graph order. The values were real and the sentence
        about them was not, which is the same defect as the invented rows one
        level up.
      */}
      <InspectorSection title={last ? `Last output — ${last.stepId}` : "Output"} open>
        {last ? (
          <RunOutput output={last.output} title={last.stepId} />
        ) : (
          <p className="text-caption text-muted">
            {testing ? "No step has produced output yet." : "No run yet — output appears after Test workflow."}
          </p>
        )}
      </InspectorSection>
    </div>
  );
}
