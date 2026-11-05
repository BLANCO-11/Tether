/**
 * Phase 3 step 1 (E3.1): a SINGLE call bound to another step's field used to
 * compile to `""` — "post the summary's text to chat" deployed, ran green and
 * posted empty text. It now builds the whole object in jq over that ONE
 * upstream's output; reads from two upstreams are refused with the fix named.
 */
import { describe, expect, it } from "vitest";
import { flowCompiler, FlowCompileError, type FlowModel } from "./flow-compiler.service.js";
import { namespaceFor } from "./kestra-client.service.js";

const draft = namespaceFor("acme", "hr", "draft");

const model = (postInputs: unknown[]): FlowModel =>
  ({
    id: "digest",
    inputs: [{ id: "period", type: "STRING", defaults: "2026-06" }],
    steps: [
      { id: "screen", kind: "datasource", ref: "hr_demo.attendance_below_threshold", paramsExpr: '[{ "period": "{{ inputs.period }}" }]' },
      { id: "summary", kind: "tool", ref: "llm_complete", paramsExpr: '[{ "prompt": "x" }]', dependsOn: ["screen"] },
      { id: "post", kind: "tool", ref: "chat_post_message", inputs: postInputs, dependsOn: ["summary"] },
    ],
  }) as unknown as FlowModel;

describe("a single call over one upstream's output", () => {
  it("compiles the step read into jq — never an empty string", () => {
    const { yaml } = flowCompiler.compile(
      model([
        { name: "text", source: { from: "step", stepId: "summary", field: "text" } },
        { name: "channel", source: { from: "literal", value: "ops" } },
      ]),
      { namespace: draft },
    );
    expect(yaml).toContain(
      `json(outputs.summary.body).results[0].data | jq('[{"text": (if type == "array" then [.[] | .text] else .text end), "channel": "ops"}]') | first`,
    );
    expect(yaml).not.toMatch(/"text": ""/);
  });

  it("refuses reads from two upstreams in one call, naming the transform fix", () => {
    const two = model([
      { name: "text", source: { from: "step", stepId: "summary", field: "text" } },
      { name: "count", source: { from: "step", stepId: "screen", field: "n" } },
    ]);
    expect(() => flowCompiler.compile(two, { namespace: draft })).toThrow(FlowCompileError);
    expect(() => flowCompiler.compile(two, { namespace: draft })).toThrow(/2 upstream steps.*combine them in a transform/);
  });
});
