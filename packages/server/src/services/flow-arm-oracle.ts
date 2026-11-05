/**
 * Which arm of a branch SHOULD have fired — Jev programme phase 5a.
 *
 * ── ⚠ THE FAILURE THIS EXISTS FOR IS GREEN ──────────────────────────────────
 *
 * A branching flow that picks the wrong arm settles **SUCCESS**. The YAML is
 * valid, every expression renders, every task that ran succeeded — because the
 * tasks in the arm that should have fired were never scheduled. Nothing in
 * `kestra:check`, no unit test and no green run reports it. The only evidence is
 * which task ids appear in `taskRunList` against what should have happened.
 *
 * `itops-verify.ts` already asserts exactly this, and it is the only thing in
 * the product that can — but it is **hand-written for two flows**, against a
 * hand-written domain oracle (`itopsOracle()`), at three named instants. Every
 * other branching flow in every workspace has no such check at all.
 *
 * ── The general oracle is the CONDITION and the run's own data ───────────────
 *
 * A domain oracle cannot generalise: there is no `financeOracle()` for a flow
 * somebody built in chat this morning. But a branch's condition is a bounded,
 * decidable predicate over rows the run itself recorded — so the model plus the
 * execution is an oracle for arm selection, with no per-domain knowledge at all.
 * That is what this module computes.
 *
 * ── ⚠ IT DELIBERATELY SHARES NO CODE WITH THE RENDERER, AND THAT LOOKS LIKE A
 *      D-197 VIOLATION UNTIL YOU SEE WHAT IT IS FOR ──────────────────────────
 *
 * `@foundry/flow-edit`'s `render.ts` turns a condition into a jq program; this
 * turns the same condition into an answer, in TypeScript, from scratch. Two
 * implementations of one meaning is normally the defect this repo names most
 * often (D-197, I-127, the `llm_complete` single-comparison rule).
 *
 * It is the right shape **here**, for the same reason `legalOracle()` imports
 * nothing and must never become a parameterisation of `financeOracle()`: the
 * entire job of this module is to DISAGREE with the compiler when the compiler
 * is wrong. Calling the renderer would make it structurally incapable of that —
 * *"a shared oracle lets a shared bug produce a wrong answer that agrees with
 * itself."* The independence is the mechanism, not an oversight.
 *
 * ⚠ The cost is real and is stated rather than hidden: these two can drift, and
 * the drift surfaces as this oracle reporting a wrong arm on a correct flow.
 * `flow-arm-oracle.test.ts` pins every operator against the jq it mirrors,
 * quoting the program in the test, so a change to `render.ts` that is not
 * mirrored here has one place to go red.
 *
 * ── ⚠ `unevaluable` IS NOT A PASS ───────────────────────────────────────────
 *
 * D-68's rule, and `flow-expectation.service.ts` already states it: a claim
 * nobody could check must not read as one that held. Most real branches will be
 * `unevaluable` on any given run — the upstream step's output was not recorded,
 * or the field is not in the redacted view. That is a fact about coverage, and
 * a harness reporting it as agreement would be the false green this module was
 * written to remove, arriving from the other side.
 */

import type { BranchTest } from "@foundry/flow-edit";

/** One typed condition, in the compiler's own vocabulary. */
export type OracleSide = { stepId: string; field: string } | { fixed: string };
export interface OracleCondition {
  left: OracleSide;
  op: BranchTest;
  right?: OracleSide;
}

/** A branch step, reduced to what arm selection depends on. */
export interface OracleBranch {
  id: string;
  /** Absent on the opening `if`; names the branch this one continues. */
  elseOf?: string;
  /** ⚠ Two or more are a CONJUNCTION — every one must hold (D-234/D-235). */
  conditions?: OracleCondition[];
}

/**
 * The rows a step produced, as the REDACTED step view reports them.
 *
 * ⚠ Redacted on purpose. An oracle reading unredacted output would be a second
 * path to a credential (D-68's expectation evaluator makes the same choice, and
 * for the same reason: a predicate a tenant can re-run at will must not be able
 * to read a secret out one character at a time).
 *
 * `undefined` means *not recorded*, which is `unevaluable` — never "no rows".
 * Those two are opposite answers and conflating them is how a branch that never
 * ran reads as a branch that correctly did not.
 */
export type RecordedRows = Record<string, ReadonlyArray<Record<string, unknown>> | undefined>;

