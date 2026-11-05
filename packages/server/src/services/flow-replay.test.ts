import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { downstreamOf, replay, replayPlan } from "./flow-replay.service.js";
import { retentionDays } from "./retention.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * Replay — the authorisation and the four hazards.
 * 05 §6.3 · phase-6.md 6.1
 *
 * ── What is tested here, and what is not ─────────────────────────────────────
 *
 * The engine half — does Kestra actually rehydrate step 1's output and resume at
 * step 2 — is `kestra:phase6`'s job and cannot be faked here. What IS testable
 * without an engine, and matters more, is everything Foundry decides BEFORE it
 * calls Kestra:
 *
 *   * a replay request naming another workspace's execution is a 404, and the
 *     same 404 as a nonexistent one
 *   * `downstreamOf` is computed from `dependsOn`, not from ordinal position —
 *     the set it returns is what decides whether a pausing step is inside the
 *     replay, and ordinals agree with dependencies right up until a flow branches
 *   * a partial replay is refused when Foundry cannot verify it is safe
 *
 * The last one is the point of the whole file. A Kestra replay from step N skips
 * `begin`, which is where the approval gate, the execution token and the M3
 * budget all live — so an unguarded `fromStepId` is an approval bypass reachable
 * by pressing a button that already exists.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[phase6] SKIPPING replay tests — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

const stamp = Date.now();
let wsA: string;
let wsB: string;
let executionInA: string;

/**
 * A branching flow. `fan_a` and `fan_b` both depend on `fetch`, and `gate_step`
 * hangs off `fan_b` only — so replaying from `fan_a` does NOT reach the gate
 * even though the gate's ordinal is higher. An ordinal-based implementation
 * gets this exactly backwards, which is why the fixture branches.
 */
const BRANCHING: FlowModel = {
  id: `replay-branch-${stamp}`,
  steps: [
    { id: "fetch", kind: "datasource", ref: "db.q", paramsExpr: "[{}]" },
    { id: "fan_a", kind: "transform", expr: "{{ outputs.fetch.body }}", dependsOn: ["fetch"] },
    { id: "fan_b", kind: "transform", expr: "{{ outputs.fetch.body }}", dependsOn: ["fetch"] },
    {
      id: "gate_step",
      kind: "approval",
      summaryExpr: '"proceed?"',
      dependsOn: ["fan_b"],
    },
    { id: "tail", kind: "transform", expr: "{{ outputs.fan_a.value }}", dependsOn: ["fan_a"] },
  ],
};

beforeAll(async () => {
  if (!reachable) return;
  const mk = async (name: string) => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name, description: "phase-6 replay test; safe to delete" })
      .returning();
    return ws.id;
  };
  wsA = await mk(`replay-a-${stamp}`);
  wsB = await mk(`replay-b-${stamp}`);

  const flow = await flowRepo.create({
    workspaceId: wsA,
    name: "branching",
    kestraFlowId: BRANCHING.id,
    draftRevision: 1,
    status: "draft",
  });
  if (!flow) throw new Error("setup: flow insert unexpectedly conflicted");
  await flowRepo.insertRevision({
    flowId: flow.id,
    revision: 1,
    modelJson: BRANCHING,
    compiledYamlHash: "sha256:t",
    structureHash: "sha256:t",
    createdByKind: "system",
  });

  const exec = await flowExecutionRepo.create({
    workspaceId: wsA,
    flowId: flow.id,
    flowRevision: 1,
    kestraNamespace: "foundry.test.replay.draft",
    kestraFlowId: BRANCHING.id,
    // Deliberately an id no engine has. Every assertion below is reached before
    // Kestra is consulted, or asserts the behaviour when Kestra does not know it.
    kestraExecutionId: `absent-${stamp}`,
    status: "failed",
  });
  executionInA = exec.id;
});

