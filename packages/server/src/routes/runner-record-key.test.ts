/**
 * A Forge run's RECORD is written only by the runner (runner-report-key.ts, plugins phase 9 P9-I2), over real HTTP into
 * the real app. ⚠ What is pinned: the run's token alone — which a step's code holds — cannot post a step result, pause
 * the run or complete it; the token plus the runner's key for THAT run can; another run's key cannot; a Kestra
 * execution's callbacks are untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const TOKEN = "tok-valid";
const EXEC_ID = "6b0c1c4e-2f43-4d7a-9a51-0d6e3f7a1b22";
const m = vi.hoisted(() => ({ kestraExecutionId: "fr-1" }));

vi.mock("../services/execution-token.service.js", () => ({
  executionTokenService: {
    verify: vi.fn(async (t: string) => (t === "tok-valid" ? { workspaceId: "ws-1", flowExecutionId: "6b0c1c4e-2f43-4d7a-9a51-0d6e3f7a1b22" } : null)),
    burnForExecution: vi.fn(async () => 1),
  },
}));
vi.mock("../repositories/flow-execution.repo.js", () => ({
  flowExecutionRepo: { get: vi.fn(async () => ({ kestraExecutionId: m.kestraExecutionId, runnerJob: null })), update: vi.fn(async () => ({})) },
  flowStepRunRepo: { record: vi.fn(async () => {}) },
}));
vi.mock("../repositories/runner-step-result.repo.js", async (orig) => ({
  ...(await orig<typeof import("../repositories/runner-step-result.repo.js")>()),
  runnerStepResultRepo: { record: vi.fn(async () => {}) },
}));
vi.mock("../services/flow-expectation.service.js", async (orig) => ({
  ...(await orig<typeof import("../services/flow-expectation.service.js")>()),
  flowExpectationService: { evaluate: vi.fn(async () => ({ verdicts: [] })) },
}));

const { createApp } = await import("../app.js");
const { runnerReportKey } = await import("../services/runner-report-key.js");
const { flowRunnerService } = await import("../services/flow-runner.service.js");

const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  m.kestraExecutionId = "fr-1";
  vi.spyOn(flowRunnerService, "recordPause").mockResolvedValue(undefined as never);
});

const post = (path: string, body: unknown, key?: string) =>
  fetch(`${base}/api/executions/${EXEC_ID}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(key ? { "x-runner-report": key } : {}) },
    body: JSON.stringify(body),
  });

const result = { status: "succeeded" };
const pause = { stepId: "ok", title: "Approve?", ahead: [], memo: {} };

describe("⚠ a step's code holds the token, and the token alone does not write the run's record", () => {
  it("a step result, a pause and the end of the run are each refused without the runner's key", async () => {
    expect((await post("/steps/a/result", result)).status).toBe(403);
    expect((await post("/pause", pause)).status).toBe(403);
    expect((await post("/complete", { status: "succeeded" })).status).toBe(403);
  });
  it("another run's key is not this run's", async () => {
    const other = runnerReportKey("00000000-0000-4000-8000-000000000000");
    expect((await post("/steps/a/result", result, other)).status).toBe(403);
  });
  it("CONTROL: the token with this run's key writes all three", async () => {
    const key = runnerReportKey(EXEC_ID);
    expect((await post("/steps/a/result", result, key)).status).toBe(204);
    expect((await post("/pause", pause, key)).status).toBe(204);
    expect((await post("/complete", { status: "succeeded" }, key)).status).toBe(200);
  });
  it("a Kestra execution's callbacks are unchanged", async () => {
    m.kestraExecutionId = "kestra-abc";
    expect((await post("/steps/a/result", result)).status).toBe(204);
  });
});
