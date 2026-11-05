import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowApprovals, flowRevisions, flows, piChatReferences, type PiChatReferenceRow } from "../db/schema.js";

/**
 * A saved version of a workflow a chat may reference: its number, when it was saved, and — when it was approved — the
 * approval number the workflows list shows for it ("approved as v1"). The two numbers differ on purpose: the list's
 * "v1, v2" counts APPROVALS, a reference pins a SAVED version.
 */
export type SavedVersion = { revision: number; savedAt: Date | null; approvedAs: number | null };

/** Workflow references (0099). Every read is scoped to a workspace; a chat or flow id from another one is not found. */
export const piChatReferenceRepo = {
  async listByChat(workspaceId: string, chatId: string): Promise<PiChatReferenceRow[]> {
    return db
      .select()
      .from(piChatReferences)
      .where(and(eq(piChatReferences.chatId, chatId), eq(piChatReferences.workspaceId, workspaceId)))
      .orderBy(asc(piChatReferences.addedAt));
  },

  async add(input: {
    chatId: string;
    workspaceId: string;
    flowId: string;
    flowNameSnapshot: string;
    revision: number;
    cardMd: string;
    bundleJson: unknown;
    addedBySubject: string | null;
  }): Promise<PiChatReferenceRow> {
    const [row] = await db.insert(piChatReferences).values(input).returning();
    return row!;
  },

  async setRevision(
    workspaceId: string,
    id: string,
    patch: { revision: number; cardMd: string; bundleJson: unknown; flowNameSnapshot: string },
  ): Promise<void> {
    await db
      .update(piChatReferences)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(piChatReferences.id, id), eq(piChatReferences.workspaceId, workspaceId)));
  },

  async remove(workspaceId: string, id: string): Promise<void> {
    await db.delete(piChatReferences).where(and(eq(piChatReferences.id, id), eq(piChatReferences.workspaceId, workspaceId)));
  },

  /**
   * Saved versions per flow, oldest first. A foundry workflow's saved version IS its revision (each Save is
   * `draft_revision + 1`, insert-only). Only revisions whose bundle is a Forge bundle count: that is what can be
   * copied into a chat.
   */
  async savedVersions(workspaceId: string, flowIds: string[]): Promise<Map<string, SavedVersion[]>> {
    const out = new Map<string, SavedVersion[]>();
    if (!flowIds.length) return out;
    const revs = await db
      .select({ flowId: flowRevisions.flowId, revision: flowRevisions.revision, savedAt: flowRevisions.createdAt })
      .from(flowRevisions)
      .innerJoin(flows, eq(flows.id, flowRevisions.flowId))
      .where(
        and(
          inArray(flowRevisions.flowId, flowIds),
          eq(flows.workspaceId, workspaceId),
          sql`${flowRevisions.modelJson}->>'runtime' = 'foundry'`,
        ),
      )
      .orderBy(asc(flowRevisions.flowId), asc(flowRevisions.revision));
    // Numbered like the workflows list (client `versionsFromApprovals`): every approval counts, revoked ones too,
    // ordered by when it was approved, an unstamped one last. A revision approved twice keeps its first number.
    const approvals = await db
      .select({ flowId: flowApprovals.flowId, revision: flowApprovals.revision, at: flowApprovals.approvedAt })
      .from(flowApprovals)
      .where(inArray(flowApprovals.flowId, flowIds));
    const approvedAs = new Map<string, number>();
    const byFlow = new Map<string, typeof approvals>();
    for (const a of approvals) byFlow.set(a.flowId, [...(byFlow.get(a.flowId) ?? []), a]);
    for (const [flowId, list] of byFlow) {
      list.sort((x, y) => (x.at && y.at ? x.at.getTime() - y.at.getTime() : x.at ? -1 : y.at ? 1 : 0));
      list.forEach((a, i) => {
        const key = `${flowId}:${a.revision}`;
        if (!approvedAs.has(key)) approvedAs.set(key, i + 1);
      });
    }
    for (const r of revs) {
      const list = out.get(r.flowId) ?? [];
      list.push({ revision: r.revision, savedAt: r.savedAt, approvedAs: approvedAs.get(`${r.flowId}:${r.revision}`) ?? null });
      out.set(r.flowId, list);
    }
    return out;
  },
};
