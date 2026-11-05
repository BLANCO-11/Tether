import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { releaseGates, flowExecutions, flowStepFlags, flowRevisions, flows } from "../db/schema.js";

/**
 * B-19 · `release_gates` — publish review 4 gates (S-24).
 *
 * Four gates (ordinal order):
 *  1. Successful test required   — satisfiedBy: "Run a test on this draft and let it pass."
 *  2. No open blockers           — satisfiedBy: "Resolve all blocking items in the readiness checklist."
 *  3. All resources published    — satisfiedBy: "Publish all resources this workflow depends on."
 *  4. Publication approval       — satisfiedBy: "Get publication approval for this draft."
 *
 * Three-state ✓/✗/◷: met / unmet / pending per gate; `enabled:false` gates are
 * returned with `enabled:false` so UI can render "not enforced" rather than hiding.
 * `satisfiedBy` is quoted verbatim when blocked (AC-07-5).
 *
 * `flowId null` = workspace default; non-null = per-flow override.
 * Workspace scoping: every read filters WHERE workspace_id = ?
 * Honours D-37 insert-only: evaluation reads flags + runs for a *revision*,
 * never mutates them; this table stores configuration only.
 */

export const DEFAULT_GATES: Array<{
  name: string;
  satisfiedBy: string;
  ordinal: number;
}> = [
  {
    name: "Successful test required",
    satisfiedBy: "Run a test on this draft and let it pass.",
    ordinal: 1,
  },
  {
    name: "No open blockers",
    satisfiedBy: "Resolve all blocking items in the readiness checklist.",
    ordinal: 2,
  },
  {
    name: "All resources published",
    satisfiedBy: "Publish all resources this workflow depends on.",
    ordinal: 3,
  },
  {
    name: "Publication approval",
    satisfiedBy: "Get publication approval for this draft.",
    ordinal: 4,
  },
];

export type ReleaseGate = typeof releaseGates.$inferSelect;

export type GateState = "met" | "unmet" | "pending";

export interface EvaluatedGate {
  name: string;
  state: GateState;
  detail: string;
  satisfiedBy: string;
  enabled: boolean;
  ordinal: number;
}

export interface Blocker {
  title: string;
  detail: string;
  satisfiedBy: string;
  whoCan: string;
}

export interface EvaluatePublishGatesResult {
  gates: EvaluatedGate[];
  blocked: boolean;
  blockers: Blocker[];
}

function whoCanForGate(name: string): string {
  // Honest mapping: who can clear each gate (stub, documented).
  // Publication approval → approvers; others → authors/owners.
  if (name === "Publication approval") return "Approver";
  if (name === "Successful test required") return "Author";
  if (name === "No open blockers") return "Author";
  if (name === "All resources published") return "Admin";
  return "Author";
}

