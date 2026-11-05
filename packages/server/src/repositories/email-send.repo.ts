/**
 * The record that a real email was attempted.
 * email-send-tool · US1, US4 · contracts/mail-send.md §4
 *
 * ⚠ **A failed insert here is NOT swallowed**, and that is the one way this repo
 * differs from the resilient-insert pattern used for step-run telemetry.
 *
 * Telemetry can be lost: a missing `flow_step_runs` row costs a gap in a chart,
 * so an insert failure there is logged and the request continues. This row is
 * different in kind — it is **the only evidence a message left the building**.
 * Losing it means a real email was delivered to a real mailbox and Foundry has no
 * record of the recipient, which is precisely the "emailed 0 of 11 people and
 * reported clean" shape the run page exists to prevent, inverted: sent, and
 * reported nothing.
 *
 * So the error surfaces. A caller that cannot record what it is about to do must
 * not do it — which is also why the intent row is written **before** Graph is
 * called (`routes/mail.ts`), not after.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailSends } from "../db/schema.js";

export type NewEmailSend = typeof emailSends.$inferInsert;
export type EmailSend = typeof emailSends.$inferSelect;

export const emailSendRepo = {
  /**
   * Write the attempt. Throws if it cannot — see the module docblock.
   *
   * ⚠ There is no `body` parameter and there must never be one. The body is the
   * script's output and may carry tenant PII; this record answers "was a message
   * sent, to whom, and did it work" without it. `email-send.repo.test.ts` asserts
   * the body string appears in no column of the inserted row.
   */
  async record(data: NewEmailSend): Promise<EmailSend> {
    const rows = await db.insert(emailSends).values(data).returning();
    return rows[0];
  },

  /**
   * Update an intent row once the provider has answered.
   *
   * Two writes rather than one because the row must exist *before* Graph is
   * called: a process that dies mid-send leaves a `refused`/pending row rather
   * than nothing at all, and "we may have sent something" is a far better state
   * to wake up to than silence.
   */
  async finish(
    id: string,
    patch: Pick<NewEmailSend, "outcome" | "graphMessageId" | "failureReason"> &
      Partial<Pick<NewEmailSend, "capturedBody" | "capturedAttachments">>,
  ): Promise<EmailSend | undefined> {
    const rows = await db.update(emailSends).set(patch).where(eq(emailSends.id, id)).returning();
    return rows[0];
  },

  /**
   * What the run page reads. Workspace-scoped as well as execution-scoped —
   * an execution id is a uuid a caller could hold from another tenant, and
   * scoping by both means a cross-workspace read returns empty rather than rows.
   */
  async listByExecution(workspaceId: string, flowExecutionId: string): Promise<EmailSend[]> {
    return db
      .select()
      .from(emailSends)
      .where(
        and(
          eq(emailSends.workspaceId, workspaceId),
          eq(emailSends.flowExecutionId, flowExecutionId),
        ),
      )
      .orderBy(desc(emailSends.createdAt));
  },

  /** Workspace-wide history, newest first. The operator's "what has this tenant emailed" view. */
  async listByWorkspace(workspaceId: string, limit = 50): Promise<EmailSend[]> {
    return db
      .select()
      .from(emailSends)
      .where(eq(emailSends.workspaceId, workspaceId))
      .orderBy(desc(emailSends.createdAt))
      .limit(limit);
  },
};
