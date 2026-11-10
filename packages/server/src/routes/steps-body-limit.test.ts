/**
 * The callback body bound, through `createApp()` — step-payload-bounds T07.
 *
 * ── Why this file exists when `callback-body-limit.test.ts` already passes ────
 *
 * That suite tests the handler. **This one tests the MOUNT ORDER**, which is the
 * half that actually broke: a perfectly correct refusal mounted one line below
 * `express.json` never runs, body-parser answers its own 413 first, and every
 * assertion in the unit suite still passes. The measured incident was exactly
 * that shape — `express.json({ limit: "2mb" })` was mounted ABOVE `requestId`
 * and above these routes, so the 413 on execution `05aca859-…` carried no id, no
 * size and no limit.
 *
 * So every case here goes over real HTTP into the real app, and the properties
 * under test are ordering properties:
 *
 *   · 401 beats 413        — auth runs before the size guard
 *   · 413 beats the parser — the guard runs before `express.json`
 *   · 3 MiB gets through   — the callback parser is at the CALLBACK cap, not 2 MB
 *   · 3 MiB elsewhere 413s — the process-wide parser is still 2 MB
 *
 * ⚠ The third is the one that proves the feature. Under the old order it was a
 * 413; if it ever becomes one again, the transport is binding once more and every
 * specific per-parameter refusal downstream is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const VALID_TOKEN = "tok-valid";
const EXEC_ID = "05aca859-91df-4472-be95-edcd7e0d967b";

/**
 * Only the seams the request path touches are mocked, and each returns the
 * smallest thing that lets a request be *observed reaching* its route. Nothing
 * here is asked to do work — the subject is what happens before the route.
 */
vi.mock("../services/execution-token.service.js", () => ({
  executionTokenService: {
    verify: vi.fn(async (t: string) =>
      t === VALID_TOKEN ? { workspaceId: "ws-1", flowExecutionId: EXEC_ID } : null,
    ),
  },
}));

vi.mock("../services/step-execution.service.js", () => ({
  stepBatchSchema: { safeParse: (b: unknown) => ({ success: true, data: b }) },
  stepExecutionService: {
    // Echoes the item count, so a test can see the body arrived intact.
    tool: vi.fn(async (_ws: string, input: { params?: unknown[] }) => ({
      results: [],
      succeeded: 0,
      failed: 0,
      warnings: [],
      received: input.params?.length ?? 0,
    })),
    datasource: vi.fn(),
    query: vi.fn(),
  },
  StepError: class StepError extends Error {},
}));

vi.mock("../services/agent-run.service.js", () => ({
  agentRunService: {},
  agentStepSchema: { safeParse: () => ({ success: false, error: { flatten: () => ({}) } }) },
}));
vi.mock("../services/step-approval.service.js", () => ({
  stepApprovalService: {},
  approvalStepSchema: { safeParse: () => ({ success: false, error: { flatten: () => ({}) } }) },
}));
vi.mock("../repositories/flow-execution.repo.js", () => ({
  flowStepRunRepo: { record: vi.fn(async () => {}) },
  // Not a Forge run, so the declared-uses check (forge-uses.ts) lets the callback through to the route.
  flowExecutionRepo: { get: vi.fn(async () => ({ kestraExecutionId: "k-1", runnerJob: null })) },
}));
vi.mock("../services/execution-env.service.js", () => ({
  envForExecution: vi.fn(async () => "draft"),
}));

const { createApp } = await import("../app.js");
const { config } = await import("../config/index.js");

const LIMIT = config.steps.callbackMaxBytes;

const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    // Express 5 hands a listen failure to this callback; passing `resolve` straight in would resolve on it.
    server = app.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A body of a given size, shaped like the real thing.
 *
 * ⚠ Built as one long string rather than N items: the subject is BYTES, and a
 * 9 MiB array of small objects would make the suite slow for no gain.
 */
function bodyOfBytes(bytes: number): string {
  const envelope = `{"ref":"x","params":[{"input":""}]}`;
  const pad = "A".repeat(Math.max(0, bytes - envelope.length));
  return `{"ref":"x","params":[{"input":"${pad}"}]}`;
}

