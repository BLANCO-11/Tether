import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { flowsRouter } from "./flows.js";
import { flowTriggersRouter } from "./triggers.js";
import { flowService } from "../services/flow.service.js";
import { triggerService } from "../services/trigger.service.js";

/**
 * I-22 / GAPS §3.1 — what crosses the wire, asserted at the wire.
 *
 * R5: an execution is addressed by its FOUNDRY id, and a client is never handed
 * anything that addresses Kestra. `ExecutionView.id`'s own docblock says so.
 * Two write routes disagreed with it: `POST …/flows/:id/test-run` returned the
 * engine's execution id **and** the namespace, and `POST …/triggers/:tid/fire`
 * returned the execution id. Both because they did `res.json(<the service's
 * return value>)`, and the service legitimately resolves those fields.
 *
 * ⚠ Which is why the fix is at the ROUTE and this test is at the route. Every
 * `kestra:*` harness imports `flowService` in-process and waits on the engine
 * with `kestraExecutionId`; taking it off the service would break eight of them
 * to close a leak that only exists over HTTP. So the service still returns it,
 * the route projects, and the property "the projection is a projection" has to
 * be checked somewhere the service's own return value is not the answer.
 *
 * ⚠ And it is asserted on the RAW RESPONSE TEXT, not on parsed fields. A field
 * re-added under a different name, or a `...started` spread restored, still puts
 * the value on the wire — and a test reading `body.kestraExecutionId` would see
 * nothing wrong. The service is stubbed to return unmistakable sentinel values
 * for exactly that reason: they cannot occur by coincidence.
 */

const KESTRA_EXECUTION_ID = "SENTINEL-kestra-execution-4sJhq2";
const NAMESPACE = "foundry.acme.hr.draft";

const app = express();
app.use(express.json());
app.use("/ws/:workspaceId/flows", flowsRouter);
app.use("/ws/:workspaceId/flows/:flowId/triggers", flowTriggersRouter);

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

