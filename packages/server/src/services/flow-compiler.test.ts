import { describe, expect, it } from "vitest";
import {
  flowCompiler,
  FlowCompileError,
  validateModel,
  computedInputExpression,
  displayCondition,
  type ApprovalStep,
  type BranchStep,
  type CallStep,
  type CodeStep,
  type FlowModel,
} from "./flow-compiler.service.js";
import { namespaceFor } from "./kestra-client.service.js";
import { checkFlowOutput } from "./flow-validator.service.js";
import { NODE_TYPES } from "@foundry/flow-edit";

/**
 * The compiler is the only YAML emitter in the system (R8), so these tests are
 * about what it REFUSES as much as what it produces.
 *
 * Pure: no database, no Kestra. The end-to-end proof that the emitted YAML is
 * accepted by Kestra AND produces the oracle's answer is `pnpm kestra:phase3`.
 */

const live = namespaceFor("acme", "hr", "live");
const draft = namespaceFor("acme", "hr", "draft");

/**
 * Only the `tasks:` block.
 *
 * `inputs:` uses the same `  - id:` / `    type:` shape, so a naive match over
 * the whole document counts an input as a task — which would have made the
 * allowlist assertions below pass for the wrong reason.
 */
function tasksSection(yaml: string): string {
  const start = yaml.indexOf("\ntasks:\n");
  if (start < 0) throw new Error("no tasks block");
  const end = yaml.indexOf("\ntriggers:\n", start);
  return yaml.slice(start, end < 0 ? undefined : end);
}

const taskIds = (yaml: string) =>
  [...tasksSection(yaml).matchAll(/^ {2}- id: (\S+)$/gm)].map((m) => m[1]);

const model = (over: Partial<FlowModel> = {}): FlowModel => ({
  id: "hr-screening",
  inputs: [{ id: "period", type: "STRING", defaults: "2026-06" }],
  steps: [
    { id: "screen", kind: "datasource", ref: "hr_demo.attendance_below_threshold", paramsExpr: '[{ "period": "{{ inputs.period }}" }]' },
    { id: "notify", kind: "tool", ref: "mail_send", paramsExpr: "{{ x }}", dependsOn: ["screen"] },
  ],
  ...over,
});

const codeStep = (over: Partial<CodeStep> = {}): CodeStep => ({
  id: "compute",
  kind: "code",
  code: "def run(payload):\n    return {'rows': payload['rows']}",
  inputExpr: '{"rows": {{ outputs.screen.body }}}',
  outputKeys: ["rows"],
  ...over,
});

const gateStep = (over: Partial<ApprovalStep> = {}): ApprovalStep => ({
  id: "triage",
  kind: "approval",
  summaryExpr: '"Send the exceptions?"',
  ...over,
});

describe("flow-compiler — what it emits", () => {
  it("emits begin and complete around the model's steps, and nothing else", () => {
    const { yaml } = flowCompiler.compile(model(), { namespace: draft });
    expect(taskIds(yaml)).toEqual(["begin", "screen", "notify", "complete"]);
  });

  it("contacts exactly one host, and it is not named by the model", () => {
    const { yaml } = flowCompiler.compile(model(), { namespace: draft });
    // Every URI is `{{ vars.foundry }}<path>`, and `vars.foundry` is set once
    // from config. A model cannot name a host, which is what keeps the
    // one-host egress allowlist true even for a hostile model (R8, §4).
    const uris = [...yaml.matchAll(/^ {4}uri: "(.*)"$/gm)].map((m) => m[1]);
    expect(uris.length).toBeGreaterThan(0);
    expect(uris.every((u) => u.startsWith("{{ vars.foundry }}/api/"))).toBe(true);
    expect(yaml).toContain('foundry: "http://server:4000"');
  });

  it("emits only http.Request and debug.Return task types", () => {
    const { yaml } = flowCompiler.compile(
      model({ steps: [...model().steps, { id: "reshape", kind: "transform", expr: "{{ y }}" }] }),
      { namespace: draft },
    );
    const types = [...new Set([...tasksSection(yaml).matchAll(/^ {4}type: (\S+)$/gm)].map((m) => m[1]))];
    expect(types.sort()).toEqual([
      "io.kestra.plugin.core.debug.Return",
      "io.kestra.plugin.core.http.Request",
    ]);
  });

  it("only `begin` reads the Kestra callback secret", () => {
    const { yaml } = flowCompiler.compile(model(), { namespace: draft });
    const secretLines = yaml.split("\n").filter((l) => l.includes("secret("));
    expect(secretLines).toHaveLength(1);
    // Everything after `begin` authenticates with the execution token it minted (R3).
    expect(yaml.match(/Bearer \{\{ json\(outputs\.begin\.body\)\.token \}\}/g)?.length).toBe(3);
  });

  it("is deterministic — the same model compiles to the same bytes", () => {
    const a = flowCompiler.compile(model(), { namespace: draft });
    const b = flowCompiler.compile(model(), { namespace: draft });
    expect(a.yaml).toBe(b.yaml);
    expect(a.hash).toBe(b.hash);
  });
  it("a per-item `select(…)` in paramsExpr compiles through verbatim — one task, whole array", () => {
    // The builder's if/elif routing. The compiler treats `paramsExpr` as opaque
    // (emitted as the task's `params` block); the `select` runs at execution
    // time inside Kestra's jq, so each destination step receives only its items.
    const routed = model({
      steps: [
        model().steps[0],
        {
          id: "severe",
          kind: "tool",
          ref: "mail_send",
          paramsExpr:
            "{{ json(outputs.screen.body).results[0].data " +
            `| jq('[.[] | select((.attendance_rate | tonumber?) < 70) | {"recipients": .work_email}]') | first }}`,
          dependsOn: ["screen"],
        } as CallStep,
      ],
    });
    const { yaml } = flowCompiler.compile(routed, { namespace: draft });
    expect(taskIds(yaml)).toEqual(["begin", "screen", "severe", "complete"]);
    expect(yaml).toContain("select((.attendance_rate | tonumber?) < 70)");
  });
});


