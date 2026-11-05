// src/lib/step-shape.ts — what a step consumes and what it produces, in words.
// T8 · BD-005 (builder programme, closed; record removed 2026-09-11)
//
// ── Two facts the product already knew and never said ────────────────────────
//
// **Fan-out.** `lib/flow-expr.ts`'s `buildFanOutParams` emits `[.[] | {…}]` over
// an upstream step's rows, which means the call is made ONCE PER ROW. The
// inspector computes the step it fans over — twice, in two form components,
// under the name `fanOutOver` — and renders it nowhere. So "this sends one email
// per employee" and "this sends one email" look identical on screen, and the
// difference is the whole behaviour of the step.
//
// **Output shape.** `GET …/catalogue` serves `outputs.<kind>.describes` and
// `.caution` — written from real failures: I-42 (a timestamp crossing into a
// tool body), I-44 (`.vars.result`, not `.value`), an agent's answer not being a
// shape to depend on, a gate producing no data at all. Measured 2026-09-02: the
// client reads `outputs` ONLY to build expressions, and renders neither field.
// ⚠ That is I-120's shape across the wire — a correct answer computed, served,
// and discarded, so nothing would notice if it stopped being true.
//
// Both are derived here rather than in a component, so the rules can be asserted
// without a render — the reason `canvas-model.ts` and `flow-authoring.ts` are
// pure.

import type { OutputShapes } from "@/lib/flow-expr";
import type { StepKind } from "@/lib/flow-authoring";

/**
 * The upstream step a `paramsExpr` fans out over, or null when the call is made
 * once.
 *
 * ⚠ **Derived from the expression, never from a flag.** The expression is what
 * the compiler emits and what Kestra runs; a stored boolean beside it could
 * disagree with it, and the screen would then be describing a step that does
 * something else.
 *
 * `buildFanOutParams` produces
 * `{{ <rows> | jq('[.[] | {…}]') | first }}`, so the marker is a jq program
 * opening `[.[] |` and the subject is the first `outputs.<id>` in the
 * expression. A single call (`buildSingleParams`) opens `[{` and has no `.[]`.
 */
export function fanOutOver(paramsExpr: string | null | undefined): string | null {
  if (!paramsExpr) return null;
  // The jq program, as passed to `jq('…')`. Anything else is not a fan-out this
  // inspector built, and guessing at a hand-written one would be a claim.
  const jq = /jq\(\s*'([\s\S]*?)'\s*\)/.exec(paramsExpr) ?? /jq\(\s*"([\s\S]*?)"\s*\)/.exec(paramsExpr);
  if (!jq || !/^\s*\[\s*\.\[\]\s*\|/.test(jq[1])) return null;
  const over = /outputs\.([A-Za-z0-9_-]+)/.exec(paramsExpr);
  return over ? over[1] : null;
}

/** How a step's call count reads on screen. */
export function fanOutSentence(paramsExpr: string | null | undefined): string {
  const over = fanOutOver(paramsExpr);
  return over
    ? `Runs once per row from ${over}.`
    : "Runs once, whatever the previous step returned.";
}

/**
 * ⚠ Output is editable for `transform` and `code` ONLY, and that is a STATED
 * BOUND rather than an omission.
 *
 * A `datasource`, `query` or `tool` step's output belongs to the query or the
 * endpoint. An editable box there lets somebody type a shape the call will
 * ignore — the value would not change, and the screen would be the only place
 * the typed shape existed. So the panel says WHOSE shape it is instead of
 * offering a box and silently dropping what is typed into it.
 */
export const OUTPUT_EDITABLE: ReadonlySet<StepKind> = new Set(["transform", "code"] as StepKind[]);

/**
 * Who owns a step's INPUT shape, when it is not the author's to declare.
 *
 * ⚠ **This lives here, beside `outputSummary`'s `ownedBy`, because there were
 * about to be THREE tables answering one question** — this one (in
 * `StepShape.tsx`), the output one below, and a third in `step-io.ts`. D-197's
 * rule: a second definition drifts in whichever direction nothing is testing,
 * and here that means two panels disagreeing about who owns a shape.
 *
 * It is deliberately NOT merged with `outputSummary`'s `ownedBy`: an `agent`
 * step's inputs belong to the agent runtime and its output belongs to the
 * model, which are different answers to different questions and read as a bug
 * only if you assume they should match.
 */
export function inputOwnerOf(kind: string): string | null {
  if (kind === "tool" || kind === "action" || kind === "notify" || kind === "report") return "the endpoint";
  if (kind === "datasource" || kind === "query") return "the query";
  if (kind === "agent" || kind === "assistant") return "the agent runtime";
  return null;
}

export type OutputSummary = {
  /** `outputs.<id>.…`, resolved for this step. Null when the kind produces nothing. */
  expr: string | null;
  /** What the value IS, from the catalogue. */
  describes: string | null;
  /** What a chooser would otherwise get wrong. Null when there is nothing to warn about. */
  caution: string | null;
  /** Whether this kind's output is the author's to declare. */
  editable: boolean;
  /** Who owns the shape when it is not the author's. Null when it is. */
  ownedBy: string | null;
};

/**
 * Everything the panel needs to say about a step's output — assembled from the
 * catalogue the SERVER served, never from a table hardcoded here. A second copy
 * of `describes`/`caution` in the client is how the screen goes on quoting I-44
 * after the server has learned something new.
 */
export function outputSummary(
  shapes: OutputShapes,
  kind: StepKind,
  stepId: string,
): OutputSummary {
  const shape = shapes[kind] ?? { template: null, describes: null, caution: null };
  const editable = OUTPUT_EDITABLE.has(kind);
  return {
    expr: shape.template ? shape.template.replaceAll("<id>", stepId) : null,
    describes: shape.describes,
    caution: shape.caution,
    editable,
    ownedBy: editable
      ? null
      : kind === "datasource" || kind === "query"
        ? "the query"
        : kind === "tool"
          ? "the endpoint"
          : null,
  };
}