export type Verdict = "fires" | "skips" | "unevaluable";

export interface ArmVerdict {
  stepId: string;
  verdict: Verdict;
  /** Why — always populated, because a bare verdict is not reviewable. */
  reason: string;
}

// ── the eleven operators, mirrored from `render.ts`'s jq ─────────────────────
//
// ⚠ Every nuance below is one the jq has and a naive reimplementation would
// not. They are the whole reason this file is longer than it looks like it
// should be, and each is named against the program it mirrors.

/**
 * One row against one condition.
 *
 * ⚠ `value` is compared as the jq compares it: `render.ts` writes the right
 * side as `JSON.stringify(value ?? "")`, so `field_eq` tests a **string**.
 * `.n == "5"` is FALSE in jq when `.n` is the number 5, and a TypeScript `==`
 * would have said true — which would make this oracle disagree with a correct
 * flow, the one failure mode that discredits the whole harness.
 */
function rowMatches(row: Record<string, unknown>, field: string, op: BranchTest, value: string): boolean {
  const raw = row[field];
  // `(.f // "")` — jq's alternative operator, which also replaces `false`.
  const orEmpty = raw === undefined || raw === null || raw === false ? "" : String(raw);
  switch (op) {
    case "field_eq":
      // Strict, and against the STRING form — see the docblock above.
      return raw === value;
    case "field_ne":
      return raw !== value;
    case "field_contains":
      return orEmpty.includes(value);
    case "field_starts":
      return orEmpty.startsWith(value);
    case "field_ends":
      return orEmpty.endsWith(value);
    case "field_empty":
      return orEmpty === "";
    case "field_present":
      // ⚠ `has("f")` is KEY PRESENCE. A row with `{f: null}` has the key, so
      // this is true — `.f != null` would be a different predicate, and the
      // jq says `has`.
      return Object.prototype.hasOwnProperty.call(row, field);
    case "field_gt":
    case "field_lt": {
      // ⚠ `tonumber?` yields NOTHING on a value that will not parse, so the row
      // contributes no answer to `any(…)` — it is not false-and-counted, it is
      // absent. `Number("")` is 0 in JavaScript and `"" | tonumber` is an error
      // in jq, so the empty string must be excluded explicitly or this oracle
      // says a blank field is less than every threshold.
      if (raw === undefined || raw === null || raw === "") return false;
      const n = Number(raw);
      if (!Number.isFinite(n)) return false;
      const want = Number(value);
      if (!Number.isFinite(want)) return false;
      return op === "field_gt" ? n > want : n < want;
    }
    case "any":
    case "none":
      // Not row-scoped; handled by the caller.
      return false;
  }
}

/** One condition against the recorded rows. `null` = could not be decided. */
export function conditionHolds(c: OracleCondition, rows: RecordedRows): boolean | null {
  if (!("stepId" in c.left)) return null; // a fixed left side is not a rows read
  const over = rows[c.left.stepId];
  if (over === undefined) return null;

  if (c.op === "any") return over.length > 0;
  if (c.op === "none") return over.length === 0;

  const field = c.left.field.replace(/[^A-Za-z0-9_]/g, "");
  if (!field) return null;
  // ⚠ A `fixed` right side is the only comparable one. `{stepId, field}` on the
  // right is a column-to-column comparison the RENDERER cannot emit either
  // (`render.ts` takes a single `value` string), so returning `null` here is
  // agreement about a shared limit rather than a gap in this module.
  if (!c.right || !("fixed" in c.right)) return null;
  const value = c.right.fixed;

  // `any(.[]; …)` — true when ANY row matches.
  return over.some((r) => rowMatches(r, field, c.op, value));
}

/**
 * Whether a branch's OWN condition holds, before the chain is considered.
 *
 * ⚠ Two or more conditions are a CONJUNCTION (D-234). An unevaluable conjunct
 * makes the whole thing unevaluable **unless another conjunct is already
 * false** — `false AND unknown` is false, and reporting that as unknown would
 * lose a verdict this module can legitimately give.
 */
function ownCondition(b: OracleBranch, rows: RecordedRows): boolean | null {
  const cs = b.conditions ?? [];
  if (cs.length === 0) return null;
  let unknown = false;
  for (const c of cs) {
    const held = conditionHolds(c, rows);
    if (held === false) return false;
    if (held === null) unknown = true;
  }
  return unknown ? null : true;
}

