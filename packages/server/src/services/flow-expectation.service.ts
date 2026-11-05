import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowExpectationResults } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowVisibilityService, type StepView } from "./flow-visibility.service.js";
import { retentionDays } from "./retention.js";

/**
 * What a flow claims about its own output, and whether a run bore it out.
 * archive/GAPS.md §2.3 · decision D-68
 *
 * ── The gap this closes, and the one it does NOT ─────────────────────────────
 *
 * Gate 1 requires a flow to have completed one successful run before a trigger
 * may be armed. "Completed" is all it has ever meant. The measured failure this
 * whole migration exists to fix was a script that *"hardcoded `period="2023-10"`,
 * emailed 0 of 11, and still exited 0"* — a green run, past gate 1, wrong.
 *
 * An expectation is the author's chance to say what the run should have looked
 * like, checked against what it did look like. **It is not an oracle.** An
 * oracle computes the right answer from the dataset definition independently of
 * the flow (`expectedScreening`, `financeOracle`); an expectation is written by
 * the same person who wrote the flow and can be wrong in the same direction.
 * What it catches is the flow drifting away from its own author's intent —
 * which is exactly the hardcoded-date failure, and is not the units trap.
 * ⚠ **Never describe a passing expectation as a correct run.**
 *
 * ── Four properties, and each is a refusal of an easier design ───────────────
 *
 *  1. **It is declarative, and there is no escape hatch.** Three assert types,
 *     nine operators, one optional key name. No expression, no regex, no code.
 *     Same reasoning as D-50: D-22's allowlist is a good boundary and a terrible
 *     text box, and a `code`-shaped expectation would be a second generated-code
 *     surface with none of `code`'s containment. A claim this vocabulary cannot
 *     express is a claim for an oracle, not for a widened grammar.
 *
 *  2. **It reads the REDACTED view — the same bytes a person sees.**
 *     `evaluate()` goes through `flowVisibilityService.get()`, whose outputs
 *     have already been through `redactSecrets`. That is not incidental: an
 *     expectation is a predicate a tenant can run against a step's output as
 *     many times as it likes, so an unredacted one would be a binary-search
 *     oracle on any credential that reached a step's output. `contains` in
 *     particular would read a secret out one character at a time. Reading the
 *     redacted view makes that structurally impossible rather than forbidden.
 *
 *  3. **`unevaluable` is a third state and it does not satisfy the gate.**
 *     A step whose output could not be read as rows is a claim nobody checked.
 *     Collapsing it into `passed` is the I-38 failure — a control that cannot
 *     fail — and collapsing it into `failed` would blame the flow for the
 *     checker's own inability to read it. It is recorded, with what was found.
 *
 *  4. **The result is PERSISTED at the run, never recomputed later.** Same rule
 *     as `flow_step_runs.read_from` (D-53): deriving it later from the flow's
 *     current expectations would rewrite the history of every run that predates
 *     a claim, turning "nobody checked this" into "this always held".
 *
 * ⚠ **Evaluation has a deadline, and it is the retention window.** The run's
 * outputs live in Kestra, Foundry keeps the pointer (R6), and retention purges
 * terminal executions after `retentionDays()`. So an unevaluated run older than
 * that can never be evaluated — recorded as `unevaluable` naming retention, the
 * same coupling `replayWindow()` states for replay (D-63).
 */

// ── The vocabulary ───────────────────────────────────────────────────────────

/**
 * Every comparison this system can make. Deliberately short.
 *
 * No regex: a pattern is a mini-language with its own runtime cost, and
 * `contains` covers the cases anyone actually writes. No `between`: two
 * expectations say it more clearly and each fails on its own.
 */
export const EXPECT_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "present",
  "absent",
  "contains",
] as const;
export type ExpectOp = (typeof EXPECT_OPS)[number];

/** `present`/`absent` are the ONLY ops that take no value. */
const NULLARY_OPS: ReadonlySet<string> = new Set(["present", "absent"]);

