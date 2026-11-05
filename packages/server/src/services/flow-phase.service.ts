import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowPhases } from "../db/schema.js";

/**
 * B-11 · `flow_phases` — background frames for the builder canvas.
 *
 * Phases are per-revision background frames, not collapsible groups (flows/02:48).
 * The builder still renders derived grouping from `flow_steps.phase_id` when present,
 * but revision frames are the source of truth — Phase 2 canvas will read them
 * via `GET /workspaces/:ws/flows/:id/phases`. Lane gap 56px is CSS only.
 */

export type Phase = typeof flowPhases.$inferSelect;

export const phaseService = {
  async list(revisionId: string): Promise<Phase[]> {
    return db
      .select()
      .from(flowPhases)
      .where(eq(flowPhases.flowRevisionId, revisionId))
      .orderBy(asc(flowPhases.ordinal));
  },
};
