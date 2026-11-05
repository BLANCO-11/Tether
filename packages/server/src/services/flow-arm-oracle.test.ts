import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  rowsFrom,
  branchesOf,
  conditionHolds,
  expectedArms,
  compareArms,
  type OracleBranch,
  type RecordedRows,
} from "./flow-arm-oracle.js";

/**
 * The arm oracle — Jev programme phase 5a.
 *
 * ⚠ **This file is the drift control for a deliberate second implementation.**
 * `flow-arm-oracle.ts` re-derives, in TypeScript, the meaning that
 * `@foundry/flow-edit`'s `render.ts` emits as jq. That independence is the
 * point (it must be able to disagree with the compiler), and its cost is that
 * the two can drift. So every operator below quotes the jq program it mirrors,
 * and the nuance cases are the ones a naive reimplementation gets wrong.
 *
 * The four that are NOT obvious, and each was a real trap while writing it:
 *
 *  - `field_eq` compares against a **string**, because `render.ts` writes the
 *    right side as `JSON.stringify(value)`. `5 == "5"` is false in jq.
 *  - `field_gt`/`field_lt` use `tonumber?`, which yields NOTHING on a value
 *    that will not parse — and `Number("")` is `0` in JavaScript, so a blank
 *    field would otherwise be "less than" every threshold.
 *  - `field_present` is `has("f")` — KEY presence, so `{f: null}` is present.
 *  - `(.f // "")` replaces `false` as well as null, which is jq's alternative
 *    operator and not JavaScript's `??`.
 */

const rows = (stepId: string, data: Array<Record<string, unknown>>): RecordedRows => ({ [stepId]: data });
const cond = (op: string, field = "amount", fixed = "1000") =>
  ({ left: { stepId: "rows", field }, op, right: { fixed } }) as never;

describe("one condition against recorded rows — mirroring render.ts's jq", () => {
  it("`any` is `length > 0`", () => {
    expect(conditionHolds(cond("any") , rows("rows", [{ a: 1 }]))).toBe(true);
    expect(conditionHolds(cond("any"), rows("rows", []))).toBe(false);
  });

  it("`none` is `length == 0`", () => {
    expect(conditionHolds(cond("none"), rows("rows", []))).toBe(true);
    expect(conditionHolds(cond("none"), rows("rows", [{ a: 1 }]))).toBe(false);
  });

  it("`field_eq` is `any(.[]; .f == \"v\")` — a STRING compare", () => {
    // ⚠ The trap. `render.ts` JSON-stringifies the value, so jq compares the
    // field against a string. A TypeScript `==` would say the number 1000
    // equals "1000" and this oracle would then contradict a correct flow —
    // the one failure that discredits the whole harness.
    expect(conditionHolds(cond("field_eq"), rows("rows", [{ amount: "1000" }]))).toBe(true);
    expect(conditionHolds(cond("field_eq"), rows("rows", [{ amount: 1000 }]))).toBe(false);
  });

  it("`field_ne` is the negation, per row, under `any`", () => {
    expect(conditionHolds(cond("field_ne"), rows("rows", [{ amount: "1000" }]))).toBe(false);
    expect(conditionHolds(cond("field_ne"), rows("rows", [{ amount: "1000" }, { amount: "5" }]))).toBe(true);
  });

  it("`field_contains` / `starts` / `ends` read through `(.f // \"\")`", () => {
    const r = rows("rows", [{ region: "EU-WEST" }]);
    expect(conditionHolds(cond("field_contains", "region", "U-W"), r)).toBe(true);
    expect(conditionHolds(cond("field_starts", "region", "EU"), r)).toBe(true);
    expect(conditionHolds(cond("field_ends", "region", "WEST"), r)).toBe(true);
    expect(conditionHolds(cond("field_starts", "region", "US"), r)).toBe(false);
  });

  it("a missing field is the EMPTY STRING, not an error", () => {
    // jq's string builtins throw on null; `// \"\"` is why a row missing the
    // field is ordinary rather than fatal. A step that threw mid-guard would
    // fail the run rather than answering false.
    expect(conditionHolds(cond("field_contains", "region", "EU"), rows("rows", [{}]))).toBe(false);
    expect(conditionHolds(cond("field_empty", "region", ""), rows("rows", [{}]))).toBe(true);
  });

  it("`(.f // \"\")` replaces `false`, which `??` would not", () => {
    // jq's `//` treats `false` as absent. JavaScript's `??` does not, so a
    // direct translation gets this backwards.
    expect(conditionHolds(cond("field_empty", "flag", ""), rows("rows", [{ flag: false }]))).toBe(true);
  });

  it("`field_present` is `has(\"f\")` — KEY presence, so null is present", () => {
    expect(conditionHolds(cond("field_present", "region", ""), rows("rows", [{ region: null }]))).toBe(true);
    expect(conditionHolds(cond("field_present", "region", ""), rows("rows", [{}]))).toBe(false);
  });

  it("`field_gt` / `field_lt` compare numerically", () => {
    expect(conditionHolds(cond("field_gt", "amount", "100"), rows("rows", [{ amount: 500 }]))).toBe(true);
    expect(conditionHolds(cond("field_lt", "amount", "100"), rows("rows", [{ amount: 500 }]))).toBe(false);
    // A numeric string parses, exactly as `tonumber` does.
    expect(conditionHolds(cond("field_gt", "amount", "100"), rows("rows", [{ amount: "500" }]))).toBe(true);
  });

  it("⚠ a blank or unparseable field is NOT less than everything", () => {
    // `Number("")` is 0 in JavaScript and `"" | tonumber` is an error in jq, so
    // the empty string has to be excluded explicitly. Without that, a blank
    // field satisfies `field_lt` against every threshold and the oracle
    // reports a wrong arm on a correct flow.
    expect(conditionHolds(cond("field_lt", "amount", "100"), rows("rows", [{ amount: "" }]))).toBe(false);
    expect(conditionHolds(cond("field_lt", "amount", "100"), rows("rows", [{ amount: "abc" }]))).toBe(false);
    expect(conditionHolds(cond("field_lt", "amount", "100"), rows("rows", [{ amount: null }]))).toBe(false);
  });

  it("`any(…)` is satisfied by ONE row, not by all of them", () => {
    expect(conditionHolds(cond("field_gt", "amount", "100"), rows("rows", [{ amount: 1 }, { amount: 500 }]))).toBe(true);
  });
});