/** A field name, not a path. A dot here would be the first inch of an expression language. */
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ID_RE = /^[a-z][a-z0-9_]{0,62}$/;

const scalarSchema = z.union([z.string().max(512), z.number(), z.boolean()]);

const predicateFields = {
  field: z.string().regex(FIELD_RE, "a field name, not a path — no dots"),
  op: z.enum(EXPECT_OPS),
  value: scalarSchema.optional(),
};

const assertSchema = z.discriminatedUnion("type", [
  /** How many rows the step produced. */
  z.object({
    type: z.literal("rowCount"),
    op: z.enum(["eq", "gte", "lte"]),
    value: z.number().int().min(0).max(1_000_000),
  }),
  /** One named field on the step's output OBJECT — e.g. a `code` step's `{sent: 11}`. */
  z.object({ type: z.literal("field"), ...predicateFields }),
  /** A predicate quantified over every row, or over none of them. */
  z.object({
    type: z.literal("rows"),
    quantifier: z.enum(["every", "none"]),
    ...predicateFields,
  }),
]);

export const expectationSchema = z
  .object({
    /**
     * The author's name for the claim, unique within the flow. It is what a
     * result row is keyed on, so renaming one drops its history — correct, since
     * a renamed claim is a different claim to the person reading the run.
     */
    id: z.string().regex(ID_RE),
    /** Which step's output. Validated against the model in `checkFlowExpectations`. */
    stepId: z.string().min(1).max(63),
    /**
     * One top-level key on the step's output, when the interesting value is not
     * the output itself. A single key and never a path — see `FIELD_RE`.
     */
    select: z.string().regex(FIELD_RE).optional(),
    /** What the author meant, in their words. Rendered beside the verdict. */
    description: z.string().max(500).optional(),
    assert: assertSchema,
  })
  .superRefine((e, ctx) => {
    const a = e.assert;
    if (a.type === "rowCount") return;
    const nullary = NULLARY_OPS.has(a.op);
    if (nullary && a.value !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assert", "value"],
        message: `"${a.op}" compares against nothing — remove \`value\``,
      });
    }
    if (!nullary && a.value === undefined) {
      // A missing value silently comparing against `undefined` is the shape that
      // makes an expectation pass over anything.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assert", "value"],
        message: `"${a.op}" needs a \`value\` to compare against`,
      });
    }
  });

export type FlowExpectation = z.infer<typeof expectationSchema>;

/** The cap. Each is a claim somebody has to read on every run. */
export const MAX_EXPECTATIONS = 16;

/** Only these kinds have an output this vocabulary can read. See `resolveOutput`. */
export const EXPECTABLE_KINDS: ReadonlySet<string> = new Set([
  "tool",
  "datasource",
  "query",
  "code",
  "transform",
]);

// ── The key ──────────────────────────────────────────────────────────────────

/**
 * A hash over WHAT is claimed — never over the revision that claimed it.
 *
 * This is what lets gate 1 stay per-flow (its documented, deliberate scope)
 * without letting a run that predates a claim satisfy it. `description` is
 * excluded: rewording a claim in English does not change what it tests, and
 * re-blocking an armed flow for a typo fix is exactly the friction the gate's
 * own docblock warns turns gates off.
 */
export function expectationKey(e: FlowExpectation): string {
  const canonical = JSON.stringify([e.id, e.stepId, e.select ?? null, canonicalise(e.assert)]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Key order in a JS object is insertion order, and a hash must not depend on it. */
function canonicalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canonicalise(x)]),
    );
  }
  return v;
}

// ── Reading a step's output ──────────────────────────────────────────────────

