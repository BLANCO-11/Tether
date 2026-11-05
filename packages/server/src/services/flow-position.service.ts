import { z } from "zod";
import { flowRepo } from "../repositories/flow.repo.js";
import {
  flowStepPositionRepo,
  type FlowStepPosition,
} from "../repositories/flow-position.repo.js";

/**
 * A flow's step positions — plan decision ②, D-150.
 *
 * Workspace-scoped by construction: every operation resolves the flow through
 * `flowRepo.get(workspaceId, flowId)`, so a flow id from a request cannot
 * address another workspace's flow (the same rule every flow route follows,
 * `flow.repo.ts`).
 *
 * Deliberately thin and deliberately outside the revision machinery: reads
 * never touch the revision, writes never create one. Reconciliation (drop on
 * step delete, re-key on step rename) is the CLIENT's job at save time — the
 * server stores exactly what it is given (D-150(f)). The one thing this layer
 * adds to the raw table is the ownership check and the wire shape.
 */

/** Wire shape: an array of step positions, order-insensitive. */
export const putPositionsSchema = z.object({
  positions: z
    .array(
      z.object({
        stepId: z.string().min(1).max(255),
        x: z.number().int().min(-100_000).max(100_000),
        y: z.number().int().min(-100_000).max(100_000),
      }),
    )
    .max(10_000),
});

export type PutPositionsInput = z.infer<typeof putPositionsSchema>;

export const flowPositionService = {
  /**
   * `undefined` means the flow does not exist in this workspace — the route
   * turns that into a 404, the same signal `GET /flows/:flowId` gives.
   */
  async list(workspaceId: string, flowId: string): Promise<FlowStepPosition[] | undefined> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return undefined;
    return flowStepPositionRepo.getByFlow(flowId);
  },

  /** `false` means the flow does not exist in this workspace (route → 404). */
  async replace(
    workspaceId: string,
    flowId: string,
    input: PutPositionsInput,
  ): Promise<boolean> {
    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return false;
    await flowStepPositionRepo.replace(
      flowId,
      input.positions.map((p) => ({ flowId, stepId: p.stepId, x: p.x, y: p.y })),
    );
    return true;
  },
};