describe("what CANNOT be decided says so, and never says false", () => {
  it("rows that were not recorded are unevaluable, not empty", () => {
    // ⚠ The distinction the whole module turns on. "no rows" and "we did not
    // record the rows" are opposite answers, and conflating them makes a branch
    // nobody checked read as a branch that correctly did not fire.
    expect(conditionHolds(cond("none"), {})).toBe(null);
    expect(conditionHolds(cond("none"), rows("rows", []))).toBe(true);
  });

  it("a column-to-column comparison is unevaluable — the renderer cannot emit one either", () => {
    const c = { left: { stepId: "rows", field: "a" }, op: "field_eq", right: { stepId: "rows", field: "b" } } as never;
    expect(conditionHolds(c, rows("rows", [{ a: 1, b: 1 }]))).toBe(null);
  });

  it("a fixed LEFT side is not a rows read", () => {
    const c = { left: { fixed: "x" }, op: "field_eq", right: { fixed: "x" } } as never;
    expect(conditionHolds(c, rows("rows", [{}]))).toBe(null);
  });
});

describe("two conditions are a CONJUNCTION (D-234/D-235)", () => {
  const two = (rowsData: Array<Record<string, unknown>>) =>
    expectedArms(
      [{ id: "guard", conditions: [cond("field_gt", "amount", "100"), cond("field_eq", "region", "EU")] }] as OracleBranch[],
      rows("rows", rowsData),
    )[0]!;

  it("fires only when both hold", () => {
    expect(two([{ amount: 500, region: "EU" }]).verdict).toBe("fires");
  });

  it("skips when either fails", () => {
    expect(two([{ amount: 5, region: "EU" }]).verdict).toBe("skips");
    expect(two([{ amount: 500, region: "US" }]).verdict).toBe("skips");
  });

  it("⚠ `false AND unknown` is FALSE, not unknown", () => {
    // A verdict this module can legitimately give, and an over-cautious version
    // would throw it away — reporting `unevaluable` on a branch it could prove
    // does not fire. Coverage lost for nothing.
    const v = expectedArms(
      [{ id: "guard", conditions: [cond("field_gt", "amount", "100"), { left: { fixed: "x" }, op: "field_eq", right: { fixed: "y" } } as never] }],
      rows("rows", [{ amount: 5 }]),
    )[0]!;
    expect(v.verdict).toBe("skips");
  });

  it("`true AND unknown` is unknown", () => {
    const v = expectedArms(
      [{ id: "guard", conditions: [cond("field_gt", "amount", "100"), { left: { fixed: "x" }, op: "field_eq", right: { fixed: "y" } } as never] }],
      rows("rows", [{ amount: 500 }]),
    )[0]!;
    expect(v.verdict).toBe("unevaluable");
  });
});