export interface ResolvedOutput {
  /** The step's output as an object, when it is one. */
  object: Record<string, unknown> | null;
  /** The step's output as rows, when it can be read as a sequence. */
  rows: unknown[] | null;
  /** Where the two above came from, quoted verbatim in every verdict. */
  source: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseJson(s: unknown): unknown {
  if (typeof s !== "string") return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Turn one step's redacted output into `{object, rows}`, per kind.
 *
 * ⚠ **Every failure here is a named refusal, never a guess.** The three shapes
 * below are the real ones and they are all different — a `code` step's dict, a
 * step API batch envelope, a rendered jq string — so a resolver that fell back
 * to "treat it as empty" would report `rowCount eq 0` as passing on a step whose
 * output it simply could not read.
 */
export function resolveOutput(
  kind: string | null,
  output: Record<string, unknown> | null,
  select?: string,
): ResolvedOutput | { error: string } {
  if (!output) {
    return { error: `step produced no output (a step that failed or never ran has none)` };
  }

  let native: unknown;
  let source: string;

  switch (kind) {
    case "code": {
      // I-44: a `code` step's output is `outputs.<id>.vars.result`, not `.value`.
      const vars = output.vars;
      if (!isPlainObject(vars) || !("result" in vars)) {
        return {
          error:
            `this \`code\` step has no \`vars.result\` — the fragment did not reach the ` +
            `compiler's output wrapper, so there is nothing to check`,
        };
      }
      native = vars.result;
      source = "vars.result";
      break;
    }
    case "tool":
    case "datasource":
    case "query": {
      // `output.body` is Kestra's JSON *string* holding the step API's batch.
      native = parseJson(output.body);
      if (native === undefined) {
        return { error: `this \`${kind}\` step's response body is not JSON` };
      }
      source = "response body";
      break;
    }
    case "transform": {
      // A rendered jq string. It is usually JSON and is not required to be.
      native = parseJson(output.value);
      if (native === undefined) {
        return {
          error:
            `this \`transform\` step's output is not JSON, so it has no fields or rows to ` +
            `check — expectations read structured output`,
        };
      }
      source = "rendered value";
      break;
    }
    default:
      return {
        error:
          `expectations are not supported on \`${kind ?? "unknown"}\` steps — only ` +
          `${[...EXPECTABLE_KINDS].sort().join(", ")}`,
      };
  }

  // ── `select` narrows, and it narrows the NATIVE value only ─────────────────
  if (select !== undefined) {
    if (!isPlainObject(native)) {
      return {
        error:
          `\`select: "${select}"\` needs an object to read a key from, and this step's ` +
          `${source} is ${describeShape(native)}`,
      };
    }
    if (!(select in native)) {
      return {
        error:
          `\`select: "${select}"\` names a key this step did not produce — its ` +
          `${source} has ${Object.keys(native).length ? Object.keys(native).sort().join(", ") : "no keys"}`,
      };
    }
    native = native[select];
    source = `${source}.${select}`;
    return {
      object: isPlainObject(native) ? native : null,
      rows: Array.isArray(native) ? native : null,
      source,
    };
  }

  // ── The per-kind defaults, when nothing was selected ───────────────────────
  if (Array.isArray(native)) return { object: null, rows: native, source };

  if (!isPlainObject(native)) return { object: null, rows: null, source };

  if (kind === "datasource" || kind === "query") {
    // The envelope is `{results: [{ok, data: <rows>}], succeeded, failed, …}`.
    // A datasource step's rows are the union of every invocation's rows, which
    // is what "this query returned 11 employees" means to the person who wrote
    // it — the fan-out is Foundry's business, not the claim's. A DB operation
    // returns the SAME envelope (it is the same step API), so the same rule
    // applies.
    const rows = flattenBatchRows(native);
    return {
      object: native,
      rows: rows === null ? null : rows,
      source: rows === null ? source : `${source} → results[].data`,
    };
  }

  if (kind === "tool") {
    // A tool step's "rows" are its CALLS, not their response bodies: the useful
    // claims are "11 emails went out" and "every call succeeded", and both are
    // about the calls. A response body is reachable per call via `data`.
    const results = (native as { results?: unknown }).results;
    return Array.isArray(results)
      ? { object: native, rows: results, source: `${source} → results[]` }
      : { object: native, rows: null, source };
  }

  return { object: native, rows: null, source };
}

/** `{results: [{ok, data: [...]}, …]}` → one flat row list, or null if it is not that shape. */
function flattenBatchRows(envelope: Record<string, unknown>): unknown[] | null {
  const results = envelope.results;
  if (!Array.isArray(results)) return null;
  const rows: unknown[] = [];
  for (const r of results) {
    if (!isPlainObject(r)) return null;
    if (r.ok === false) continue; // a failed invocation contributes no rows
    if (!Array.isArray(r.data)) return null;
    rows.push(...r.data);
  }
  return rows;
}

function describeShape(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  return `a ${typeof v}`;
}

// ── Comparison ───────────────────────────────────────────────────────────────

type Comparison = { ok: boolean } | { error: string };

/**
 * One comparison.
 *
 * ⚠ `eq`/`neq` compare loosely by STRING as a fallback, and that is a decision
 * about Postgres rather than about JavaScript. `count(*)` comes back as the
 * string `"11"` through node-postgres because a bigint does not fit a JS number,
 * so a strict `11 === "11"` would fail an obviously-true claim and the author's
 * only recourse would be to quote their number — which then breaks when the
 * column is an int4. Ordering ops coerce to Number and REFUSE on a non-number
 * rather than comparing strings lexically, where `"9" > "11"`.
 */
function compare(actual: unknown, op: ExpectOp, expected: unknown): Comparison {
  const isPresent = actual !== null && actual !== undefined && actual !== "";
  switch (op) {
    case "present":
      return { ok: isPresent };
    case "absent":
      return { ok: !isPresent };
    case "eq":
      return { ok: looseEq(actual, expected) };
    case "neq":
      return { ok: !looseEq(actual, expected) };
    case "contains": {
      if (actual === null || actual === undefined) return { ok: false };
      return { ok: String(actual).includes(String(expected)) };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === null) return { error: `${JSON.stringify(actual)} is not a number` };
      if (b === null) return { error: `${JSON.stringify(expected)} is not a number` };
      if (op === "gt") return { ok: a > b };
      if (op === "gte") return { ok: a >= b };
      if (op === "lt") return { ok: a < b };
      return { ok: a <= b };
    }
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a) === String(b);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Evaluating one expectation ───────────────────────────────────────────────

export type ExpectationStatus = "passed" | "failed" | "unevaluable";

export interface ExpectationVerdict {
  expectationId: string;
  expectationKey: string;
  stepId: string;
  status: ExpectationStatus;
  /** Always populated, on a pass as much as on a failure. */
  detail: string;
  observed: unknown;
}

/** Enough offending rows to see the pattern, few enough not to store a dataset. */
const MAX_SAMPLE = 3;

export function evaluateOne(e: FlowExpectation, step: StepView | undefined): ExpectationVerdict {
  const base = { expectationId: e.id, expectationKey: expectationKey(e), stepId: e.stepId };
  const unevaluable = (detail: string, observed: unknown = null): ExpectationVerdict => ({
    ...base,
    status: "unevaluable",
    detail,
    observed,
  });

  if (!step) {
    return unevaluable(
      `this run has no step "${e.stepId}" — the expectation names a step the executed ` +
        `revision does not contain`,
    );
  }

  const resolved = resolveOutput(step.kind, step.output ?? null, e.select);
  if ("error" in resolved) return unevaluable(resolved.error, { stepStatus: step.status });

  const a = e.assert;

  if (a.type === "rowCount") {
    if (resolved.rows === null) {
      return unevaluable(
        `"${e.stepId}" produced no readable row list — its ${resolved.source} is ` +
          `${describeShape(resolved.object ?? null)}. Name the field holding the rows with ` +
          `\`select\`.`,
        { source: resolved.source },
      );
    }
    const n = resolved.rows.length;
    const cmp = compare(n, a.op, a.value);
    if ("error" in cmp) return unevaluable(cmp.error);
    return {
      ...base,
      status: cmp.ok ? "passed" : "failed",
      detail: `"${e.stepId}" produced ${n} row(s); expected ${a.op} ${a.value} (${resolved.source})`,
      observed: { rowCount: n, source: resolved.source },
    };
  }

  if (a.type === "field") {
    if (!resolved.object) {
      return unevaluable(
        `"${e.stepId}" has no output object to read "${a.field}" from — its ` +
          `${resolved.source} is ${describeShape(resolved.rows)}`,
        { source: resolved.source },
      );
    }
    const actual = resolved.object[a.field];
    if (!(a.field in resolved.object) && !NULLARY_OPS.has(a.op)) {
      // ⚠ Missing is not `absent`-shaped for a value comparison: comparing
      // against `undefined` would make `neq` pass over a field nobody produced.
      return unevaluable(
        `"${e.stepId}" produced no field "${a.field}" — its ${resolved.source} has ` +
          `${Object.keys(resolved.object).sort().join(", ") || "no keys"}`,
        { available: Object.keys(resolved.object).sort() },
      );
    }
    const cmp = compare(actual, a.op, a.value);
    if ("error" in cmp) return unevaluable(`"${a.field}": ${cmp.error}`);
    return {
      ...base,
      status: cmp.ok ? "passed" : "failed",
      detail:
        `"${e.stepId}".${a.field} was ${JSON.stringify(actual) ?? "undefined"}; expected ` +
        `${a.op}${NULLARY_OPS.has(a.op) ? "" : " " + JSON.stringify(a.value)} (${resolved.source})`,
      observed: { field: a.field, value: actual, source: resolved.source },
    };
  }

  // a.type === "rows"
  if (resolved.rows === null) {
    return unevaluable(
      `"${e.stepId}" produced no readable row list — its ${resolved.source} is ` +
        `${describeShape(resolved.object ?? null)}. Name the field holding the rows with \`select\`.`,
      { source: resolved.source },
    );
  }

  const offenders: unknown[] = [];
  let matched = 0;
  for (let i = 0; i < resolved.rows.length; i++) {
    const row = resolved.rows[i];
    if (!isPlainObject(row)) {
      return unevaluable(
        `row ${i} of "${e.stepId}" is ${describeShape(row)}, not an object, so it has no ` +
          `field "${a.field}"`,
        { source: resolved.source },
      );
    }
    const cmp = compare(row[a.field], a.op, a.value);
    if ("error" in cmp) return unevaluable(`row ${i}, "${a.field}": ${cmp.error}`);
    if (cmp.ok) {
      matched++;
      if (a.quantifier === "none" && offenders.length < MAX_SAMPLE) offenders.push(row[a.field]);
    } else if (a.quantifier === "every" && offenders.length < MAX_SAMPLE) {
      offenders.push(row[a.field]);
    }
  }

  const total = resolved.rows.length;
  const ok = a.quantifier === "every" ? matched === total : matched === 0;
  const predicate = `${a.field} ${a.op}${NULLARY_OPS.has(a.op) ? "" : " " + JSON.stringify(a.value)}`;

  // ⚠ The empty case is reported, not hidden. `every` over zero rows is
  // vacuously true and that is the right answer — but a person reading "every
  // row had an email" over a run that produced no rows deserves to be told.
  const vacuous = total === 0 ? " — over ZERO rows, so it is vacuously true" : "";

  return {
    ...base,
    status: ok ? "passed" : "failed",
    detail:
      a.quantifier === "every"
        ? `${matched} of ${total} row(s) of "${e.stepId}" satisfy ${predicate}${ok ? vacuous : ""}` +
          (ok ? "" : `; sample of what failed: ${JSON.stringify(offenders)}`)
        : `${matched} of ${total} row(s) of "${e.stepId}" match ${predicate}, expected none` +
          (ok ? "" : `; sample: ${JSON.stringify(offenders)}`),
    observed: { total, matched, source: resolved.source, sample: offenders },
  };
}

// ── Reading a revision's expectations ────────────────────────────────────────

/** The expectations declared by one revision's model. Empty when it declares none. */
export function expectationsOf(model: unknown): FlowExpectation[] {
  const raw = (model as { expectations?: unknown } | null)?.expectations;
  if (!Array.isArray(raw)) return [];
  const out: FlowExpectation[] = [];
  for (const e of raw) {
    const parsed = expectationSchema.safeParse(e);
    // A stored model that no longer parses is a model written before a schema
    // change. Skipping is right — the alternative is every read of an old run
    // throwing — and it cannot weaken the gate, because a skipped expectation
    // simply has no key for the gate to find satisfied.
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ── The service ──────────────────────────────────────────────────────────────

export interface EvaluationOutcome {
  verdicts: ExpectationVerdict[];
  /** True when the verdicts were computed now rather than read back. */
  evaluated: boolean;
  /** Set when nothing could be computed and the reason is worth retrying later. */
  deferred?: string;
}

// ── Suggesting a claim — archive/GAPS.md §2.3b ───────────────────────────────────────

/**
 * Claims a flow's own shape implies, offered as a starting point.
 *
 * ⚠ **This is a PALETTE, not inference, and the distinction is the whole reason
 * it is safe.** §2.3b names two separate things and only this one is cheap:
 *
 *  * **Suggesting** is mechanical. A `datasource` step returns rows, so
 *    `rowCount gte 1` is a claim its author can accept or reject in one glance.
 *    A `code` step declares `outputKeys`, so `field <key> present` follows from
 *    the contract the fragment was already generated against. No model is
 *    involved and none can be — there is nothing here to get wrong.
 *  * **Generating** would mean asking the drafter what its own flow should
 *    produce, which is `generation-audit.service.ts` with a new name. That
 *    service marked `clean` a script that emailed 0 of 11 people, and it was
 *    deleted for it. If it is ever built, the claim must come from the GOAL a
 *    person typed rather than from the flow the model produced, and the two
 *    must not share a context (D-23). **This function does not do that.**
 *
 * ⚠ Every suggestion is deliberately WEAK — `gte 1`, `eq 0` on a failure
 * counter, `present` on a declared key. A suggestion that guessed a number
 * ("11 rows") would be the system inventing the very fact the claim exists to
 * pin down, and the author would accept it because it looks specific. The
 * numbers have to come from the person, and the copy on screen says so.
 */
export interface ExpectationSuggestion {
  expectation: FlowExpectation;
  /** Why this is being offered, in the author's language. Rendered beside it. */
  because: string;
}

export function suggestExpectations(
  model: unknown,
  existing: FlowExpectation[] = [],
): ExpectationSuggestion[] {
  const steps = (model as { steps?: Array<Record<string, unknown>> } | null)?.steps;
  if (!Array.isArray(steps)) return [];

  // Never re-offer a claim the flow already makes about the same step and
  // subject — a list that keeps proposing what is already there is one people
  // stop reading.
  const taken = new Set(existing.map((e) => `${e.stepId}:${e.assert.type}:${claimSubject(e)}`));
  const out: ExpectationSuggestion[] = [];

  const push = (s: ExpectationSuggestion) => {
    const key = `${s.expectation.stepId}:${s.expectation.assert.type}:${claimSubject(s.expectation)}`;
    if (taken.has(key)) return;
    if (existing.some((e) => e.id === s.expectation.id)) return;
    taken.add(key);
    out.push(s);
  };

  for (const step of steps) {
    const id = typeof step.id === "string" ? step.id : null;
    const kind = typeof step.kind === "string" ? step.kind : null;
    if (!id || !kind || !EXPECTABLE_KINDS.has(kind)) continue;
    const slug = id.replace(/[^a-z0-9_]/g, "_").toLowerCase();

    if (kind === "datasource" || kind === "query") {
      push({
        expectation: {
          id: `${slug}_returned_rows`,
          stepId: id,
          description: "the query found something",
          assert: { type: "rowCount", op: "gte", value: 1 },
        },
        because:
          "a query that silently returns nothing is the commonest way a flow keeps running and " +
          "stops doing anything. ⚠ Adjust the number — and if this flow has a legitimate empty " +
          "month, this is the wrong claim to make.",
      });
    }

    if (kind === "tool") {
      push({
        expectation: {
          id: `${slug}_all_succeeded`,
          stepId: id,
          description: "every call this step made succeeded",
          assert: { type: "field", field: "failed", op: "eq", value: 0 },
        },
        because:
          "a tool step throws only when EVERY call fails, so '7 of 10 sent' is a green run today. " +
          "This is the claim that notices the other three.",
      });
    }

    if (kind === "code") {
      // From `outputKeys`, which is itself DERIVED from the contract the
      // fragment was generated against — so this suggestion inherits the
      // contract's authority rather than inventing one.
      const keys = Array.isArray(step.outputKeys) ? step.outputKeys : [];
      for (const key of keys.slice(0, 2)) {
        if (typeof key !== "string") continue;
        push({
          expectation: {
            id: `${slug}_${key.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_present`,
            stepId: id,
            description: `the fragment produced "${key}"`,
            assert: { type: "field", field: key, op: "present" },
          },
          because:
            `"${key}" is a declared output of this fragment's contract. The container already ` +
            `checks the key EXISTS; this checks it is not empty, which the contract cannot.`,
        });
      }
    }
  }
  return out;
}

function claimSubject(e: FlowExpectation): string {
  return e.assert.type === "rowCount" ? "*" : e.assert.field;
}

export const flowExpectationService = {
  suggestExpectations,
  expectationSchema,
  expectationKey,
  expectationsOf,
  evaluateOne,
  resolveOutput,
  MAX_EXPECTATIONS,
  EXPECTABLE_KINDS,

  /** Stored verdicts for one run, in declaration order where it is known. */
  async resultsFor(flowExecutionId: string): Promise<ExpectationVerdict[]> {
    const rows = await db
      .select()
      .from(flowExpectationResults)
      .where(eq(flowExpectationResults.flowExecutionId, flowExecutionId));
    return rows.map((r) => ({
      expectationId: r.expectationId,
      expectationKey: r.expectationKey,
      stepId: r.stepId,
      status: r.status as ExpectationStatus,
      detail: r.detail,
      observed: r.observedJson ?? null,
    }));
  },

  /**
   * Evaluate a run's expectations, once, and store the verdicts.
   *
   * Idempotent: a run whose verdicts are already stored returns them untouched.
   * Callers are `POST /executions/:id/complete` (eagerly, best-effort) and the
   * read paths (lazily, so a transient engine outage at completion is not
   * permanent). Both are safe because the inputs — the run's own revision and
   * the run's own outputs — are immutable.
   *
   * ⚠ **It never throws.** Its eager caller is the callback that closes an
   * execution and burns its token; a throw there would leave the run `running`
   * for ever and leak an M3 budget slot — the I-10 shape, arriving through a
   * feature that has nothing to do with budgets.
   */
  async evaluate(flowExecutionId: string): Promise<EvaluationOutcome> {
    try {
      const stored = await this.resultsFor(flowExecutionId);
      if (stored.length) return { verdicts: stored, evaluated: false };

      const execution = await flowExecutionRepo.get(flowExecutionId);
      if (!execution) return { verdicts: [], evaluated: false };
      if (!execution.flowId || execution.flowRevision == null) {
        // Flowless history (a deleted flow, or a Phase-1 run), or a run that
        // recorded no revision. There is no revision to read a claim from, so
        // there is nothing to check — and inferring one from the flow's CURRENT
        // draft would be the D-53 mistake: checking a run against claims it was
        // never subject to.
        return { verdicts: [], evaluated: false };
      }

      const revision = await flowRepo.getRevision(execution.flowId, execution.flowRevision);
      const expectations = expectationsOf(revision?.modelJson);
      if (!expectations.length) return { verdicts: [], evaluated: false };

      let view;
      try {
        view = await flowVisibilityService.get(execution.workspaceId, flowExecutionId);
      } catch (e) {
        return { verdicts: [], evaluated: false, deferred: (e as Error).message };
      }
      if (!view) return { verdicts: [], evaluated: false, deferred: "execution not readable" };

      if (view.engineUnavailable) {
        // ⚠ The engine holds the outputs (R6), so with it unreachable there is
        // nothing to check against. Defer — UNLESS the run is past the retention
        // window, at which point deferring is a promise that will never be kept.
        const expired = pastRetention(execution.startedAt);
        if (!expired) return { verdicts: [], evaluated: false, deferred: view.engineUnavailable };
      }

      const steps = new Map(view.steps.map((s) => [s.stepId, s]));
      const verdicts = expectations.map((e) => evaluateOne(e, steps.get(e.stepId)));

      await db
        .insert(flowExpectationResults)
        .values(
          verdicts.map((v) => ({
            flowExecutionId,
            flowId: execution.flowId,
            expectationId: v.expectationId,
            expectationKey: v.expectationKey,
            stepId: v.stepId,
            status: v.status,
            detail: v.detail,
            observedJson: v.observed ?? null,
          })),
        )
        // Two callers can race — the `complete` callback and a browser opening
        // the run page. First write wins; the second is a no-op, not a 500.
        .onConflictDoNothing();

      return { verdicts, evaluated: true };
    } catch (e) {
      console.warn(
        `[flow-expectation] evaluation of ${flowExecutionId} failed: ${(e as Error).message}`,
      );
      return { verdicts: [], evaluated: false, deferred: (e as Error).message };
    }
  },

  /**
   * Gate 1's second half — archive/GAPS.md §2.3.
   *
   * ⚠ **A flow that declares no expectations is unchanged, deliberately.** Every
   * flow in this deployment predates the feature, and a control that refuses
   * everything on day one is a control everybody routes around — and what gets
   * routed around is the control (the same argument D-52 makes for a draft run
   * with no sandbox). Declaring a claim is opting in to having it checked.
   *
   * ⚠ **And a passing expectation is not a correct run.** The gate goes from
   * "it ran" to "it ran and did what its author said it would". Only an oracle
   * closes the rest, and an oracle cannot be written by the flow's author.
   */
  async gateOutcome(flowId: string, draftModel: unknown) {
    const expectations = expectationsOf(draftModel);
    if (!expectations.length) {
      return { declared: 0, satisfied: true, unmet: [] as FlowExpectation[], reason: null };
    }

    const keys = expectations.map(expectationKey);
    const succeeded = await flowExecutionRepo.succeededIds(flowId);
    if (!succeeded.length) {
      return { declared: expectations.length, satisfied: false, unmet: expectations, reason: null };
    }

    const rows = await db
      .select({
        key: flowExpectationResults.expectationKey,
        status: flowExpectationResults.status,
        execId: flowExpectationResults.flowExecutionId,
      })
      .from(flowExpectationResults)
      .where(
        and(
          eq(flowExpectationResults.flowId, flowId),
          inArray(flowExpectationResults.expectationKey, keys),
        ),
      );

    // ⚠ Only a `passed` verdict on a SUCCEEDED run counts. A failed run's
    // verdicts are still recorded and still worth reading — but a claim that
    // held during a run that then fell over has not been demonstrated end to end.
    const ok = new Set<string>();
    const succeededSet = new Set(succeeded);
    for (const r of rows) {
      if (r.status === "passed" && succeededSet.has(r.execId)) ok.add(r.key);
    }

    const unmet = expectations.filter((e) => !ok.has(expectationKey(e)));
    return {
      declared: expectations.length,
      satisfied: unmet.length === 0,
      unmet,
      reason: null,
    };
  },
};

/** Kestra keeps a run's outputs for `retentionDays()`; after that nothing can be checked (D-63). */
function pastRetention(startedAt: Date | null): boolean {
  if (!startedAt) return false;
  const ageDays = (Date.now() - startedAt.getTime()) / 86_400_000;
  return ageDays > retentionDays();
}
