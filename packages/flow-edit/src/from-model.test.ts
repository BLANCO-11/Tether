/**
 * `authoredFromModel` — reading a stored flow back into the editable shape.
 * foundations Phase 2.2 · I-130.
 *
 * The three refusals below are the point of the suite. An adapter that opened a
 * flow "as best it could" would be the most dangerous version of this function:
 * the graph on screen would look right, and what came back on save would be a
 * different automation.
 */
import { describe, expect, it } from "vitest";
import { authoredFromModel, type StoredFlow } from "./from-model.js";
import type { AuthoredStep } from "./index.js";
import { normaliseModel } from "./model-version.js";
import { sameFeed } from "./typecheck/index.js";
import {
  buildApprovalSummary,
  buildCodeInput,
  buildCondition,
  buildFanOutParams,
  toLegacyInputSpelling,
  buildSingleParams,
  type OutputShapes,
} from "./render.js";

const UNGENERATED = "needs_regeneration";

/** A flow with one of every kind, as it would be persisted. */
const stored: StoredFlow = {
  id: "chase_overdue",
  inputs: [{ id: "period", type: "STRING", defaults: "2026-06", required: true }],
  steps: [
    { id: "overdue", kind: "datasource", ref: "q.overdue_invoices", paramsExpr: "[{}]" },
    { id: "shape", kind: "transform", expr: "{{ 1 }}", dependsOn: ["overdue"] },
    {
      id: "rank",
      kind: "code",
      code: "def run(payload):\n    return {'ranked': []}",
      inputExpr: "{{ 1 }}",
      outputKeys: ["ranked"],
      dependsOn: ["shape"],
      timeoutSeconds: 120,
    },
    { id: "gate", kind: "approval", summaryExpr: '"ok?"', dependsOn: ["rank"], awaitSeconds: 86400 },
    { id: "send", kind: "tool", ref: "send_email", paramsExpr: "[{}]", dependsOn: ["gate"] },
    { id: "ask", kind: "approval", summaryExpr: '"why?"', dependsOn: ["send"] },
  ],
};

const contracts = {
  rank: {
    stepId: "rank",
    purpose: "rank invoices by age",
    input: [{ name: "rows", type: "array" as const, items: "object" as const }],
    output: [{ name: "ranked", type: "array" as const, description: "worst first" }],
  },
};

