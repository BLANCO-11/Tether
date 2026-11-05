import { describe, expect, it } from "vitest";
import {
  EXPECTABLE_KINDS,
  evaluateOne,
  expectationKey,
  expectationSchema,
  expectationsOf,
  resolveOutput,
  suggestExpectations,
  type FlowExpectation,
} from "./flow-expectation.service.js";
import { checkFlowExpectations } from "./flow-validator.service.js";
import type { StepView } from "./flow-visibility.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * Expectations — archive/GAPS.md §2.3, D-68.
 *
 * ⚠ **The organising rule of this file is that every assertion has a matched
 * pair.** An expectation vocabulary is a control, and a control that cannot fail
 * is worse than none (I-38, and this repo has now been bitten by it five times).
 * So for each assert type and each output shape there is a case that PASSES and
 * a case that FAILS on the same input shape — because "everything passes" and
 * "everything fails" both score 100% against a suite that only tests one arm.
 *
 * The third arm is `unevaluable`, and it is tested as hard as the other two: it
 * is the state that would quietly swallow a broken expectation if it were ever
 * folded into either of them.
 */

// ── Fixtures shaped like the real thing ──────────────────────────────────────

function step(partial: Partial<StepView> & { stepId: string }): StepView {
  return {
    status: "SUCCESS",
    kind: null,
    platform: false,
    ref: null,
    readFrom: null,
    attempt: 1,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    request: null,
    responseCode: null,
    output: null,
    error: null,
    logs: [],
    kestraTaskrunId: null,
    auditVerdict: null,
    oracleScore: null,
    ...partial,
  } as StepView;
}

/** A `datasource` step: Kestra's `body` is the step API's batch envelope, as a JSON string. */
function datasourceStep(rows: unknown[], stepId = "fetch"): StepView {
  return step({
    stepId,
    kind: "datasource",
    output: {
      body: JSON.stringify({
        results: [{ ok: true, data: rows }],
        succeeded: 1,
        failed: 0,
        warnings: [],
        readFrom: "production",
      }),
    },
  });
}

/** A `tool` step: one `results` entry per CALL. */
function toolStep(calls: Array<{ ok: boolean; status?: number; data?: unknown }>, stepId = "send") {
  const failed = calls.filter((c) => !c.ok).length;
  return step({
    stepId,
    kind: "tool",
    output: {
      body: JSON.stringify({
        results: calls,
        succeeded: calls.length - failed,
        failed,
        warnings: [],
      }),
    },
  });
}

/** A `code` step: I-44 — the output is `vars.result`, never `.value`. */
function codeStep(result: unknown, stepId = "compute"): StepView {
  return step({ stepId, kind: "code", output: { vars: { result, contract_ok: true } } });
}

const EMPLOYEES = [
  { name: "Ada", email: "ada@acme-hr.example", rate: 79.5 },
  { name: "Grace", email: "grace@acme-hr.example", rate: 80.95 },
  { name: "Alan", email: "alan@acme-hr.example", rate: 62.0 },
];

function expectation(over: Partial<FlowExpectation> & { assert: FlowExpectation["assert"] }) {
  return expectationSchema.parse({ id: "claim", stepId: "fetch", ...over });
}

// ── rowCount ─────────────────────────────────────────────────────────────────

