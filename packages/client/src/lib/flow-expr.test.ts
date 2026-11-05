import { describe, it, expect } from "vitest";
// Stage 3.2: the builders live in `@foundry/flow-edit` (`render.ts`) — this
// suite imports them from the package, which is also what proves the client's
// re-exports resolve. The inverse readers stay local, below.
import {
  BRANCH_TESTS,
  buildApprovalSummary,
  buildCodeInput,
  buildCondition,
  buildFanOutParams,
  buildSingleParams,
  type OutputShapes,
} from "@foundry/flow-edit";
import {
  buildAgentPrompt,
  insertJqReference,
  insertReference,
  parseCondition,
  referenceText,
  serializeTokens,
  tokenizeReferences,
  validateAgainstAllowlist,
} from "./flow-expr";
import type { AuthoredStep } from "./flow-authoring";

/**
 * The one claim this file makes: **everything the builder emits is inside D-22
 * by construction.** If that is true, a non-technical person can map fields onto
 * parameters and never meet the allowlist. If it is false, they meet it on save,
 * with a message about jq roots.
 *
 * So every builder below is asserted against the same check the server runs.
 */

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

/** As the catalogue serves it — the server's five roots and seven callables. */
const ALLOW = {
  roots: ["execution", "flow", "inputs", "outputs", "trigger"],
  // The server's `ALLOWED_CALLS` as it stands (flow-expression.service.ts): `toJson` was run and admitted (2d; I-288 renders
  // every flow input through it); `not`/`tonumber`/`tostring` were dropped by I-118 and are gone from here too.
  calls: ["first", "jq", "json", "length", "toJson"],
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

describe("built expressions pass the allowlist the server enforces", () => {
  // A bare list of names — the per-item routing the exact-string pins cover in
  // `render.test.ts`; asserted here against the same check the server runs.
  const names: AuthoredStep = { kind: "transform", id: "names", expr: "{{ [...] }}" };
  const built: Array<[string, string | null]> = [
    [
      "fan-out over a query",
      buildFanOutParams(SHAPES, fetch, [
        { param: "to_email", source: { from: "step", stepId: "fetch", field: "contact_email" } },
        { param: "due", source: { from: "step", stepId: "fetch", field: "due_date", transform: "date" } },
        { param: "period", source: { from: "input", inputId: "period" } },
        { param: "subject", source: { from: "literal", value: 'Invoice "overdue"' } },
      ]),
    ],
    [
      "fan-out over a code step",
      buildFanOutParams(SHAPES, rank, [
        { param: "amount", source: { from: "step", stepId: "rank", field: "total", transform: "number" } },
      ]),
    ],
    [
      "a single call",
      buildSingleParams([
        { param: "period", source: { from: "input", inputId: "period" } },
        { param: "to", source: { from: "literal", value: "finance@acme-finance.example" } },
      ]),
    ],
    ["a gate's question", buildApprovalSummary(SHAPES, fetch, "Send these chases?")],
    ["an agent prompt", buildAgentPrompt("Summarise the variance")],
    [
      "per-item routing over a bare list",
      buildFanOutParams(SHAPES, names, [{ param: "name", source: { from: "self" } }]),
    ],
    [
      "a predicated fan-out",
      buildFanOutParams(
        SHAPES,
        fetch,
        [{ param: "value", source: { from: "step", stepId: "fetch", field: "amount" } }],
        { test: "field_gte", field: "amount", value: "70" },
      ),
    ],
  ];

  for (const [what, expr] of built) {
    it(`${what} — no finding`, () => {
      expect(expr).not.toBeNull();
      expect(validateAgainstAllowlist(expr!, ALLOW)).toEqual([]);
    });
  }
});

describe("validateAgainstAllowlist mirrors the server's refusals", () => {
  it("rejects a call the server does not allow", () => {
    const f = validateAgainstAllowlist("{{ secret('FOUNDRY_CALLBACK') }}", ALLOW);
    expect(f.some((m) => m.includes("secret"))).toBe(true);
  });

  /**
   * A PEBBLE-level binding, which is the shape `outline:measure` saw refused
   * ("`vs` is not readable in a generated expression"). Verified against the
   * server's own `validateGeneratedExpr` while writing this file.
   *
   * ⚠ Its twin does NOT fire, and the difference is worth knowing before anyone
   * relies on the check: a binding INSIDE the jq program
   * (`jq('. as $vs | $vs')`) is invisible, because the whole single-quoted
   * program is blanked before the scan. D-22 governs what Pebble can reach; it
   * has never claimed to read jq.
   */
  it("rejects a Pebble-level binding, naming the identifier", () => {
    const f = validateAgainstAllowlist("{{ outputs.a.value | jq('.') as vs | vs }}", ALLOW);
    expect(f.some((m) => m.includes("vs"))).toBe(true);
  });

  it("a binding inside the jq program is NOT seen — the documented bound", () => {
    expect(validateAgainstAllowlist("{{ outputs.a.value | jq('. as $vs | $vs') | first }}", ALLOW)).toEqual([]);
  });

  it("does not mine a jq string literal for identifiers", () => {
    expect(
      validateAgainstAllowlist(
        `{{ json(outputs.f.body) | jq('[.[] | {from: "hr-bot@acme-hr.example"}]') | first }}`,
        ALLOW,
      ),
    ).toEqual([]);
  });

  /**
   * ⚠ It takes the allowlist as an argument. A hardcoded client copy would be a
   * second definition of the boundary, and the drift is silent in both
   * directions.
   */
  it("is driven by the list it is handed", () => {
    expect(validateAgainstAllowlist("{{ json(outputs.a.body) }}", { roots: ["inputs"], calls: [] }).length)
      .toBeGreaterThan(0);
  });
});

/**
 * ⚠ **THESE STRINGS WERE RUN AGAINST THE ENGINE BEFORE THEY WERE OFFERED**
 * (2026-09-03, a probe flow in `foundry.system`, executed and deleted). The
 * exact programs are pinned beside the builders in `render.test.ts`; what stays
 * here is the construction claim — every operator's build is inside D-22.
 */
describe("built branch guards pass the allowlist the server enforces", () => {
  const over = { kind: "datasource", id: "read", ref: "q", paramsExpr: "[{}]" } as never;
  const cond = (t: string, f?: string, v?: string) => buildCondition(SHAPES, over, t as never, f, v);

  it("everything it builds is inside D-22's allowlist", () => {
    const allow = { roots: ["outputs", "inputs"], calls: ["json", "jq", "first", "length"] };
    for (const t of BRANCH_TESTS) {
      const out = cond(t.test, "status", t.test === "field_gt" || t.test === "field_lt" ? "5" : "open");
      expect(validateAgainstAllowlist(out, allow as never), `${t.test}`).toEqual([]);
    }
  });
});

/**
 * ⚠ **THE PARSER IS THE BUILDER'S INVERSE AND IS PINNED AS ONE.**
 *
 * The branch form used to hold `test`/`field`/`value` in local state
 * initialised to defaults, so reopening a configured branch showed *"has any
 * rows"* whatever it really tested — and the first edit wrote that back over
 * the real condition. Nothing failed; the guard quietly became something else.
 *
 * A parser written by eye drifts the moment a builder changes, silently and in
 * exactly that direction. So it is tested as a round trip over every operator
 * rather than against hand-written strings.
 */
describe("parseCondition is the inverse of buildCondition", () => {
  const over = { kind: "datasource", id: "read", ref: "q", paramsExpr: "[{}]" } as never;

  it("round-trips every offered operator", () => {
    for (const t of BRANCH_TESTS) {
      const field = t.needsField ? "status" : "";
      const value = !t.needsValue ? "" : t.test === "field_gt" || t.test === "field_lt" ? "5" : "open";
      const expr = buildCondition(SHAPES, over, t.test, field, value);
      expect(expr, `${t.test} built nothing`).not.toBe("");
      const back = parseCondition(expr);
      expect(back, `${t.test}`).toMatchObject({
        overId: "read",
        test: t.test,
        field,
        value,
        unparsed: false,
      });
    }
  });

  /**
   * ⚠ **AN UNREADABLE CONDITION IS REPORTED, NEVER GUESSED.** A hand-written or
   * imported guard is legitimate. Returning plausible picks for one would put a
   * form on screen that overwrites it with something else on the next
   * keystroke — the exact bug this parser exists to remove, arriving by a
   * different road.
   */
  it("⚠ flags an expression it did not build rather than guessing", () => {
    const r = parseCondition("{{ outputs.read.body | jq('.something | weird') | first }}");
    expect(r.unparsed).toBe(true);
    // The control: a condition it CAN read is not flagged.
    expect(parseCondition(buildCondition(SHAPES, over, "any")).unparsed).toBe(false);
  });

  it("an absent condition is the empty default, not an error", () => {
    expect(parseCondition(undefined)).toMatchObject({ test: "any", unparsed: false });
    expect(parseCondition("")).toMatchObject({ test: "any", unparsed: false });
  });
});

describe("chip references", () => {
  it("spells exactly what the compiler accepts", () => {
    expect(referenceText({ stepId: "fetch_offers", field: "body" })).toBe("{{ outputs.fetch_offers.body }}");
    expect(referenceText({ inputId: "period" })).toBe("{{ inputs.period }}");
  });

  it("inserts with separating spaces, never doubling", () => {
    expect(insertReference("total due", 5, { stepId: "f", field: "b" })).toEqual({
      text: "total {{ outputs.f.b }} due",
      caret: 5 + 1 + "{{ outputs.f.b }}".length,
    });
    expect(insertReference("ab", 1, { inputId: "p" })).toEqual({
      text: "a {{ inputs.p }} b",
      caret: "a {{ inputs.p }} ".length,
    });
    expect(insertReference("", 0, { stepId: "f", field: "b" })).toEqual({
      text: "{{ outputs.f.b }}",
      caret: "{{ outputs.f.b }}".length,
    });
  });

  it("offers jq with the caret inside the quotes", () => {
    const r = insertJqReference("", 0, { stepId: "f", field: "b" });
    expect(r.text).toBe("{{ outputs.f.b | jq('') }}");
    expect(r.text.slice(0, r.caret)).toBe("{{ outputs.f.b | jq('");
  });

  it("tokenize then serialize is byte-identical", () => {
    const cases = [
      "",
      "plain text",
      "Dear {{ outputs.fetch_offers.body }}, yours",
      "{{ inputs.period }}",
      "{{ json(outputs.f.body) }} stays raw",
      "{{ outputs.f.b | jq('map(.)') }} stays raw",
      "unclosed {{ outputs.f.b",
    ];
    for (const c of cases) expect(serializeTokens(tokenizeReferences(c))).toBe(c);
  });

  it("chips exact forms only", () => {
    const kinds = tokenizeReferences("a {{ outputs.f.b }} b {{ inputs.p }} c").map((t) => t.k);
    expect(kinds).toEqual(["text", "ref", "text", "input", "text"]);
  });
});

