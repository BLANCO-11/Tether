/**
 * The builder pins — moved from `packages/client/src/lib/flow-expr.test.ts`
 * with the builders themselves (Stage 3.2).
 *
 * The claim here is exact strings: these are the programs that were run
 * against the engine before they were offered, and what this suite guards is
 * that they do not drift away from the verified ones. The D-22 allowlist claim
 * ("everything built is inside the boundary by construction") stays beside the
 * preview that checks it, in the client's `flow-expr.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  BRANCH_TESTS,
  buildApprovalSummary,
  buildCodeInput,
  buildCondition,
  buildFanOutParams,
  buildSingleParams,
  outputExpr,
  rowsExpr,
  type OutputShapes,
  toEscapedInputSpelling,
  toLegacyInputSpelling,
} from "./render.js";
import type { AuthoredStep } from "./index.js";

/** The shapes as the catalogue serves them — the server's table, verbatim. */
const SHAPES: OutputShapes = {
  datasource: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  // A DB operation uses the SAME envelope as a named query: `core.http.Request`
  // answered by ops-api with `{results: [{data: [...]}]}` (Phase 4).
  query: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  tool: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  // A merge emits the same task type a transform does, so it shares that
  // spelling — see `OUTPUT_SHAPES.merge` server-side for why that holds
  // whichever arm actually ran.
  merge: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  transform: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  code: { template: "outputs.<id>.vars.result", describes: null, caution: null },
  approval: { template: null, describes: null, caution: null },
  branch: { template: null, describes: null, caution: null },
};

const fetch: AuthoredStep = {
  kind: "datasource",
  id: "fetch",
  ref: "finance_demo.invoices_overdue",
  paramsExpr: "[{}]",
};
const rank: AuthoredStep = {
  kind: "code",
  id: "rank",
  inputExpr: "{}",
  contract: { purpose: "rank", input: [], output: [{ name: "ranked", type: "array" }] },
};

describe("output shapes are applied, not guessed", () => {
  it("a code step's output is .vars.result, not .value (I-44)", () => {
    expect(outputExpr(SHAPES, "code", "rank")).toBe("outputs.rank.vars.result");
  });

  it("a gate has no output to read", () => {
    expect(outputExpr(SHAPES, "approval", "gate")).toBeNull();
  });

  it("a query's ROWS are under .results[0].data, its body is not", () => {
    expect(rowsExpr(SHAPES, fetch)).toBe("json(outputs.fetch.body).results[0].data");
    expect(rowsExpr(SHAPES, rank)).toBe("outputs.rank.vars.result");
    // A `query` step reads the same envelope a named query does (Phase 4).
    const op: AuthoredStep = { kind: "query", id: "op", ref: "hr.attendance_by_dept", paramsExpr: "[{}]" };
    expect(rowsExpr(SHAPES, op)).toBe("json(outputs.op.body).results[0].data");
    // A fan-out call ran once per element: every call's rows, not call 0's (phase 7, R03).
    expect(rowsExpr(SHAPES, { ...fetch, over: { stepId: "people", field: "" } } as never)).toBe(
      `json(outputs.fetch.body) | jq('[.results[]?.data | if type == "array" then .[] else . end]') | first`,
    );
  });
});

