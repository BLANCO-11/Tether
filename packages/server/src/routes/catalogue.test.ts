import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { catalogueRouter } from "./catalogue.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { requestId } from "../middleware/request-id.middleware.js";
import { flowCatalogueService } from "../services/flow-catalogue.service.js";

/**
 * FR-001/FR-002 — a non-UUID workspaceId must never reach
 * `flowCatalogueService.forWorkspace` (research.md Decision 3's second
 * measured gap).
 */
const app = express();
app.use(requestId);
app.use("/ws/:workspaceId/catalogue", catalogueRouter);
app.use(errorHandler);

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

describe("GET /ws/:workspaceId/catalogue", () => {
  it("rejects a non-UUID workspaceId with 400 before the service is called", async () => {
    const spy = vi.spyOn(flowCatalogueService, "forWorkspace");
    const res = await fetch(`${base}/ws/not-a-uuid/catalogue`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reaches the service unchanged for a well-formed UUID", async () => {
    const spy = vi
      .spyOn(flowCatalogueService, "forWorkspace")
      .mockResolvedValue({ refs: [], caps: {} } as never);
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const res = await fetch(`${base}/ws/${id}/catalogue`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(id);
    spy.mockRestore();
  });
});
