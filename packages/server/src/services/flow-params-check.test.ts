import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkFlowParams,
  literalParamKeys,
  paramsPlainlyNotArray,
  flowValidator,
} from "./flow-validator.service.js";
import type { FlowModel, FlowStep } from "./flow-compiler.service.js";

/**
 * `checkFlowParams` — a step may only name parameters its ref declares, and must
 * name the ones it requires.
 *
 * ── ⚠ The corpus below is the load-bearing half of this file ────────────────
 *
 * The check is BLOCKING, so its risk is not that it misses the bug — it is that
 * it refuses a flow that was always fine. `REAL_EXPRESSIONS` is every distinct
 * `paramsExpr` shape on the deployment this check was written against (57 tool
 * and datasource steps across 10 refs, taken from `flow_steps`), each with the
 * ref's real declared parameters. **All of them must pass except the one that
 * caused the incident.** A future change that makes the scanner cleverer has to
 * keep that true, and this is what says so.
 *
 * The jq-built entries matter most: they must come back `null` from
 * `literalParamKeys` and produce NO finding. If a change ever makes them
 * readable-but-wrong, this file goes red rather than the product refusing
 * `finance-invoice-chase`'s fan-out.
 */

const IFACES = {
  foundry_email_send: {
    params: [
      { name: "subject", required: true },
      { name: "body", required: true },
      { name: "to", required: false },
      { name: "cc", required: false },
    ],
  },
  llm_complete: {
    params: [
      { name: "input", required: true },
      { name: "instruction", required: true },
      { name: "model", required: false },
      { name: "max_tokens", required: false },
    ],
  },
  mail_send: {
    params: [
      { name: "sender", required: true },
      { name: "recipients", required: true },
      { name: "subject", required: true },
      { name: "body", required: true },
      { name: "cc", required: false },
      { name: "attachments", required: false },
    ],
  },
  ticket_create: {
    params: [
      { name: "title", required: true },
      { name: "description", required: false },
      { name: "priority", required: false },
      { name: "labels", required: false },
      { name: "assignee", required: false },
    ],
  },
  "finance_demo.spend_by_cost_centre": { params: [{ name: "period", required: true }] },
  "legal_demo.contracts_renewal_due": {
    params: [
      { name: "as_of", required: true },
      { name: "lookahead_days", required: false },
      { name: "row_limit", required: false },
    ],
  },
  no_declared_params: { params: [] as Array<{ name: string; required: boolean }> },
};

function step(ref: string, paramsExpr: string, kind = "tool"): FlowStep {
  return { kind, id: "s1", ref, paramsExpr } as unknown as FlowStep;
}
function model(steps: FlowStep[]): FlowModel {
  return { id: "f", steps, inputs: [] } as unknown as FlowModel;
}
function findings(ref: string, expr: string, kind = "tool") {
  return checkFlowParams(model([step(ref, expr, kind)]), IFACES);
}

/** Every distinct shape in production, and whether its keys are readable. */
const REAL_EXPRESSIONS: Array<{ ref: string; expr: string; readable: boolean }> = [
  // Shape A — literal skeleton with `{{ }}` values.
  {
    ref: "llm_complete",
    expr: `[{"input":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }},"instruction":"Write a concise report."}]`,
    readable: true,
  },
  {
    ref: "foundry_email_send",
    expr: `[{"body":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }},"subject":"Attendance report for {{ inputs.period }}","to":[]}]`,
    readable: true,
  },
  {
    ref: "finance_demo.spend_by_cost_centre",
    expr: `[{ "period": "{{ inputs.period }}" }]`,
    readable: true,
  },
  {
    ref: "legal_demo.contracts_renewal_due",
    expr: `[{"as_of":"{{ inputs.period }}","lookahead_days":90,"row_limit":1000}]`,
    readable: true,
  },
  // Shape C — a literal object INSIDE a template span, then piped through jq.
  {
    ref: "foundry_email_send",
    expr: `{{ [{"body": (json(outputs.fetch.body).results[0].data | jq('tostring') | first), "subject": ("Report for " ~ inputs.period), "cc": [], "to": []}] | jq('.') | first }}`,
    readable: true,
  },
  {
    ref: "llm_complete",
    expr: `{{ [{"input": (json(outputs.fetch.body).results[0].data | jq('tostring') | first), "instruction": "Write a concise commentary."}] | jq('.') | first }}`,
    readable: true,
  },
  // Shape B — built inside a jq program. NOT readable, and must stay that way.
  {
    ref: "mail_send",
    expr: `{{ json(outputs.shape.value) | jq('[.claims[] | select(.email != null) | {sender: "ap-bot@acme-finance.example", recipients: [.email], cc: [.owner], subject: ("Claim " + .id)}]') }}`,
    readable: false,
  },
  {
    ref: "ticket_create",
    expr: `{{ json(outputs.route.value) | jq('.unreachable | if length == 0 then [] else [{title: ("Cannot chase " + (length|tostring)), priority: "high"}] end') }}`,
    readable: false,
  },
  {
    ref: "llm_complete",
    expr: `{{ outputs.variance.vars.result | jq('[{instruction: "Write two sentences.", input: (. | tostring)}]') }}`,
    readable: false,
  },
];