describe("the CHAIN — the half a per-branch check would miss", () => {
  const chain = (rowsData: Array<Record<string, unknown>>) =>
    expectedArms(
      [
        { id: "page", conditions: [cond("field_gt", "score", "8")] },
        { id: "ticket", elseOf: "page", conditions: [cond("field_gt", "score", "4")] },
        { id: "digest", elseOf: "ticket" },
      ],
      rows("rows", rowsData),
    );

  it("exactly one arm fires — the first whose condition holds", () => {
    const v = chain([{ score: 9 }]);
    expect(v.map((x) => x.verdict)).toEqual(["fires", "skips", "skips"]);
  });

  it("⚠ an elif does NOT fire just because its own condition holds", () => {
    // `score: 9` satisfies `> 4` as well as `> 8`. A version evaluating each
    // condition in isolation reports two arms firing on a chain where exactly
    // one can — and the wrong-arm bug this phase exists for lives in that gap.
    expect(chain([{ score: 9 }])[1]!.verdict).toBe("skips");
  });

  it("the middle arm fires when the first does not", () => {
    expect(chain([{ score: 5 }]).map((x) => x.verdict)).toEqual(["skips", "fires", "skips"]);
  });

  it("the closing else fires when every earlier arm was false", () => {
    expect(chain([{ score: 1 }]).map((x) => x.verdict)).toEqual(["skips", "skips", "fires"]);
  });

  it("an unevaluable head makes the whole chain unevaluable", () => {
    // Not "the else fires". Nothing is known about the earlier arms, so nothing
    // is known about this one — and guessing would be a confident wrong answer
    // about the least inspectable thing in the product.
    const v = expectedArms(
      [
        { id: "page", conditions: [cond("field_gt", "score", "8")] },
        { id: "digest", elseOf: "page" },
      ],
      {},
    );
    expect(v.map((x) => x.verdict)).toEqual(["unevaluable", "unevaluable"]);
  });

  it("a chain naming a branch that is not in the model is unevaluable", () => {
    const v = expectedArms([{ id: "digest", elseOf: "gone" }], rows("rows", [{}]));
    expect(v[0]!.verdict).toBe("unevaluable");
  });

  it("a cycle is unevaluable rather than a hang", () => {
    const v = expectedArms(
      [
        { id: "a", elseOf: "b" },
        { id: "b", elseOf: "a" },
      ],
      rows("rows", [{}]),
    );
    expect(v.every((x) => x.verdict === "unevaluable")).toBe(true);
  });

  it("two INDEPENDENT guards can both fire — they are not a chain", () => {
    // The `itops-vuln-remediation` shape. If somebody "tidies" two independent
    // guards into an `elseOf` chain, this is the property that changes.
    const v = expectedArms(
      [
        { id: "defer", conditions: [cond("field_eq", "frozen", "yes")] },
        { id: "proceed", conditions: [cond("field_eq", "frozen", "no")] },
      ],
      rows("rows", [{ frozen: "yes" }, { frozen: "no" }]),
    );
    expect(v.map((x) => x.verdict)).toEqual(["fires", "fires"]);
  });
});

