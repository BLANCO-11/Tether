/**
 * M3 / M4 — per-workspace execution budget.
 * archive/kestra-migration/08-scale-and-phasing.md §M3, §M4
 *
 * Kestra OSS ships no per-tenant resource quotas (Worker Isolation is EE), so
 * nothing in the engine stops one client's runaway flow starving every other
 * client on a shared instance. Kestra's flow-level `concurrency` is a different
 * control: it stops a flow overlapping ITSELF. The two are complementary and the
 * plan says use both.
 *
 * Enforced in two places, and they are deliberately different hooks:
 *
 *   M3  concurrent executions  `POST /api/executions/begin`  — once schedule
 *       triggers moved to Kestra (§5.4), Kestra initiates executions and
 *       `begin` is the only Foundry hook left before step 1 runs.
 *   M4  agent runs per day     the `agent` STEP — a flow's agent-run count is a
 *       property of the steps it reaches, so a branch that skips the agent step
 *       must not consume the day's allowance.
 */
import { z } from "zod";
import { config } from "../config/index.js";
import { tenantBudgetRepo, type TenantBudget } from "../repositories/tenant-budget.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowStepRunRepo } from "../repositories/flow-execution.repo.js";

/** A budget with every field populated — defaults already applied. */
export interface EffectiveBudget {
  workspaceId: string;
  maxConcurrentExecutions: number;
  /** null = token spend is not metered for this workspace yet. */
  maxTokensPerDay: number | null;
  /** false when no row exists and config defaults were substituted. */
  configured: boolean;
}

export const budgetSchema = z.object({
  // Positive, so a budget cannot be set to 0 by accident and silently refuse
  // every execution. Removing the row is how you go back to defaults.
  maxConcurrentExecutions: z.number().int().positive().max(1000).optional(),
  // Explicit null clears the token ceiling; omitting the key leaves it alone.
  maxTokensPerDay: z.number().int().positive().nullable().optional(),
});

export type BudgetInput = z.infer<typeof budgetSchema>;

function withDefaults(workspaceId: string, row: TenantBudget | undefined): EffectiveBudget {
  const d = config.budgetDefaults;
  if (!row) {
    return {
      workspaceId,
      maxConcurrentExecutions: d.maxConcurrentExecutions,
      maxTokensPerDay: d.maxTokensPerDay,
      configured: false,
    };
  }
  return {
    workspaceId,
    maxConcurrentExecutions: row.maxConcurrentExecutions,
    maxTokensPerDay: row.maxTokensPerDay ?? d.maxTokensPerDay,
    configured: true,
  };
}

async function assertWorkspace(workspaceId: string) {
  const ws = await workspaceRepo.get(workspaceId);
  if (!ws) {
    const err = new Error(`Workspace not found: ${workspaceId}`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return ws;
}

export const tenantBudgetService = {
  /**
   * The budget that actually applies, defaults substituted.
   *
   * Never returns "unlimited" for an unconfigured workspace — see
   * `config.budgetDefaults` for why an opt-in runaway guard is not a guard.
   */
  async resolve(workspaceId: string): Promise<EffectiveBudget> {
    return withDefaults(workspaceId, await tenantBudgetRepo.getByWorkspace(workspaceId));
  },

  async set(workspaceId: string, input: BudgetInput): Promise<EffectiveBudget> {
    await assertWorkspace(workspaceId);
    const row = await tenantBudgetRepo.upsert(workspaceId, input);
    return withDefaults(workspaceId, row);
  },

  /** Drop the override; the workspace falls back to config defaults. */
  async clear(workspaceId: string): Promise<EffectiveBudget> {
    await tenantBudgetRepo.remove(workspaceId);
    return withDefaults(workspaceId, undefined);
  },
};