describe("the shapes the runtime actually requires", () => {
  it("a fan-out produces an ARRAY — one object per invocation, never a loop (M1)", () => {
    const e = buildFanOutParams(SHAPES, fetch, [
      { param: "to_email", source: { from: "step", stepId: "fetch", field: "contact_email" } },
    ])!;
    expect(e).toContain("jq('[.[] | {");
    expect(e.trimEnd().endsWith("| first }}")).toBe(true);
  });

  it("buildSingleParams is an array of one", () => {
    const e = buildSingleParams([{ param: "period", source: { from: "literal", value: "2026-06" } }])!;
    expect(JSON.parse(e)).toEqual([{ period: "2026-06" }]);
  });

  it("an empty single call is the canonical blank, byte-identical to a fresh step", () => {
    expect(buildSingleParams([])).toBe("[{}]");
  });

  /**
   * E3.1: a single call reading a step field used to render `""` — "post the
   * summary's text to chat" ran green and posted empty text. Now the whole
   * object is built in jq over that ONE upstream's output (I-11).
   */
  describe("a single call over ONE upstream's output", () => {
    const summary: AuthoredStep = { kind: "tool", id: "summary", ref: "llm_complete", paramsExpr: "[{}]" };
    const ctx = { shapes: SHAPES, steps: [fetch, summary, rank] };

    it("literal/input-only output is byte-identical with or without a context", () => {
      const m = [
        { param: "period", source: { from: "input" as const, inputId: "period" } },
        { param: "to", source: { from: "literal" as const, value: "a@b.example" } },
      ];
      // I-288: the input is an escaped JSON literal of its TEXT, never spliced between quotes.
      expect(buildSingleParams(m, ctx)).toBe(`[{ "period": {{ (inputs.period ~ '') | toJson }}, "to": "a@b.example" }]`);
      expect(buildSingleParams(m)).toBe(buildSingleParams(m, ctx));
    });

    it("a step field is read in jq, never written as an empty string", () => {
      const e = buildSingleParams(
        [
          { param: "text", source: { from: "step", stepId: "summary", field: "text" } },
          { param: "channel", source: { from: "literal", value: "ops" } },
        ],
        ctx,
      );
      expect(e).toBe(
        `{{ json(outputs.summary.body).results[0].data | jq('[{"text": (if type == "array" then [.[] | .text] else .text end), "channel": "ops"}]') | first }}`,
      );
      expect(e).not.toContain(`""`);
    });

    it("a flow input beside a step read is spliced with ~, never nested {{ }} (I-11)", () => {
      const e = buildSingleParams(
        [
          { param: "rows", source: { from: "whole", stepId: "fetch" } },
          { param: "period", source: { from: "input", inputId: "period" } },
        ],
        ctx,
      )!;
      expect(e).toBe(
        `{{ json(outputs.fetch.body).results[0].data | jq('[{"rows": ., "period": ' ~ ((inputs.period ~ '') | toJson) ~ '}]') | first }}`,
      );
      expect(e.slice(2).includes("{{")).toBe(false);
    });

    it("a literal's {{ inputs.x }} placeholder is SPLICED in the jq form, never left in the program (I-11)", () => {
      const e = buildSingleParams(
        [
          { param: "subject", source: { from: "literal", value: 'Report for {{ inputs.period }} ("draft")' } },
          { param: "body", source: { from: "step", stepId: "summary", field: "text" } },
        ],
        ctx,
      )!;
      expect(e).toContain(`jq('[{"subject": "Report for ' ~ inputs.period ~ ' (\\"draft\\")", "body": `);
      expect(e.slice(2).includes("{{")).toBe(false);
      // The plain JSON form is ONE template, so there the placeholder renders as written.
      expect(buildSingleParams([{ param: "s", source: { from: "literal", value: "R {{ inputs.period }}" } }])).toBe(`[{ "s": "R {{ inputs.period }}" }]`);
    });

    it("an apostrophe never reaches the Pebble literal raw — it is jq's \\u0027 (R05)", () => {
      const programOf = (e: string) => /jq\('([\s\S]*)'\) \| first/.exec(e)![1]!.split("' ~ ").join("").split(" ~ '").join("");
      const single = buildSingleParams(
        [
          { param: "input", source: { from: "whole", stepId: "fetch", transform: "text" } },
          { param: "instruction", source: { from: "literal", value: "summarise this month's attendance" } },
        ],
        ctx,
      )!;
      expect(single).toContain(`"instruction": "summarise this month\\u0027s attendance"`);
      expect(programOf(single)).not.toContain("'");
      const fan = buildFanOutParams(SHAPES, fetch, [{ param: "who", source: { from: "literal", value: "O'Brien" } }], {
        test: "field_eq",
        field: "name",
        value: "O'Brien",
      })!;
      expect(programOf(fan)).not.toContain("'");
      // And a value WITHOUT one is byte-identical to before.
      expect(buildSingleParams([{ param: "s", source: { from: "literal", value: "plain" } }], ctx)).toBe(`[{ "s": "plain" }]`);
    });

    it("a whole output as TEXT is `tostring` — what a text port like llm_complete.input takes", () => {
      const e = buildSingleParams(
        [
          { param: "input", source: { from: "whole", stepId: "fetch", transform: "text" } },
          { param: "instruction", source: { from: "literal", value: "summarise" } },
        ],
        ctx,
      );
      expect(e).toBe(
        `{{ json(outputs.fetch.body).results[0].data | jq('[{"input": (. | tostring), "instruction": "summarise"}]') | first }}`,
      );
    });

    it("a transform wraps every element as well as a single value", () => {
      const e = buildSingleParams([{ param: "due", source: { from: "step", stepId: "fetch", field: "due_date", transform: "date" } }], ctx)!;
      expect(e).toContain(`[.[] | .due_date | tostring | split("T")[0]] else .due_date | tostring | split("T")[0] end`);
    });

    it("reads from two upstreams are refused — combine them in a transform", () => {
      expect(
        buildSingleParams(
          [
            { param: "a", source: { from: "step", stepId: "fetch", field: "x" } },
            { param: "b", source: { from: "step", stepId: "summary", field: "text" } },
          ],
          ctx,
        ),
      ).toBeNull();
    });

    it("a step read with no context, or an unknown / unaddressable upstream, is refused", () => {
      const read = [{ param: "t", source: { from: "step" as const, stepId: "summary", field: "text" } }];
      expect(buildSingleParams(read)).toBeNull();
      expect(buildSingleParams([{ param: "t", source: { from: "step", stepId: "ghost", field: "x" } }], ctx)).toBeNull();
      const gate: AuthoredStep = { kind: "approval", id: "gate", summaryExpr: "", prompt: "" } as unknown as AuthoredStep;
      expect(buildSingleParams([{ param: "t", source: { from: "whole", stepId: "gate" } }], { shapes: SHAPES, steps: [gate] })).toBeNull();
    });
  });

  /**
   * ⚠ I-42 as a checkbox. A timestamp cannot cross into an `http.Request` body
   * via `jq()`; the mitigation is flattening it to YYYY-MM-DD in the projection.
   */
  it("the date control emits split(\"T\")[0]", () => {
    const e = buildFanOutParams(SHAPES, fetch, [
      { param: "due", source: { from: "step", stepId: "fetch", field: "due_date", transform: "date" } },
    ])!;
    expect(e).toContain('split("T")[0]');
  });

  /** ⚠ I-43 — `@json` is a jq encoder, so it belongs INSIDE the jq program. */
  it("an approval summary encodes with @json inside the jq program", () => {
    const e = buildApprovalSummary(SHAPES, fetch, "Send?");
    expect(e).toContain("| @json') | first }}");
    expect(e).not.toContain("') | @json");
  });

  /** ⚠ I-11 — a flow input in the question is spliced with `~`, never left inside the jq argument. */
  it("an approval summary over rows splices {{ inputs.x }} with ~", () => {
    const e = buildApprovalSummary(SHAPES, fetch, "Send the chases for {{ inputs.period }}?");
    expect(e).toContain("' ~ inputs.period ~ '");
    expect(e.slice(2)).not.toContain("{{");
  });

  /** ⚠ I-11 — `summaryExpr`/`promptExpr` must be a JSON STRING, quotes included. */
  it("a gate with no upstream rows is still a quoted JSON string", () => {
    const e = buildApprovalSummary(SHAPES, null, 'Approve the "big" send?');
    expect(() => JSON.parse(e)).not.toThrow();
    expect(JSON.parse(e)).toBe('Approve the "big" send?');
  });

  it("a literal containing a quote does not break out of the jq string", () => {
    const e = buildFanOutParams(SHAPES, fetch, [
      { param: "subject", source: { from: "literal", value: 'say "hi"' } },
    ])!;
    expect(e).toContain('\\"hi\\"');
  });
});