describe("the oracle against what the engine actually ran — BOTH directions", () => {
  const members = new Map([["page", ["page_call"]], ["digest", ["digest_mail"]]]);

  it("reports an arm that should have run and did not", () => {
    const f = compareArms(
      [{ stepId: "page", verdict: "fires", reason: "its condition held" }],
      members,
      new Set(["digest_mail"]),
    );
    expect(f[0]!.code).toBe("should_have_run");
  });

  it("⚠ reports an arm that RAN and should not — the direction that matters", () => {
    // "the page task ran" is satisfied by a flow that runs every arm every
    // time, which is exactly what a broken guard does. Without this direction
    // the harness passes over the failure it was built for.
    const f = compareArms(
      [{ stepId: "page", verdict: "skips", reason: "its condition did not hold" }],
      members,
      new Set(["page_call"]),
    );
    expect(f[0]!.code).toBe("ran_but_should_not");
  });

  it("says nothing when the run agrees with the oracle", () => {
    // The control. Without it, a comparator that reported every branch would
    // satisfy both assertions above.
    expect(
      compareArms(
        [
          { stepId: "page", verdict: "fires", reason: "" },
          { stepId: "digest", verdict: "skips", reason: "" },
        ],
        members,
        new Set(["page_call"]),
      ),
    ).toEqual([]);
  });

  it("⚠ an unevaluable branch is REPORTED, never silently passed", () => {
    // D-68's rule. A harness that dropped these would print a clean sheet over
    // a run it checked nothing about, and its coverage could fall to zero
    // without a single line changing.
    const f = compareArms(
      [{ stepId: "page", verdict: "unevaluable", reason: "no recorded rows for rows" }],
      members,
      new Set(["page_call"]),
    );
    expect(f[0]!.code).toBe("unevaluable");
    expect(f[0]!.message).toMatch(/nothing here can say whether that was right/);
  });

  it("a branch whose arm has no members of its own is not evidence either way", () => {
    // The branch task itself is always scheduled, so its presence says nothing
    // about which way it went. Counting it would make every empty arm a finding.
    expect(compareArms([{ stepId: "page", verdict: "fires", reason: "" }], new Map(), new Set())).toEqual([]);
  });
});

