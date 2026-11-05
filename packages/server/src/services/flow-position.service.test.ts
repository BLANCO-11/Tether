import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { flowRevisions, flows, workspaces } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowPositionService } from "./flow-position.service.js";
// A fresh engine id for a test flow (the job service that offered one is deleted, phase 8).
const freeFlowId = async (_ws: string, wanted: string) => `${wanted}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Step positions — plan decision ②, D-150.
 *
 * The organising rule of this file is the REVISION BOUNDARY: `saveRevision` /
 * `writeRevision` are the approval gate, and positions are a DIFFERENT write
 * path — a cosmetic drag must never create a revision and invalidate an
 * approval. Every test here either crosses the boundary (and must come back
 * empty) or stays on its own side of it.
 *
 * The second concern is tenancy: positions are workspace-scoped through the
 * flow row, so a flow id from another workspace must read as not-found on both
 * GET and PUT — the same refusal a missing flow gives, not an empty success.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(
      `\n[phase-2] SKIPPING position tests — parent DB unreachable: ${(e as Error).message}\n`,
    );
    return false;
  }
})();

const stamp = Date.now();
let wsA: string;
let wsB: string;
let flowA: string;
let flowB: string;

async function mkFlow(workspaceId: string, name: string): Promise<string> {
  const kestraFlowId = await freeFlowId(workspaceId, `pos-${stamp}-${name}`);
  const created = await flowRepo.create({
    workspaceId,
    name,
    kestraFlowId,
    description: "phase-2 position pin test; safe to delete",
  });
  if (!created) throw new Error(`flow create failed for ${name}`);
  return created.id;
}

async function revisionCount(flowId: string): Promise<number> {
  const rows = await db
    .select({ id: flowRevisions.id })
    .from(flowRevisions)
    .where(eq(flowRevisions.flowId, flowId));
  return rows.length;
}

beforeAll(async () => {
  if (!reachable) return;
  const mkWs = async (name: string) => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name, description: "phase-2 position test; safe to delete" })
      .returning();
    return ws.id;
  };
  wsA = await mkWs(`pos-a-${stamp}`);
  wsB = await mkWs(`pos-b-${stamp}`);
  flowA = await mkFlow(wsA, "positions-a");
  flowB = await mkFlow(wsB, "positions-b");
});

afterAll(async () => {
  if (reachable) {
    for (const id of [wsA, wsB]) {
      if (id) await db.delete(workspaces).where(eq(workspaces.id, id));
    }
  }
  await pool.end();
});

describe.skipIf(!reachable)("flow_step_positions", () => {
  it("round-trips: PUT replaces the set, GET returns exactly it", async () => {
    await flowPositionService.replace(wsA, flowA, {
      positions: [
        { stepId: "step_a", x: 120, y: 40 },
        { stepId: "step_b", x: 480, y: 200 },
      ],
    });
    const got = await flowPositionService.list(wsA, flowA);
    expect(got?.map((p) => ({ stepId: p.stepId, x: p.x, y: p.y }))).toEqual([
      { stepId: "step_a", x: 120, y: 40 },
      { stepId: "step_b", x: 480, y: 200 },
    ]);
  });

  it("PUT replaces the WHOLE set (wholesale mirror, D-150(f))", async () => {
    await flowPositionService.replace(wsA, flowA, {
      positions: [{ stepId: "step_b", x: 999, y: 111 }],
    });
    const got = await flowPositionService.list(wsA, flowA);
    expect(got?.map((p) => p.stepId)).toEqual(["step_b"]);
    expect(got?.[0].x).toBe(999);
    expect(got?.[0].y).toBe(111);
  });

  // ── THE PIN — the phase's own exit criterion ──────────────────────────────
  it("a positions write never touches flow_revisions", async () => {
    const before = await revisionCount(flowA);
    for (let i = 0; i < 3; i++) {
      await flowPositionService.replace(wsA, flowA, {
        positions: [{ stepId: `step_${i}`, x: i * 10, y: i * 20 }],
      });
    }
    expect(await revisionCount(flowA)).toBe(before);
  });

  it("reads and writes are workspace-scoped: another workspace's flow is not-found", async () => {
    const got = await flowPositionService.list(wsB, flowA);
    expect(got).toBeUndefined();
    const wrote = await flowPositionService.replace(wsB, flowA, {
      positions: [{ stepId: "sneaky", x: 1, y: 1 }],
    });
    expect(wrote).toBe(false);
    const after = await flowPositionService.list(wsA, flowA);
    expect(after?.some((p) => p.stepId === "sneaky")).toBe(false);
  });

  it("a missing flow id is not-found on both reads and writes", async () => {
    const ghost = "00000000-0000-0000-0000-000000000000";
    expect(await flowPositionService.list(wsA, ghost)).toBeUndefined();
    expect(
      await flowPositionService.replace(wsA, ghost, {
        positions: [{ stepId: "x", x: 1, y: 1 }],
      }),
    ).toBe(false);
  });
});