/**
 * ⚠ **THESE STRINGS WERE RUN AGAINST THE ENGINE BEFORE THEY WERE OFFERED**
 * (2026-09-03, a probe flow in `foundry.system`, executed and deleted). Each
 * operator was checked to answer `true` on data that should match and `false`
 * on data that should not — an operator that always answered the same thing
 * would otherwise be indistinguishable from one that works.
 *
 * These unit tests pin the exact programs that were measured. They cannot
 * re-run the engine, so what they guard is that the strings do not drift away
 * from the ones that were verified.
 */
describe("the branch operators are the ones that were measured", () => {
  const over = { kind: "datasource", id: "read", ref: "q", paramsExpr: "[{}]" } as never;
  const cond = (t: string, f?: string, v?: string) => buildCondition(SHAPES, over, t as never, f, v);

  it("every offered test has a builder that produces something", () => {
    for (const t of BRANCH_TESTS) {
      const out = cond(t.test, "status", t.test === "field_gt" || t.test === "field_lt" ? "5" : "open");
      expect(out, `${t.test} produced nothing`).not.toBe("");
      expect(out).toMatch(/^\{\{ .* \| first \}\}$/);
    }
  });

  /**
   * ⚠ **THE NUMERIC TRAP, AND IT IS MEASURED.** `any(.[]; .n > 5)` where `.n`
   * is the STRING `"2"` returned **true** on the engine — jq's total ordering
   * puts every string above every number. On a guard that means the arm ALWAYS
   * runs. `tonumber?` is the whole difference, and it was measured to yield
   * `false` rather than erroring on `null` and on `"not-a-number"`.
   */
  it("⚠ a numeric comparison coerces, and never compares a raw field", () => {
    for (const t of ["field_gt", "field_lt"]) {
      const out = cond(t, "n", "5");
      expect(out).toContain("tonumber?");
      expect(out).not.toMatch(/\.n [<>] 5/);
    }
  });

  /**
   * ⚠ **jq's string builtins ERROR on null**, and a row missing the field is
   * the ordinary case. A guard that throws fails the run instead of answering
   * false, which is a much louder failure than the wrong answer it replaces —
   * but still not the answer.
   */
  it("⚠ string tests survive a missing field", () => {
    for (const t of ["field_contains", "field_starts", "field_ends", "field_empty"]) {
      expect(cond(t, "name", "x")).toContain('// ""');
    }
  });

  /**
   * ⚠ **A non-numeric value has NO safe program**, so none is produced. The
   * alternative — emitting `tonumber? > NaN` — is a guard that is always false,
   * which reads on screen as a configured condition and silently stops the arm
   * ever running.
   */
  it("refuses a numeric comparison whose value is not a number", () => {
    expect(cond("field_gt", "n", "lots")).toBe("");
    // The control: the same operator with a real number does build.
    expect(cond("field_gt", "n", "5")).not.toBe("");
  });

  it("refuses any field test with no field, rather than guessing one", () => {
    expect(cond("field_eq", "", "open")).toBe("");
    expect(cond("field_eq", "status", "open")).not.toBe("");
  });
});

