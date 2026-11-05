/**
 * `GET /api/workspaces/:ws/email-box`.
 *
 * ⚠ **THE FIRST TEST IS THE ONE THAT MATTERS, AND IT EXISTS BECAUSE THE ROUTE
 * SHIPPED BROKEN.** The router was mounted at a path carrying `:workspaceId`
 * and created with a bare `Router()`. Express does not give a child router its
 * parent's path parameters without `mergeParams: true`, so `req.params
 * .workspaceId` was `undefined` and the route answered **an empty list for
 * every workspace**.
 *
 * Nothing caught it. The typecheck passes, the route returns 200 with a valid
 * shape, and the page renders its empty state — which on THIS surface reads as
 * "no automation has sent an email", the exact lie the page's own header warns
 * about. It was found by draft-running a real chat-built flow and then failing
 * to see a message the database plainly held.
 *
 * So the test does not assert "the route returns rows". It asserts the route
 * returns rows **for the workspace in the path and not for another one** — the
 * property a missing `mergeParams` breaks and a row count does not notice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { vi } from "vitest";
import type { AddressInfo } from "node:net";
import { inArray } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { emailSends, workspaces } from "../db/schema.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { contentVisibility } from "../services/content-visibility.service.js";

// These tests are about the Email box itself; who may see which message is `content-visibility`'s and has its own
// tests. The route is mounted with no person behind it, so it is given an Admin-level viewer (sees everything).
vi.spyOn(contentVisibility, "viewer").mockResolvedValue({ subject: null, all: true, reviewer: false });
import { emailBoxRouter } from "./email-box.js";

let base = "";
let server: ReturnType<express.Express["listen"]>;
const created: string[] = [];

beforeAll(async () => {
  const app = express();
  // ⚠ Mounted EXACTLY as `app.ts` mounts it, parameter and all. A test that
  // mounted the router at a bare path would pass with `mergeParams` removed,
  // which is the whole defect.
  app.use("/api/workspaces/:workspaceId/email-box", emailBoxRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const rows = await db
    .insert(workspaces)
    .values([{ name: `email-box test A ${Date.now()}` }, { name: `email-box test B ${Date.now()}` }])
    .returning();
  created.push(...rows.map((r) => r.id));

  await db.insert(emailSends).values([
    {
      workspaceId: created[0],
      recipients: ["held@acme.example"],
      cc: [],
      subject: "held for A",
      outcome: "captured",
      capturedBody: "<p>A body</p>",
    },
    {
      workspaceId: created[0],
      recipients: ["real@acme.example"],
      cc: [],
      subject: "delivered for A",
      outcome: "sent",
      graphMessageId: "req-1",
    },
    {
      workspaceId: created[1],
      recipients: ["other@acme.example"],
      cc: [],
      subject: "held for B",
      outcome: "captured",
      capturedBody: "<p>B body</p>",
    },
  ]);
});

afterAll(async () => {
  server?.close();
  if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  await pool.end();
});

type Box = {
  workspaceId?: string;
  foundry: Array<{ id: string; subject: string | null; outcome: string; delivered: boolean; body: string | null }>;
};

const get = async (ws: string): Promise<Box> =>
  (await (await fetch(`${base}/api/workspaces/${ws}/email-box`)).json()) as Box;

describe("the workspace in the PATH is the workspace answered for", () => {
  it("returns this workspace's messages and not the other's", async () => {
    const a = await get(created[0]);
    const subjects = a.foundry.map((m) => m.subject).sort();
    expect(subjects).toEqual(["delivered for A", "held for A"]);
    // ⚠ The half a row count cannot notice.
    expect(subjects).not.toContain("held for B");
    expect(a.workspaceId).toBe(created[0]);
  });

  it("answers differently for a different workspace", async () => {
    // The control. Without it, a route that returned the SAME rows for every
    // workspace would satisfy the test above.
    const b = await get(created[1]);
    expect(b.foundry.map((m) => m.subject)).toEqual(["held for B"]);
  });
});

describe("held and delivered are told apart", () => {
  it("marks only a real send as delivered, and holds a body only for a captured one", async () => {
    const a = await get(created[0]);
    const held = a.foundry.find((m) => m.subject === "held for A")!;
    const sent = a.foundry.find((m) => m.subject === "delivered for A")!;

    expect(held.outcome).toBe("captured");
    expect(held.delivered).toBe(false);
    expect(held.body).toContain("A body");

    expect(sent.outcome).toBe("sent");
    expect(sent.delivered).toBe(true);
    // ⚠ A delivered message carries no body. If one ever did, the route must
    // still not hand it out — the client's guard is separate, and both exist.
    expect(sent.body).toBeNull();
  });
});

describe("clearing the Email box removes what was never delivered — never a delivered email", () => {
  // ⚠ Runs LAST in this file: it deletes rows the blocks above read.
  it("refuses to remove a delivered email, one at a time", async () => {
    const a = await get(created[0]);
    const sent = a.foundry.find((m) => m.subject === "delivered for A")!;
    const res = await fetch(`${base}/api/workspaces/${created[0]}/email-box/messages/${sent.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await get(created[0])).foundry.map((m) => m.subject)).toContain("delivered for A");
  });

  it("removes one held email by id — and only in its own workspace", async () => {
    const b = await get(created[1]);
    const heldB = b.foundry.find((m) => m.subject === "held for B")!;
    // Asked through workspace A, B's message is not found — the workspace is part of the query.
    const wrong = await fetch(`${base}/api/workspaces/${created[0]}/email-box/messages/${heldB.id}`, { method: "DELETE" });
    expect(wrong.status).toBe(404);
    const right = await fetch(`${base}/api/workspaces/${created[1]}/email-box/messages/${heldB.id}`, { method: "DELETE" });
    expect(right.status).toBe(200);
    expect((await get(created[1])).foundry).toEqual([]);
  });

  it("clears every held, refused and failed email in this workspace, keeps the delivered one", async () => {
    await db.insert(emailSends).values([
      { workspaceId: created[0], recipients: ["x@acme.example"], cc: [], subject: "refused for A", outcome: "refused" },
      { workspaceId: created[0], recipients: ["y@acme.example"], cc: [], subject: "failed for A", outcome: "failed" },
    ]);
    const res = await fetch(`${base}/api/workspaces/${created[0]}/email-box/undelivered`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 3 });
    expect((await get(created[0])).foundry.map((m) => m.subject)).toEqual(["delivered for A"]);
  });
});