describe("rowCount, over each output shape", () => {
  it("PASSES on a datasource step that returned the expected number of rows", () => {
    const v = evaluateOne(
      expectation({ assert: { type: "rowCount", op: "eq", value: 3 } }),
      datasourceStep(EMPLOYEES),
    );
    expect(v.status).toBe("passed");
    // ⚠ The detail is populated on a PASS too. `verifyTaxonomy` earned this rule:
    // a "yes" with no values behind it cannot be distinguished from a check that
    // found nothing to look at.
    expect(v.detail).toMatch(/produced 3 row\(s\)/);
  });

  it("FAILS on the same shape with a different number — the negative control", () => {
    const v = evaluateOne(
      expectation({ assert: { type: "rowCount", op: "eq", value: 11 } }),
      datasourceStep(EMPLOYEES),
    );
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/produced 3 row\(s\); expected eq 11/);
  });

  it("⚠ counts a tool step's CALLS, not the bodies they returned", () => {
    // The useful claim about a fan-out is "11 emails went out". A tool step's
    // rows are therefore its invocations; the response bodies hang off `data`.
    const s = toolStep([{ ok: true, status: 200 }, { ok: true, status: 200 }]);
    expect(evaluateOne(expectation({ stepId: "send", assert: { type: "rowCount", op: "eq", value: 2 } }), s).status).toBe("passed");
    expect(evaluateOne(expectation({ stepId: "send", assert: { type: "rowCount", op: "eq", value: 1 } }), s).status).toBe("failed");
  });

  it("counts a code step's array result, and both arms of gte", () => {
    const s = codeStep([1, 2, 3, 4]);
    const e = (value: number) =>
      evaluateOne(
        expectation({ stepId: "compute", assert: { type: "rowCount", op: "gte", value } }),
        s,
      ).status;
    expect(e(4)).toBe("passed");
    expect(e(5)).toBe("failed");
  });

  it("⚠ zero rows is a real answer, not a missing one", () => {
    // HR flags eleven employees at 2026-06 and zero at 2026-04. A `rowCount eq 0`
    // expectation at the empty period must PASS, or every flow with an empty
    // case becomes unarmable in half the months of the year.
    const s = datasourceStep([]);
    expect(evaluateOne(expectation({ assert: { type: "rowCount", op: "eq", value: 0 } }), s).status).toBe("passed");
    expect(evaluateOne(expectation({ assert: { type: "rowCount", op: "gte", value: 1 } }), s).status).toBe("failed");
  });
});

// ── field ────────────────────────────────────────────────────────────────────

describe("field, on the output object", () => {
  it("reads a code fragment's own summary — the measured failure this exists to catch", () => {
    // The script that "emailed 0 of 11 and still exited 0" would have failed
    // this and passed gate 1 without it.
    const s = codeStep({ sent: 11, skipped: 0 });
    const claim = (value: number) =>
      evaluateOne(
        expectation({ stepId: "compute", assert: { type: "field", field: "sent", op: "eq", value } }),
        s,
      );
    expect(claim(11).status).toBe("passed");
    const bad = evaluateOne(
      expectation({ stepId: "compute", assert: { type: "field", field: "sent", op: "gte", value: 1 } }),
      codeStep({ sent: 0, skipped: 11 }),
    );
    expect(bad.status).toBe("failed");
    expect(bad.detail).toMatch(/was 0; expected gte 1/);
  });

  it("reads the batch envelope's own counters on a tool step", () => {
    const s = toolStep([{ ok: true }, { ok: false }]);
    expect(evaluateOne(expectation({ stepId: "send", assert: { type: "field", field: "failed", op: "eq", value: 0 } }), s).status).toBe("failed");
    expect(evaluateOne(expectation({ stepId: "send", assert: { type: "field", field: "succeeded", op: "eq", value: 1 } }), s).status).toBe("passed");
  });

  it("⚠ a field the step never produced is UNEVALUABLE, not absent and not false", () => {
    // Comparing against `undefined` would make `neq` pass over a field nobody
    // wrote — an expectation that reports success because it could not find its
    // own subject.
    const v = evaluateOne(
      expectation({ stepId: "compute", assert: { type: "field", field: "sent", op: "neq", value: 0 } }),
      codeStep({ total: 3 }),
    );
    expect(v.status).toBe("unevaluable");
    expect(v.detail).toMatch(/produced no field "sent"/);
    // and it names what IS there, so the fix does not need a second look
    expect(v.detail).toMatch(/total/);
  });

  it("`present` and `absent` are the only ops that may omit a value, and the schema says so", () => {
    expect(() =>
      expectationSchema.parse({ id: "c", stepId: "s", assert: { type: "field", field: "x", op: "eq" } }),
    ).toThrow(/needs a `value`/);
    expect(() =>
      expectationSchema.parse({
        id: "c",
        stepId: "s",
        assert: { type: "field", field: "x", op: "present", value: 1 },
      }),
    ).toThrow(/compares against nothing/);
  });
});

