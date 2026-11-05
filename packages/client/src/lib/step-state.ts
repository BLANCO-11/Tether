// src/lib/step-state.ts — one definition of a step's state, read by every surface.
//
// The card, the panel head, the readiness sheet and StepStrip must never
// re-derive a state each: they all call `stepState`, so the five words mean
// the same thing everywhere. The inputs are facts this repo already computes —
// `localFindings()` blockers, the broken references from `lib/step-io.ts`, the
// last run's per-step record, the draft revision, and the existing step flag —
// and the precedence below is the whole design.
import type { LocalFinding } from "@foundry/flow-edit";

/** The five states a step card can carry, with the blocker named in `reason`. */
export type StepState = "ready" | "incomplete" | "broken" | "failed" | "stale";

/** What `stepState` returns: the state, a computed sentence, and what it refuses. */
export type StepStateResult = {
  state: StepState;
  reason: string;
  blocks: "save" | "run" | null;
};

/** A broken reference into a step or field that no longer resolves. */
export type BrokenReference = { name: string; stepId: string; field: string };

/** A per-step run record: only the status word and the revision it ran at matter here. */
export type StepLastRun = { status: string; revision: number } | null;

/**
 * One step's state from facts the repo already computes. Precedence is
 * `broken` → `incomplete` (a blocking finding for this step) → `failed`
 * (the last run's status is a failure word) → `stale` (a flag is set, or the
 * last run predates the draft) → `ready`. Non-blocking findings never change
 * the state. `broken`/`incomplete` refuse a save, `failed` refuses a run.
 */
export function stepState(input: {
  stepId: string;
  findings: LocalFinding[];
  broken: BrokenReference[];
  lastRun: StepLastRun;
  draftRevision: number;
  flag: string | null;
}): StepStateResult {
  const firstBroken = input.broken[0];
  if (firstBroken) {
    return {
      state: "broken",
      reason: `${firstBroken.name} is bound to a removed step`,
      blocks: "save",
    };
  }
  const blocking = input.findings.find((f) => f.blocking && f.stepId === input.stepId);
  if (blocking) {
    return { state: "incomplete", reason: blocking.message, blocks: "save" };
  }
  if (input.lastRun && input.lastRun.status.toLowerCase().includes("fail")) {
    return { state: "failed", reason: "last run failed", blocks: "run" };
  }
  if (input.lastRun && input.lastRun.revision < input.draftRevision) {
    return {
      state: "stale",
      reason: `edited since revision ${input.lastRun.revision}`,
      blocks: null,
    };
  }
  if (input.flag !== null) {
    return { state: "stale", reason: `flagged: ${input.flag}`, blocks: null };
  }
  return { state: "ready", reason: "ready", blocks: null };
}