describe("POST /…/flows/:id/test-run hands the client no engine addressing", () => {
  it("returns the revision and neither the Kestra execution id nor the namespace", async () => {
    const spy = vi.spyOn(flowService, "testRun").mockResolvedValue({
      kestraExecutionId: KESTRA_EXECUTION_ID,
      namespace: NAMESPACE,
      revision: 4,
      usedProductionData: false,
    });

    const r = await fetch(`${base}/ws/ws-1/flows/flow-1/test-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: { period: "2026-06" } }),
    });
    const text = await r.text();

    expect(r.status).toBe(202);
    // The whole point: the service DID resolve both, and neither reached the wire.
    await expect(spy.mock.results[0].value).resolves.toMatchObject({
      kestraExecutionId: KESTRA_EXECUTION_ID,
    });
    expect(text).not.toContain(KESTRA_EXECUTION_ID);
    expect(text).not.toContain(NAMESPACE);
    // Still useful: the revision is which draft actually ran, and it is Foundry's
    // own number. Stripping to `{}` would have been a smaller diff and would have
    // left the caller unable to say what it started. The mock-vs-prod indicator
    // rides along beside it: a boolean, never addressing.
    expect(JSON.parse(text)).toEqual({ revision: 4, usedProductionData: false });

    spy.mockRestore();
  });
});

describe("POST /…/triggers/:tid/fire hands the client no engine addressing", () => {
  const stubLoadAndValidate = () => {
    const load = vi.spyOn(triggerService, "getForFire").mockResolvedValue({ id: "t-1" } as never);
    const valid = vi
      .spyOn(triggerService, "validateFireInputs")
      .mockResolvedValue({ inputs: {}, issues: [] });
    return [load, valid] as const;
  };
  it("returns the Foundry fire id and a boolean, never the Kestra execution id", async () => {
    const [load, valid] = stubLoadAndValidate();
    const spy = vi.spyOn(triggerService, "fire").mockResolvedValue({
      fire: { id: "9d0f1e2a-0000-4000-8000-000000000001" } as never,
      executionId: null,
      kestraExecutionId: KESTRA_EXECUTION_ID,
      error: undefined,
    });

    const r = await fetch(`${base}/ws/ws-1/flows/flow-1/triggers/t-1/fire`, { method: "POST" });
    const text = await r.text();

    expect(r.status).toBe(202);
    expect(text).not.toContain(KESTRA_EXECUTION_ID);
    // `started` is what the client actually read the leaked id for — presence,
    // and nothing else (`lib/api.ts` said as much in a comment). `fireId` is the
    // `trigger_fires` row, which is written BEFORE the engine is called and so
    // exists even for a fire that started nothing.
    expect(JSON.parse(text)).toEqual({
      fireId: "9d0f1e2a-0000-4000-8000-000000000001",
      started: true,
      error: undefined,
    });

    spy.mockRestore();
    load.mockRestore();
    valid.mockRestore();
  });

  /**
   * The control. Without it, a route that hardcoded `started: true` — or one that
   * simply always reported success — would pass the assertion above, and "did
   * anything actually start" is the single question this response answers.
   */
  it("reports `started: false` when the engine accepted nothing", async () => {
    const [load, valid] = stubLoadAndValidate();
    const spy = vi.spyOn(triggerService, "fire").mockResolvedValue({
      fire: { id: "9d0f1e2a-0000-4000-8000-000000000002" } as never,
      executionId: null,
      kestraExecutionId: null,
      error: "no approved revision",
    });

    const r = await fetch(`${base}/ws/ws-1/flows/flow-1/triggers/t-1/fire`, { method: "POST" });
    expect(await r.json()).toEqual({
      fireId: "9d0f1e2a-0000-4000-8000-000000000002",
      started: false,
      error: "no approved revision",
    });

    spy.mockRestore();
    load.mockRestore();
    valid.mockRestore();
  });
});

describe("POST /…/triggers/:tid/fire validates per-fire inputs", () => {
  it("422s naming each input and fires nothing when validation fails", async () => {
    const load = vi.spyOn(triggerService, "getForFire").mockResolvedValue({ id: "t-1" } as never);
    const valid = vi.spyOn(triggerService, "validateFireInputs").mockResolvedValue({
      inputs: {},
      issues: [{ input: "period", message: 'input "period" is required and no value was supplied' }],
    });
    const fire = vi.spyOn(triggerService, "fire");

    const r = await fetch(`${base}/ws/ws-1/flows/flow-1/triggers/t-1/fire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: {} }),
    });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({
      error: "invalid_inputs",
      message: 'input "period" is required and no value was supplied',
      issues: [{ input: "period", message: 'input "period" is required and no value was supplied' }],
    });
    // The fire row is written inside `fire` — validation failure never gets there.
    expect(fire).not.toHaveBeenCalled();

    fire.mockRestore();
    load.mockRestore();
    valid.mockRestore();
  });

  it("passes the validated map to fire, not the raw body", async () => {
    const load = vi.spyOn(triggerService, "getForFire").mockResolvedValue({ id: "t-1" } as never);
    const valid = vi.spyOn(triggerService, "validateFireInputs").mockResolvedValue({
      inputs: { period: "2026-08" },
      issues: [],
    });
    const spy = vi.spyOn(triggerService, "fire").mockResolvedValue({
      fire: { id: "9d0f1e2a-0000-4000-8000-000000000003" } as never,
      executionId: null,
      kestraExecutionId: null,
      error: undefined,
    });

    const r = await fetch(`${base}/ws/ws-1/flows/flow-1/triggers/t-1/fire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: { period: "2026-08", undeclared: "x" } }),
    });
    expect(r.status).toBe(202);
    // Whatever the body carried, `fire` receives the validator's map.
    expect(spy).toHaveBeenCalledWith("t-1", "manual", undefined, { period: "2026-08" });

    spy.mockRestore();
    load.mockRestore();
    valid.mockRestore();
  });
});