function ok(r: ReturnType<typeof authoredFromModel>) {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${r.error}`);
  return r;
}

describe("authoredFromModel", () => {
  it("reads every kind back, keeping ids, refs, expressions and edges", () => {
    const r = ok(authoredFromModel(stored, contracts, { ungenerated: UNGENERATED }));
    expect(r.flow.id).toBe("chase_overdue");
    expect(r.flow.steps.map((s) => s.id)).toEqual(["overdue", "shape", "rank", "gate", "send", "ask"]);
    expect(r.flow.steps.map((s) => s.kind)).toEqual([
      "datasource",
      "transform",
      "code",
      "approval",
      "tool",
      "approval",
    ]);
    // The edges survive, which is what makes the canvas draw the same graph.
    expect(r.flow.steps.find((s) => s.id === "send")?.dependsOn).toEqual(["gate"]);
    expect(r.dropped).toEqual([]);
  });

  /**
   * ⚠ **The control this whole file exists for.** `AuthoredStep` has no `code`
   * field, and `ui-honesty-check.sh` asserts `index.ts` declares none — but that
   * grep is not pointed at this file, which is the one that reads a stored step's
   * body. So the guarantee is asserted at runtime instead: over a model whose
   * every step carried code, no returned step does.
   */
  it("no step it returns carries code, and the input's did", () => {
    const everyStepHasCode: StoredFlow = {
      ...stored,
      steps: stored.steps.map((s) => ({ ...s, code: "def run(payload):\n    return {}" })),
    };
    // The control: the assertion below is about an absence, not an empty read.
    expect(everyStepHasCode.steps.every((s) => "code" in s)).toBe(true);

    const r = ok(authoredFromModel(everyStepHasCode, contracts, { ungenerated: UNGENERATED }));
    for (const s of r.flow.steps) {
      expect(Object.keys(s)).not.toContain("code");
    }
  });

  it("the code comes out as carriedCode instead, keyed by step", () => {
    const r = ok(authoredFromModel(stored, contracts, { ungenerated: UNGENERATED }));
    expect(r.carriedCode).toEqual({ rank: "def run(payload):\n    return {'ranked': []}" });
  });

  /**
   * The placeholder is not code. Carrying it would hand `flow-compiler` the one
   * string it rejects by name — and it would do so on a flow that had *just*
   * been edited, so the failure would read as caused by the edit.
   */
  it("an UNGENERATED placeholder is not carried", () => {
    const never = {
      ...stored,
      steps: stored.steps.map((s) => (s.id === "rank" ? { ...s, code: UNGENERATED } : s)),
    };
    expect(ok(authoredFromModel(never, contracts, { ungenerated: UNGENERATED })).carriedCode).toEqual({});
    // The control: with the placeholder unnamed, the same call carries it — which
    // is why the server must pass `ungenerated` and this parameter is documented.
    expect(Object.keys(ok(authoredFromModel(never, contracts)).carriedCode)).toEqual(["rank"]);
  });

  it("strips stepId from the contract and never reads outputKeys", () => {
    const r = ok(authoredFromModel(stored, contracts, { ungenerated: UNGENERATED }));
    const rank = r.flow.steps.find((s) => s.id === "rank");
    if (rank?.kind !== "code") throw new Error("rank should be a code step");
    expect(Object.keys(rank.contract).sort()).toEqual(["input", "output", "purpose"]);
    expect(rank.contract.output).toEqual([{ name: "ranked", type: "array", description: "worst first" }]);
    expect(Object.keys(rank)).not.toContain("outputKeys");
  });

  it("carries declared inputs, including a default a person confirmed", () => {
    const r = ok(authoredFromModel(stored, contracts, { ungenerated: UNGENERATED }));
    expect(r.flow.inputs).toEqual([{ id: "period", type: "STRING", defaults: "2026-06", required: true }]);
  });

  // ── The three refusals ─────────────────────────────────────────────────────

  it("refuses a code step with no stored contract, naming the step", () => {
    const r = authoredFromModel(stored, {}, { ungenerated: UNGENERATED });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"rank"');
    expect(r.error).toContain("contract");
  });

  it("refuses a contract that belongs to a different step", () => {
    const r = authoredFromModel(
      stored,
      { rank: { ...contracts.rank, stepId: "shape" } },
      { ungenerated: UNGENERATED },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"shape"');
  });

  /**
   * ⚠ **This assertion DID its job.** It named `branch` when it was written, and
   * on the day Phase 3 declared that kind it turned red — which is exactly what
   * an absence check is for. It now names a kind that genuinely does not exist,
   * and the next kind will turn it red again.
   */
  it("refuses an unrecognised kind rather than skipping it", () => {
    const withUnknown: StoredFlow = {
      ...stored,
      steps: [...stored.steps, { id: "later", kind: "subflow" }],
    };
    const r = authoredFromModel(withUnknown, contracts, { ungenerated: UNGENERATED });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"subflow"');
    expect(r.error).toContain("datasource, query, tool, transform, code, approval, branch, merge, llm, http");
  });
  /**
   * ⚠ **Stage 2 retired the aliases** (`calculate`, `condition`, `trigger`,
   * `action`, `notify`, `report`, `end`): the storage schema (`stepSchema` in
   * `flow.service.ts`) cannot persist them, so no stored flow can carry one —
   * and this refuses rather than mapping, because a silent rename on open would
   * save back a different automation than the one on screen.
   */
  it("refuses a retired alias rather than mapping it", () => {
    const withRetired: StoredFlow = {
      ...stored,
      steps: [...stored.steps, { id: "calc", kind: "calculate", expr: "{{ 1 }}" }],
    };
    const r = authoredFromModel(withRetired, contracts, { ungenerated: UNGENERATED });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"calc"');
    expect(r.error).toContain('"calculate"');
  });

  /** Phase 3. A guard reads back with its condition, and nothing else. */
  it("reads a branch guard back with its condition", () => {
    const withBranch: StoredFlow = {
      ...stored,
      steps: [
        ...stored.steps,
        { id: "only_if_any", kind: "branch", conditionExpr: "{{ 1 }}", dependsOn: ["rank"] },
      ],
    };
    const r = ok(authoredFromModel(withBranch, contracts, { ungenerated: UNGENERATED }));
    // `"{{ 1 }}"` is not a shape any builder emits, so the upgrade leaves it
    // as written and marks the test explicitly unknown (`null`) — the panel
    // renders "set in the expression", never a guess.
    expect(r.flow.steps.at(-1)).toEqual({
      kind: "branch",
      id: "only_if_any",
      conditionExpr: "{{ 1 }}",
      test: null,
      dependsOn: ["rank"],
    });
  });
  it("a typed-only guard never reads back with an empty condition", () => {
    const withTyped: StoredFlow = {
      ...stored,
      steps: [
        ...stored.steps,
        {
          id: "low_score",
          kind: "branch",
          test: { left: { from: "step", stepId: "rank", field: "score" }, operator: "field_lt", right: "2" },
          dependsOn: ["rank"],
        },
      ],
    };
    const r = ok(authoredFromModel(withTyped, contracts, { ungenerated: UNGENERATED }));
    const guard = r.flow.steps.at(-1) as { conditionExpr?: unknown; test?: unknown };
    // The typed test is authoritative downstream; an "" here fails every
    // shape check on a branch that is actually guarded.
    expect(guard.conditionExpr === undefined || (typeof guard.conditionExpr === "string" && guard.conditionExpr.length > 0)).toBe(true);
    expect(guard.test).toBeDefined();
  });

  // ── What the canvas cannot carry, reported rather than dropped ─────────────
  //
  // ⚠ The schedule is NOT in this list (Phase 6): `AuthoredFlow` gained
  // `schedule`/`webhook`/`api`, so trigger declarations ride through the reopen
  // — the canvas edits them now. The concurrency limit, the claims and a retry
  // still have no authored home and are reported.

  it("carries the schedule and webhook, and names the concurrency limit, the claims and a retry", () => {
    const r = ok(
      authoredFromModel(
        {
          ...stored,
          schedule: { cron: "0 7 * * 1", timezone: "Europe/London" },
          webhook: { name: "orders" },
          api: { name: "ingest" },
          concurrencyLimit: 2,
          expectations: [{}, {}],
          steps: stored.steps.map((s) => (s.id === "send" ? { ...s, retry: { maxAttempts: 3 } } : s)),
        },
        contracts,
        { ungenerated: UNGENERATED },
      ),
    );
    expect(r.flow.schedule).toEqual({ cron: "0 7 * * 1", timezone: "Europe/London" });
    expect(r.flow.webhook).toEqual({ name: "orders" });
    expect(r.flow.api).toEqual({ name: "ingest" });
    const all = r.dropped.join("\n");
    expect(all).not.toContain("0 7 * * 1");
    expect(all).toContain("concurrency limit (2)");
    expect(all).toContain("2 expectation(s)");
    /**
     * ⚠ **A retry on a RETRYABLE kind is no longer dropped — it is read into
     * the authored step**, because the inspector can edit one now. This test
     * asserted the opposite, and the message it asserted was also wrong on the
     * surface people read it on: the builder page carries `retry` forward, so
     * "reopening and saving removes it" was only ever true on the copy path.
     */
    expect(all).not.toContain("runtime retry");
    expect(r.dropped).toHaveLength(2);
    const send = r.flow.steps.find((x) => x.id === "send") as { retry?: unknown };
    expect(send.retry).toEqual({ maxAttempts: 3 });
  });

  it("⚠ still reports a retry the COMPILER would refuse, rather than carrying it", () => {
    const withBadRetry = {
      ...stored,
      steps: stored.steps.map((s) =>
        s.kind === "transform" ? { ...s, retry: { maxAttempts: 3 } } : s,
      ),
    };
    const r = ok(authoredFromModel(withBadRetry, contracts, { ungenerated: UNGENERATED }));
    expect(r.dropped.join("\n")).toContain("the compiler refuses");
    for (const st of r.flow.steps) expect(st).not.toHaveProperty("retry");
  });

  it("says nothing for a flow with no schedule, no claims and no retry", () => {
    expect(ok(authoredFromModel(stored, contracts, { ungenerated: UNGENERATED })).dropped).toEqual([]);
  });
});

/**
 * ⚠ **A kind `fromModel` does not know is REFUSED, not dropped** — which is the
 * behaviour that makes a new step kind a failure rather than a silent deletion.
 * So a merge added server-side without a case here would not merely fail to
 * open: the whole flow would refuse to open, on a screen, for everybody. These
 * pin the case and the field that carries the entire step.
 */
describe("a merge", () => {
  it("opens, carrying its sources", () => {
    const r = authoredFromModel({
      id: "f",
      steps: [
        { id: "a", kind: "transform", expr: "{{ 1 }}" },
        { id: "b", kind: "transform", expr: "{{ 2 }}" },
        { id: "j", kind: "merge", sources: ["a", "b"] },
      ],
    }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const j = r.flow.steps.find((s) => s.id === "j");
    expect(j?.kind).toBe("merge");
    expect(j && "sources" in j ? j.sources : null).toEqual(["a", "b"]);
  });

  /**
   * ⚠ The order is a PRIORITY — the first source that ran wins — so it is
   * carried as stored and never sorted. Sorting would silently change which
   * arm's result the rest of the flow acts on.
   */
  it("keeps the source order exactly as stored", () => {
    const r = authoredFromModel({
      id: "f",
      steps: [
        { id: "a", kind: "transform", expr: "{{ 1 }}" },
        { id: "b", kind: "transform", expr: "{{ 2 }}" },
        { id: "j", kind: "merge", sources: ["b", "a"] },
      ],
    }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const j = r.flow.steps.find((s) => s.id === "j");
    expect(j && "sources" in j ? j.sources : null).toEqual(["b", "a"]);
  });
});

/**
 * ⚠ **Stage 2 declared `llm` and `http` in `AuthoredStep`.** A stored flow
 * carrying either must open with every field carried — a reopen that dropped
 * the model id or the URL would save back a step aimed nowhere.
 */
describe("llm and http", () => {
  it("round-trips an llm step and an http step with every field carried", () => {
    const r = authoredFromModel(
      {
        id: "f",
        steps: [
          {
            id: "judge",
            kind: "llm",
            model: "acme-large",
            tempPreset: "balanced",
            temperature: 0.7,
            topP: 1,
            frequencyPenalty: 0,
            presencePenalty: 0,
            promptBlocks: [{ role: "user", text: "which are worth escalation?" }],
            contextStepId: null,
            outputFields: [{ name: "shortlist", type: "array" as const }],
            memoryEnabled: false,
            visionDetail: "low",
            reasoningSeparated: false,
            dependsOn: [],
          },
          {
            id: "post",
            kind: "http",
            method: "POST",
            url: "https://hooks.example/e",
            headers: [{ name: "Content-Type", value: "application/json" }],
            queryParams: [],
            body: { kind: "json", content: "{{ 1 }}" },
            auth: { kind: "none" },
            sslVerify: true,
            dependsOn: ["judge"],
          },
        ],
      },
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps).toEqual([
      {
        kind: "llm",
        id: "judge",
        model: "acme-large",
        tempPreset: "balanced",
        temperature: 0.7,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        promptBlocks: [{ role: "user", text: "which are worth escalation?" }],
        contextStepId: null,
        outputFields: [{ name: "shortlist", type: "array" }],
        memoryEnabled: false,
        visionDetail: "low",
        reasoningSeparated: false,
        dependsOn: [],
      },
      {
        kind: "http",
        id: "post",
        method: "POST",
        url: "https://hooks.example/e",
        headers: [{ name: "Content-Type", value: "application/json" }],
        queryParams: [],
        body: { kind: "json", content: "{{ 1 }}" },
        auth: { kind: "none" },
        sslVerify: true,
        dependsOn: ["judge"],
      },
    ]);
    expect(r.dropped).toEqual([]);
  });

  it("fills registry defaults where a stored llm step is bare", () => {
    const r = authoredFromModel({ id: "f", steps: [{ id: "j", kind: "llm" }] }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.steps).toEqual([
      {
        kind: "llm",
        id: "j",
        model: "",
        tempPreset: "balanced",
        temperature: 0.7,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        promptBlocks: [{ role: "user", text: "" }],
        outputFields: [],
        memoryEnabled: false,
        visionDetail: "low",
        reasoningSeparated: false,
      },
    ]);
  });
});

// ── Stage 3: typed stored model ──────────────────────────────────────────────
//
// `authoredFromModel` accepts a v1 or a v2 stored model (`normaliseModel`
// runs first, internally) and every emitted step carries BOTH representations:
// the new typed fields (authoritative) and the old display strings (rendered
// via `render.ts`, parseable by construction). A v1 expression no builder
// emits stays as written with null bindings — unknown, never rebound.

const SHAPES: OutputShapes = {
  datasource: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  query: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  tool: { template: "json(outputs.<id>.body)", describes: null, caution: null },
  transform: { template: "json(outputs.<id>.value)", describes: null, caution: null },
  code: { template: "outputs.<id>.vars.result", describes: null, caution: null },
  approval: { template: null, describes: null, caution: null },
  branch: { template: null, describes: null, caution: null },
};

const fetchStep = {
  id: "fetch",
  kind: "datasource",
  ref: "finance_demo.invoices_overdue",
  paramsExpr: "[{}]",
} as const;

describe("v1 upgrade", () => {
  // ⚠ A v1 blob is HISTORY, and history carries only the legacy input spelling (I-288) — so the fixture is today's render
  // written back in it, never today's render itself.
  it("a fan-out becomes inputs/over and re-renders the identical display", () => {
    const over = { ...fetchStep } as unknown as Parameters<typeof buildFanOutParams>[1];
    const paramsExpr = toLegacyInputSpelling(buildFanOutParams(SHAPES, over, [
      { param: "to_email", source: { from: "step", stepId: "fetch", field: "contact_email" } },
      { param: "period", source: { from: "input", inputId: "period" } },
      { param: "subject", source: { from: "literal", value: "chase" } },
    ])!);
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "send", kind: "tool", ref: "send_email", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const send = r.flow.steps.find((s) => s.id === "send");
    expect(send).toMatchObject({
      kind: "tool",
      inputs: [
        { name: "to_email", source: { from: "step", stepId: "fetch", field: "contact_email" } },
        { name: "period", source: { from: "input", inputId: "period" } },
        { name: "subject", source: { from: "literal", value: "chase" } },
      ],
      over: { stepId: "fetch", field: "" },
    });
    // Rendered from the typed fields by the same builders: the SAME feed (FT0206's `sameFeed`), now in the escaped input
    // spelling (I-288) — upgrading a v1 step is what fixes its unescaped input.
    const shown = send && "paramsExpr" in send ? send.paramsExpr : null;
    expect(sameFeed(shown!, paramsExpr)).toBe(true);
    expect(shown).toContain("((inputs.period ~ '') | toJson)");
  });

  it("a single call upgrades without an over", () => {
    const paramsExpr = toLegacyInputSpelling(buildSingleParams([
      { param: "period", source: { from: "input", inputId: "period" } },
      { param: "to", source: { from: "literal", value: "finance@example" } },
    ])!);
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "lookup", kind: "tool", ref: "lookup", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const lookup = r.flow.steps.find((s) => s.id === "lookup");
    expect(lookup).toMatchObject({
      inputs: [
        { name: "period", source: { from: "input", inputId: "period" } },
        { name: "to", source: { from: "literal", value: "finance@example" } },
      ],
    });
    expect(lookup && "over" in lookup ? lookup.over : undefined).toBeUndefined();
    const shown = lookup && "paramsExpr" in lookup ? lookup.paramsExpr : null;
    expect(sameFeed(shown!, paramsExpr)).toBe(true); // same feed, escaped spelling (I-288)
    expect(shown).toBe(`[{ "period": {{ (inputs.period ~ '') | toJson }}, "to": "finance@example" }]`);
  });

  it("an unquoted scalar upgrades to a literal binding, never an unbound input", () => {
    const paramsExpr = `[{"as_of": "{{ inputs.as_of }}", "lookahead_days": 90, "flag": true, "nothing": null}]`;
    // beta-1.0.1: `"lookahead_days": 90` fell to `skipped`, became
    // `{ name, source: null }`, and the compiler refused the step as unbound.
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "lookup", kind: "tool", ref: "lookup", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const lookup = r.flow.steps.find((s) => s.id === "lookup");
    expect(lookup).toMatchObject({
      inputs: [
        { name: "as_of", source: { from: "input", inputId: "as_of" } },
        { name: "lookahead_days", source: { from: "literal", value: "90" } },
        { name: "flag", source: { from: "literal", value: "true" } },
        { name: "nothing", source: { from: "literal", value: "null" } },
      ],
    });
  });
  it("a bare template upgrades to a literal binding, commas and quotes inside", () => {
    // beta-1.0.2: the chat prompt taught `"input": {{ ... }}` unquoted and the
    // model obeyed — parsePairs cut the template on a comma parens could not
    // see and refused the step as unbound. The template text is the value.
    const template = `{{ json(outputs.fetch.body).results[0].data | jq('[.[] | {name: .candidate_name, role: .role_title}] | tostring') | first }}`;
    const paramsExpr = `[{"input": ${template}, "instruction": "hi"}]`;
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "digest", kind: "tool", ref: "llm_complete", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const digest = r.flow.steps.find((s) => s.id === "digest");
    expect(digest).toMatchObject({
      inputs: [
        { name: "input", source: { from: "literal", value: template } },
        { name: "instruction", source: { from: "literal", value: "hi" } },
      ],
    });
  });
  it("a bare template WITH a live @json encoder stays skipped, display verbatim", () => {
    // json_double_encoded root cause: `"body": {{ … | jq('.text | @json') | first }}`
    // must splice raw — `@json` already quotes the value, so binding it as a
    // literal stringifies it whole at emit and the value arrives double-quoted.
    // Skipped keeps the stored display authoritative and the binding unbound.
    const template = `{{ outputs.summary.text | jq('.text | @json') | first }}`;
    const paramsExpr = `[{"body": ${template}, "subject": "hi"}]`;
    const out = normaliseModel({
      id: "f",
      steps: [{ id: "send", kind: "tool", ref: "send_email", paramsExpr }],
    });
    const first = (out["steps"] as Array<Record<string, unknown>>)[0]!;
    expect(first["inputs"]).toContainEqual({ name: "body", source: null });
    expect(first["inputs"]).toContainEqual({ name: "subject", source: { from: "literal", value: "hi" } });
    // The display stays authoritative: dropping it would lose the splice.
    expect(first["paramsExpr"]).toBe(paramsExpr);
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "send", kind: "tool", ref: "send_email", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const send = r.flow.steps.find((s) => s.id === "send");
    expect(send && "paramsExpr" in send ? send.paramsExpr : null).toBe(paramsExpr);
    expect(send).toMatchObject({ inputs: expect.arrayContaining([{ name: "body", source: null }]) });
  });

  it("a bare template WITHOUT @json still upgrades to a literal binding", () => {
    // Blast-radius guard: only a LIVE encoder skips. `tostring` splices no
    // quotes of its own, so today's literal binding is unchanged.
    const template = `{{ outputs.summary.text | jq('.text | tostring') | first }}`;
    const paramsExpr = `[{"body": ${template}, "subject": "hi"}]`;
    const out = normaliseModel({
      id: "f",
      steps: [{ id: "send", kind: "tool", ref: "send_email", paramsExpr }],
    });
    const first = (out["steps"] as Array<Record<string, unknown>>)[0]!;
    expect(first["inputs"]).toContainEqual({
      name: "body",
      source: { from: "literal", value: template },
    });
    expect("paramsExpr" in first).toBe(false);
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "send", kind: "tool", ref: "send_email", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const send = r.flow.steps.find((s) => s.id === "send");
    expect(send).toMatchObject({
      inputs: [
        { name: "body", source: { from: "literal", value: template } },
        { name: "subject", source: { from: "literal", value: "hi" } },
      ],
    });
  });

  it("@json inside a jq string literal stays a literal binding — that text never carried quotes", () => {
    const template = `{{ outputs.summary.text | jq('{label: "@json"}') | first }}`;
    const paramsExpr = `[{"body": ${template}, "subject": "hi"}]`;
    const out = normaliseModel({
      id: "f",
      steps: [{ id: "send", kind: "tool", ref: "send_email", paramsExpr }],
    });
    const first = (out["steps"] as Array<Record<string, unknown>>)[0]!;
    expect(first["inputs"]).toContainEqual({
      name: "body",
      source: { from: "literal", value: template },
    });
    expect("paramsExpr" in first).toBe(false);
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "send", kind: "tool", ref: "send_email", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const send = r.flow.steps.find((s) => s.id === "send");
    expect(send).toMatchObject({
      inputs: [
        { name: "body", source: { from: "literal", value: template } },
        { name: "subject", source: { from: "literal", value: "hi" } },
      ],
    });
  });

  it("a predicated fan-out upgrades with its where", () => {
    const over = { ...fetchStep } as unknown as Parameters<typeof buildFanOutParams>[1];
    const paramsExpr = buildFanOutParams(
      SHAPES,
      over,
      [{ param: "value", source: { from: "step", stepId: "fetch", field: "amount" } }],
      { test: "field_gt", field: "amount", value: "10000" },
    )!;
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "big", kind: "tool", ref: "escalate", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const big = r.flow.steps.find((s) => s.id === "big");
    expect(big).toMatchObject({
      over: { stepId: "fetch", field: "" },
      where: { field: "amount", test: "field_gt", value: "10000" },
    });
    expect(big && "paramsExpr" in big ? big.paramsExpr : null).toBe(paramsExpr);
  });

  it("a built condition becomes a typed test", () => {
    const over = { ...fetchStep } as unknown as Parameters<typeof buildCondition>[1];
    const conditionExpr = buildCondition(SHAPES, over, "field_eq", "status", "open");
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "guard", kind: "branch", conditionExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const guard = r.flow.steps.find((s) => s.id === "guard");
    expect(guard).toMatchObject({
      test: {
        left: { from: "step", stepId: "fetch", field: "status" },
        operator: "field_eq",
        right: "open",
      },
    });
    expect(guard && "conditionExpr" in guard ? guard.conditionExpr : null).toBe(conditionExpr);
  });

  it("a JSON question becomes a summary", () => {
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "gate", kind: "approval", summaryExpr: '"ok?"' }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const gate = r.flow.steps.find((s) => s.id === "gate");
    expect(gate).toMatchObject({ summary: "ok?", summaryExpr: '"ok?"' });
  });

  it("a built approval summary becomes a summary with whole-rows context", () => {
    const over = { ...fetchStep } as unknown as Parameters<typeof buildApprovalSummary>[1];
    const summaryExpr = buildApprovalSummary(SHAPES, over, "Send?");
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "gate", kind: "approval", summaryExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const gate = r.flow.steps.find((s) => s.id === "gate");
    expect(gate).toMatchObject({
      summary: "Send?",
      context: { from: "whole", stepId: "fetch" },
    });
    expect(gate && "summaryExpr" in gate ? gate.summaryExpr : null).toBe(summaryExpr);
  });

  it("a whole-rows code payload becomes whole bindings", () => {
    const from = { ...fetchStep } as unknown as AuthoredStep;
    const inputExpr = buildCodeInput(SHAPES, [{ name: "rows", from }]);
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "rank", kind: "code", inputExpr }] },
        {
          rank: {
            stepId: "rank",
            purpose: "rank",
            input: [{ name: "rows", type: "array" as const }],
            output: [{ name: "ranked", type: "array" as const }],
          },
        },
        { shapes: SHAPES },
      ),
    );
    const rank = r.flow.steps.find((s) => s.id === "rank");
    expect(rank).toMatchObject({
      inputs: [{ name: "rows", source: { from: "whole", stepId: "fetch" } }],
    });
    expect(rank && "inputExpr" in rank ? rank.inputExpr : null).toBe(inputExpr);
  });
});

describe("v2 round-trip", () => {
  it("typed-only steps keep their bindings and gain the display", () => {
    const r = ok(
      authoredFromModel(
        {
          id: "f",
          version: 2,
          steps: [
            { ...fetchStep },
            {
              id: "send",
              kind: "tool",
              ref: "send_email",
              inputs: [{ name: "period", source: { from: "input", inputId: "period" } }],
            },
          ],
        },
        {},
        { shapes: SHAPES },
      ),
    );
    const send = r.flow.steps.find((s) => s.id === "send");
    expect(send).toMatchObject({
      inputs: [{ name: "period", source: { from: "input", inputId: "period" } }],
    });
    expect(send && "paramsExpr" in send ? send.paramsExpr : null).toBe(
      buildSingleParams([{ param: "period", source: { from: "input", inputId: "period" } }]),
    );
  });

  it("new wins over a stale display string", () => {
    const out = normaliseModel({
      id: "f",
      steps: [
        {
          id: "send",
          kind: "tool",
          ref: "send_email",
          inputs: [{ name: "period", source: { from: "input", inputId: "period" } }],
          paramsExpr: "[{}]",
        },
      ],
    });
    const rawSteps: unknown = out["steps"];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error("expected a converted step");
    const first: unknown = rawSteps[0];
    if (!first || typeof first !== "object" || !("inputs" in first)) {
      throw new Error("expected typed inputs on the converted step");
    }
    expect(first.inputs).toEqual([{ name: "period", source: { from: "input", inputId: "period" } }]);
    expect("paramsExpr" in first).toBe(false);
    expect(out["version"]).toBe(2);
  });
});

describe("unknown stays unknown", () => {
  it("a hand-written paramsExpr is carried, never rebound", () => {
    const paramsExpr = "{{ json(outputs.ghost.body) | jq('.x') | first }}";
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "send", kind: "tool", ref: "send_email", paramsExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const send = r.flow.steps.find((s) => s.id === "send");
    // Left as written — a ghost over reads as unknown, not as `fetch`.
    expect(send && "paramsExpr" in send ? send.paramsExpr : null).toBe(paramsExpr);
    if (!send || "inputs" in send) throw new Error("expected no inputs key beside an unknown display string");
  });

  it("a hand-written condition is carried with an explicit null test", () => {
    const conditionExpr = "{{ outputs.fetch.body | jq('.something | weird') | first }}";
    const r = ok(
      authoredFromModel(
        { id: "f", steps: [{ ...fetchStep }, { id: "guard", kind: "branch", conditionExpr }] },
        {},
        { shapes: SHAPES },
      ),
    );
    const guard = r.flow.steps.find((s) => s.id === "guard");
    expect(guard).toMatchObject({ conditionExpr, test: null });
  });

  it("normaliseModel never throws, even on nonsense", () => {
    expect(normaliseModel(null)).toEqual({ version: 2 });
    expect(normaliseModel(42)).toEqual({ version: 2 });
    expect(normaliseModel({ steps: "nope" })).toMatchObject({ version: 2, steps: [] });
  });
});

/**
 * A read that lives in the WORKFLOW rather than in the data source.
 *
 * Reported from flow `cd9f339b` on 2026-09-16: a chat turn on a flow whose
 * `fetch_employees` step carried a drafter-written join answered
 * `needs_component` — *"finance_demo IS a datasource … but it has no readable
 * component named employees_with_cost_centres"* — and never applied what the
 * person asked for. The exemption in `refFindings` was already there and
 * correct; this adapter had removed the field it keys on before the check ran.
 *
 * Nothing errored and `dropped` named nothing, which is why it went unnoticed:
 * the loss surfaced one screen later as a component that does not exist.
 */
describe("a step carrying its own SQL", () => {
  const local: StoredFlow = {
    id: "staff",
    steps: [
      {
        kind: "datasource",
        id: "fetch_employees",
        ref: "finance_demo.employees_with_cost_centres",
        paramsExpr: "[{}]",
        sql: "SELECT e.full_name FROM employees e JOIN cost_centres c ON c.id = e.cost_centre_id",
        datasourceRef: "finance_demo",
        sqlParamOrder: ["centre"],
        sqlParamsSchema: { centre: { type: "string", required: true } },
      },
    ],
  } as unknown as StoredFlow;

  it("keeps the statement, the datasource and the binding", () => {
    const r = ok(authoredFromModel(local, {}));
    const step = r.flow.steps[0] as unknown as Record<string, unknown>;
    expect(step.sql).toContain("JOIN cost_centres");
    expect(step.datasourceRef).toBe("finance_demo");
    expect(step.sqlParamOrder).toEqual(["centre"]);
    expect(step.sqlParamsSchema).toEqual({ centre: { type: "string", required: true } });
    expect(r.dropped).toEqual([]);
  });

  /**
   * ⚠ CONTROL. A `tool` never carries either — the write side
   * (`authoredToStoredFlow`) restricts the carry to `datasource`/`query` and
   * the two must agree, or a round trip invents a field on one side and drops
   * it on the other.
   */
  it("\u26a0 CONTROL: a tool step carries neither, even when the stored row has them", () => {
    const onTool = {
      ...local,
      steps: [{ ...(local.steps[0] as object), kind: "tool", ref: "mail.send" }],
    } as unknown as StoredFlow;
    const step = ok(authoredFromModel(onTool, {})).flow.steps[0] as unknown as Record<string, unknown>;
    expect(step.sql).toBeUndefined();
    expect(step.datasourceRef).toBeUndefined();
  });

  /**
   * ⚠ The fields are OPTIONAL and their absence must stay an absence — an
   * ordinary catalogue-backed step must not gain four undefined keys, which
   * would change what `structureHash` and every diff see.
   */
  it("\u26a0 CONTROL: an ordinary reader gains no empty step-local keys", () => {
    const plain = {
      id: "plain",
      steps: [{ kind: "datasource", id: "read", ref: "finance_demo.invoices_overdue", paramsExpr: "[{}]" }],
    } as unknown as StoredFlow;
    const step = ok(authoredFromModel(plain, {})).flow.steps[0] as unknown as Record<string, unknown>;
    for (const f of ["sql", "datasourceRef", "sqlParamOrder", "sqlParamsSchema"]) {
      expect(f in step).toBe(false);
    }
  });
});
