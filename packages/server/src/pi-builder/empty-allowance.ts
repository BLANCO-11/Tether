/**
 * "This output may come back with NO rows" is the person's call, never Forge's (2026-10-12).
 *
 * The failure it closes: the test data could not produce a single row (its tables did not connect), every fix
 * failed, and on the fourth round Forge declared the whole report `allow_empty` to get past the test. The rule that
 * already stood — an AUTOMATIC fix round may not add one — did not cover a turn the person started ("address this
 * structurally"). On real data that declaration turns "found nothing" into a quietly emailed empty report.
 *
 * So after any turn, a NEW whole-output allowance (one with no `field`) is taken back out of the workflow and put to
 * the person as a question. "Yes" writes it back; anything else leaves it out. A FIELD allowance (one column blank in
 * every row) is not held: a column left blank on purpose is ordinary, and the step's own reason says why.
 *
 * Pure apart from the file read/write at the bottom.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxDir } from "./sandbox-fs.js";
import type { PiQuestion } from "./types.js";

export type HeldAllowance = { stepId: string; output: string; reason: string };

export const HOLD_PREFIX = "allow_empty:";
export const ALLOW_YES = "Yes, an empty result is fine";
export const ALLOW_NO = "No, it should never be empty";

type Json = unknown;

/** Every node in the workflow that carries `allow_empty`, wherever it sits (inside a loop or a branch path too). */
function nodesWithAllowances(v: Json, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(v)) for (const x of v) nodesWithAllowances(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && Array.isArray(o.allow_empty)) out.push(o);
    for (const x of Object.values(o)) if (x && typeof x === "object") nodesWithAllowances(x, out);
  }
  return out;
}

const keyOf = (stepId: string, output: string) => `${stepId}:${output}`;

/** Whole-output allowances in `workflow` that were not there when the turn began (`before`, "step:output[:field]"). */
export function newWholeOutputAllowances(workflow: Json, before: readonly string[]): HeldAllowance[] {
  const had = new Set(before);
  const out: HeldAllowance[] = [];
  for (const node of nodesWithAllowances(workflow)) {
    for (const a of node.allow_empty as Array<Record<string, unknown>>) {
      if (!a || typeof a.output !== "string" || a.field) continue;
      const k = keyOf(node.id as string, a.output);
      if (!had.has(k)) out.push({ stepId: node.id as string, output: a.output, reason: String(a.reason ?? "") });
    }
  }
  return out;
}

/** The workflow with these whole-output allowances removed (field allowances untouched). */
export function withoutAllowances(workflow: Json, held: readonly HeldAllowance[]): Json {
  const drop = new Set(held.map((h) => keyOf(h.stepId, h.output)));
  const copy = JSON.parse(JSON.stringify(workflow)) as Json;
  for (const node of nodesWithAllowances(copy)) {
    const kept = (node.allow_empty as Array<Record<string, unknown>>).filter(
      (a) => !(a && !a.field && typeof a.output === "string" && drop.has(keyOf(node.id as string, a.output))),
    );
    if (kept.length) node.allow_empty = kept;
    else delete node.allow_empty;
  }
  return copy;
}

/** The workflow with this allowance written back onto its step (the person said yes). */
export function withAllowance(workflow: Json, h: HeldAllowance): Json {
  const copy = JSON.parse(JSON.stringify(workflow)) as Json;
  const visit = (v: Json): boolean => {
    if (Array.isArray(v)) return v.some(visit);
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (o.id === h.stepId && typeof o.entry === "string") {
      const list = Array.isArray(o.allow_empty) ? (o.allow_empty as unknown[]) : [];
      o.allow_empty = [...list, { output: h.output, reason: h.reason }];
      return true;
    }
    return Object.values(o).some((x) => x && typeof x === "object" && visit(x));
  };
  visit(copy);
  return copy;
}

/** The question the person answers, in plain words with the consequence of each answer. */
export function heldQuestion(h: HeldAllowance): PiQuestion {
  return {
    id: `${HOLD_PREFIX}${h.stepId}:${h.output}`,
    prompt:
      `Can "${h.output}" (step ${h.stepId}) genuinely come back with nothing in it?` +
      (h.reason ? ` Forge's reason: ${h.reason}` : "") +
      ` If yes, a run that finds nothing carries on — an empty report would still go out. If no, a run that finds ` +
      `nothing stops and says so.`,
    choices: [ALLOW_YES, ALLOW_NO],
  };
}

export function heldFromId(id: string, held: readonly HeldAllowance[]): HeldAllowance | undefined {
  return held.find((h) => `${HOLD_PREFIX}${h.stepId}:${h.output}` === id);
}

