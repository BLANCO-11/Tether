import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flows, pins } from "../db/schema.js";

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

export const pinService = {
  async list(workspaceId: string, subject: string): Promise<Array<{ flowId: string; createdAt: string | null }>> {
    const rows = await db
      .select()
      .from(pins)
      .where(and(eq(pins.workspaceId, workspaceId), eq(pins.subject, subject)))
      .orderBy(pins.createdAt);
    return rows.map((r) => ({ flowId: r.flowId, createdAt: r.createdAt ? r.createdAt.toISOString() : null }));
  },

  async toggle(
    workspaceId: string,
    subject: string,
    flowId: string,
  ): Promise<{ pinned: boolean; pins: Array<{ flowId: string }> }> {
    if (!subject) throw httpError("subject required", 401);
    const flow = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, flowId), eq(flows.workspaceId, workspaceId)))
      .limit(1);
    if (!flow[0]) throw httpError("flow not found", 404);

    const existing = await db
      .select()
      .from(pins)
      .where(and(eq(pins.workspaceId, workspaceId), eq(pins.subject, subject), eq(pins.flowId, flowId)))
      .limit(1);

    if (existing[0]) {
      await db
        .delete(pins)
        .where(and(eq(pins.workspaceId, workspaceId), eq(pins.subject, subject), eq(pins.flowId, flowId)));
      const remaining = await db
        .select()
        .from(pins)
        .where(and(eq(pins.workspaceId, workspaceId), eq(pins.subject, subject)));
      return { pinned: false, pins: remaining.map((r) => ({ flowId: r.flowId })) };
    }

    await db.insert(pins).values({ workspaceId, subject, flowId });
    const remaining = await db
      .select()
      .from(pins)
      .where(and(eq(pins.workspaceId, workspaceId), eq(pins.subject, subject)));
    return { pinned: true, pins: remaining.map((r) => ({ flowId: r.flowId })) };
  },
};
