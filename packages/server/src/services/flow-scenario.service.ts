import { asc, and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { flowTestScenarios, SCENARIO_KINDS, type ScenarioKind } from "../db/schema.js";

/**
 * B-18 · flow_test_scenarios — S-20 Test scenario picker
 *
 * Five equal radio cards: Saved / Edge case / AI-generated / Manual / Real.
 * `real` is NOT a kind — real is namespace D-52 (draft vs live), never a fixture.
 * `saved` is a fixture binding (fixture_id → datasource_fixtures SET NULL).
 * `edge-case` carries `reason` = why worth running.
 * `ai-generated` stores the description that built the fixture; `manual` stores row JSON.
 * `population` e.g. "142 employees · normal month" is REQUIRED, never faked — honest-empty when none (B-24/B-26).
 *
 * B-24: datasource_fixtures already exists with masked/mock safety; this service reuses fixture_id.
 * B-26: inferred confidence threshold 90 is not duplicated here; it lives in inference.
 */

export { SCENARIO_KINDS };
export type { ScenarioKind };
export type FlowTestScenario = typeof flowTestScenarios.$inferSelect;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

export function assertScenarioKind(v: string): asserts v is ScenarioKind {
  if (!(SCENARIO_KINDS as readonly string[]).includes(v)) {
    throw httpError(`invalid scenario kind: ${v}. Allowed: ${SCENARIO_KINDS.join(", ")} — real is not a scenario kind, real is namespace D-52, never a fixture`, 400);
  }
  if (v === "real") {
    throw httpError("real is not a scenario kind — real is namespace D-52, never a fixture", 400);
  }
}

const createScenarioSchema = z.object({
  workspaceId: z.string().uuid(),
  flowId: z.string().uuid(),
  name: z.string().min(1, "name required").max(255),
  kind: z.enum(SCENARIO_KINDS),
  population: z.string().min(1, "population required e.g. '142 employees · normal month'").max(500),
  reason: z.string().max(4000).nullable().optional(),
  fixtureId: z.string().uuid().nullable().optional(),
  createdBySubject: z.string().max(255).nullable().optional(),
});

export type CreateScenarioInput = z.infer<typeof createScenarioSchema>;

export const scenarioService = {
  /**
   * List scenarios for a flow, ordered by created_at asc. Honest-empty when none — population not faked.
   * Returns {scenarios} shape as required by B-18 route.
   */
  async list(workspaceId: string, flowId: string): Promise<{ scenarios: FlowTestScenario[] }> {
    const scenarios = await db
      .select()
      .from(flowTestScenarios)
      .where(and(eq(flowTestScenarios.workspaceId, workspaceId), eq(flowTestScenarios.flowId, flowId)))
      .orderBy(asc(flowTestScenarios.createdAt));
    return { scenarios };
  },

  /**
   * Create a scenario. Validates kind (real rejected), population required.
   * `population` is not faked — caller must supply it; empty list is honest-empty.
   */
  async create(input: CreateScenarioInput): Promise<FlowTestScenario> {
    const parsed = createScenarioSchema.parse(input);
    // Explicit real guard (redundant with z.enum but documents D-52)
    if ((parsed.kind as string) === "real") {
      throw httpError("real is not a scenario kind — real is namespace D-52", 400);
    }
    const [row] = await db
      .insert(flowTestScenarios)
      .values({
        workspaceId: parsed.workspaceId,
        flowId: parsed.flowId,
        name: parsed.name,
        kind: parsed.kind,
        population: parsed.population,
        reason: parsed.reason ?? null,
        fixtureId: parsed.fixtureId ?? null,
        createdBySubject: parsed.createdBySubject ?? null,
      })
      .returning();
    if (!row) throw httpError("failed to create scenario", 500);
    return row;
  },

  /** Validate kind string, throw 400 if invalid (used by tests). */
  assertKind(kind: string): void {
    assertScenarioKind(kind);
  },
};