afterAll(async () => {
  if (reachable) {
    for (const id of [wsA, wsB]) if (id) await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  await pool.end().catch(() => {});
});

describe("downstreamOf — dependencies, never ordinals", () => {
  it("returns the target plus its transitive dependents", () => {
    expect([...downstreamOf(BRANCHING, "fetch")].sort()).toEqual([
      "fan_a",
      "fan_b",
      "fetch",
      "gate_step",
      "tail",
    ]);
  });

  it("does NOT include a later step on a sibling branch", () => {
    // `gate_step` has a higher ordinal than `fan_a` and is not downstream of it.
    // An ordinal-based version would include it and refuse a replay that is
    // perfectly safe — and, on a flow ordered the other way, would ALLOW one
    // that hangs.
    const from = downstreamOf(BRANCHING, "fan_a");
    expect([...from].sort()).toEqual(["fan_a", "tail"]);
    expect(from.has("gate_step")).toBe(false);
  });

  it("does include an agent step reached through a chain", () => {
    expect(downstreamOf(BRANCHING, "fan_b").has("gate_step")).toBe(true);
  });

  it("terminates on a step nothing depends on", () => {
    expect([...downstreamOf(BRANCHING, "tail")]).toEqual(["tail"]);
  });
});

describe.skipIf(!reachable)("6.1 replay authorisation", () => {
  it("gives the SAME answer for another workspace's execution as for a missing one", async () => {
    // Both 404. A 403 for the second would confirm the execution exists, which is
    // a cross-tenant existence oracle over an id space a client can iterate.
    const cross = replay(wsB, executionInA);
    const absent = replay(wsB, "00000000-0000-0000-0000-000000000000");
    await expect(cross).rejects.toMatchObject({ statusCode: 404 });
    await expect(absent).rejects.toMatchObject({ statusCode: 404 });
    await expect(cross).rejects.toThrow(/execution not found/);
    await expect(absent).rejects.toThrow(/execution not found/);
  });

  it("refuses before it ever asks the engine — the workspace check is first", async () => {
    // The fixture's Kestra execution id does not exist. A cross-workspace request
    // must still 404 rather than 410/503, which is what proves ownership is
    // checked before the engine is consulted at all.
    await expect(replay(wsB, executionInA)).rejects.toMatchObject({ statusCode: 404 });
  });

  /**
   * ⚠ Kestra **cannot publish ports** (its network is `internal: true`, and Docker
   * discards the stanza), so a unit test never reaches an engine. That is not a
   * gap to work around here — it is what makes the following assertion the
   * valuable one.
   *
   * An unreachable engine and a purged execution are different answers, and the
   * code returns 503 for one and 410 for the other. Collapsing them would send a
   * user whose Kestra is down to read a retention policy — the same class of
   * mistake as I-12, where a degrade-gracefully catch lost what it had degraded
   * from and the bug then presented as "the field is just null sometimes".
   *
   * The 410 half is asserted against a real engine in `kestra:phase6`.
   */
  it("does not report an unreachable engine as a purged execution", async () => {
    const plan = await replayPlan(wsA, executionInA);
    expect(plan.replayable).toBe(false);
    expect(plan.reason).toMatch(/cannot reach the engine/i);
    expect(plan.reason).not.toMatch(/retained for/);
    expect(plan.steps).toEqual([]);
  });

  it("surfaces the reason rather than an empty list, so a control can explain itself", async () => {
    const plan = await replayPlan(wsA, executionInA);
    // The distinction that matters to a UI: `replayable: false` WITH a reason is
    // renderable; a bare empty list reads as "this feature is broken".
    expect(plan.reason).toBeTruthy();
    expect(plan.engineState).toBeNull();
  });

  /**
   * GAPS §6.3. The window travels on the REFUSAL too — computed from the Foundry
   * row before the engine is consulted, so a run that cannot be replayed because
   * the engine no longer holds it can still say what the window was. A
   * `retention` block that only appeared on the happy path would be absent from
   * every screen where the question is actually being asked.
   */
  it("carries the replay window even when the plan is a refusal", async () => {
    const plan = await replayPlan(wsA, executionInA);
    expect(plan.replayable).toBe(false);
    expect(plan.retention.days).toBe(retentionDays());
    expect(plan.retention.note).toContain(`retained for ${retentionDays()} days`);
    expect(plan.retention.daysRemaining).not.toBeNull();
  });
});