describe("flow-compiler — the schedule is the approval gate", () => {
  const scheduled = model({ schedule: { cron: "0 6 * * 1", timezone: "Europe/London" } });

  it("omits the trigger unless withSchedule is set, even when the model has one", () => {
    // The draft namespace must never carry the trigger: a draft that fired
    // unattended would route around gate 2 entirely.
    const { yaml } = flowCompiler.compile(scheduled, { namespace: draft });
    expect(yaml).not.toContain("triggers:");
    expect(yaml).not.toContain("Schedule");
  });

  it("emits the Schedule trigger when promoting to live", () => {
    const { yaml } = flowCompiler.compile(scheduled, { namespace: live, withSchedule: true });
    expect(yaml).toContain("triggers:");
    expect(yaml).toContain("type: io.kestra.plugin.core.trigger.Schedule");
    expect(yaml).toContain('cron: "0 6 * * 1"');
    // Removed, never `disabled: true` — a flag is one redeploy away from firing.
    expect(yaml).not.toContain("disabled:");
  });

  it("live and draft differ ONLY by namespace, labels and the trigger", () => {
    const d = flowCompiler.compile(scheduled, { namespace: draft }).yaml.split("\n");
    const l = flowCompiler.compile(scheduled, { namespace: live, withSchedule: true }).yaml.split("\n");
    const onlyInLive = l.filter((line) => !d.includes(line));
    expect(onlyInLive.filter((s) => s.startsWith("namespace:"))).toHaveLength(1);
    expect(onlyInLive.some((s) => s.includes("trigger.Schedule"))).toBe(true);
    // No step body differs. If one did, "editing an armed flow does not change
    // what the schedule runs" would be checking the wrong thing.
    expect(onlyInLive.filter((s) => s.includes('"ref":'))).toHaveLength(0);
  });

  it("refuses withSchedule when the model declares none, rather than arming nothing", () => {
    expect(() => flowCompiler.compile(model(), { namespace: live, withSchedule: true })).toThrow(
      FlowCompileError,
    );
  });

  it.each([["nope"], ["* * * *"], ["* * * * * * *"], ["0 6 * * 1; rm -rf /"]])(
    "rejects the malformed cron %s",
    (cron) => {
      expect(() =>
        flowCompiler.compile(model({ schedule: { cron } }), { namespace: live }),
      ).toThrow(FlowCompileError);
    },
  );
});

describe("flow-compiler — the R8 allowlist", () => {
  it("refuses a step kind it cannot emit, naming what it can", () => {
    // `notify` is the one declared kind still without an emitter. Absent from
    // the allowlist rather than stubbed — an allowlist with unreachable entries
    // is one nobody trusts. (`code` and `agent` moved OUT of this test in Phase
    // 4, when they gained real emitters.)
    const bad = model({ steps: [{ id: "run", kind: "notify", expr: "hi" } as never] });
    expect(() => flowCompiler.compile(bad, { namespace: draft })).toThrow(/not emittable/);
  });

  it("refuses a step that would overwrite the gate or the terminal task", () => {
    for (const id of ["begin", "complete"]) {
      const bad = model({ steps: [{ id, kind: "transform", expr: "{{ x }}" }] });
      expect(() => flowCompiler.compile(bad, { namespace: draft })).toThrow(/reserved/);
    }
  });

  it("refuses a ref that could break out of the JSON string it lands in", () => {
    for (const ref of ['mail"', "mail\nsend", "mail send", "../../etc"]) {
      const bad = model({ steps: [{ id: "s", kind: "tool", ref, paramsExpr: "[]" }] });
      expect(() => flowCompiler.compile(bad, { namespace: draft })).toThrow(/malformed ref/);
    }
  });

  it("refuses cycles and unknown dependencies", () => {
    expect(() =>
      flowCompiler.compile(
        model({
          steps: [
            { id: "a", kind: "transform", expr: "x", dependsOn: ["b"] },
            { id: "b", kind: "transform", expr: "x", dependsOn: ["a"] },
          ],
        }),
        { namespace: draft },
      ),
    ).toThrow(/cycle/);
    expect(() =>
      flowCompiler.compile(
        model({ steps: [{ id: "a", kind: "transform", expr: "x", dependsOn: ["ghost"] }] }),
        { namespace: draft },
      ),
    ).toThrow(/unknown step/);
  });

  it("contains a hostile expression inside its block scalar", () => {
    // The containment is re-indentation, not a blocklist: ending a block scalar
    // requires DEDENTING, and every line is emitted with the block's indent. So
    // an expression that looks like YAML stays a line of text.
    const hostile = 'x\n  - id: evil\n    type: io.kestra.plugin.scripts.python.Script\n    script: "import os"';
    const { yaml } = flowCompiler.compile(
      model({ steps: [{ id: "t", kind: "transform", expr: hostile }] }),
      { namespace: draft },
    );
    expect(taskIds(yaml)).toEqual(["begin", "t", "complete"]);
    expect(yaml).not.toMatch(/^ {4}type: io\.kestra\.plugin\.scripts/m);
  });
});

describe("flow-compiler — structureHash and the §6.5 asymmetry", () => {
  it("changes when a step is added, so the change needs human re-approval", () => {
    const before = flowCompiler.structureHash(model());
    const after = flowCompiler.structureHash(
      model({ steps: [...model().steps, { id: "extra", kind: "transform", expr: "x" }] }),
    );
    expect(after).not.toBe(before);
  });

  it("changes when a ref changes — different systems get touched", () => {
    const other = model();
    (other.steps[1] as { ref: string }).ref = "chat_post";
    expect(flowCompiler.structureHash(other)).not.toBe(flowCompiler.structureHash(model()));
  });

  it("is stable across a pure fragment change — the automated-retest case", () => {
    // §6.5's asymmetry, now that `code` steps are real. Regenerating a fragment
    // must NOT force a human re-approval: at 1-of-3 first-pass accuracy every
    // regeneration would become an approval cycle, and that friction is what
    // gets the gate switched off.
    const a = model({ steps: [codeStep()] });
    const b = model({ steps: [codeStep({ code: "def run(payload):\n    return {'rows': sorted(payload['rows'])}" })] });
    expect(flowCompiler.structureHash(b)).toBe(flowCompiler.structureHash(a));
  });

  it("changes when a fragment's CONTRACT changes — the human case", () => {
    // The other half. A fragment's declared output is what decides whether a
    // downstream step gets what it expects, so widening or narrowing it is a
    // structural change even though the body is untouched.
    const a = model({ steps: [codeStep()] });
    expect(flowCompiler.structureHash(model({ steps: [codeStep({ outputKeys: ["rows", "total"] })] }))).not.toBe(
      flowCompiler.structureHash(a),
    );
    expect(flowCompiler.structureHash(model({ steps: [codeStep({ inputExpr: "{}" })] }))).not.toBe(
      flowCompiler.structureHash(a),
    );
  });

  it("changes when a gate's SUMMARY changes", () => {
    // The summary IS what a past approval meant — it is the whole of what the
    // approver was asked. A revision that edits it is a different revision.
    const a = model({ steps: [gateStep()] });
    expect(flowCompiler.structureHash(model({ steps: [gateStep({ summaryExpr: '"delete everything?"' })] }))).not.toBe(
      flowCompiler.structureHash(a),
    );
  });

  it("ignores the order dependsOn happens to be written in", () => {
    const a = model({
      steps: [
        { id: "x", kind: "transform", expr: "e" },
        { id: "y", kind: "transform", expr: "e" },
        { id: "z", kind: "transform", expr: "e", dependsOn: ["x", "y"] },
      ],
    });
    const b = model({
      steps: [
        { id: "x", kind: "transform", expr: "e" },
        { id: "y", kind: "transform", expr: "e" },
        { id: "z", kind: "transform", expr: "e", dependsOn: ["y", "x"] },
      ],
    });
    expect(flowCompiler.structureHash(a)).toBe(flowCompiler.structureHash(b));
  });
});

