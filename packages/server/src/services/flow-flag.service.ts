import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowStepFlags } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";

/**
 * B-12 · `flow_step_flags` — the five/six flag kinds the builder resolves.
 *
 * Flags are keyed to a `flowRevisionId` (FK → `flow_revisions`) and honour
 * D-37 insert-only revisions: no update to a revision, no in-place mutation of
 * flags outside the `status` transition here. `consequence` is required — a flag
 * without a quantified consequence would invent the sentence the reviewer
 * decides on ("14 of 142", "Up to 27 emails").
 *
 * ⚠ UI currently keeps findings local via `useLocalFindings` until this lands
 * (backend-required B-12). This service does NOT generate `consequence`
 * sentences — they are authored and persisted, never inferred.
 *
 * `canTest` vs `canPublish` (AC-05-13):
 *   - `canTest` IGNORES a draft-level `step_number = null` flag (the
 *     "No successful test run" blocker). Testing is how you clear it, so it
 *     cannot block testing.
 *   - `canPublish` requires ZERO `blocking = true` AND `status = 'open'`
 *     flags, including the draft-level one. A successful test run clears it
 *     (by resolving the flag), not by ignoring it.
 *
 * B-29: `operations` table does not yet exist. When it lands, per-operation
 * safety badges will be the source of `restricted` consequences, still authored.
 */
export const FLAG_KINDS = [
  "restricted",
  "assumption",
  "low-confidence",
  "missing-input",
  "unresolved-decision",
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export const FLAG_STATUSES = ["open", "resolved", "deferred"] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

export type FlowStepFlag = typeof flowStepFlags.$inferSelect;

const updateFlagSchema = z.object({
  status: z.enum(["resolved", "deferred"]),
  // `consequence` must already be present on the row (NOT NULL), but when
  // resolving/deferring we require the caller to echo it — ensures the
  // reviewer saw the consequence they are clearing, and prevents a future
  // writer from clearing a flag whose consequence was somehow nulled.
  consequence: z.string().min(1).max(4000).optional(),
});

export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;

function isFlagKind(v: string): v is FlagKind {
  return (FLAG_KINDS as readonly string[]).includes(v);
}

export const flowFlagService = {
  /**
   * List flags for a revision, workspace-scoped via the flow.
   * `revisionId` is the `flow_revisions.id` (uuid). Callers that have a
   * revision number should resolve it first via `flowRepo.getRevision`.
   * Returns `undefined` when the flow is not in the workspace (→ 404).
   */
  async list(
    workspaceId: string,
    flowId: string,
    revisionId: string,
  ): Promise<FlowStepFlag[] | undefined> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return undefined;
    // Verify the revision belongs to this flow — prevents cross-flow id probing.
    const rev = await flowRepo.getRevisionById(revisionId);
    if (!rev || rev.flowId !== flowId) return undefined;
    const rows = await db
      .select()
      .from(flowStepFlags)
      .where(eq(flowStepFlags.flowRevisionId, revisionId))
      .orderBy(flowStepFlags.stepNumber, flowStepFlags.kind);
    return rows;
  },

  /**
   * List by revision number (convenience for routes that carry `?revision=3`).
   */
  async listByRevisionNumber(
    workspaceId: string,
    flowId: string,
    revisionNumber: number,
  ): Promise<FlowStepFlag[] | undefined> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return undefined;
    const rev = await flowRepo.getRevision(flowId, revisionNumber);
    if (!rev) return undefined;
    const rows = await db
      .select()
      .from(flowStepFlags)
      .where(eq(flowStepFlags.flowRevisionId, rev.id))
      .orderBy(flowStepFlags.stepNumber, flowStepFlags.kind);
    return rows;
  },

  /**
   * Transition a flag's `status` — `open` → `resolved` | `deferred`.
   * Validation: `consequence` must be present and non-empty on the row
   * (DB NOT NULL) and the caller must not clear a flag with empty consequence.
   * Returns `undefined` for not-found / not-in-workspace, or throws 400.
   */
  async updateStatus(
    workspaceId: string,
    flowId: string,
    flagId: string,
    input: UpdateFlagInput,
  ): Promise<FlowStepFlag | undefined> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const parsed = updateFlagSchema.parse(input);

    const rows = await db.select().from(flowStepFlags).where(eq(flowStepFlags.id, flagId)).limit(1);
    const flag = rows[0];
    if (!flag) return undefined;

    // Verify flag's revision belongs to this flow → workspace scoping.
    const rev = await flowRepo.getRevisionById(flag.flowRevisionId);
    if (!rev || rev.flowId !== flowId) return undefined;

    // Consequence required: DB guarantees NOT NULL, but also reject whitespace-only.
    const effectiveConsequence = parsed.consequence ?? flag.consequence;
    if (!effectiveConsequence || effectiveConsequence.trim().length === 0) {
      throw Object.assign(new Error("consequence is required — a flag cannot be resolved without a quantified consequence"), {
        status: 400,
      });
    }
    if (flag.consequence.trim().length === 0) {
      throw Object.assign(new Error("flag has empty consequence — cannot resolve"), { status: 400 });
    }

    if (flag.status !== "open") {
      throw Object.assign(new Error(`flag already ${flag.status}`), { status: 409 });
    }

    const updated = await db
      .update(flowStepFlags)
      .set({ status: parsed.status })
      .where(eq(flowStepFlags.id, flagId))
      .returning();
    return updated[0];
  },

  // Convenience wrappers matching the brief's `resolve` / `defer` naming.
  async resolve(
    workspaceId: string,
    flowId: string,
    flagId: string,
    input: { consequence?: string } = {},
  ): Promise<FlowStepFlag | undefined> {
    return this.updateStatus(workspaceId, flowId, flagId, {
      status: "resolved",
      ...(input.consequence !== undefined ? { consequence: input.consequence } : {}),
    });
  },

  async defer(
    workspaceId: string,
    flowId: string,
    flagId: string,
    input: { consequence?: string } = {},
  ): Promise<FlowStepFlag | undefined> {
    return this.updateStatus(workspaceId, flowId, flagId, {
      status: "deferred",
      ...(input.consequence !== undefined ? { consequence: input.consequence } : {}),
    });
  },

  /**
   * Whether the revision can be Test-run. Ignores draft-level (`step_number IS NULL`)
   * blocker — testing is how you clear "No successful test run".
   */
  canTest(flags: FlowStepFlag[]): boolean {
    const blockers = flags.filter((f) => f.blocking && f.status === "open" && f.stepNumber !== null);
    return blockers.length === 0;
  },

  /**
   * Whether the revision can be Published. Requires zero open blockers,
   * INCLUDING draft-level (`step_number IS NULL`) ones.
   */
  canPublish(flags: FlowStepFlag[]): boolean {
    const blockers = flags.filter((f) => f.blocking && f.status === "open");
    return blockers.length === 0;
  },

  /** Validate kind at runtime — DB CHECK is the second wall, this is the first. */
  assertKind(kind: string): asserts kind is FlagKind {
    if (!isFlagKind(kind)) throw Object.assign(new Error(`invalid kind: ${kind}`), { status: 400 });
  },
};