describe("per-item routing — iterate a list, route each item", () => {
  const names = { kind: "transform", id: "names", expr: "{{ [...] }}" } as never;

  it("maps the bare element when the source is the item itself", () => {
    const e = buildFanOutParams(SHAPES, names, [{ param: "name", source: { from: "self" } }]);
    expect(e).toBe(`{{ json(outputs.names.value) | jq('[.[] | {"name": .}]') | first }}`);
  });

  it("a self predicate on a number list selects each matching element", () => {
    const e = buildFanOutParams(
      SHAPES,
      names,
      [{ param: "num", source: { from: "self" } }],
      { test: "field_gt", field: "", value: "5" },
    );
    expect(e).toBe(`{{ json(outputs.names.value) | jq('[.[] | select((. | tonumber?) > 5) | {"num": .}]') | first }}`);
  });

  it("a field predicate splits one list across destinations — the if/elif routing", () => {
    const mapping = [{ param: "value", source: { from: "step", stepId: "fetch", field: "amount" } }] as const;
    const hi = buildFanOutParams(SHAPES, fetch, [...mapping], { test: "field_gt", field: "amount", value: "10000" });
    const lo = buildFanOutParams(SHAPES, fetch, [...mapping], { test: "field_lt", field: "amount", value: "10000" });
    expect(hi).toBe(
      `{{ json(outputs.fetch.body).results[0].data | jq('[.[] | select((.amount | tonumber?) > 10000) | {"value": .amount}]') | first }}`,
    );
    expect(lo).toBe(
      `{{ json(outputs.fetch.body).results[0].data | jq('[.[] | select((.amount | tonumber?) < 10000) | {"value": .amount}]') | first }}`,
    );
  });

  it("gte/lte close the band the gt/lt pair leaves open", () => {
    const e = buildFanOutParams(
      SHAPES,
      fetch,
      [{ param: "value", source: { from: "step", stepId: "fetch", field: "amount" } }],
      { test: "field_gte", field: "amount", value: "70" },
    );
    expect(e).toContain("select((.amount | tonumber?) >= 70)");
  });

  it("a string predicate on a field is null-safe, like the branch guard", () => {
    const e = buildFanOutParams(
      SHAPES,
      fetch,
      [{ param: "to_email", source: { from: "step", stepId: "fetch", field: "contact_email" } }],
      { test: "field_contains", field: "contact_email", value: "acme" },
    );
    expect(e).toContain(`select((.contact_email // "") | contains("acme"))`);
  });

  it("⚠ a predicate that builds nothing builds no expression — never an unfiltered fan-out", () => {
    // `gt` with a non-number has no honest reading; emitting the fan-out
    // without the `select` would send every row where a subset was asked for.
    expect(
      buildFanOutParams(
        SHAPES,
        fetch,
        [{ param: "value", source: { from: "step", stepId: "fetch", field: "amount" } }],
        { test: "field_gt", field: "amount", value: "not-a-number" },
      ),
    ).toBeNull();
  });

  it("a self source in a single call is the same empty placeholder as an unaddressable field", () => {
    expect(buildSingleParams([{ param: "num", source: { from: "self" } }])).toBe(`[{ "num": "" }]`);
  });
});

