import { describe, expect, it } from "vitest";
import {
  flowCompiler,
  type FlowModel,
  type HttpStep,
  type LlmStep,
} from "./flow-compiler.service.js";
import { RETRYABLE_KINDS as EDIT_RETRYABLE } from "@foundry/flow-edit";
import { namespaceFor } from "./kestra-client.service.js";

/**
 * Wave-1 emitters (Stage 4.1/4.2) — `llm` and `http` compile to Foundry
 * callbacks, in the `tool` task shape exactly: one `http.Request`, one
 * envelope, the credential never in the engine.
 *
 * Pure: no database, no Kestra, no gateway.
 */

const draft = namespaceFor("acme", "hr", "draft");

const llmStep = (over: Partial<LlmStep> = {}): LlmStep => ({
  id: "ask",
  kind: "llm",
  model: "test-model",
  tempPreset: "balanced",
  temperature: 0.7,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  promptBlocks: [{ role: "user", text: "Which invoices are worth escalation?" }],
  outputFields: [],
  memoryEnabled: false,
  visionDetail: "low",
  reasoningSeparated: false,
  ...over,
});

const httpStep = (over: Partial<HttpStep> = {}): HttpStep => ({
  id: "post",
  kind: "http",
  method: "POST",
  url: "https://hooks.example.test/shortlist",
  headers: [{ name: "Content-Type", value: "application/json" }],
  queryParams: [],
  body: { kind: "json", content: '{"items": []}' },
  auth: { kind: "none" },
  sslVerify: true,
  ...over,
});

const model = (steps: FlowModel["steps"]): FlowModel => ({ id: "wave-one", steps });

function taskBody(yaml: string, id: string): string {
  const start = yaml.indexOf(`- id: ${id}\n`);
  if (start < 0) throw new Error(`no task ${id}`);
  const next = yaml.indexOf("\n  - id: ", start + 1);
  return yaml.slice(start, next < 0 ? undefined : next);
}

describe("flow-compiler — `llm` emits a Foundry callback in the tool shape", () => {
  it("posts to /api/steps/llm with ref, step, taskrun and rendered params", () => {
    const { yaml } = flowCompiler.compile(model([llmStep()]), { namespace: draft });
    const task = taskBody(yaml, "ask");
    expect(task).toContain("type: io.kestra.plugin.core.http.Request");
    expect(task).toContain("uri: \"{{ vars.foundry }}/api/steps/llm\"");
    expect(task).toContain("method: POST");
    expect(task).toContain("Authorization: \"Bearer {{ json(outputs.begin.body).token }}\"");
    expect(task).toContain('"ref": "llm"');
    expect(task).toContain('"stepId": "ask"');
    expect(task).toContain('"taskrunId": "{{ taskrun.id }}"');
    expect(task).toContain('"model": "test-model"');
    expect(task).toContain('"temperature": 0.7');
    expect(task).toContain("Which invoices are worth escalation?");
  });

  it("is retryable — a lost model response re-runs the whole task", () => {
    const { yaml } = flowCompiler.compile(
      model([llmStep({ retry: { maxAttempts: 3 } })]),
      { namespace: draft },
    );
    expect(taskBody(yaml, "ask")).toContain("maxAttempts: 3");
  });

  it("the flow-edit mirror agrees — `llm` carries a runtime retry", () => {
    expect([...EDIT_RETRYABLE]).toContain("llm");
  });

  it("structureHash moves when the model changes", () => {
    const before = flowCompiler.structureHash(model([llmStep()]));
    const after = flowCompiler.structureHash(model([llmStep({ model: "other-model" })]));
    expect(before).not.toBe(after);
  });
});

describe("flow-compiler — `http` emits a Foundry callback with the request fields", () => {
  it("posts to /api/steps/http with step, taskrun and the request line", () => {
    const { yaml } = flowCompiler.compile(model([httpStep()]), { namespace: draft });
    const task = taskBody(yaml, "post");
    expect(task).toContain("type: io.kestra.plugin.core.http.Request");
    expect(task).toContain("uri: \"{{ vars.foundry }}/api/steps/http\"");
    expect(task).toContain("method: POST");
    expect(task).toContain('"stepId": "post"');
    expect(task).toContain('"method": "POST"');
    expect(task).toContain('"url": "https://hooks.example.test/shortlist"');
    expect(task).toContain('"sslVerify": true');
    expect(task).not.toContain('"ref"');
  });

  it("carries the auth reference, never a token", () => {
    const { yaml } = flowCompiler.compile(
      model([httpStep({ auth: { kind: "bearer", secretRef: "HOOKS_TOKEN" } })]),
      { namespace: draft },
    );
    const task = taskBody(yaml, "post");
    expect(task).toContain('"secretRef": "HOOKS_TOKEN"');
  });

  it("is retryable — a dropped dial re-runs the whole task", () => {
    const { yaml } = flowCompiler.compile(
      model([httpStep({ retry: { maxAttempts: 2 } })]),
      { namespace: draft },
    );
    expect(taskBody(yaml, "post")).toContain("maxAttempts: 2");
  });

  it("the flow-edit mirror agrees — `http` carries a runtime retry", () => {
    expect([...EDIT_RETRYABLE]).toContain("http");
  });

  it("structureHash moves when the url changes", () => {
    const before = flowCompiler.structureHash(model([httpStep()]));
    const after = flowCompiler.structureHash(model([httpStep({ url: "https://other.example.test/x" })]));
    expect(before).not.toBe(after);
  });
});