describe("the independence this module depends on", () => {
  it("imports nothing from the renderer it mirrors", () => {
    // ⚠ The whole mechanism. Importing `render.ts` would make this structurally
    // incapable of disagreeing with the compiler — "a shared oracle lets a
    // shared bug produce a wrong answer that agrees with itself". The import it
    // DOES have is `import type`, erased at compile time.
    const src = readFileSync(new URL("./flow-arm-oracle.ts", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(1000); // control: the file was actually read
    const valueImports = src
      .split("\n")
      .filter((l) => /^import /.test(l) && !/^import type /.test(l));
    expect(valueImports).toEqual([]);
  });
});

/**
 * Reading a real execution — the assembly the harness runs on.
 *
 * ⚠ **The envelope is the trap, and it is I-117**: a step's `output.body` is
 * Foundry's `{results, succeeded, failed, warnings}` wrapper, NOT the rows.
 * Every rule in the product said otherwise for weeks. Reading `body` as the
 * rows directly makes every branch unevaluable — and the harness would then
 * report full agreement over **zero** checks, which is the false green it was
 * written to remove arriving from the other side.
 */
describe("rowsFrom — the redacted step view to rows", () => {
  const envelope = (data: unknown[]) =>
    JSON.stringify({ results: [{ data }], succeeded: data.length, failed: 0, warnings: [] });

  it("reads the rows out of Foundry's envelope, not the envelope itself", () => {
    const out = rowsFrom([{ stepId: "rows", output: { body: envelope([{ amount: 5 }]) } }]);
    expect(out.rows).toEqual([{ amount: 5 }]);
  });

  it("⚠ the control: the envelope's own keys are NOT the rows", () => {
    // Without this, an implementation returning `[parsed]` passes the case above
    // for a one-row result and silently reads `succeeded`/`failed` as a data row.
    const out = rowsFrom([{ stepId: "rows", output: { body: envelope([{ amount: 5 }]) } }]);
    expect(out.rows?.[0]).not.toHaveProperty("succeeded");
    expect(out.rows?.[0]).not.toHaveProperty("results");
  });

  it("reads a transform's bare array, which carries no envelope", () => {
    const out = rowsFrom([{ stepId: "proj", output: { value: JSON.stringify([{ to: "a@b.example" }]) } }]);
    expect(out.proj).toEqual([{ to: "a@b.example" }]);
  });

  it("an empty result is EMPTY ROWS, and a missing one is ABSENT", () => {
    // The distinction the whole oracle turns on, at the point it enters.
    const out = rowsFrom([
      { stepId: "empty", output: { body: envelope([]) } },
      { stepId: "nothing", output: null },
    ]);
    expect(out.empty).toEqual([]);
    expect(out.nothing).toBeUndefined();
  });

  it("unparseable output is ABSENT, never an empty array", () => {
    // An agent step's free text, a truncated body. Reading it as "no rows" would
    // make `none` true and fire an arm on the strength of a parse failure.
    const out = rowsFrom([{ stepId: "prose", output: { value: "The digest is ready." } }]);
    expect(out.prose).toBeUndefined();
  });

  it("a redacted body still parses — redaction replaces values, not the shape", () => {
    const out = rowsFrom([
      { stepId: "rows", output: { body: envelope([{ token: "[REDACTED]", amount: 5 }]) } },
    ]);
    expect(out.rows).toEqual([{ token: "[REDACTED]", amount: 5 }]);
  });
});

describe("branchesOf — finding the guards in a stored model", () => {
  it("takes the branch steps and keeps the chain links", () => {
    const b = branchesOf({
      steps: [
        { id: "rows", kind: "datasource" },
        { id: "page", kind: "branch", conditions: [{ left: { stepId: "rows", field: "s" }, op: "any" }] },
        { id: "digest", kind: "branch", elseOf: "page" },
        { id: "mail", kind: "tool" },
      ],
    });
    expect(b.map((x) => x.id)).toEqual(["page", "digest"]);
    expect(b[1]!.elseOf).toBe("page");
  });

  it("a model with no branches yields none — the harness then checks nothing and says so", () => {
    expect(branchesOf({ steps: [{ id: "a", kind: "tool" }] })).toEqual([]);
    expect(branchesOf({})).toEqual([]);
  });
});

/**
 * ⚠ **END TO END over the assembly, with a PLANTED wrong arm.**
 *
 * The deployment this was built on holds **zero** branching flows (9 flows, 8
 * executions, measured 2026-09-22), so `arms:verify` correctly reported
 * *"NOTHING WAS CHECKED"* rather than a tick. That is the honest output and it
 * is also I-38: a control never shown to fire. These two cases run the real
 * assembly — `rowsFrom` → `branchesOf` → `expectedArms` → `compareArms` — over
 * a realistic envelope, in both directions.
 *
 * ⚠ What they still do NOT prove: that Kestra schedules the arm the compiler's
 * jq selects. That needs a branching flow executed on the engine, and it is
 * recorded as owed rather than implied.
 */
describe("the whole pipeline, on a planted wrong arm", () => {
  const steps = [
    { stepId: "rows", output: { body: JSON.stringify({ results: [{ data: [{ score: 9 }] }] }) } },
    { stepId: "digest_mail", output: null },
  ];
  const model = {
    steps: [
      { id: "rows", kind: "datasource" },
      { id: "page", kind: "branch", conditions: [{ left: { stepId: "rows", field: "score" }, op: "field_gt", right: { fixed: "8" } }] },
      { id: "digest", kind: "branch", elseOf: "page" },
    ],
  };

  it("catches the wrong arm on a run that is GREEN", () => {
    const rows = rowsFrom(steps);
    const verdicts = expectedArms(branchesOf(model), rows);
    // score 9 > 8, so `page` should fire and `digest` should not.
    expect(verdicts.map((v) => v.verdict)).toEqual(["fires", "skips"]);
    const findings = compareArms(
      verdicts,
      new Map([["page", ["page_call"]], ["digest", ["digest_mail"]]]),
      new Set(["rows", "digest_mail"]), // the DIGEST arm ran. Every task succeeded.
    );
    expect(findings.map((f) => f.code).sort()).toEqual(["ran_but_should_not", "should_have_run"]);
  });

  it("the control: the same flow with the RIGHT arm reports nothing", () => {
    const verdicts = expectedArms(branchesOf(model), rowsFrom(steps));
    expect(
      compareArms(
        verdicts,
        new Map([["page", ["page_call"]], ["digest", ["digest_mail"]]]),
        new Set(["rows", "page_call"]),
      ),
    ).toEqual([]);
  });
});