// ── rows ─────────────────────────────────────────────────────────────────────

describe("rows: every / none", () => {
  it("`every … present` passes on complete data and fails on the NULL-email contractor", () => {
    const ok = evaluateOne(
      expectation({ assert: { type: "rows", quantifier: "every", field: "email", op: "present" } }),
      datasourceStep(EMPLOYEES),
    );
    expect(ok.status).toBe("passed");

    const withNull = [...EMPLOYEES, { name: "Contractor", email: null, rate: 55 }];
    const bad = evaluateOne(
      expectation({ assert: { type: "rows", quantifier: "every", field: "email", op: "present" } }),
      datasourceStep(withNull),
    );
    expect(bad.status).toBe("failed");
    expect(bad.detail).toMatch(/3 of 4 row\(s\)/);
  });

  it("`none` is not `every` negated — it reports the matches, which is what you want to see", () => {
    const bad = evaluateOne(
      expectation({
        assert: { type: "rows", quantifier: "none", field: "rate", op: "gte", value: 85 },
      }),
      datasourceStep([...EMPLOYEES, { name: "Over", email: "o@x.example", rate: 91 }]),
    );
    expect(bad.status).toBe("failed");
    expect(bad.detail).toMatch(/1 of 4 row\(s\).*expected none/);
    expect(JSON.stringify(bad.observed)).toContain("91");
  });

  it("⚠ `every` over ZERO rows passes, and SAYS it was vacuous", () => {
    // Vacuous truth is the correct answer and a misleading one. A run at the
    // empty period reporting "every row had an email" with no rows is how
    // somebody concludes the check ran when it had nothing to run on.
    const v = evaluateOne(
      expectation({ assert: { type: "rows", quantifier: "every", field: "email", op: "present" } }),
      datasourceStep([]),
    );
    expect(v.status).toBe("passed");
    expect(v.detail).toMatch(/vacuously true/);
  });

  it("⚠ an ordering op on a non-numeric value is UNEVALUABLE, never a lexical comparison", () => {
    // `"9" > "11"` is true as strings. Silently doing that would make a
    // threshold expectation report the opposite of the truth on any column that
    // arrives as text.
    const v = evaluateOne(
      expectation({ assert: { type: "rows", quantifier: "every", field: "name", op: "gt", value: 5 } }),
      datasourceStep(EMPLOYEES),
    );
    expect(v.status).toBe("unevaluable");
    expect(v.detail).toMatch(/is not a number/);
  });

  it("⚠ but a NUMERIC STRING compares numerically — Postgres returns bigints as text", () => {
    // `count(*)` comes back as "11" through node-postgres. Refusing it would
    // make the most obvious expectation anybody writes unevaluable.
    const v = evaluateOne(
      expectation({ assert: { type: "rows", quantifier: "every", field: "n", op: "gte", value: 10 } }),
      datasourceStep([{ n: "11" }, { n: "12" }]),
    );
    expect(v.status).toBe("passed");
    expect(
      evaluateOne(
        expectation({ assert: { type: "rows", quantifier: "every", field: "n", op: "gte", value: 12 } }),
        datasourceStep([{ n: "11" }, { n: "12" }]),
      ).status,
    ).toBe("failed");
  });
});

// ── Resolution failures are named refusals, never guesses ────────────────────