const post = (path: string, body: string, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

const MiB = 1024 * 1024;

describe("an oversize step callback names itself", () => {
  it("9 MiB with a valid token → 413 in the contract's shape, naming the execution", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/api/steps/tool", bodyOfBytes(9 * MiB), VALID_TOKEN);

    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "callback_payload_too_large",
      limitBytes: LIMIT,
      flowExecutionId: EXEC_ID,
    });
    expect(body.actualBytes as number).toBeGreaterThan(9 * MiB - 100);
    // The whole point of P0: the refusal is greppable.
    expect(typeof body.requestId).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
    spy.mockRestore();
  });

  /**
   * ⚠ PRECEDENCE. An anonymous caller must learn 401 and nothing about our
   * limits — a 413 here would be a free probe of the transport bound, and it is
   * the ordering (auth above the guard) that decides it, not either component.
   */
  it("9 MiB with NO token → 401, not 413", async () => {
    const res = await post("/api/steps/tool", bodyOfBytes(9 * MiB));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("9 MiB with an INVALID token → 401, not 413", async () => {
    const res = await post("/api/steps/tool", bodyOfBytes(9 * MiB), "tok-nope");
    expect(res.status).toBe(401);
  });

  /**
   * ⚠ **THE ASSERTION THAT PROVES THE FEATURE.** 3 MiB is over the old
   * process-wide 2 MB and under the new callback cap. Before this change it was
   * a 413 from body-parser; now it must reach the route, because that is what
   * "the transport is no longer the binding constraint" means (Decision 1).
   */
  it("3 MiB with a valid token REACHES THE ROUTE — over the old 2 MB cap, under the new one", async () => {
    const res = await post("/api/steps/tool", bodyOfBytes(3 * MiB), VALID_TOKEN);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: 1 });
  });

  it("a small callback is unchanged", async () => {
    const res = await post("/api/steps/tool", '{"ref":"x","params":[{}]}', VALID_TOKEN);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: 1 });
  });

  /**
   * `/api/executions` has mixed per-route auth, so the guard runs there with no
   * `req.stepAuth`. It must refuse the same way and name NO execution rather
   * than reading one out of the body it is refusing to parse.
   */
  it("an oversize /api/executions body → 413 with NO flowExecutionId", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/api/executions/begin", bodyOfBytes(9 * MiB));

    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("callback_payload_too_large");
    expect(body).not.toHaveProperty("flowExecutionId");
    expect(body.message as string).toContain("A step callback sent");
    spy.mockRestore();
  });

  /**
   * ⚠ THE CONTROL FOR DECISION 1's SECOND HALF. The process-wide limit is
   * UNCHANGED at 2 MB. If this ever returns 200, someone "simplified" two limits
   * into one and widened every route in the process — including the two public
   * receivers — by 2.5×.
   */
  it("CONTROL — 3 MiB to a NON-callback route is still refused by the 2 MB parser", async () => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "nope" },
      body: bodyOfBytes(3 * MiB),
    });
    expect(res.status).toBe(413);
    // Body-parser's own 413, routed through `errorHandler` — which now carries an
    // id on the 4xx branch (P0), so even this one is greppable.
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("request_error");
    expect(typeof body.requestId).toBe("string");
  });
});

describe("⚠ a Forge run's callback is held to what its workflow declares (forge-uses.ts, plugins phase 9)", () => {
  it("an undeclared tool, and any other step route, are a 403 before the handler; a declared tool reaches it", async () => {
    const { flowExecutionRepo } = await import("../repositories/flow-execution.repo.js");
    const get = vi.mocked(flowExecutionRepo.get);
    const before = get.getMockImplementation();
    get.mockImplementation(async () => ({ kestraExecutionId: "fr-1", runnerJob: { workflow: { steps: [{ id: "s", entry: "s.py", uses: ["tool:x"] }] } } }) as never);
    try {
      const refused = await post("/api/steps/tool", JSON.stringify({ ref: "tether_email_send", params: [{}] }), VALID_TOKEN);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "undeclared_use", message: expect.stringMatching(/tether_email_send/) });
      expect((await post("/api/steps/http", JSON.stringify({ ref: "x", params: [{}] }), VALID_TOKEN)).status).toBe(403);
      expect((await post("/api/steps/tool", bodyOfBytes(1024), VALID_TOKEN)).status).toBe(200);
    } finally {
      get.mockImplementation(before!);
    }
  });
});