/**
 * Every branch's verdict, chain rules applied.
 *
 * ⚠ **The chain is the half a per-branch check would miss.** An `elif` fires
 * only when its own condition holds AND every earlier branch in its chain did
 * not — which is what the compiler emits as a real Kestra `else:` rather than a
 * negated copy. A version that evaluated each condition in isolation would
 * report two arms firing on a chain where exactly one can, and the wrong-arm
 * bug this whole phase is about lives precisely in that gap.
 */
export function expectedArms(branches: ReadonlyArray<OracleBranch>, rows: RecordedRows): ArmVerdict[] {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const memo = new Map<string, Verdict>();

  /**
   * The chain a branch belongs to, head first.
   *
   * ⚠ Built by walking `elseOf` BACK to the opening `if`, then evaluating
   * FORWARD. The first version evaluated each branch against its predecessor's
   * verdict and was wrong in a way its own test caught: `skips` conflates two
   * different facts — *my condition was false* and *an earlier arm already won*
   * — and only the first of them lets the next arm fire. On `if score>8 / elif
   * score>4 / else`, a score of 9 made `page` fire, `ticket` skip (correctly,
   * because `page` won), and then `digest` fire as well, because its
   * predecessor had "skipped". **Two arms firing on a chain where exactly one
   * can** is precisely the wrong-arm bug this module exists to report.
   */
  const chainOf = (b: OracleBranch): OracleBranch[] => {
    const chain: OracleBranch[] = [];
    const seen = new Set<string>();
    let cur: OracleBranch | undefined = b;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.elseOf ? byId.get(cur.elseOf) : undefined;
    }
    // A chain whose head still names an `elseOf` never reached the opening
    // `if` — either a cycle (`seen` stopped it) or a branch not in the model.
    const head = chain[0]!;
    return head.elseOf ? [] : chain;
  };

  const verdictOf = (b: OracleBranch): Verdict => {
    const cached = memo.get(b.id);
    if (cached) return cached;

    const chain = chainOf(b);
    // An unresolvable chain decides nothing, for every member of it.
    if (chain.length === 0) {
      memo.set(b.id, "unevaluable");
      return "unevaluable";
    }

    let decided: Verdict | undefined;
    for (const arm of chain) {
      if (decided === "fires") {
        // Something earlier already won; everything after it is skipped.
        memo.set(arm.id, "skips");
        if (arm.id === b.id) return "skips";
        continue;
      }
      // A closing `else` carries no condition and fires outright once every
      // earlier arm is known false; an `elif` still needs its own condition.
      const own = (arm.conditions ?? []).length === 0 && arm.elseOf ? true : ownCondition(arm, rows);
      const v: Verdict = own === null ? "unevaluable" : own ? "fires" : "skips";
      if (v === "unevaluable") {
        // ⚠ Everything downstream of an undecided arm is also undecided. It is
        // NOT "the else fires" — nothing is known about the earlier arms, so
        // nothing is known about this one, and guessing would be a confident
        // wrong answer about the least inspectable thing in the product.
        for (const rest of chain.slice(chain.indexOf(arm))) memo.set(rest.id, "unevaluable");
        return "unevaluable";
      }
      memo.set(arm.id, v);
      if (v === "fires") decided = "fires";
      if (arm.id === b.id) return v;
    }
    return memo.get(b.id) ?? "unevaluable";
  };

  return branches.map((b) => {
    const verdict = verdictOf(b);
    return { stepId: b.id, verdict, reason: reasonFor(b, verdict, rows) };
  });
}

function reasonFor(b: OracleBranch, v: Verdict, rows: RecordedRows): string {
  const cs = b.conditions ?? [];
  if (v === "unevaluable") {
    const missing = cs
      .map((c) => ("stepId" in c.left ? c.left.stepId : null))
      .filter((s): s is string => s !== null && rows[s] === undefined);
    if (missing.length > 0) {
      return `no recorded rows for ${[...new Set(missing)].join(", ")} — the condition could not be decided`;
    }
    if (b.elseOf) return `the branch it continues ("${b.elseOf}") could not be decided`;
    return "the condition could not be decided from what this run recorded";
  }
  if (cs.length === 0 && b.elseOf) {
    return v === "fires" ? "every earlier arm in the chain was false" : "an earlier arm in the chain fired";
  }
  return v === "fires"
    ? `every one of its ${cs.length} condition(s) held`
    : "its condition did not hold, or an earlier arm in the chain fired";
}