describe("reading a step's output", () => {
  it("refuses a kind whose output this vocabulary cannot read, by name", () => {
    const v = evaluateOne(
      expectation({ stepId: "ask", assert: { type: "rowCount", op: "eq", value: 1 } }),
      step({ stepId: "ask", kind: "approval", output: { value: "yes" } }),
    );
    expect(v.status).toBe("unevaluable");
    expect(v.detail).toMatch(/not supported on `approval` steps/);
  });

  it("a step that produced nothing is unevaluable — and not a passing rowCount of 0", () => {
    // The sharp one. A failed step has no outputs at all, and treating that as
    // an empty list would make `rowCount eq 0` pass on a step that crashed.
    const v = evaluateOne(
      expectation({ assert: { type: "rowCount", op: "eq", value: 0 } }),
      step({ stepId: "fetch", kind: "datasource", status: "failed", output: null }),
    );
    expect(v.status).toBe("unevaluable");
    expect(v.detail).toMatch(/no output/);
  });

  it("an expectation naming a step this run does not have is unevaluable, not skipped", () => {
    const v = evaluateOne(expectation({ stepId: "typo", assert: { type: "rowCount", op: "eq", value: 1 } }), undefined);
    expect(v.status).toBe("unevaluable");
    expect(v.detail).toMatch(/no step "typo"/);
  });

  it("`select` narrows to one key, and names the available keys when it misses", () => {
    const s = codeStep({ flagged: [{ id: 1 }, { id: 2 }], skipped: [] });
    expect(
      evaluateOne(
        expectation({ stepId: "compute", select: "flagged", assert: { type: "rowCount", op: "eq", value: 2 } }),
        s,
      ).status,
    ).toBe("passed");

    const miss = evaluateOne(
      expectation({ stepId: "compute", select: "flaged", assert: { type: "rowCount", op: "eq", value: 2 } }),
      s,
    );
    expect(miss.status).toBe("unevaluable");
    expect(miss.detail).toMatch(/flagged, skipped/);
  });

  it("⚠ an object output with no `select` cannot be counted, and the message says how to fix it", () => {
    const v = evaluateOne(
      expectation({ stepId: "compute", assert: { type: "rowCount", op: "eq", value: 2 } }),
      codeStep({ flagged: [{ id: 1 }, { id: 2 }] }),
    );
    expect(v.status).toBe("unevaluable");
    expect(v.detail).toMatch(/`select`/);
  });

  it("a transform whose output is not JSON is unevaluable — not empty", () => {
    const v = evaluateOne(
      expectation({ stepId: "t", assert: { type: "rowCount", op: "eq", value: 0 } }),
      step({ stepId: "t", kind: "transform", output: { value: "not json at all" } }),
    );
    expect(v.status).toBe("unevaluable");
    expect(v.detail).toMatch(/not JSON/);
  });

  it("a datasource step's rows are the UNION across invocations (M1 fan-out)", () => {
    const s = step({
      stepId: "fetch",
      kind: "datasource",
      output: {
        body: JSON.stringify({
          results: [
            { ok: true, data: [{ n: 1 }, { n: 2 }] },
            { ok: true, data: [{ n: 3 }] },
          ],
          succeeded: 2,
          failed: 0,
          warnings: [],
        }),
      },
    });
    const r = resolveOutput("datasource", s.output!, undefined);
    expect("error" in r).toBe(false);
    expect((r as { rows: unknown[] }).rows).toHaveLength(3);
  });
});

// ── The key: what re-blocks the gate, and what does not ──────────────────────

