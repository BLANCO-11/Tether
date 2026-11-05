/**
 * `build:measure`'s pure half — the failure taxonomy and the shape match.
 * Phased-typed-build phase 0, D-251.
 *
 * ⚠ **PURE.** No repos, no gateway, no `process`. `build-measure.ts` is a
 * scenario whose `main()` runs at import, so what its test asserts lives here.
 *
 * ⚠ **The nine classes are FIXED** (D-251). A message nothing here recognises
 * is `other` and is printed verbatim, so a new failure kind is visible rather
 * than silently filed under a neighbour. Split a class only by a phase decision.
 */
import type { BuildGoal, LabelStep } from "./build-goals.js";

export const FAILURE_CLASSES = [
  "shape",
  "component",
  "serialization",
  "io_shape",
  "generated_sql",
  "environment",
  "llm_output",
  "code_fragment",
  "other",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Ordered: the FIRST matching rule wins, so the specific comes before the
 * general. `generated_sql` sits before `io_shape` because *column "x" does not
 * exist* is a SQL error, while *never returns* is a transform reading a column.
 */
const RULES: Array<[FailureClass, RegExp]> = [
  ["environment", /recipients_rejected|mock data|mock file|has no mock|mock .*tables|more than \d+ tables|sandbox .*(missing|refused)/i],
  ["serialization", /Unable to parse jq value|JsonParseException|Unexpected character|inside a quoted JSON string|is never closed|unexpected `?[\]}]`? in the literal|unescaped|Illegal unquoted|double.?encoded|nested `?\{\{|I-11/i],
  ["component", /IS a datasource in this workspace, but it has no readable component|not callable|references? "[^"]+" .*does not exist|unknown ref|no such (tool|query|operation)/i],
  ["generated_sql", /relation "[^"]+" does not exist|column "[^"]+" does not exist|operator does not exist|function [a-z_]+\(.*\) does not exist|syntax error at or near|invalid input syntax for type|could not determine data type of parameter/i],
  ["code_fragment", /Traceback|contract_violation|fragment (raised|failed)|NameError|KeyError|TypeError: /],
  ["llm_output", /truncated|max_tokens|finish_reason/i],
  ["io_shape", /never returns|reads `outputs\.[^`]+\.(value|body)`|is reached through|not a valid address|must be YYYY|must be an integer|Expected (string|number|object)|Required|is required|unbound|not declared|does not declare|no value for|type [A-Z]+ .*(month|date)|format/i],
  ["shape", /dependsOn|cycle|unknown step|duplicate step|step count|at most \d+ steps|not slug|flow id/i],
];

export function classify(message: string): FailureClass {
  for (const [cls, re] of RULES) if (re.test(message)) return cls;
  return "other";
}

/** A finding can be a string or `{message, …}` — the scratch run printed `[object Object]`. */
export function findingText(f: unknown): string {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") {
    const o = f as Record<string, unknown>;
    if (typeof o.message === "string") return o.path ? `${String(o.path)}: ${o.message}` : o.message;
    return JSON.stringify(f);
  }
  return String(f);
}

// ── Shape match ────────────────────────────────────────────────────────────

export interface DraftedStep {
  id: string;
  kind: string;
  ref?: string;
  dependsOn?: string[];
}

export interface ShapeMatch {
  /** Every required step matched, no unexplained extra, every edge holds. */
  exact: boolean;
  matched: number;
  required: number;
  /** Labels no drafted step satisfied. */
  missing: string[];
  /** Drafted steps no label and no `mayAlsoUse` explains (`id:kind(ref)`). */
  extra: string[];
  /** Label edges `a→b` the draft does not respect. */
  brokenEdges: string[];
}

/** `ds.*` matches any ref on datasource `ds` (see `LabelStep`). */
export const refIn = (ref: string | undefined, list: string[] | undefined) =>
  !!ref && !!list?.some((r) => (r.endsWith(".*") ? ref.startsWith(r.slice(0, -1)) : r === ref));

const fits = (l: LabelStep, s: DraftedStep) => (l.refs ? refIn(s.ref, l.refs) : s.kind === l.kind);

/** `b` downstream of `a` through `dependsOn`, transitively. */
function downstream(steps: DraftedStep[], a: string, b: string): boolean {
  const by = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const stack = [...(by.get(b)?.dependsOn ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === a) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(by.get(x)?.dependsOn ?? []));
  }
  return false;
}

/**
 * Match a draft against its label.
 *
 * Assignment is greedy in label order, preferring a drafted step that fits
 * exactly one label — enough for sets this small, where no two labels in a goal
 * share a ref list. A `transform`, `branch` or `merge` extra never counts
 * against the shape: they are plumbing a person may or may not draw.
 */
export function matchShape(goal: BuildGoal, drafted: DraftedStep[]): ShapeMatch {
  const used = new Set<string>();
  const assigned = new Map<string, string>(); // label.as → drafted id
  const missing: string[] = [];
  for (const l of goal.steps) {
    const cands = drafted.filter((s) => !used.has(s.id) && fits(l, s));
    if (!cands.length) { missing.push(l.as); continue; }
    const pick = cands.find((s) => goal.steps.filter((o) => fits(o, s)).length === 1) ?? cands[0];
    used.add(pick.id);
    assigned.set(l.as, pick.id);
  }
  const PLUMBING = new Set(["transform", "branch", "merge"]);
  const extra = drafted
    .filter((s) => !used.has(s.id))
    .filter((s) => !PLUMBING.has(s.kind) && !refIn(s.ref, goal.mayAlsoUse))
    .map((s) => `${s.id}:${s.kind}${s.ref ? `(${s.ref})` : ""}`);
  const brokenEdges = goal.edges
    .filter(([a, b]) => assigned.has(a) && assigned.has(b))
    .filter(([a, b]) => !downstream(drafted, assigned.get(a)!, assigned.get(b)!))
    .map(([a, b]) => `${a}→${b}`);
  return {
    exact: !missing.length && !extra.length && !brokenEdges.length,
    matched: assigned.size,
    required: goal.steps.length,
    missing,
    extra,
    brokenEdges,
  };
}

// ── The outcome of one goal, in one bucket ─────────────────────────────────

export type Verdict =
  | "runs" // drafted, draft run SUCCESS (or PAUSED at a gate, which is by design)
  | "run_failed"
  | "refused_correctly"
  | "refused_wrongly" // refused where the label says draft
  | "drafted_wrongly" // drafted where the label says refuse
  | "contract_refused"
  | "failed_static";

export function verdictOf(goal: BuildGoal, outcome: string, run?: string): Verdict {
  if (outcome === "insufficient_catalogue") return goal.expect === "refuse" ? "refused_correctly" : "refused_wrongly";
  if (outcome === "insufficient_contract") return "contract_refused";
  if (outcome !== "ok") return "failed_static";
  if (goal.expect === "refuse") return "drafted_wrongly";
  return run === "SUCCESS" || run === "PAUSED" ? "runs" : "run_failed";
}
