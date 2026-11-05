/**
 * What the chat tables deliberately DO NOT have. Phase 2 task 2.6 · D-119/D-120.
 *
 * Three absences carry design decisions, and an absence with no test is a column
 * somebody adds in a fortnight because it would obviously be convenient. Each
 * assertion below is paired with a positive control on the same schema slice, so
 * none of them can pass by reading nothing (I-38).
 */
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { flowChatThreads, flowChatTurns } from "./schema.js";

const threadCols = Object.keys(getTableColumns(flowChatThreads));
const turnCols = Object.keys(getTableColumns(flowChatTurns));

describe("the chat tables' deliberate absences (2.6)", () => {
  /**
   * ⚠ No prose column. Chat renders **no model narration**: what the screen says
   * is computed by pure code from the op that was applied (`describeOp`) plus the
   * diff `flowApprovalService.diff` produces — the same function the approval
   * screen reads, so "what changed" has exactly one answer.
   *
   * A stored narration would sit beside a diff it could contradict, which is
   * `llm_complete`'s leaf rule (D-34) with the stakes raised: there the model's
   * paragraph is read by a person and consumed by nothing, here it would look
   * like the record of the edit.
   */
  it("a turn has no assistant prose column", () => {
    const prose = turnCols.filter((c) =>
      /^(assistant_?text|assistantText|text|reply|answer|message_?from|narration|explanation)$/i.test(c),
    );
    expect(prose).toEqual([]);
    // The control: this slice is a real table with the columns a turn needs, so
    // the assertion above is about an absence rather than about an empty read.
    expect(turnCols).toContain("opJson");
    expect(turnCols).toContain("resolvedStepId");
  });

  /**
   * ⚠ No goal column, and this is why chat does not reuse `flow_generation_jobs`
   * (whose `goal` is NOT NULL). A stored goal is a resubmittable sentence, and
   * §6.7's rule is that a refusal is never re-asked — in chat there is nothing to
   * retry, because no turn designs a flow.
   */
  it("a thread has no goal column", () => {
    expect(threadCols.filter((c) => /goal|prompt|instruction/i.test(c))).toEqual([]);
    expect(threadCols).toContain("name");
    expect(threadCols).toContain("designSelection");
  });

  /**
   * ⚠ No `draft_model_json`. A flow model living outside `writeRevision` has no
   * D-22 expression allowlist, no `FLOW_CAPS` and no ref check — three controls
   * turned off by one convenience column. The flow model IS the conversation's
   * state; the thread is the audit record.
   */
  it("a thread stores no flow model of its own", () => {
    expect(threadCols.filter((c) => /model|steps|draft/i.test(c))).toEqual([]);
    expect(threadCols).toContain("flowId");
  });

  /**
   * `flow_id` must be NULLABLE — that is the empty-flow seed (D-120). A thread
   * whose every turn was refused leaves a thread row and no flow, which is the
   * honest outcome: nothing was designed.
   */
  it("a thread's flow_id is nullable, so a thread can exist before a flow does", () => {
    expect(getTableColumns(flowChatThreads).flowId.notNull).toBe(false);
  });

  /**
   * `created_by_kind` is NOT NULL with **no default**, the same rule
   * `flow_revisions` follows. A default is how a row whose origin nobody recorded
   * comes to claim one; §1.2's backfill is `unknown` for exactly that reason.
   */
  it("created_by_kind is required and has no default", () => {
    const col = getTableColumns(flowChatThreads).createdByKind;
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(false);
  });

  /**
   * A message is bounded at 2000 — the same bound `refineFlowSchema` uses — so a
   * turn cannot become a pasted specification. One instruction, one component.
   */
  it("a message is bounded at 2000, matching refineFlowSchema", () => {
    // @ts-expect-error drizzle exposes varchar length on the column config
    expect(getTableColumns(flowChatTurns).message.length).toBe(2000);
  });
});