describe("literalParamKeys", () => {
  it("reads the keys of a literal skeleton, and not the values", () => {
    expect(literalParamKeys(`[{"subject":"hi","to":["a@b.example"]}]`)).toEqual(["subject", "to"]);
  });

  it("reads a literal object inside a template span", () => {
    expect(
      literalParamKeys(`{{ [{"body": (x | jq('tostring') | first), "subject": ("a" ~ b)}] | jq('.') | first }}`),
    ).toEqual(["body", "subject"]);
  });

  it("takes only the object's OWN keys, never a nested object's", () => {
    expect(literalParamKeys(`[{"outer":{"inner":1},"other":2}]`)).toEqual(["outer", "other"]);
  });

  /**
   * ⚠ The discriminating case. A jq program's keys are another language's
   * syntax; returning them would make every fan-out step in the product
   * refusable on names that are not parameters at all.
   */
  it("returns null for an object built inside a jq program", () => {
    expect(
      literalParamKeys(`{{ json(x) | jq('[{sender: "a@b.example", recipients: [.email]}]') }}`),
    ).toBeNull();
  });

  /**
   * ⚠ The case the single-quote skip is FOR. jq permits quoted keys, so without
   * skipping the program these read exactly like a literal params object — and
   * `sender`/`recipients` are `mail_send`'s parameters seen through the wrong
   * end: they are the shape of the message the tool is being asked to build,
   * for each row of a fan-out, not the call's own top-level keys. Without this
   * test the skip is unmeasured, and removing it turns nothing red.
   */
  it("returns null for a jq program that uses QUOTED keys", () => {
    expect(
      literalParamKeys(`{{ json(x) | jq('[{"sender": .a, "recipients": [.email]}]') }}`),
    ).toBeNull();
  });

  it("returns null when there is no object at all", () => {
    expect(literalParamKeys(`{{ 1 }}`)).toBeNull();
    expect(literalParamKeys(``)).toBeNull();
  });
});