// ── comparing the oracle against what the engine actually ran ────────────────

export interface ArmFinding {
  stepId: string;
  /** `wrong_arm` — it ran and should not, or did not run and should have. */
  code: "ran_but_should_not" | "should_have_run" | "unevaluable";
  message: string;
}

/**
 * The oracle against the run. ⚠ **Both directions**, and the second is the one
 * that matters: *"the page task ran"* is satisfied by a flow that runs every arm
 * every time, which is exactly what a broken guard does.
 *
 * ⚠ `unevaluable` is REPORTED, never silently skipped. A harness that dropped
 * them would print a clean sheet over a run it checked nothing about, and its
 * coverage would fall to zero without a single line changing.
 */
export function compareArms(
  expected: ReadonlyArray<ArmVerdict>,
  armMembers: ReadonlyMap<string, ReadonlyArray<string>>,
  ranTaskIds: ReadonlySet<string>,
): ArmFinding[] {
  const out: ArmFinding[] = [];
  for (const e of expected) {
    const members = armMembers.get(e.stepId) ?? [];
    // ⚠ An arm with no members of its own is not evidence either way — the
    // branch task itself is always scheduled, so its presence says nothing
    // about which way it went.
    if (members.length === 0) continue;
    const anyRan = members.some((m) => ranTaskIds.has(m));

    if (e.verdict === "unevaluable") {
      out.push({
        stepId: e.stepId,
        code: "unevaluable",
        message: `"${e.stepId}": ${e.reason}. Its arm ${anyRan ? "ran" : "did not run"}, and nothing here can say whether that was right.`,
      });
      continue;
    }
    if (e.verdict === "fires" && !anyRan) {
      out.push({
        stepId: e.stepId,
        code: "should_have_run",
        message: `"${e.stepId}" should have fired — ${e.reason} — and none of its arm ran. The execution is still green.`,
      });
    }
    if (e.verdict === "skips" && anyRan) {
      out.push({
        stepId: e.stepId,
        code: "ran_but_should_not",
        message: `"${e.stepId}" fired and should not have — ${e.reason}. The wrong arm ran and the execution is still green.`,
      });
    }
  }
  return out;
}

// ── reading a real execution: the assembly the harness used to hold ─────────
//
// ⚠ Moved OUT of `scenarios/arms-verify.ts` so it can be tested. A scenario
// script's `main()` runs at IMPORT, so importing one from a test loads the
// repos, the config and the gateway client and calls `process.exit` inside the
// suite — the trap `propose-measure.test.ts` hit, and the reason
// `propose-adjudicate.ts` is its own module.

/**
 * The rows a step produced, out of the REDACTED step view.
 *
 * ⚠ `output.body` is Foundry's ENVELOPE, not the payload — `{results, succeeded,
 * failed, warnings}`, with the rows at `.results[0].data`. That sentence is
 * I-117, the platform-coherence programme's first critical: every rule in the
 * product said otherwise for weeks. Reading `body` as the rows directly would
 * make every branch unevaluable and the harness would report full agreement
 * over zero checks.
 */
export function rowsFrom(steps: ReadonlyArray<{ stepId: string; output: unknown }>): RecordedRows {
  const out: RecordedRows = {};
  for (const s of steps) {
    const o = s.output as { body?: unknown; value?: unknown } | null;
    if (!o) continue;
    const raw = typeof o.body === "string" ? o.body : typeof o.value === "string" ? o.value : null;
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // not JSON — nothing to read, and `undefined` means unevaluable
    }
    const env = parsed as { results?: Array<{ data?: unknown }> };
    const data = env?.results?.[0]?.data;
    if (Array.isArray(data)) {
      out[s.stepId] = data as Array<Record<string, unknown>>;
    } else if (Array.isArray(parsed)) {
      // A `transform` yields the projected array directly rather than an envelope.
      out[s.stepId] = parsed as Array<Record<string, unknown>>;
    }
  }
  return out;
}

export function branchesOf(model: { steps?: ReadonlyArray<unknown> }): OracleBranch[] {
  return (model.steps ?? [])
    .filter((s): s is { kind: string } => !!s && typeof s === "object" && (s as { kind?: string }).kind === "branch")
    .map((s) => {
      const b = s as unknown as { id: string; elseOf?: string; conditions?: unknown[] };
      return { id: b.id, elseOf: b.elseOf, conditions: (b.conditions ?? []) as never };
    });
}