describe("expectationKey — the gate's scope", () => {
  const base = expectation({ assert: { type: "rowCount", op: "eq", value: 11 } });

  it("is stable across key ORDER in the assert object", () => {
    const a = expectationSchema.parse({
      id: "claim",
      stepId: "fetch",
      assert: { value: 11, op: "eq", type: "rowCount" },
    });
    expect(expectationKey(a)).toBe(expectationKey(base));
  });

  it("⚠ does NOT move when only the description changes", () => {
    // Re-blocking an armed flow because somebody fixed a typo in English is the
    // friction the gate's own docblock warns turns gates off.
    const reworded = { ...base, description: "eleven employees fall below the bar" };
    expect(expectationKey(reworded)).toBe(expectationKey(base));
  });

  it("DOES move when the claim changes — value, op, step or select", () => {
    const keys = new Set([
      expectationKey(base),
      expectationKey({ ...base, assert: { type: "rowCount", op: "eq", value: 12 } }),
      expectationKey({ ...base, assert: { type: "rowCount", op: "gte", value: 11 } }),
      expectationKey({ ...base, stepId: "other" }),
      expectationKey({ ...base, select: "flagged" }),
      expectationKey({ ...base, id: "renamed" }),
    ]);
    // Six distinct claims, six distinct keys. A collision here would let a run
    // that tested one claim satisfy the gate for a different one.
    expect(keys.size).toBe(6);
  });
});

// ── Validation at authoring time ─────────────────────────────────────────────

