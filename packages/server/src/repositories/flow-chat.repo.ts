import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowChatThreads, flowChatTurns } from "../db/schema.js";

/**
 * Chat threads and their turns (Phase 2, task 2.6).
 *
 * ⚠ **Workspace-scoped on every read**, the same rule `flowGenerationJobRepo` and
 * `flowTemplateRepo` follow and for a sharper reason here: a turn row holds the
 * sentence a person typed, the op it produced, and on a refusal the contract that
 * was refused — ref names, parameter shapes, the tenant's own vocabulary. A lookup
 * by thread id alone would be one careless route away from handing that to another
 * tenant.
 *
 * ⚠ **A turn is scoped through its THREAD's workspace, never by a column of its
 * own.** Denormalising `workspace_id` onto the turn would create a second answer
 * to "whose turn is this?", and the two can disagree only in the direction that
 * leaks. Every turn read below joins.
 */

export type FlowChatThread = typeof flowChatThreads.$inferSelect;
export type NewFlowChatThread = typeof flowChatThreads.$inferInsert;
export type FlowChatTurn = typeof flowChatTurns.$inferSelect;
export type NewFlowChatTurn = typeof flowChatTurns.$inferInsert;

export const flowChatRepo = {
  async createThread(data: NewFlowChatThread): Promise<FlowChatThread> {
    const rows = await db.insert(flowChatThreads).values(data).returning();
    return rows[0];
  },

  async getThread(workspaceId: string, id: string): Promise<FlowChatThread | undefined> {
    const rows = await db
      .select()
      .from(flowChatThreads)
      .where(and(eq(flowChatThreads.workspaceId, workspaceId), eq(flowChatThreads.id, id)))
      .limit(1);
    return rows[0];
  },

  async listThreads(workspaceId: string, limit = 50): Promise<FlowChatThread[]> {
    return db
      .select()
      .from(flowChatThreads)
      .where(eq(flowChatThreads.workspaceId, workspaceId))
      .orderBy(desc(flowChatThreads.createdAt))
      .limit(limit);
  },

  /**
   * Point the thread at the flow its first applied turn created (D-120).
   *
   * ⚠ **Set once and never repointed.** A thread addresses one automation for its
   * whole life; letting a later turn move it would leave every earlier turn's diff
   * describing a flow it was not about. The `IS NULL` guard makes that structural
   * rather than a rule in a service — a second call is a no-op, not an overwrite.
   */
  async attachFlow(workspaceId: string, id: string, flowId: string): Promise<FlowChatThread | undefined> {
    const rows = await db
      .update(flowChatThreads)
      .set({ flowId, updatedAt: new Date() })
      .where(
        and(
          eq(flowChatThreads.workspaceId, workspaceId),
          eq(flowChatThreads.id, id),
          sql`${flowChatThreads.flowId} IS NULL`,
        ),
      )
      .returning();
    return rows[0];
  },

  async deleteThread(workspaceId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(flowChatThreads)
      .where(and(eq(flowChatThreads.workspaceId, workspaceId), eq(flowChatThreads.id, id)))
      .returning({ id: flowChatThreads.id });
    return rows.length > 0;
  },

  // ── turns ────────────────────────────────────────────────────────────────

  /**
   * The next `seq` for a thread.
   *
   * ⚠ Advisory only — `uq_flow_chat_turns_seq` is what actually stops two turns
   * claiming one number, and it is a unique constraint precisely because a
   * read-then-write here races. The service holds **one turn in flight per
   * thread**; this is the number that turn takes, and a collision means the
   * concurrency rule was broken and the insert must fail loudly rather than
   * silently renumber.
   */
  async nextSeq(threadId: string): Promise<number> {
    const rows = await db
      .select({ max: sql<number | null>`max(${flowChatTurns.seq})` })
      .from(flowChatTurns)
      .where(eq(flowChatTurns.threadId, threadId));
    return (rows[0]?.max ?? 0) + 1;
  },

  async createTurn(data: NewFlowChatTurn): Promise<FlowChatTurn> {
    const rows = await db.insert(flowChatTurns).values(data).returning();
    return rows[0];
  },

  async finishTurn(id: string, patch: Partial<NewFlowChatTurn>): Promise<FlowChatTurn | undefined> {
    const rows = await db
      .update(flowChatTurns)
      .set({ ...patch, finishedAt: new Date() })
      .where(eq(flowChatTurns.id, id))
      .returning();
    return rows[0];
  },

  /** One turn, scoped through its thread's workspace. */
  async getTurn(workspaceId: string, threadId: string, turnId: string): Promise<FlowChatTurn | undefined> {
    const rows = await db
      .select({ turn: flowChatTurns })
      .from(flowChatTurns)
      .innerJoin(flowChatThreads, eq(flowChatTurns.threadId, flowChatThreads.id))
      .where(
        and(
          eq(flowChatThreads.workspaceId, workspaceId),
          eq(flowChatTurns.threadId, threadId),
          eq(flowChatTurns.id, turnId),
        ),
      )
      .limit(1);
    return rows[0]?.turn;
  },

  /** A thread's turns oldest-first — the order the transcript reads in. */
  async listTurns(workspaceId: string, threadId: string): Promise<FlowChatTurn[]> {
    const rows = await db
      .select({ turn: flowChatTurns })
      .from(flowChatTurns)
      .innerJoin(flowChatThreads, eq(flowChatTurns.threadId, flowChatThreads.id))
      .where(and(eq(flowChatThreads.workspaceId, workspaceId), eq(flowChatTurns.threadId, threadId)))
      .orderBy(asc(flowChatTurns.seq));
    return rows.map((r) => r.turn);
  },

  /**
   * The last N **APPLIED** turns, oldest-first, for the prompt's RECENT CHANGES
   * block.
   *
   * ⚠ **Applied only, and that filter is a control rather than a tidy-up.**
   * Putting a refused instruction and its reason into the next prompt is re-asking
   * a refused design one turn later, with the refusal as encouragement — which is
   * §6.7's forbidden retry wearing a context window. `status = 'applied'` is the
   * whole mechanism, so do not relax it to "not failed".
   */
  async recentApplied(threadId: string, limit = 6): Promise<FlowChatTurn[]> {
    const rows = await db
      .select()
      .from(flowChatTurns)
      .where(and(eq(flowChatTurns.threadId, threadId), eq(flowChatTurns.status, "applied")))
      .orderBy(desc(flowChatTurns.seq))
      .limit(limit);
    return rows.reverse();
  },

  /**
   * The last N **ANSWERED** turns, oldest-first, for the prompt's RECENT CHANGES
   * block beside `recentApplied`.
   *
   * ⚠ **Answers travel; refusals do not.** An answer is terminal prose about the
   * automation as it stood — carrying it lets follow-up questions ("what about
   * the email step?") read against it instead of starting over. A refused
   * instruction stays out per `recentApplied`'s docblock: re-asking a refused
   * design with the refusal as encouragement is §6.7's forbidden retry. Failed
   * turns stay out for the same reason.
   */
  async recentAnswered(threadId: string, limit = 6): Promise<FlowChatTurn[]> {
    const rows = await db
      .select()
      .from(flowChatTurns)
      .where(and(eq(flowChatTurns.threadId, threadId), eq(flowChatTurns.status, "answered")))
      .orderBy(desc(flowChatTurns.seq))
      .limit(limit);
    return rows.reverse();
  },


  /**
   * How many `needs_input` turns close this thread without anything after
   * them — the count the prompt's CLARIFICATIONS line reports and the retry
   * loop's clarification cap enforces. Scans at most three rows back: the
   * guidance bites at two, so older history is irrelevant to it.
   *
   * Skips the thread's in-flight `running` row: the scan runs after the new
   * turn is created, so the newest row is always this turn. At most one turn
   * runs per thread (entry rejects a second), so a `running` row is always
   * the current turn, never history.
   */
  async trailingNeedsInput(threadId: string): Promise<number> {
    const rows = await db
      .select({ status: flowChatTurns.status })
      .from(flowChatTurns)
      .where(eq(flowChatTurns.threadId, threadId))
      .orderBy(desc(flowChatTurns.seq))
      .limit(4);
    let n = 0;
    for (const r of rows) {
      if (r.status === "running") continue;
      if (r.status !== "needs_input") break;
      n += 1;
    }
    return n;
  },
  /**
   * A previously stored refusal for the same declared boundary (D-118).
   *
   * `refusal_key = sha256(stepId + canonical(contract) + sorted(declaredInputIds))`.
   * A hit is served **verbatim with `attempts: 0`** — the only way past it is a
   * change to the flow's declared boundary, which is data the system can see.
   * Scoped to the thread so one conversation's refusal cannot silence another's.
   */
  async cachedRefusal(threadId: string, refusalKey: string): Promise<FlowChatTurn | undefined> {
    const rows = await db
      .select()
      .from(flowChatTurns)
      .where(and(eq(flowChatTurns.threadId, threadId), eq(flowChatTurns.refusalKey, refusalKey)))
      .orderBy(desc(flowChatTurns.seq))
      .limit(1);
    return rows[0];
  },

  /**
   * How many turns are in flight across this WORKSPACE.
   *
   * A second bound beside the per-thread one, and they answer different
   * questions: the per-thread rule stops two turns editing one flow from
   * different revisions, this one stops one workspace's conversations consuming
   * every inference slot the deployment has. Counted through the join for the
   * same reason every other read here does — a turn has no workspace of its own.
   */
  async runningCount(workspaceId: string): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(flowChatTurns)
      .innerJoin(flowChatThreads, eq(flowChatTurns.threadId, flowChatThreads.id))
      .where(and(eq(flowChatThreads.workspaceId, workspaceId), eq(flowChatTurns.status, "running")));
    return rows[0]?.n ?? 0;
  },

  /**
   * Is a turn already in flight on this thread?
   *
   * One turn per thread at a time: two concurrent turns would each read the same
   * revision, apply their op to it, and the second would silently discard the
   * first — a lost edit with a diff on screen claiming otherwise.
   */
  async runningTurn(threadId: string): Promise<FlowChatTurn | undefined> {
    const rows = await db
      .select()
      .from(flowChatTurns)
      .where(and(eq(flowChatTurns.threadId, threadId), eq(flowChatTurns.status, "running")))
      .orderBy(desc(flowChatTurns.seq))
      .limit(1);
    return rows[0];
  },
};