describe("a literal inside a jq program is escaped like JSON (I-289)", () => {
  it("a newline, a tab and a control character become escapes, never raw bytes in the program", () => {
    const e = buildFanOutParams(SHAPES, fetch as never, [
      { param: "to", source: { from: "step", stepId: "fetch", field: "email" } },
      { param: "target", source: { from: "literal", value: "not a value\nsecond\tline\u0001" } },
    ] as never)!;
    expect(e).toContain(String.raw`"not a value\nsecond\tline\u0001"`);
    expect(/[\u0000-\u001f]/.test(e)).toBe(false);
    // CONTROL: a value with no control character is byte-identical to before.
    const plain = buildFanOutParams(SHAPES, fetch as never, [{ param: "target", source: { from: "literal", value: "one line" } }] as never)!;
    expect(plain).toContain(`"target": "one line"`);
  });
});


describe("the two input spellings map exactly onto each other (I-288)", () => {
  const forms = () => [
    buildSingleParams([{ param: "p", source: { from: "input", inputId: "period" } }, { param: "q", source: { from: "literal", value: "x" } }] as never)!,
    buildSingleParams([{ param: "m", source: { from: "input", inputId: "month", transform: "month" } }] as never)!,
    buildFanOutParams(SHAPES, fetch as never, [
      { param: "to", source: { from: "step", stepId: "fetch", field: "email" } },
      { param: "period", source: { from: "input", inputId: "period" } },
      { param: "day", source: { from: "input", inputId: "day", transform: "date" } },
    ] as never)!,
  ];
  it("legacy then escaped is the identity on every builder output, and escaped is idempotent", () => {
    for (const f of forms()) {
      expect(toLegacyInputSpelling(f)).not.toBe(f); // CONTROL: each form carries an input to map
      expect(toEscapedInputSpelling(toLegacyInputSpelling(f))).toBe(f);
      expect(toEscapedInputSpelling(f)).toBe(f);
    }
  });
  it("the legacy form holds no escaped spelling, and the escaped form no legacy one", () => {
    for (const f of forms()) {
      expect(toLegacyInputSpelling(f)).not.toMatch(/toJson|@json/);
      expect(f).not.toMatch(/"\{\{ inputs\.|"' ~ inputs\./);
    }
  });
});
