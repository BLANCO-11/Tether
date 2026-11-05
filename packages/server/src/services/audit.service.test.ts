import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { auditEvents, workspaces } from "../db/schema.js";
import { auditService } from "./audit.service.js";

const reachable = await (async () => {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!reachable)("auditService", () => {
  let ws: string;
  let wsOther: string;
  const stamp = Date.now().toString(36);

  beforeAll(async () => {
    const [a] = await db
      .insert(workspaces)
      .values({ name: `audit-ws-${stamp}-a`, slug: `audit-${stamp}-a` })
      .returning();
    const [b] = await db
      .insert(workspaces)
      .values({ name: `audit-ws-${stamp}-b`, slug: `audit-${stamp}-b` })
      .returning();
    ws = a.id;
    wsOther = b.id;

    // Seed three events with distinct times/actors/operations
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    await auditService.record({
      workspaceId: ws,
      actor: "alice@example.com",
      operation: "create",
      entity: "workflow",
      description: "Created workflow Weekly digest",
      whereText: "Workflows · Weekly digest",
      raw: { id: "1" },
      time: twoDaysAgo,
    });
    await auditService.record({
      workspaceId: ws,
      actor: "bob@example.com",
      operation: "publish",
      entity: "workflow",
      description: "Published workflow Weekly digest",
      whereText: "Workflows · Weekly digest",
      raw: { id: "2" },
      time: yesterday,
    });
    await auditService.record({
      workspaceId: ws,
      actor: "System",
      operation: "execute",
      entity: "run",
      entityId: "run-123",
      description: "Executed run run-123",
      whereText: "Runs · run-123",
      raw: { id: "3" },
      time: now,
    });
    // Other workspace event — must not leak
    await auditService.record({
      workspaceId: wsOther,
      actor: "alice@example.com",
      operation: "create",
      entity: "workflow",
      description: "Other workspace event",
      whereText: "Workflows · Other",
      raw: { id: "other" },
    });
  });

  afterAll(async () => {
    await db.delete(auditEvents).where(eq(auditEvents.workspaceId, ws));
    await db.delete(auditEvents).where(eq(auditEvents.workspaceId, wsOther));
    await db.delete(workspaces).where(eq(workspaces.id, ws));
    await db.delete(workspaces).where(eq(workspaces.id, wsOther));
  });

  it("lists scoped to workspace ordered by time desc", async () => {
    const rows = await auditService.list({ workspaceId: ws });
    expect(rows).toHaveLength(3);
    expect(rows[0].actor).toBe("System");
    expect(rows[1].actor).toBe("bob@example.com");
    expect(rows[2].actor).toBe("alice@example.com");
    // Other workspace not included
    const other = await auditService.list({ workspaceId: wsOther });
    expect(other).toHaveLength(1);
  });

  it("filters by q (actor, operation, exact id)", async () => {
    const byActor = await auditService.list({ workspaceId: ws, q: "alice" });
    expect(byActor).toHaveLength(1);
    expect(byActor[0].actor).toBe("alice@example.com");

    const byOp = await auditService.list({ workspaceId: ws, q: "publish" });
    expect(byOp).toHaveLength(1);
    expect(byOp[0].operation).toBe("publish");

    const all = await auditService.list({ workspaceId: ws });
    const exactId = all[0].id;
    const byId = await auditService.list({ workspaceId: ws, q: exactId });
    expect(byId).toHaveLength(1);
    expect(byId[0].id).toBe(exactId);
  });

  it("filters by from/to inclusive", async () => {
    const all = await auditService.list({ workspaceId: ws });
    expect(all).toHaveLength(3);
    const middle = all[1].time;
    const fromIso = new Date(middle.getTime() - 60_000).toISOString();
    const toIso = new Date(middle.getTime() + 60_000).toISOString();
    const window = await auditService.list({ workspaceId: ws, from: fromIso, to: toIso });
    expect(window).toHaveLength(1);
    expect(window[0].id).toBe(all[1].id);

    // Filtered-empty: future range excludes everything
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const empty = await auditService.list({ workspaceId: ws, from: future });
    expect(empty).toHaveLength(0);
  });

  it("record helper writes and validates enums", async () => {
    const row = await auditService.record({
      workspaceId: ws,
      actor: "tester",
      operation: "approve",
      entity: "approval",
      description: "Approved request",
      whereText: "Approvals · REQ-1",
    });
    expect(row.workspaceId).toBe(ws);
    expect(row.operation).toBe("approve");
    await db.delete(auditEvents).where(eq(auditEvents.id, row.id));

    await expect(
      auditService.record({
        workspaceId: ws,
        actor: "tester",
        operation: "invalid" as never,
        entity: "workflow",
        description: "bad",
        whereText: "x",
      }),
    ).rejects.toThrow(/invalid operation/);
  });

  it("pages: consecutive pages are the whole list in order, and count is its length", async () => {
    const all = await auditService.list({ workspaceId: ws });
    expect(all.length).toBeGreaterThanOrEqual(3); // CONTROL: there is something to page over
    const first = await auditService.list({ workspaceId: ws, limit: 2, offset: 0 });
    const rest = await auditService.list({ workspaceId: ws, limit: 200, offset: 2 });
    expect(first).toHaveLength(2);
    expect([...first, ...rest].map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(await auditService.count({ workspaceId: ws })).toBe(all.length);
    // The same filter decides both: a search narrows the count exactly as it narrows the list.
    const bob = await auditService.list({ workspaceId: ws, q: "bob" });
    expect(await auditService.count({ workspaceId: ws, q: "bob" })).toBe(bob.length);
    // And another workspace's events are counted for nobody else.
    expect(await auditService.count({ workspaceId: wsOther, q: "bob" })).toBe(0);
  });
});