export function saysYes(answer: string): boolean {
  return answer.trim() === ALLOW_YES || /^\s*(yes|y|yeah|yep|allow|it'?s fine|fine)\b/i.test(answer);
}

// ── the sandbox's workflow.json, read and written raw (every key kept as Forge wrote it) ──────────────────────

export function readWorkflowRaw(workspaceId: string, sessionId: string): Json {
  try {
    return JSON.parse(readFileSync(join(sandboxDir(workspaceId, sessionId), "workflow.json"), "utf8"));
  } catch {
    return null;
  }
}

export function writeWorkflowRaw(workspaceId: string, sessionId: string, workflow: Json): void {
  writeFileSync(join(sandboxDir(workspaceId, sessionId), "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
}

export function writeQuestionsRaw(workspaceId: string, sessionId: string, questions: PiQuestion[]): void {
  writeFileSync(
    join(sandboxDir(workspaceId, sessionId), "questions.json"),
    JSON.stringify({ status: questions.length ? "open" : "idle", questions }, null, 2) + "\n",
  );
}

// ── columns blank in every row: the person ticks which can be (2026-10-13) ─────────────────────────────────────
//
// The failure this closes (chat 25d67dbd): the test failed on "Remarks" blank in every row — blank on purpose, by the
// person's own rule. They said "all the columns where empty rows are visible can be genuinely empty". Forge, never
// told which column failed, allowed three OTHER columns; then, told "all columns", declared the whole report may come
// back with no rows. That was held and asked as "can the report come back with nothing?", the person rightly said no,
// and the workflow was left with no allowance at all. Two different statements had been made one.
//
// So the columns are put to the person by CODE, from the runner's own findings, as one `multi` question per step
// output: the ones ticked are written onto the step as field allowances, the rest go to Forge as columns that must
// have values. Only the columns the test named — never "every column", which would let a column that later goes blank
// because a join broke through silently. The question is rebuilt from its id and its options, so an answer still
// settles after a restart.

export const BLANK_PREFIX = "blank_columns:";

/** One step output's columns that came back blank in every row. */
export type BlankColumns = { stepId: string; output: string; rows: number | null; fields: string[] };

type Finding = { output?: unknown; field?: unknown; rows?: unknown; verdict?: unknown };

/** The columns the runner FAILED for being blank in every row, grouped by step output (a loop's items merged). */
export function blankColumnsOf(steps: ReadonlyArray<{ stepId: string; status: string; checksJson: unknown }>): BlankColumns[] {
  const by = new Map<string, BlankColumns>();
  for (const st of steps) {
    if (st.status !== "failed") continue;
    for (const c of (Array.isArray(st.checksJson) ? st.checksJson : []) as Finding[]) {
      if (c?.verdict !== "failed" || typeof c.output !== "string" || typeof c.field !== "string") continue;
      const k = `${st.stepId}:${c.output}`;
      const b = by.get(k) ?? { stepId: st.stepId, output: c.output, rows: typeof c.rows === "number" ? c.rows : null, fields: [] };
      if (!b.fields.includes(c.field)) b.fields.push(c.field);
      by.set(k, b);
    }
  }
  return [...by.values()];
}

export function blankColumnsQuestion(b: BlankColumns): PiQuestion {
  const n = b.fields.length;
  const rows = b.rows != null ? ` (${b.rows.toLocaleString("en-US")} rows)` : "";
  return {
    id: `${BLANK_PREFIX}${b.stepId}:${b.output}`,
    kind: "multi",
    prompt:
      `The test found ${n === 1 ? "this column" : `these ${n} columns`} blank in every row of "${b.output}" from step ` +
      `${b.stepId}${rows}. Tick the ones that can genuinely be blank. Any you leave unticked must have values, and ` +
      `Forge will fix the step so they do.`,
    choices: b.fields,
  };
}

/** The step output a blank-columns question is about, from its id. */
export function blankColumnsTarget(id: string): { stepId: string; output: string } | null {
  if (!id.startsWith(BLANK_PREFIX)) return null;
  const rest = id.slice(BLANK_PREFIX.length);
  const i = rest.lastIndexOf(":");
  return i > 0 && i < rest.length - 1 ? { stepId: rest.slice(0, i), output: rest.slice(i + 1) } : null;
}

export const BLANK_REASON = "The person confirmed this column can be blank in every row.";

/** The workflow with these columns allowed to be blank on the step (an existing allowance is not repeated). */
export function withFieldAllowances(workflow: Json, stepId: string, output: string, fields: readonly string[]): Json {
  const copy = JSON.parse(JSON.stringify(workflow)) as Json;
  const visit = (v: Json): boolean => {
    if (Array.isArray(v)) return v.some(visit);
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (o.id === stepId && typeof o.entry === "string") {
      const list = (Array.isArray(o.allow_empty) ? o.allow_empty : []) as Array<Record<string, unknown>>;
      const have = new Set(list.filter((a) => a?.output === output && typeof a.field === "string").map((a) => a.field as string));
      const added = fields.filter((f) => !have.has(f)).map((f) => ({ output, field: f, reason: BLANK_REASON }));
      if (added.length) o.allow_empty = [...list, ...added];
      return true;
    }
    return Object.values(o).some((x) => x && typeof x === "object" && visit(x));
  };
  visit(copy);
  return copy;
}
