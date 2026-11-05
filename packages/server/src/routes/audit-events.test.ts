import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { auditEventsRouter } from "./audit-events.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { requestId } from "../middleware/request-id.middleware.js";
import { auditService } from "../services/audit.service.js";

const app = express();
app.use(requestId);
app.use("/ws/:workspaceId/audit-events", auditEventsRouter);
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

describe("GET /ws/:workspaceId/audit-events", () => {
  it("rejects non-UUID workspaceId with 400 before service", async () => {
    const spy = vi.spyOn(auditService, "list");
    const res = await fetch(`${base}/ws/not-a-uuid/audit-events`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 200 with {events} and forwards filters", async () => {
    const rows = [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        workspaceId: "550e8400-e29b-41d4-a716-446655440001",
        time: new Date("2026-08-11T15:02:00Z"),
        actor: "alice@example.com",
        operation: "create",
        entity: "workflow",
        entityId: null,
        description: "Created workflow",
        whereText: "Workflows · Weekly digest",
        whereEntityType: null,
        whereEntityId: null,
        raw: { hello: "world" },
      },
    ];
    const spy = vi.spyOn(auditService, "list").mockResolvedValue(rows as never);
    const ws = "550e8400-e29b-41d4-a716-446655440001";
    const res = await fetch(`${base}/ws/${ws}/audit-events?q=alice&from=2026-08-10&to=2026-08-12&view=raw`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith({ workspaceId: ws, q: "alice", from: "2026-08-10", to: "2026-08-12" });
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ raw: { hello: "world" } });
    spy.mockRestore();
  });

  it("strips raw when view is not raw (plain)", async () => {
    const rows = [
      {
        id: "550e8400-e29b-41d4-a716-446655440002",
        workspaceId: "550e8400-e29b-41d4-a716-446655440001",
        time: new Date("2026-08-11T15:02:00Z"),
        actor: "bob@example.com",
        operation: "publish",
        entity: "workflow",
        entityId: null,
        description: "Published",
        whereText: "Workflows · Weekly digest",
        whereEntityType: null,
        whereEntityId: null,
        raw: { secret: 1 },
      },
    ];
    const spy = vi.spyOn(auditService, "list").mockResolvedValue(rows as never);
    const ws = "550e8400-e29b-41d4-a716-446655440001";
    const res = await fetch(`${base}/ws/${ws}/audit-events?view=plain`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(body.events[0].raw).toBeUndefined();
    spy.mockRestore();
  });

  it("supports ?download=1 as csv export", async () => {
    const rows = [
      {
        id: "550e8400-e29b-41d4-a716-446655440003",
        workspaceId: "550e8400-e29b-41d4-a716-446655440001",
        time: new Date("2026-08-11T15:02:00Z"),
        actor: "alice@example.com",
        operation: "create",
        entity: "workflow",
        entityId: null,
        description: "Created",
        whereText: "Workflows · W",
        whereEntityType: null,
        whereEntityId: null,
        raw: null,
      },
    ];
    const spy = vi.spyOn(auditService, "list").mockResolvedValue(rows as never);
    const ws = "550e8400-e29b-41d4-a716-446655440001";
    const res = await fetch(`${base}/ws/${ws}/audit-events?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    expect(text).toContain("id,time,actor");
    spy.mockRestore();
  });

  it("export endpoint returns csv by default and json when format=json", async () => {
    const rows = [
      {
        id: "550e8400-e29b-41d4-a716-446655440004",
        workspaceId: "550e8400-e29b-41d4-a716-446655440001",
        time: new Date("2026-08-11T15:02:00Z"),
        actor: "alice@example.com",
        operation: "create",
        entity: "workflow",
        entityId: null,
        description: "Created",
        whereText: "Workflows · W",
        whereEntityType: null,
        whereEntityId: null,
        raw: null,
      },
    ];
    const spy = vi.spyOn(auditService, "list").mockResolvedValue(rows as never);
    const ws = "550e8400-e29b-41d4-a716-446655440001";
    const csvRes = await fetch(`${base}/ws/${ws}/audit-events/export`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const jsonRes = await fetch(`${base}/ws/${ws}/audit-events/export?format=json`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toContain("application/json");
    const body = (await jsonRes.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
    spy.mockRestore();
  });

  it("with ?limit it returns one page and the total the filter matches", async () => {
    const list = vi.spyOn(auditService, "list").mockResolvedValue([] as never);
    const count = vi.spyOn(auditService, "count").mockResolvedValue(312);
    const ws = "550e8400-e29b-41d4-a716-446655440001";
    const res = await fetch(`${base}/ws/${ws}/audit-events?q=alice&limit=50&offset=100`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], total: 312, limit: 50, offset: 100 });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws, q: "alice", limit: 50, offset: 100 }));
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws, q: "alice" }));
    list.mockRestore();
    count.mockRestore();
  });

  it("a CSV download is the whole filtered set, never a page", async () => {
    const list = vi.spyOn(auditService, "list").mockResolvedValue([] as never);
    const ws = "550e8400-e29b-41d4-a716-446655440001";
    await fetch(`${base}/ws/${ws}/audit-events?format=csv&limit=50`);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
    list.mockRestore();
  });
});