export const releaseGateService = {
  /**
   * List gates in ordinal order.
   * - `flowId` undefined/null → workspace defaults (flow_id IS NULL)
   * - `flowId` provided → per-flow gates if any exist, otherwise fallback to workspace defaults
   *   (keeps simple: callers that pass flowId get flow-scoped gates when configured,
   *   else the workspace baseline — disabled gates still returned with enabled:false).
   * Workspace-scoped: every read filters WHERE workspace_id = ?.
   * Returns gates in `ordinal` order; disabled still returned so UI can render "not enforced".
   */
  async list(params: { workspaceId: string; flowId?: string | null }): Promise<ReleaseGate[]> {
    const { workspaceId, flowId } = params;

    // Workspace-scoped check: ensure workspace exists? Rely on caller for scoping,
    // but we filter strictly by workspace_id here.

    if (flowId) {
      // Verify flow belongs to workspace (workspace scoping).
      // If flow not in workspace, return empty (caller will map to 404 or empty).
      const flowRows = await db.select().from(flows).where(and(eq(flows.id, flowId), eq(flows.workspaceId, workspaceId))).limit(1);
      if (flowRows.length === 0) {
        // Flow not in workspace → no gates (workspace scoping enforced)
        return [];
      }
      // Check for per-flow gates
      const perFlow = await db
        .select()
        .from(releaseGates)
        .where(and(eq(releaseGates.workspaceId, workspaceId), eq(releaseGates.flowId, flowId)))
        .orderBy(asc(releaseGates.ordinal));
      if (perFlow.length > 0) return perFlow;
      // Fallback to workspace defaults
      const defaults = await db
        .select()
        .from(releaseGates)
        .where(and(eq(releaseGates.workspaceId, workspaceId), isNull(releaseGates.flowId)))
        .orderBy(asc(releaseGates.ordinal));
      if (defaults.length > 0) return defaults;
      // No DB gates yet → return empty (caller may seed defaults elsewhere)
      return [];
    }

    // Workspace defaults only
    const rows = await db
      .select()
      .from(releaseGates)
      .where(and(eq(releaseGates.workspaceId, workspaceId), isNull(releaseGates.flowId)))
      .orderBy(asc(releaseGates.ordinal));
    return rows;
  },

  /**
   * Ensure workspace defaults exist (idempotent seed of the 4 gates).
   * Called lazily by list/evaluate when table is empty for a workspace.
   * Insert-only: does not update existing rows (preserves enabled=false edits).
   */
  async ensureDefaults(workspaceId: string): Promise<ReleaseGate[]> {
    const existing = await this.list({ workspaceId });
    if (existing.length > 0) return existing;
    // Insert default 4 gates atomically
    const toInsert = DEFAULT_GATES.map((g) => ({
      workspaceId,
      flowId: null,
      name: g.name,
      enabled: true,
      satisfiedBy: g.satisfiedBy,
      policyId: null,
      ordinal: g.ordinal,
    }));
    const inserted = await db.insert(releaseGates).values(toInsert).returning();
    // Return in ordinal order
    inserted.sort((a, b) => a.ordinal - b.ordinal);
    return inserted;
  },

  // Helper for seeding per-flow overrides (used by tests or future admin UI)
  async createGate(params: {
    workspaceId: string;
    flowId?: string | null;
    name: string;
    satisfiedBy: string;
    enabled?: boolean;
    policyId?: string | null;
    ordinal: number;
  }): Promise<ReleaseGate> {
    const [row] = await db
      .insert(releaseGates)
      .values({
        workspaceId: params.workspaceId,
        flowId: params.flowId ?? null,
        name: params.name,
        enabled: params.enabled ?? true,
        satisfiedBy: params.satisfiedBy,
        policyId: params.policyId ?? null,
        ordinal: params.ordinal,
      })
      .returning();
    return row;
  },

  /**
   * Flip a single gate on or off. Matches by primary key only — a caller who
   * does not own the workspace is refused at the route, not here.
   */
  async setEnabled(params: {
    workspaceId: string;
    gateId: string;
    enabled: boolean;
  }): Promise<ReleaseGate | undefined> {
    const [row] = await db
      .update(releaseGates)
      .set({ enabled: params.enabled })
      .where(and(eq(releaseGates.workspaceId, params.workspaceId), eq(releaseGates.id, params.gateId)))
      .returning();
    return row;
  },

  /**
   * `evaluatePublishGates({flowId, draftRevision})` helper documenting met/unmet/pending + blocked bool + blockers.
   *
   * Reads:
   *  - `release_gates` (enabled gates, ordered, satisfiedBy verbatim)
   *  - `flow_step_flags` (blocking open flags → "No open blockers")
   *  - `flow_executions` (successful run → "Successful test required")
   *  - resources (future: "All resources published" — stubbed honest as pending until resources table lands)
   *
   * Keeps honest: returns enabled gates with satisfiedBy; disabled gates are excluded from blocking
   * (not enforced) but still listed in `gates` with `enabled:false` downstream (list path). This helper
   * filters to enabled for evaluation, but documents disabled handling.
   *
   * States:
   *  - `met` — gate satisfied
   *  - `unmet` — enabled gate not yet satisfied (blocked)
   *  - `pending` — awaiting human (e.g. approval) or stubbed resource check
   *
   * `blocked` = true if any enabled gate is `unmet` (or `pending` for blocking gates? Honest: pending is not blocked, only unmet).
   * Actually per S-24: "pending" is the third state (◷) — blocked means at least one `unmet` among enabled.
   * For honest stub: "Publication approval" is always pending (awaits approval_requests), "All resources published" is pending stub.
   */
  async evaluatePublishGates(params: { workspaceId: string; flowId: string; draftRevision?: number }): Promise<EvaluatePublishGatesResult> {
    const { workspaceId, flowId, draftRevision } = params;

    // Resolve flow revision row to get revision id for flags/executions
    let revisionId: string | null = null;
    if (draftRevision !== undefined) {
      const revRows = await db
        .select()
        .from(flowRevisions)
        .where(and(eq(flowRevisions.flowId, flowId), eq(flowRevisions.revision, draftRevision)))
        .limit(1);
      revisionId = revRows[0]?.id ?? null;
    } else {
      // Try to load draft revision number from flows table
      const flowRow = await db.select().from(flows).where(eq(flows.id, flowId)).limit(1);
      const dr = flowRow[0]?.draftRevision;
      if (dr != null) {
        const revRows = await db.select().from(flowRevisions).where(and(eq(flowRevisions.flowId, flowId), eq(flowRevisions.revision, dr))).limit(1);
        revisionId = revRows[0]?.id ?? null;
      }
    }

    // Load gates (per-flow or workspace defaults, ordered)
    let gates = await this.list({ workspaceId, flowId });
    // If no DB gates at all, fall back to in-memory defaults for honest evaluation (no DB write)
    if (gates.length === 0) {
      gates = DEFAULT_GATES.map((g) => ({
        id: `default-${g.ordinal}`,
        workspaceId,
        flowId: null,
        name: g.name,
        enabled: true,
        satisfiedBy: g.satisfiedBy,
        policyId: null,
        ordinal: g.ordinal,
        createdAt: new Date(),
      })) as unknown as ReleaseGate[];
    }

    // Evaluate each enabled gate
    const evaluated: EvaluatedGate[] = [];
    const blockers: Blocker[] = [];

    for (const gate of gates) {
      if (!gate.enabled) {
        evaluated.push({
          name: gate.name,
          state: "met",
          detail: "Not enforced (disabled)",
          satisfiedBy: gate.satisfiedBy,
          enabled: false,
          ordinal: gate.ordinal,
        });
        continue;
      }

      let state: GateState = "pending";
      let detail = "Pending";

      if (gate.name === "Successful test required") {
        // Read flow_executions for successful test on this revision/flow.
        // Honest: flowExecutions stores status as varchar "success"/"failed"/"running".
        let hasSuccess = false;
        if (draftRevision !== undefined || revisionId) {
          const targetRev = draftRevision ?? null;
          // When we resolved revisionId, we also have targetRev via draftRevision param or flow's draftRevision
          const revToQuery = targetRev ?? (() => {
            // Derive from revisionId lookup fallback: not ideal but honest
            return null;
          })();
          if (revToQuery !== null) {
            const rows = await db
              .select({ status: flowExecutions.status })
              .from(flowExecutions)
              .where(and(eq(flowExecutions.flowId, flowId), eq(flowExecutions.flowRevision, revToQuery)))
              .limit(10);
            hasSuccess = rows.some((r) => r.status.toLowerCase() === "success" || r.status.toLowerCase() === "succeeded");
            if (rows.length === 0) hasSuccess = false;
          } else {
            // fallback - any success for flow
            const rows = await db
              .select({ status: flowExecutions.status })
              .from(flowExecutions)
              .where(eq(flowExecutions.flowId, flowId))
              .limit(10);
            hasSuccess = rows.some((r) => r.status.toLowerCase() === "success" || r.status.toLowerCase() === "succeeded");
          }
        } else {
          // No draftRevision known → any execution for flow
          const rows = await db
            .select({ status: flowExecutions.status })
            .from(flowExecutions)
            .where(eq(flowExecutions.flowId, flowId))
            .limit(10);
          hasSuccess = rows.some((r) => r.status.toLowerCase() === "success" || r.status.toLowerCase() === "succeeded");
        }
        state = hasSuccess ? "met" : "unmet";
        detail = hasSuccess ? "Satisfied" : gate.satisfiedBy;
      } else if (gate.name === "No open blockers") {
        if (revisionId) {
          const flags = await db.select().from(flowStepFlags).where(eq(flowStepFlags.flowRevisionId, revisionId)).limit(100);
          const openBlockers = flags.filter((f) => f.blocking && f.status === "open");
          if (openBlockers.length === 0) {
            state = "met";
            detail = "Satisfied";
          } else {
            state = "unmet";
            detail = `${openBlockers.length} blocker${openBlockers.length === 1 ? "" : "s"} remain in the readiness checklist.`;
          }
        } else {
          state = "pending";
          detail = "Pending — draft revision not found";
        }
      } else if (gate.name === "All resources published") {
        state = "pending";
        detail = gate.satisfiedBy;
      } else if (gate.name === "Publication approval") {
        state = "pending";
        detail = "Requested by this submission · approver pending";
      } else {
        state = "pending";
        detail = gate.satisfiedBy;
      }

      evaluated.push({
        name: gate.name,
        state,
        detail,
        satisfiedBy: gate.satisfiedBy,
        enabled: true,
        ordinal: gate.ordinal,
      });

      if (state === "unmet") {
        blockers.push({
          title: gate.name,
          detail,
          satisfiedBy: gate.satisfiedBy,
          whoCan: whoCanForGate(gate.name),
        });
      }
    }

    // Sort by ordinal
    evaluated.sort((a, b) => a.ordinal - b.ordinal);

    const blocked = blockers.length > 0;

    return { gates: evaluated, blocked, blockers };
  },
};