describe("checkFlowParams", () => {
  /** The incident, exactly as it was drafted. */
  it("refuses the undeclared key that caused the incident", () => {
    const f = findings(
      "foundry_email_send",
      `{{ [{"body": (x | jq('tostring') | first), "subject": ("Report"), "cc": [], "to": [], "author": "foundry-automation"}] | jq('.') | first }}`,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("unknown_param");
    expect(f[0]!.blocking).toBe(true);
    expect(f[0]!.facts!.unknown).toEqual(["author"]);
    // The declared list is the finding — a redraft without it is a guess.
    expect(f[0]!.facts!.declared).toEqual(["body", "cc", "subject", "to"]);
  });

  /**
   * ⚠ The redraft loop consumes `f.message` and NOTHING else — `unknownRefs`
   * pushes the string, not the finding. So a message that says only "wrong" is
   * a refusal a model cannot act on, and this was measured the hard way: a real
   * Legal goal was refused three times for passing `recipients` (which is
   * `mail_send`'s parameter, not `foundry_email_send`'s), never told the four
   * names that would have worked, and the next draft dropped the email step
   * entirely. Putting the list in `facts` alone is not enough.
   */
  it("names the declared parameters IN THE MESSAGE, not just in facts", () => {
    const f = findings("foundry_email_send", `[{"subject":"s","body":"b","recipients":["a@b.example"]}]`);
    expect(f[0]!.message).toContain("recipients");
    expect(f[0]!.message).toContain("It declares:");
    for (const p of ["subject", "body", "to", "cc"]) expect(f[0]!.message).toContain(p);
    // Which ones may be omitted is part of the same question.
    expect(f[0]!.message).toMatch(/body \(required\)/);
    expect(f[0]!.message).toMatch(/\bto\b(?! \(required\))/);
  });

  it("names the declared parameters in a missing-required message too", () => {
    const f = findings("foundry_email_send", `[{"subject":"s"}]`);
    expect(f[0]!.message).toContain("It declares:");
    expect(f[0]!.message).toContain("body (required)");
  });

  it("names every undeclared key at once, not just the first", () => {
    const f = findings("foundry_email_send", `[{"subject":"s","body":"b","author":"a","reply_to":"r"}]`);
    expect(f[0]!.facts!.unknown).toEqual(["author", "reply_to"]);
  });

  it("refuses a call missing a required parameter", () => {
    const f = findings("foundry_email_send", `[{"subject":"s","to":[]}]`);
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("missing_required_param");
    expect(f[0]!.facts!.missing).toEqual(["body"]);
  });

  it("reports both problems separately when a call has both", () => {
    const f = findings("foundry_email_send", `[{"subject":"s","author":"a"}]`);
    expect(f.map((x) => x.rule).sort()).toEqual(["missing_required_param", "unknown_param"]);
  });

  it("accepts a call using only declared parameters", () => {
    expect(findings("foundry_email_send", `[{"subject":"s","body":"b","to":[],"cc":[]}]`)).toEqual([]);
  });

  /**
   * ⚠ Absent declarations must not become refusals. Three named queries on this
   * deployment have an empty `paramsSchema`, which means "nobody wrote it down"
   * as often as "takes nothing".
   */
  it("says nothing about a ref that declares no parameters", () => {
    expect(findings("no_declared_params", `[{"anything":"at all"}]`)).toEqual([]);
  });

  it("says nothing about a ref it has no interface for — that is checkFlowRefs's finding", () => {
    expect(findings("not_registered", `[{"whatever":1}]`)).toEqual([]);
  });

  it("ignores kinds that do not call a ref", () => {
    const m = model([{ kind: "transform", id: "t", expr: "{{ 1 }}" } as unknown as FlowStep]);
    expect(checkFlowParams(m, IFACES)).toEqual([]);
  });

  /** Values are not names. The params are an expression; the value is unknown. */
  it("checks names only, never types or values", () => {
    expect(findings("finance_demo.spend_by_cost_centre", `[{"period": 42}]`, "datasource")).toEqual([]);
  });
});

/**
 * `params` must be a LIST of parameter objects — `stepBatchSchema.params` is
 * `z.array(z.record(...))` for all three ref-calling kinds. A drafter that emits
 * the single call's object directly is refused by the step API with
 * `params: Expected array, received object`, mid-run, after the flow has been
 * saved, compiled, deployed and started. Taken from a real failed run
 * (`0f7b66e5`, flow `renewal_watchlist_email`).
 */
describe("paramsPlainlyNotArray", () => {
  it("flags the object shape that failed the real run", () => {
    expect(
      paramsPlainlyNotArray(
        `{"input":{{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }},"instruction":"x"}`,
      ),
    ).toBe(true);
  });

  it("passes a literal array", () => {
    expect(paramsPlainlyNotArray(`[{"period":"{{ inputs.period }}"}]`)).toBe(false);
  });

  /**
   * ⚠ The discriminating case, and the reason this is three-valued. A leading
   * `{{` is a template span, not an object — and `{{ [{…}] | jq('.') | first }}`
   * evaluates to the array while reading exactly like the object case at
   * position 0. Treating `{{` as `{` would refuse a shape used across the
   * product.
   */
  it("returns null for a template span, whatever it evaluates to", () => {
    expect(paramsPlainlyNotArray(`{{ [{"body": (x)}] | jq('.') | first }}`)).toBeNull();
    expect(paramsPlainlyNotArray(`{{ json(x) | jq('[{"a": .b}]') }}`)).toBeNull();
  });

  it("returns null for anything else", () => {
    expect(paramsPlainlyNotArray(`outputs.x.vars.result`)).toBeNull();
    expect(paramsPlainlyNotArray(``)).toBeNull();
  });
});

describe("checkFlowParams — the container", () => {
  it("refuses an object where a list is required", () => {
    const f = findings("llm_complete", `{"input":"x","instruction":"y"}`);
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("params_not_array");
    expect(f[0]!.blocking).toBe(true);
    expect(f[0]!.message).toContain("[{");
  });

  /** One problem at a time: a wrong container makes the key question moot. */
  it("reports the container alone, even when the keys are also wrong", () => {
    const f = findings("llm_complete", `{"input":"x","nonsense":1}`);
    expect(f.map((x) => x.rule)).toEqual(["params_not_array"]);
  });

  /**
   * ⚠ Outside the declarations guard. A ref that declares no parameters, or one
   * this workspace does not have, still may not pass an object — and those are
   * exactly the refs a declaration-gated check would skip.
   */
  it("applies to a ref with no declared params", () => {
    expect(findings("no_declared_params", `{"a":1}`)[0]!.rule).toBe("params_not_array");
  });

  it("applies to a ref with no interface at all", () => {
    expect(findings("not_registered", `{"a":1}`)[0]!.rule).toBe("params_not_array");
  });
});

describe("the real corpus", () => {
  it.each(REAL_EXPRESSIONS)("$ref ($readable) produces no finding", ({ ref, expr, readable }) => {
    expect(literalParamKeys(expr) !== null).toBe(readable);
    expect(findings(ref, expr, ref.includes(".") ? "datasource" : "tool")).toEqual([]);
  });
});

describe("assertValid", () => {
  const ok = model([step("foundry_email_send", `[{"subject":"s","body":"b"}]`)]);
  const bad = model([step("foundry_email_send", `[{"subject":"s","body":"b","author":"a"}]`)]);

  it("throws on an undeclared parameter", () => {
    expect(() => flowValidator.assertValid(bad, ["foundry_email_send"], IFACES)).toThrow(/author/);
  });

  it("does not throw on a correct call", () => {
    expect(() => flowValidator.assertValid(ok, ["foundry_email_send"], IFACES)).not.toThrow();
  });

  /**
   * Interfaces are optional so the pure-shape harnesses keep working. Omitting
   * them SKIPS the check — it must never fail it, or every existing caller
   * starts refusing every flow.
   */
  it("skips the param check when no interfaces are supplied", () => {
    expect(() => flowValidator.assertValid(bad, ["foundry_email_send"])).not.toThrow();
  });
});

/**
 * ⚠ The check is only as real as its call site, and `interfaces` is OPTIONAL.
 *
 * That optionality is what keeps the pure-shape harnesses working, and it is
 * also exactly how this check could stop existing without one test going red:
 * drop the third argument in `writeRevision` and every model passes. That is
 * I-120's shape — a correct control nothing calls — and I-120's own lesson is
 * that the detector's tests cannot close it. So this reads the call site off
 * disk, with a control that the file is really being read.
 */
describe("the call site", () => {
  const src = readFileSync(new URL("./flow.service.ts", import.meta.url), "utf8");

  it("is really reading flow.service.ts", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("async writeRevision(");
  });

  it("passes the ref interfaces to assertValid", () => {
    // Two hops since D-318: the funnel passes them on, and writeRevision fills them in.
    expect(src).toMatch(/assertValid\(model,\s*g\.refNames,\s*interfaces\b/);
    expect(src).toMatch(/refNames: Object\.keys\(current\),\s*interfaces,/);
  });

  /**
   * Wave 1 (Stage 4.1) — the `llm` save refusal is only as real as this call
   * site too: `allowedModels` is OPTIONAL, so dropping the fourth argument
   * would silently uncheck every model name. Same I-120 shape as above.
   */
  it("passes the deployment's models to assertValid", () => {
    expect(src).toMatch(/assertValid\(model,\s*g\.refNames,\s*interfaces,\s*g\.allowedModels\)/);
    expect(src).toMatch(/allowedModels: \(await resolveGenerationProvider\(\)\)\.allowedModels,/);
  });

  it("fetches them from refInterfaces, not from fingerprints", () => {
    expect(src).toContain("manifestBuilderService.refInterfaces(workspaceId)");
  });
});