describe("flow-compiler — `code` steps (Phase 4)", () => {
  const yamlOf = (over: Partial<CodeStep> = {}) =>
    flowCompiler.compile(model({ steps: [codeStep(over)] }), { namespace: draft }).yaml;

  it("runs the fragment in the DOCKER task runner, never Process", () => {
    // Assertion 23, and the highest-consequence single line in the emitter.
    // `…runner.process.Process` runs the fragment IN THE KESTRA CONTAINER —
    // same filesystem, same network, same credentials as the engine. It is one
    // word away and it silently removes every containment property below.
    const yaml = yamlOf();
    expect(yaml).toContain("type: io.kestra.plugin.scripts.runner.docker.Docker");
    expect(yaml).not.toContain("runner.process.Process");
    expect(yaml).toContain("type: io.kestra.plugin.scripts.python.Script");
  });

  it("disables the network on the task itself — V1, measured", () => {
    // The engine-side half of this is proved by `kestra:phase4`, which asserts a
    // real fragment's outbound socket fails. This is the compiler-side half:
    // that the emitter cannot forget to ask for it.
    expect(yamlOf()).toMatch(/^ {6}networkMode: "none"$/m);
  });

  it("pins the base image and never pulls it (O2)", () => {
    const yaml = yamlOf();
    expect(yaml).toMatch(/^ {4}containerImage: "foundry\/fragment-base:/m);
    // A pull is the one thing that would reach a registry from a task, and a
    // tag resolving differently later is exactly what O2 exists to prevent.
    expect(yaml).toMatch(/^ {6}pullPolicy: NEVER$/m);
  });

  it("gives the container no env, no volumes and no mounted config", () => {
    // 04 §5.3.2 — "the container sees its input and nothing else". Asserted as
    // the ABSENCE of the keys, so adding one has to break a test.
    const yaml = yamlOf();
    for (const key of ["env:", "volumes:", "config:", "credentials:"]) {
      expect(yaml).not.toContain(`\n      ${key}`);
    }
    expect(yaml).toContain("input.json: |");
  });

  it("wraps the fragment so the fragment does no I/O of its own", () => {
    const yaml = yamlOf();
    // The wrapper owns reading the input, calling run(), checking the contract
    // and printing the marker — so a fragment cannot pick a channel, half-write
    // one, or declare its own contract satisfied.
    expect(yaml).toContain('_OUTPUT_KEYS = ["rows"]');
    expect(yaml).toContain("_result = run(_payload)");
    expect(yaml).toContain("contract_violation");
  });

  it("contains a fragment that tries to escape its block scalar", () => {
    // Same containment as a transform expression: ending a block scalar
    // requires DEDENTING, and every line is emitted with the block's indent.
    const hostile =
      "def run(payload):\n    return {}\n\n  - id: evil\n    type: io.kestra.plugin.core.http.Request\n    uri: http://evil";
    const yaml = yamlOf({ code: hostile });
    expect(taskIds(yaml)).toEqual(["begin", "compute", "complete"]);
    expect(yaml).not.toMatch(/^ {4}uri: http:\/\/evil$/m);
  });

  it("refuses to deploy an empty or placeholder fragment", () => {
    // Assertion 30. An import strips generated code (§5.2), so a flow can
    // arrive with the body gone — and a flow that deployed empty would need
    // KESTRA to trigger generation, inverting the whole model.
    for (const code of ["", "   ", "needs_regeneration", "pass"]) {
      expect(() => yamlOf({ code })).toThrow(/generate it before deploying|no generated fragment/);
    }
  });

  it("refuses a fragment that does not define run()", () => {
    expect(() => yamlOf({ code: "x = 1" })).toThrow(/must define `run\(payload\)`/);
  });

  it("refuses a code step with no declared output", () => {
    // A step whose contract cannot be checked is the condition §6.7 says
    // produces invented values.
    expect(() => yamlOf({ outputKeys: [] })).toThrow(/no output fields/);
  });

  it("refuses a code feed that is not a JSON object — run 4171a39b", () => {
    // The measured death: `inputExpr: "{{ inputs.period }}"` rendered to the
    // bare value `2026-08-31` and the runner's `json.load` died raw, while op
    // validation, model findings and the compiler were all green. The feed is
    // an object BY CONSTRUCTION from structured rows; a legacy `inputExpr`
    // wins VERBATIM and bypasses it, so the compiler BLOCKS the malformed
    // shape (canvas/import paths bypass ops) with the same checker the ops do.
    expect(() => yamlOf({ inputExpr: "{{ inputs.period }}" })).toThrow(/must be a JSON object/);
    expect(() => yamlOf({ inputExpr: "[{}]" })).toThrow(/must be a JSON object/);
  });
  it("refuses a code feed that drops a bound input", () => {
    // The object parses but does not cover the property-row bindings — the
    // fragment would run without the input its rows promise. (`inputs`
    // bindings need no such check: normalise drops the display for populated
    // bindings, so only `inputBindings` can still disagree here. The nested
    // object parses to no bindings, so normalise keeps the display through
    // both passes and this check sees both halves.)
    expect(() =>
      yamlOf({
        inputExpr: '{"cfg": {"a": 5}}',
        inputBindings: [{ name: "rows", source: { kind: "fixed", value: "x" } }],
      }),
    ).toThrow(/missing contract input "rows"/);
  });

  it("accepts a covering object feed, with or without bindings", () => {
    expect(yamlOf()).toContain("input.json: |");
    expect(
      yamlOf({
        inputExpr: '{"rows": "{{ inputs.period }}"}',
        inputs: [{ name: "rows", source: { from: "input", inputId: "period" } }],
      }),
    ).toContain("input.json: |");
  });

  it("classifies a bad feed as bad_input, naming the step — never a traceback", () => {
    // The load sits INSIDE a try: a feed that is not a JSON object is the
    const yaml = yamlOf();
    expect(yaml).toContain('_refuse("bad_input"');
    expect(yaml).toContain("input feed must be a JSON object");
    // Python-escaped in the emitted script (`\"`), as the wrapper renders it.
    expect(yaml).toContain('step \\"compute\\"');
    const loadAt = yaml.indexOf("_payload = _json.load(_f)");
    expect(loadAt).toBeGreaterThan(-1);
    // Guarded above by the nearest `try:`, refused below by the `except` that
    // names the step — and both land before the fragment is ever called.
    expect(yaml.lastIndexOf("try:", loadAt)).toBeGreaterThan(-1);
    const exceptAt = yaml.indexOf("except Exception as _e:", loadAt);
    expect(exceptAt).toBeGreaterThan(loadAt);
    expect(yaml.indexOf("_result = run(_payload)")).toBeGreaterThan(exceptAt);
    expect(yaml).toContain("if not isinstance(_payload, dict):");
  });

  it("never emits an inference endpoint (assertion 29)", () => {
    // The only runtime LLM path is the `agent` step VIA FOUNDRY. A `code` step
    // reaching one would also have to defeat networkMode:none, but the grep is
    // the cheap half and it is the half that catches a careless emitter.
    const yaml = yamlOf();
    for (const s of ["openai", "anthropic", "/v1/chat", "completions", "inference"]) {
      expect(yaml.toLowerCase()).not.toContain(s);
    }
  });
});

describe("flow-compiler — `approval` steps (gate 3)", () => {
  const approvalStep = (over: Partial<ApprovalStep> = {}): ApprovalStep => ({
    id: "confirm_send",
    kind: "approval",
    summaryExpr: '"Send 11 warnings?"',
    ...over,
  });
  const yamlOf = (over: Partial<ApprovalStep> = {}) =>
    flowCompiler.compile(model({ steps: [approvalStep(over)] }), { namespace: draft }).yaml;

  it("emits a registration task plus a durable Pause", () => {
    // Same two-task shape as `agent`, and for the same reason: the wait has to
    // outlive the API server. A human takes hours, so an in-process wait would
    // not survive a deploy — let alone a night.
    expect(taskIds(yamlOf())).toEqual(["begin", "confirm_send", "confirm_send_await", "complete"]);
    expect(yamlOf()).toContain("type: io.kestra.plugin.core.flow.Pause");
    expect(yamlOf()).toContain('uri: "{{ vars.foundry }}/api/steps/approval"');
  });

  it("asks for a DECISION on resume, not a result", () => {
    // `decision` and `note`, versus the agent's `result`/`status`. The names are
    // what the resume posts as multipart form fields, so they are part of the
    // contract with `step-approval.service.ts` rather than cosmetic.
    const yaml = yamlOf();
    expect(yaml).toMatch(/onResume:\n\s+- id: decision/);
    expect(yaml).toContain("- id: note");
  });

  it("bounds the wait, and defaults it to a day rather than an hour", () => {
    // Bounded for the agent's reason — an unbounded Pause holds an M3 budget
    // slot for ever. Longer by default because the thing being waited on is a
    // person, who may be asleep.
    expect(yamlOf()).toMatch(/^ {4}pauseDuration: PT86400S$/m);
    expect(yamlOf({ awaitSeconds: 3600 })).toMatch(/^ {4}pauseDuration: PT3600S$/m);
  });

  it("refuses a wait shorter than a person can answer in", () => {
    // 30s is legal for an agent and absurd for a human: a gate that always times
    // out reads as a broken flow rather than as a misconfiguration.
    expect(() => yamlOf({ awaitSeconds: 30 })).toThrow(/awaitSeconds/);
    expect(() => yamlOf({ awaitSeconds: 604_801 })).toThrow(/awaitSeconds/);
    expect(() => yamlOf({ awaitSeconds: 3600 })).not.toThrow();
  });

  it("refuses a gate with no question", () => {
    // An approval with no summary is a button. The question is the whole
    // difference between a gate and a delay.
    expect(() => yamlOf({ summaryExpr: "  " })).toThrow(/summary/);
  });

  it("refuses a step id that would collide with the synthesised await task", () => {
    const bad = model({
      steps: [
        approvalStep({ id: "gate" }),
        { id: "gate_await", kind: "transform", expr: "x" },
      ],
    });
    expect(() => flowCompiler.compile(bad, { namespace: draft })).toThrow(/already uses/);
  });

  it("puts the gate BEFORE the steps that follow it", () => {
    // Tasks run in emission order, so this is the whole mechanism: `notify`
    // appears after the Pause and therefore cannot run until it is resolved. If
    // the order inverted, every other assertion about gate 3 would still pass
    // while the send happened first.
    const yaml = flowCompiler.compile(
      model({
        steps: [
          approvalStep(),
          { id: "notify", kind: "tool", ref: "mail_send", paramsExpr: "[]", dependsOn: ["confirm_send"] },
        ],
      }),
      { namespace: draft },
    ).yaml;
    const ids = taskIds(yaml);
    expect(ids.indexOf("confirm_send_await")).toBeLessThan(ids.indexOf("notify"));
  });

  it("makes the question part of the structure hash", () => {
    // Changing what an approver is ASKED changes what a past approval meant, so
    // it needs a re-approval — unlike a fragment body, which is the
    // automated-retest case (§6.5).
    const a = flowCompiler.structureHash(model({ steps: [approvalStep()] }));
    const b = flowCompiler.structureHash(
      model({ steps: [approvalStep({ summaryExpr: '"Send 11 warnings, really?"' })] }),
    );
    expect(a).not.toEqual(b);
  });
});

describe("flow-compiler — refsOf", () => {
  it("returns tool and datasource refs, and nothing from the other kinds", () => {
    // `transform`, `code` and `agent` contribute nothing, and that follows from
    // R9 rather than being an omission: none of them can reach a tool or a
    // query. If one ever did, staleness would stop covering it — the sweep and
    // the compiled-refs record both read this function, so they cannot disagree.
    expect(
      flowCompiler.refsOf(
        model({
          steps: [
            ...model().steps,
            { id: "t", kind: "transform", expr: "x" },
            codeStep(),
            gateStep(),
          ],
        }),
      ),
    ).toEqual(["hr_demo.attendance_below_threshold", "mail_send"]);
  });
});

// ── Retry ────────────────────────────────────────────────────────────────────
//
// The compiler's half of Stage 4. The engine's half — that Kestra accepts the
// block and that a flaky step actually recovers — is `pnpm kestra:retry`; these
// assertions are about the shape emitted and, mostly, about what is REFUSED.

describe("flow-compiler — retry emission", () => {
  const withRetry = (over = {}) =>
    model({
      steps: [
        {
          id: "notify",
          kind: "tool",
          ref: "mail_send",
          paramsExpr: "{{ x }}",
          retry: { maxAttempts: 3, ...over },
        },
      ],
    });

  it("emits nothing at all when a step declares no retry", () => {
    // The byte-identical property. Adding retry must not change the YAML of any
    // flow that does not use it, or every deployed revision's `compiled_yaml_hash`
    // changes on the release that introduced it.
    expect(flowCompiler.compile(model(), { namespace: draft }).yaml).not.toContain("retry:");
  });

  it("emits maxAttemptS — plural — because that is the field the engine binds", () => {
    // Kestra accepts both `maxAttempt` and `maxAttempts` and flags neither as
    // deprecated, so this cannot be caught by validation. Its own constraint
    // violation names the plural (`tasks[0].retry.maxAttempts: must be greater
    // than or equal to 1`), which is how we know which one is real.
    const yaml = flowCompiler.compile(withRetry(), { namespace: draft }).yaml;
    expect(yaml).toContain("maxAttempts: 3");
    expect(yaml).not.toMatch(/^\s*maxAttempt:/m);
  });

  it("always emits behavior: RETRY_FAILED_TASK, and never CREATE_NEW_EXECUTION", () => {
    // The single most dangerous value in this block. `CREATE_NEW_EXECUTION`
    // would call `begin` again — a second execution token, a second M3 budget
    // slot and a second `flow_executions` row for one logical run. It is the
    // engine's default today; this asserts we do not depend on that staying true.
    const yaml = flowCompiler.compile(withRetry(), { namespace: draft }).yaml;
    expect(yaml).toContain("behavior: RETRY_FAILED_TASK");
    expect(yaml).not.toContain("CREATE_NEW_EXECUTION");
  });

  it("defaults to a constant 5s interval and marks the run WARNING on recovery", () => {
    const yaml = flowCompiler.compile(withRetry(), { namespace: draft }).yaml;
    expect(yaml).toContain("type: constant");
    expect(yaml).toContain("interval: PT5S");
    // Not cosmetic: a run that only worked on the third go is not the same as
    // one that worked first time, and every consumer already reads `warning` as
    // settled-and-successful, so this is honesty without a false alarm.
    expect(yaml).toContain("warningOnRetry: true");
  });

  it("caps the exponential backoff rather than letting it compound unbounded", () => {
    const yaml = flowCompiler.compile(
      withRetry({ backoff: "exponential", intervalSeconds: 300, maxAttempts: 5 }),
      { namespace: draft },
    ).yaml;
    expect(yaml).toContain("type: exponential");
    // 300 × 2⁴ = 4800s = 80 minutes between attempts 4 and 5. Clamped to 900.
    expect(yaml).toContain("maxInterval: PT900S");
  });

  it("emits the block for a code step too", () => {
    const yaml = flowCompiler.compile(
      model({ steps: [{ ...codeStep(), retry: { maxAttempts: 2 } }] }),
      { namespace: draft },
    ).yaml;
    expect(yaml).toContain("maxAttempts: 2");
  });
});

describe("flow-compiler — retry is REFUSED where a re-attempt would not be a re-attempt", () => {
  const refuse = (step: object) =>
    () => flowCompiler.compile(model({ steps: [step as never] }), { namespace: draft });

  it("refuses retry on an approval step, and says the decision outlives the task", () => {
    expect(
      refuse({
        id: "gate",
        kind: "approval",
        summaryExpr: '"proceed?"',
        retry: { maxAttempts: 2 },
      }),
    ).toThrow(/already answered/);
  });

  it("refuses retry on a transform, which has no network to fail on", () => {
    expect(refuse({ id: "t", kind: "transform", expr: "x", retry: { maxAttempts: 2 } })).toThrow(
      /cannot fail\s+transiently|cannot fail transiently/,
    );
  });

  it("refuses maxAttempts of 1 — that is not a retry — and of 6", () => {
    const bad = (retry: object) =>
      () =>
        flowCompiler.compile(
          model({ steps: [{ id: "n", kind: "tool", ref: "mail_send", paramsExpr: "{{x}}", retry } as never] }),
          { namespace: draft },
        );
    expect(bad({ maxAttempts: 1 })).toThrow(FlowCompileError);
    expect(bad({ maxAttempts: 6 })).toThrow(FlowCompileError);
    expect(bad({ maxAttempts: 2.5 })).toThrow(FlowCompileError);
    expect(bad({ maxAttempts: 2, intervalSeconds: 0 })).toThrow(FlowCompileError);
    expect(bad({ maxAttempts: 2, intervalSeconds: 301 })).toThrow(FlowCompileError);
    // The positive control. Without it the four above would pass against a
    // validator that rejected every retry it was given.
    expect(bad({ maxAttempts: 2, intervalSeconds: 300 })).not.toThrow();
  });
});

describe("flow-compiler — retry and the §6.5 structure line", () => {
  it("is on the STRUCTURE side: adding a retry needs re-approval", () => {
    // "May send this batch" and "may send this batch up to five times" are
    // different grants, and approval binds to a revision precisely so nobody can
    // widen a grant by editing.
    const before = flowCompiler.structureHash(model());
    const after = flowCompiler.structureHash(
      model({
        steps: [
          model().steps[0],
          { ...(model().steps[1] as CallStep), retry: { maxAttempts: 3 } },
        ],
      }),
    );
    expect(after).not.toBe(before);
  });

  it("but an absent retry contributes NOTHING, rather than contributing a null", () => {
    // The regression this guards: `[...head, ref, paramsExpr, retry ?? null]`
    // would change the hash of every step in every workspace, so the release
    // that added retry would have reported a structure change — and demanded a
    // fresh human approval — for every armed flow in the product, none of which
    // had changed. `retryShape` returns `[]`, not `[null]`, for exactly that.
    //
    // Checkable without pinning a literal digest: a model that spells out
    // `retry: undefined` must hash identically to one that omits the key.
    const omitted = model();
    const spelledOut = model({
      steps: [
        { ...(model().steps[0] as CallStep), retry: undefined },
        { ...(model().steps[1] as CallStep), retry: undefined },
      ],
    });
    expect(flowCompiler.structureHash(spelledOut)).toBe(flowCompiler.structureHash(omitted));
  });
});
 describe("flow-compiler — adjustable inputs (extraInputs)", () => {
  it("emits a tool's extraInputs as extraParams, and nothing for other steps", () => {
    const m = model({
      steps: model().steps.map((s) =>
        s.id === "notify" ? { ...s, extraInputs: [{ name: "cc", value: "boss@acme.example" }] } : s,
      ),
    });
    const { yaml } = flowCompiler.compile(m, { namespace: draft });
    expect(yaml).toContain('"extraParams": [{"name":"cc","value":"boss@acme.example"}]');
    expect(yaml.match(/"extraParams"/g)?.length).toBe(1);
  });

  /**
   * ⚠ The subject changed; the property did not. This compared two values of a
   * per-step named-parameter list on a kind that no longer exists — the property
   * is that such a list is STRUCTURE, and that an absent one hashes exactly like
   * the pre-feature shape, or every armed flow reads as changed.
   */
  it("an extraInputs change moves the structure hash; an absent list hashes like before", () => {
    const withParams = model({
      steps: model().steps.map((s) =>
        s.id === "notify" ? { ...s, extraInputs: [{ name: "cc", value: "boss@acme.example" }] } : s,
      ),
    });
    const changed = model({
      steps: model().steps.map((s) =>
        s.id === "notify" ? { ...s, extraInputs: [{ name: "cc", value: "other@acme.example" }] } : s,
      ),
    });
    expect(flowCompiler.structureHash(changed)).not.toBe(flowCompiler.structureHash(withParams));
    // Absent and explicitly-undefined both contribute nothing — no mass
    // re-approval for flows that never used the feature (the retry precedent).
    const omitted = model();
    const spelledOut = model({
      steps: [
        { ...(model().steps[0] as CallStep) },
        { ...(model().steps[1] as CallStep), extraInputs: undefined },
      ],
    });
    expect(flowCompiler.structureHash(spelledOut)).toBe(flowCompiler.structureHash(omitted));
  });
});

// ── Wave-1 golden (Stage 4) ────────────────────────────────────────────────────
//
// One fixture through the whole wave-1 surface: an `llm` callback, an `http`
// callback, a template `transform`, a two-branch chain with a `merge`, and two
// flow-level output rows. The YAML is pinned byte-for-byte — any emitter
// change, however cosmetic, must re-take this golden deliberately, not drift
// through. `structureHash` moves on a property change and holds still on a
// `name`-only change (the §6.5 line the method's docblock draws).
describe("flow-compiler — wave-1 golden (llm + http + template + branches + rows)", () => {
  const wave1 = (): FlowModel =>
    model({
      id: "invoice-escalation",
      inputs: [{ id: "as_of", type: "STRING", defaults: "2026-09-01" }],
      steps: [
        {
          id: "fetch",
          kind: "datasource",
          ref: "hr_demo.invoices",
          paramsExpr: '[{"as_of": "{{ inputs.as_of }}"}]',
        },
        {
          id: "rank",
          kind: "llm",
          model: "test-model",
          tempPreset: "balanced",
          temperature: 0.3,
          topP: 0.9,
          frequencyPenalty: 0,
          presencePenalty: 0,
          promptBlocks: [
            { role: "system", text: "You triage overdue invoices." },
            { role: "user", text: "Which invoices exceed {{ inputs.threshold }}?" },
          ],
          outputFields: [{ name: "shortlist", type: "array", description: "Worth escalation" }],
          memoryEnabled: false,
          visionDetail: "low",
          reasoningSeparated: false,
          dependsOn: ["fetch"],
        },
        {
          id: "post",
          kind: "http",
          method: "POST",
          url: "https://hooks.example.test/overdue",
          headers: [{ name: "Content-Type", value: "application/json" }],
          queryParams: [],
          body: { kind: "json", content: '{"shortlist": "x"}' },
          auth: { kind: "none" },
          sslVerify: true,
          dependsOn: ["rank"],
        },
        {
          id: "big",
          kind: "branch",
          test: {
            left: { from: "step", stepId: "fetch", field: "total" },
            operator: "field_gt",
            right: "100",
          },
          dependsOn: ["post"],
        },
        { id: "email_big", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["big"] },
        {
          id: "small",
          kind: "branch",
          conditionExpr: "{{ json(outputs.fetch.body).results[0].data | jq('length > 0') | first }}",
          elseOf: "big",
        },
        { id: "email_small", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["small"] },
        { id: "otherwise", kind: "branch", elseOf: "small" },
        { id: "email_none", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["otherwise"] },
        { id: "merged", kind: "merge", sources: ["email_big", "email_small"] },
        {
          id: "digest",
          kind: "transform",
          mode: "template",
          expr: "{{ 1 }}",
          templateText: "Escalate {{ json(outputs.merged.body) }}.",
          dependsOn: ["merged"],
        },
      ],
      output: {
        description: "the escalation shortlist",
        rows: [
          { name: "shortlist", type: "array[object]", source: { from: "whole", stepId: "rank" } },
          { name: "posted", type: "object", source: { from: "step", stepId: "post", field: "body" } },
        ],
      },
    });

  const expectedYaml = `# Generated by flow-compiler.service.ts — do not edit in Kestra.
# Foundry is the system of record for the MODEL; Kestra for the deployed YAML.
id: invoice-escalation
namespace: foundry.acme.hr.draft
inputs:
  - id: as_of
    type: STRING
    defaults: "2026-09-01"
variables:
  foundry: "http://server:4000"
tasks:
  - id: begin
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/executions/begin"
    method: POST
    contentType: application/json
    headers:
      Authorization: "Bearer {{ secret('FOUNDRY_CALLBACK') }}"
    body: |
      {
        "namespace": "{{ flow.namespace }}",
        "flowId": "{{ flow.id }}",
        "executionId": "{{ execution.id }}",
        "inputs": {
        "as_of": "{{ inputs.as_of }}"
      }
      }
  - id: fetch
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/steps/datasource"
    method: POST
    contentType: application/json
    headers:
      Authorization: "Bearer {{ json(outputs.begin.body).token }}"
    body: |
      {
        "ref": "hr_demo.invoices",
        "stepId": "fetch",
        "taskrunId": "{{ taskrun.id }}",
        "params":
          [{ "as_of": "{{ inputs.as_of }}" }]
      }
  - id: rank
    type: io.kestra.plugin.core.http.Request
    # after: fetch
    uri: "{{ vars.foundry }}/api/steps/llm"
    method: POST
    contentType: application/json
    headers:
      Authorization: "Bearer {{ json(outputs.begin.body).token }}"
    body: |
      {
        "ref": "llm",
        "stepId": "rank",
        "taskrunId": "{{ taskrun.id }}",
        "params":
          {
            "model": "test-model",
            "temperature": 0.3,
            "topP": 0.9,
            "frequencyPenalty": 0,
            "presencePenalty": 0,
            "messages": [
              {
                "role": "system",
                "text": "You triage overdue invoices."
              },
              {
                "role": "user",
                "text": "Which invoices exceed {{ inputs.threshold }}?"
              }
            ],
            "outputFields": [
              {
                "name": "shortlist",
                "type": "array",
                "description": "Worth escalation"
              }
            ],
            "contextStepId": null
          }
      }
  - id: post
    type: io.kestra.plugin.core.http.Request
    # after: rank
    uri: "{{ vars.foundry }}/api/steps/http"
    method: POST
    contentType: application/json
    headers:
      Authorization: "Bearer {{ json(outputs.begin.body).token }}"
    body: |
      {
        "stepId": "post",
        "taskrunId": "{{ taskrun.id }}",
        "params":
          {
            "method": "POST",
            "url": "https://hooks.example.test/overdue",
            "headers": [
              {
                "name": "Content-Type",
                "value": "application/json"
              }
            ],
            "queryParams": [],
            "body": {
              "kind": "json",
              "content": "{\\"shortlist\\": \\"x\\"}"
            },
            "auth": {
              "kind": "none"
            },
            "timeouts": null,
            "sslVerify": true
          }
      }
  - id: big
    type: io.kestra.plugin.core.flow.If
    # after: post
    condition: |
      {{ json(outputs.fetch.body).results[0].data | jq('any(.[]; (.total | tonumber?) > 100)') | first }}
    then:
      - id: email_big
        type: io.kestra.plugin.core.http.Request
        # after: big
        uri: "{{ vars.foundry }}/api/steps/tool"
        method: POST
        contentType: application/json
        headers:
          Authorization: "Bearer {{ json(outputs.begin.body).token }}"
        body: |
          {
            "ref": "mail_send",
            "stepId": "email_big",
            "taskrunId": "{{ taskrun.id }}",
            "params":
              [{}]
          }
    else:
          - id: small
            type: io.kestra.plugin.core.flow.If
            condition: |
              {{ json(outputs.fetch.body).results[0].data | jq('length > 0') | first }}
            then:
              - id: email_small
                type: io.kestra.plugin.core.http.Request
                # after: small
                uri: "{{ vars.foundry }}/api/steps/tool"
                method: POST
                contentType: application/json
                headers:
                  Authorization: "Bearer {{ json(outputs.begin.body).token }}"
                body: |
                  {
                    "ref": "mail_send",
                    "stepId": "email_small",
                    "taskrunId": "{{ taskrun.id }}",
                    "params":
                      [{}]
                  }
            else:
                  - id: email_none
                    type: io.kestra.plugin.core.http.Request
                    # after: otherwise
                    uri: "{{ vars.foundry }}/api/steps/tool"
                    method: POST
                    contentType: application/json
                    headers:
                      Authorization: "Bearer {{ json(outputs.begin.body).token }}"
                    body: |
                      {
                        "ref": "mail_send",
                        "stepId": "email_none",
                        "taskrunId": "{{ taskrun.id }}",
                        "params":
                          [{}]
                      }
  - id: merged
    type: io.kestra.plugin.core.debug.Return
    format: |
      {{ outputs.email_big.body ?? outputs.email_small.body ?? "null" }}
  - id: digest
    type: io.kestra.plugin.core.debug.Return
    # after: merged
    format: |
      Escalate {{ json(outputs.merged.body) }}.
  - id: complete
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/executions/{{ json(outputs.begin.body).flowExecutionId }}/complete"
    method: POST
    contentType: application/json
    headers:
      Authorization: "Bearer {{ json(outputs.begin.body).token }}"
    body: |
      { "status": "succeeded" }
`;

  it("compiles the wave-1 fixture to byte-identical YAML — but for the escaped input spelling (I-288)", async () => {
    const { toLegacyInputSpelling } = await import("@foundry/flow-edit");
    const { yaml } = flowCompiler.compile(wave1(), { namespace: draft });
    expect(toLegacyInputSpelling(yaml)).toBe(expectedYaml);
  });

  it("the fixture is saveable — its output rows validate", () => {
    // The golden must never pin a flow no route would accept: a drift between
    // the compiler and `checkFlowOutput` would otherwise hide here.
    expect(checkFlowOutput(wave1())).toEqual([]);
  });

  it("structureHash moves on a property change, not on a name-only change", () => {
    const before = flowCompiler.structureHash(wave1());
    const relabelled = wave1();
    for (const s of relabelled.steps) {
      (s as { name?: string }).name = `pretty ${s.id}`;
      (s as { description?: string }).description = "a new coat of paint";
    }
    expect(flowCompiler.structureHash(relabelled)).toBe(before);
    const retemplated = wave1();
    (retemplated.steps.find((s) => s.id === "digest") as { templateText?: string }).templateText =
      "Escalate {{ json(outputs.merged.body) }} — revised.";
    expect(flowCompiler.structureHash(retemplated)).not.toBe(before);
    const retuned = wave1();
    (retuned.steps.find((s) => s.id === "rank") as { temperature?: number }).temperature = 0.7;
    expect(flowCompiler.structureHash(retuned)).not.toBe(before);
  });

  it("a template transform emits templateText under format:, an expression one emits expr", () => {
    // `format:` for both — the block scalar re-indents either text identically,
    // and the read expression stays `json(outputs.<id>.value)` either way.
    const template = flowCompiler.compile(
      model({
        steps: [
          { id: "shape", kind: "transform", mode: "template", expr: "{{ 1 }}", templateText: "Hi {{ 1 }}." },
        ],
      }),
      { namespace: draft },
    ).yaml;
    expect(template).toContain("format: |\n      Hi {{ 1 }}.");
    expect(template).not.toContain("{{ 1 }}\n      Hi");
    const expression = flowCompiler.compile(
      model({ steps: [{ id: "shape", kind: "transform", expr: "{{ 2 }}" }] }),
      { namespace: draft },
    ).yaml;
    expect(expression).toContain("format: |\n      {{ 2 }}");
    expect(NODE_TYPES.transform.outputs[0]?.expr).toBe("json(outputs.<id>.value)");
  });

  it("a branch renders test when conditionExpr is absent; carrying both renders the test", () => {
    // The composed dual-read rule, in two halves: `normaliseModel` prefers the
    // typed test (a readable `conditionExpr` is upgraded and the display
    // string dropped — "new wins"), while `displayCondition` returns a
    // non-empty display verbatim when it is present (the unreadable past the
    // upgrade left as written, rendered unknown-with-display).
    const rendered = flowCompiler.compile(
      model({
        steps: [
          { id: "fetch", kind: "datasource", ref: "hr_demo.invoices", paramsExpr: "[{}]" },
          {
            id: "cond",
            kind: "branch",
            test: {
              left: { from: "step", stepId: "fetch", field: "status" },
              operator: "field_eq",
              right: "overdue",
            },
            dependsOn: ["fetch"],
          },
          { id: "send", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["cond"] },
        ],
      }),
      { namespace: draft },
    ).yaml;
    expect(rendered).toContain(`any(.[]; .status == "overdue")`);
    // Both keys: the upgrade drops the display string, so the test renders and
    // "{{ true }}" is gone — the step compiles to what the panel shows, not to
    // a stale string beside it.
    const upgraded = flowCompiler.compile(
      model({
        steps: [
          { id: "fetch", kind: "datasource", ref: "hr_demo.invoices", paramsExpr: "[{}]" },
          {
            id: "cond",
            kind: "branch",
            conditionExpr: "{{ true }}",
            test: {
              left: { from: "step", stepId: "fetch", field: "status" },
              operator: "field_eq",
              right: "overdue",
            },
            dependsOn: ["fetch"],
          },
          { id: "send", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["cond"] },
        ],
      }),
      { namespace: draft },
    ).yaml;
    expect(upgraded).toContain(`any(.[]; .status == "overdue")`);
    expect(upgraded).not.toContain("{{ true }}");
    // The `displayCondition` half, pinned directly: a non-empty display wins
    // verbatim; a blank one is absent, so the test renders rather than the
    const steps = model({
      steps: [
        { id: "fetch", kind: "datasource", ref: "hr_demo.invoices", paramsExpr: "[{}]" },
        { id: "send", kind: "tool", ref: "mail_send", paramsExpr: "[{}]", dependsOn: ["cond"] },
      ],
    }).steps;
    const test: BranchStep["test"] = {
      left: { from: "step", stepId: "fetch", field: "status" },
      operator: "field_eq",
      right: "overdue",
    };
    expect(displayCondition({ id: "cond", kind: "branch", conditionExpr: "{{ true }}", test }, steps)).toBe(
      "{{ true }}",
    );
    expect(displayCondition({ id: "cond", kind: "branch", conditionExpr: "", test }, steps)).toContain(
      `any(.[]; .status == "overdue")`,
    );
  });

  it("a branch with neither test nor elseOf stays refused, naming the step", () => {
    const bad = wave1();
    (bad.steps.find((s) => s.id === "big") as { test?: unknown }).test = undefined;
    expect(() => flowCompiler.compile(bad, { namespace: draft })).toThrow(/branch step "big" has no condition/);
  });
});

describe("flow-compiler — computed inputs (fire-time-inputs M1)", () => {
  const expr = (fn: "priorMonth", scheduled: boolean, timezone?: string) =>
    computedInputExpression(fn, { scheduled, timezone });

  it("spells each derivation exactly once, in one place", () => {
    expect(computedInputExpression("priorMonth", { scheduled: false })).toBe(
      "{{ now() | dateAdd(-1, 'MONTHS') | date('yyyy-MM') }}",
    );
    expect(computedInputExpression("currentMonth", { scheduled: false })).toBe(
      "{{ now() | date('yyyy-MM') }}",
    );
    expect(computedInputExpression("priorDate", { scheduled: false })).toBe(
      "{{ now() | dateAdd(-1, 'DAYS') | date('yyyy-MM-dd') }}",
    );
    expect(computedInputExpression("currentDate", { scheduled: false })).toBe(
      "{{ now() | date('yyyy-MM-dd') }}",
    );
    expect(computedInputExpression("currentYear", { scheduled: false })).toBe(
      "{{ now() | date('yyyy') }}",
    );
    expect(computedInputExpression("runTimestamp", { scheduled: false })).toBe("{{ now() }}");
  });

  it("slice 5d: a day offset on currentDate is priorDate's own dateAdd with a checked integer — and refused anywhere else", () => {
    expect(computedInputExpression("currentDate", { scheduled: false, offsetDays: -3 })).toBe("{{ now() | dateAdd(-3, 'DAYS') | date('yyyy-MM-dd') }}");
    expect(computedInputExpression("currentDate", { scheduled: true, offsetDays: -3 })).toBe("{{ (trigger.date ?? now()) | dateAdd(-3, 'DAYS') | date('yyyy-MM-dd') }}");
    expect(() => computedInputExpression("currentMonth", { scheduled: false, offsetDays: -3 })).toThrow(/currentDate only/);
    expect(() => computedInputExpression("currentDate", { scheduled: false, offsetDays: 1.5 })).toThrow(/whole number/);
  });

  it("a scheduled flow reads the scheduled tick, falling back to now on a hand fire", () => {
    // Bare `trigger.date` 422s execution creation on a manual fire ("Unable to
    // find `trigger` — measured 2026-09-14), so the coalesced root is what a
    // scheduled flow compiles to: the tick on schedule fires, creation time
    // otherwise.
    expect(expr("priorMonth", true)).toBe(
      "{{ (trigger.date ?? now()) | dateAdd(-1, 'MONTHS') | date('yyyy-MM') }}",
    );
  });

  it("appends the flow's timezone only when the model sets one", () => {
    expect(expr("priorMonth", true, "Europe/London")).toBe(
      "{{ (trigger.date ?? now()) | dateAdd(-1, 'MONTHS') | date('yyyy-MM', timeZone='Europe/London') }}",
    );
    expect(expr("priorMonth", true)).not.toContain("timeZone");
  });

  it("refuses a timezone that could break out of the Pebble string literal", () => {
    expect(() => expr("priorMonth", true, "x' | foo | 'y")).toThrow(FlowCompileError);
  });

  it("emits a computed input's expression as its defaults", () => {
    const scheduled = model({
      inputs: [{ id: "period", type: "STRING", required: true, computed: "priorMonth" }],
      schedule: { cron: "0 7 1 * *", timezone: "Europe/London" },
    });
    const { yaml } = flowCompiler.compile(scheduled, { namespace: draft });
    expect(yaml).toContain(
      `defaults: "{{ (trigger.date ?? now()) | dateAdd(-1, 'MONTHS') | date('yyyy-MM', timeZone='Europe/London') }}"`,
    );
    const plain = model({
      inputs: [{ id: "period", type: "STRING", required: true, computed: "priorMonth" }],
    });
    expect(flowCompiler.compile(plain, { namespace: draft }).yaml).toContain(
      `defaults: "{{ now() | dateAdd(-1, 'MONTHS') | date('yyyy-MM') }}"`,
    );
  });

  it("a derivation change is a structure change (§6.5)", () => {
    const before = flowCompiler.structureHash(model());
    const after = flowCompiler.structureHash(
      model({ inputs: [{ id: "period", type: "STRING", computed: "priorMonth" }] }),
    );
    expect(after).not.toBe(before);
  });
});

describe("flow-compiler — validateModel refuses bindings that name a missing step", () => {
  // Rev-2 live shape: `fetch.period → derive_month.month` with no `derive_month`
  // step. The revision saved with validateModel green.
  const rev2 = (): FlowModel =>
    model({
      steps: [
        {
          id: "fetch",
          kind: "tool",
          ref: "hr_tool",
          inputs: [{ name: "period", source: { from: "step", stepId: "derive_month", field: "month" } }],
        } as never,
      ],
    });

  it("throws naming the reader, the missing step, and the declared ids", () => {
    try {
      validateModel(rev2());
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlowCompileError);
      const message = (e as FlowCompileError).message;
      expect(message).toContain('step "fetch".inputs[period]');
      expect(message).toContain('"derive_month"');
      expect(message).toContain("steps: fetch");
      expect(message).toContain("unknown_binding_step");
      expect((e as FlowCompileError).stepId).toBe("fetch");
    }
  });

  it("refuses through compile too, not just the direct call", () => {
    expect(() => flowCompiler.compile(rev2(), { namespace: draft })).toThrow(FlowCompileError);
  });

  it("passes once the derivation step exists — the control", () => {
    const fixed = rev2();
    fixed.steps.unshift({
      id: "derive_month",
      kind: "code",
      code: "def run(payload):\n    return {'month': '2026-06'}",
      inputExpr: '{"as_of": "{{ inputs.as_of }}"}',
      outputKeys: ["month"],
    } as never);
    expect(() => validateModel(fixed)).not.toThrow();
  });
});