describe("checkFlowExpectations — a claim that names nothing is refused before it deploys", () => {
  const model = (expectations: unknown[]): FlowModel =>
    ({
      id: "f",
      steps: [
        { id: "fetch", kind: "datasource", ref: "hr.flagged", paramsExpr: "{{ x }}" },
        { id: "ask", kind: "approval", summaryExpr: "{{ p }}" },
      ],
      expectations,
    }) as unknown as FlowModel;

  it("accepts one that names a readable step", () => {
    expect(
      checkFlowExpectations(
        model([{ id: "c", stepId: "fetch", assert: { type: "rowCount", op: "eq", value: 1 } }]),
      ),
    ).toEqual([]);
  });

  it("⚠ REFUSES a typo'd step id, and lists the steps that exist", () => {
    // Without this the typo deploys, arms, and shows up months later as one
    // `unevaluable` row nobody reads — a claim in the bundle, on the screen and
    // in the gate that tests nothing.
    const f = checkFlowExpectations(
      model([{ id: "c", stepId: "fecth", assert: { type: "rowCount", op: "eq", value: 1 } }]),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("expectation_unknown_step");
    expect(f[0]!.blocking).toBe(true);
    expect(f[0]!.facts!.steps).toEqual(["fetch", "ask"]);
  });

  it("refuses a step whose kind produces no readable output, and names the ones that do", () => {
    const f = checkFlowExpectations(
      model([{ id: "c", stepId: "ask", assert: { type: "rowCount", op: "eq", value: 1 } }]),
    );
    expect(f[0]!.rule).toBe("expectation_unreadable_kind");
    expect(f[0]!.facts!.readable).toEqual(["fetch"]);
  });

  it("refuses two claims sharing one id — the result row is keyed on it", () => {
    const f = checkFlowExpectations(
      model([
        { id: "c", stepId: "fetch", assert: { type: "rowCount", op: "eq", value: 1 } },
        { id: "c", stepId: "fetch", assert: { type: "rowCount", op: "eq", value: 2 } },
      ]),
    );
    expect(f.some((x) => x.rule === "duplicate_expectation_id")).toBe(true);
  });

  it("a flow declaring none produces no findings at all", () => {
    expect(checkFlowExpectations(model([]))).toEqual([]);
  });

  it("EXPECTABLE_KINDS and the resolver agree about which kinds are readable", () => {
    // Two lists that must not drift: the validator refuses at authoring time
    // using the set, and the resolver refuses at evaluation time using a switch.
    // If they disagree, a claim is either refused on a step it could read or
    // accepted on one it cannot.
    for (const kind of ["tool", "datasource", "query", "code", "transform", "approval"]) {
      const readable = !("error" in resolveOutput(kind, { body: "{}", value: "{}", vars: { result: {} } }, undefined));
      expect(readable, `${kind} readability`).toBe(EXPECTABLE_KINDS.has(kind));
    }
  });
});

// ── Reading a stored model ───────────────────────────────────────────────────

describe("expectationsOf", () => {
  it("returns nothing for a model that declares none, in any of its absent shapes", () => {
    expect(expectationsOf(null)).toEqual([]);
    expect(expectationsOf({})).toEqual([]);
    expect(expectationsOf({ expectations: [] })).toEqual([]);
  });

  it("skips a stored claim that no longer parses, rather than throwing on every read", () => {
    // A revision written before a schema change must not make its own run page
    // 500. Skipping cannot weaken the gate: a skipped claim simply has no key
    // for the gate to find satisfied, so the flow stays blocked.
    const out = expectationsOf({
      expectations: [
        { id: "good", stepId: "fetch", assert: { type: "rowCount", op: "eq", value: 1 } },
        { id: "from-the-future", stepId: "fetch", assert: { type: "histogram", buckets: 4 } },
      ],
    });
    expect(out.map((e) => e.id)).toEqual(["good"]);
  });
});

// ── Suggestions — GAPS §2.3b ─────────────────────────────────────────────────

describe("suggestExpectations — a palette, and deliberately a weak one", () => {
  const model = {
    steps: [
      { id: "screen", kind: "datasource", ref: "hr.flagged" },
      { id: "notify", kind: "tool", ref: "mail_send" },
      { id: "summarise", kind: "code", outputKeys: ["sent", "skipped"] },
      { id: "ask", kind: "approval" },
      { id: "gate", kind: "approval" },
    ],
  };

  it("offers one claim per readable step, and NONE for approval", () => {
    const s = suggestExpectations(model);
    const steps = [...new Set(s.map((x) => x.expectation.stepId))].sort();
    expect(steps).toEqual(["notify", "screen", "summarise"]);
  });

  it("⚠ never guesses a NUMBER — every suggestion is weak by construction", () => {
    // A suggestion reading `rowCount eq 11` would be the system inventing the
    // fact the claim exists to pin down, and its author would accept it because
    // it looks specific. The numbers have to come from the person.
    for (const { expectation } of suggestExpectations(model)) {
      const a = expectation.assert;
      if (a.type === "rowCount") expect([a.op, a.value]).toEqual(["gte", 1]);
      else if (a.op !== "present") expect(a.value).toBe(0); // only `failed eq 0`
    }
  });

  it("derives a code step's claims from `outputKeys`, which comes from the contract", () => {
    const s = suggestExpectations(model).filter((x) => x.expectation.stepId === "summarise");
    expect(s.map((x) => (x.expectation.assert as { field: string }).field)).toEqual([
      "sent",
      "skipped",
    ]);
  });

  it("does not re-offer a claim the flow already makes about the same subject", () => {
    const existing = expectationsOf({
      expectations: [
        { id: "mine", stepId: "screen", assert: { type: "rowCount", op: "eq", value: 11 } },
      ],
    });
    const s = suggestExpectations(model, existing);
    expect(s.some((x) => x.expectation.stepId === "screen")).toBe(false);
    // …but the other steps are still offered, so one accepted claim does not
    // silence the list.
    expect(s.length).toBeGreaterThan(0);
  });

  it("every suggestion survives the real validator — a palette cannot offer a refusal", () => {
    for (const { expectation } of suggestExpectations(model)) {
      expect(expectationSchema.safeParse(expectation).success, expectation.id).toBe(true);
    }
    expect(
      checkFlowExpectations({
        ...model,
        expectations: suggestExpectations(model).map((s) => s.expectation),
      } as unknown as FlowModel),
    ).toEqual([]);
  });

  it("every suggestion carries a REASON — an unexplained one is a number to accept blindly", () => {
    for (const s of suggestExpectations(model)) expect(s.because.length).toBeGreaterThan(30);
  });

  it("returns nothing for a model with no readable steps, rather than throwing", () => {
    expect(suggestExpectations({ steps: [{ id: "ask", kind: "approval" }] })).toEqual([]);
    expect(suggestExpectations(null)).toEqual([]);
  });
});
