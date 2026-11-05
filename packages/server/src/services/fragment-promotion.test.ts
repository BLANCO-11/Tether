import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import {
  normaliseBody,
  promotionCandidates,
  shapeKeyOf,
} from "./fragment-promotion.service.js";
import type { StepContract } from "./step-contract.service.js";
import type { CodeStep, FlowModel } from "./flow-compiler.service.js";

/**
 * The graduation loop — 04 §5.1, phase-6.md 6.5.
 *
 * > *"Track recurring fragments; each one promoted removes a class of generation
 * > error permanently."*
 *
 * The property under test is not "does it find things". It is that what it finds
 * is **countable in a way a person can act on**, and the three ways to get that
 * wrong are all fixtured below:
 *
 *   * counting REVISIONS as recurrences, so the flow that has been iterated most
 *     looks like the most reusable one
 *   * counting two steps inside ONE flow as "recurring across flows" — a real
 *     smell, but a different one, and it would sit at the top of a list titled
 *     "candidates to become tools"
 *   * grouping on the contract's PROSE, which differs in wording for identical
 *     steps and makes the grouping never fire
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[phase6] SKIPPING promotion tests — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

const stamp = Date.now();
let wsId: string;

const RANK_IN = [
  { name: "rows", type: "array" as const, items: "object" as const },
  { name: "minimum", type: "number" as const },
];
const RANK_OUT = [{ name: "ranked", type: "array" as const, items: "object" as const }];

function contract(stepId: string, purpose: string): StepContract {
  return { stepId, purpose, input: RANK_IN, output: RANK_OUT };
}

const SHARED_BODY = "def run(payload):\n    return {'ranked': sorted(payload['rows'])}\n";

/** Insert a flow whose draft revision is `draftRevision`, with the given code steps. */
async function makeFlow(
  name: string,
  draftRevision: number,
  steps: Array<{ stepId: string; contract: StepContract | null; code: string }>,
  /** Extra earlier revisions, to prove they are NOT counted. */
  staleRevisions: number[] = [],
) {
  const model: FlowModel = {
    id: `promo-${name}-${stamp}`,
    steps: steps.map<CodeStep>((s) => ({
      id: s.stepId,
      kind: "code",
      code: s.code,
      inputExpr: "{}",
      outputKeys: RANK_OUT.map((f) => f.name),
    })),
  };
  const flow = await flowRepo.create({
    workspaceId: wsId,
    name,
    kestraFlowId: model.id,
    draftRevision,
    status: "draft",
  });
  if (!flow) throw new Error("setup: flow insert unexpectedly conflicted");
  for (const revision of [...staleRevisions, draftRevision]) {
    await flowRepo.insertRevision({
      flowId: flow.id,
      revision,
      modelJson: model,
      compiledYamlHash: "sha256:t",
      structureHash: "sha256:t",
      createdByKind: "system",
    });
    await flowRepo.insertSteps(
      steps.map((s, i) => ({
        flowId: flow.id,
        revision,
        stepId: s.stepId,
        ordinal: i,
        kind: "code",
        configJson: { ...model.steps[i], code: s.code },
        manifestRefsJson: {},
        contractJson: s.contract,
      })),
    );
  }
  return flow;
}

beforeAll(async () => {
  if (!reachable) return;
  const [ws] = await db
    .insert(workspaces)
    .values({ name: `promo-${stamp}`, description: "phase-6 promotion test; safe to delete" })
    .returning();
  wsId = ws.id;

  // Two DIFFERENT flows with the same contract interface and byte-identical
  // bodies — the strongest possible promotion signal, and the one that needs no
  // interpretation.
  await makeFlow("alpha", 3, [{ stepId: "rank", contract: contract("rank", "rank rows by shortfall descending"), code: SHARED_BODY }], [1, 2]);
  await makeFlow("beta", 1, [{ stepId: "order", contract: contract("order", "rank the rows by shortfall, descending"), code: SHARED_BODY }]);

  // A third flow whose steps share the interface but do an unrelated job, with a
  // different body. Must still be surfaced, and must be labelled `shapeOnly`.
  await makeFlow("gamma", 1, [
    {
      stepId: "dedupe",
      contract: contract("dedupe", "remove duplicate employee records by identifier"),
      code: "def run(payload):\n    return {'ranked': list({r['id']: r for r in payload['rows']}.values())}\n",
    },
  ]);

  // A shape that occurs TWICE inside one flow and nowhere else. Duplication
  // within an automation, not a recurring job — must not be reported.
  const other: StepContract = {
    stepId: "x",
    purpose: "sum a column",
    input: [{ name: "values", type: "array", items: "number" }],
    output: [{ name: "total", type: "number" }],
  };
  await makeFlow("delta", 1, [
    { stepId: "sum_a", contract: { ...other, stepId: "sum_a" }, code: "def run(payload):\n    return {'total': sum(payload['values'])}\n" },
    { stepId: "sum_b", contract: { ...other, stepId: "sum_b" }, code: "def run(payload):\n    return {'total': sum(payload['values'])}\n" },
  ]);

  // A hand-written fragment with no contract, in two flows. Nothing declares what
  // a tool replacing it would have to do, so it cannot be a candidate.
  await makeFlow("eps1", 1, [{ stepId: "hand", contract: null, code: "def run(payload):\n    return {'ranked': []}\n" }]);
  await makeFlow("eps2", 1, [{ stepId: "hand", contract: null, code: "def run(payload):\n    return {'ranked': []}\n" }]);
});

afterAll(async () => {
  if (reachable && wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await pool.end().catch(() => {});
});

describe("shape keys and body normalisation", () => {
  it("ignores field ORDER, because a contract's fields are named", () => {
    const a = shapeKeyOf({ stepId: "a", purpose: "p", input: RANK_IN, output: RANK_OUT });
    const b = shapeKeyOf({ stepId: "b", purpose: "p", input: [...RANK_IN].reverse(), output: RANK_OUT });
    expect(a).toBe(b);
  });

  it("ignores DESCRIPTIONS, which are prose and would make grouping never fire", () => {
    const a = shapeKeyOf({ stepId: "a", purpose: "p", input: RANK_IN, output: RANK_OUT });
    const b = shapeKeyOf({
      stepId: "b",
      purpose: "totally different wording",
      input: RANK_IN.map((f) => ({ ...f, description: "some model-written clause" })),
      output: RANK_OUT,
    });
    expect(a).toBe(b);
  });

  it("distinguishes an element type — rows are not ids", () => {
    const rows = shapeKeyOf({ stepId: "a", purpose: "p", input: [{ name: "xs", type: "array", items: "object" }], output: RANK_OUT });
    const ids = shapeKeyOf({ stepId: "a", purpose: "p", input: [{ name: "xs", type: "array", items: "string" }], output: RANK_OUT });
    expect(rows).not.toBe(ids);
  });

  it("normalises comments and whitespace, so a blank line is not a different fragment", () => {
    const a = "def run(payload):\n    # rank them\n    return {'x': 1}\n";
    const b = "def run(payload):\n\n        return {'x': 1}\n";
    expect(normaliseBody(a)).toBe(normaliseBody(b));
  });
});

describe.skipIf(!reachable)("6.5 promotion candidates", () => {
  it("surfaces a shape that recurs across two flows, with identical bodies", async () => {
    const candidates = await promotionCandidates(wsId);
    const top = candidates[0];
    expect(top.flowCount).toBe(3); // alpha, beta, gamma all share the interface
    expect(top.occurrences.map((o) => o.flowName).sort()).toEqual(["alpha", "beta", "gamma"]);
    // alpha and beta produced the SAME body; gamma a different one.
    expect(top.distinctBodies).toBe(2);
  });

  it("counts FLOWS, not revisions — alpha has three revisions and counts once", async () => {
    const candidates = await promotionCandidates(wsId);
    const alpha = candidates[0].occurrences.filter((o) => o.flowName === "alpha");
    expect(alpha).toHaveLength(1);
    // The draft revision, not revision 1. Scanning every revision would make the
    // most-iterated flow look like the most reusable one.
    expect(alpha[0].revision).toBe(3);
  });

  it("does NOT report duplication inside a single flow", async () => {
    const candidates = await promotionCandidates(wsId);
    const sums = candidates.find((c) => c.shapeKey.includes("total:number"));
    expect(sums).toBeUndefined();
  });

  it("labels a group whose purposes disagree as shapeOnly", async () => {
    const candidates = await promotionCandidates(wsId);
    // "rank rows by shortfall" and "remove duplicate employee records" share an
    // interface and nothing else. Presenting that as a finding would be a
    // coincidence dressed as evidence.
    expect(candidates[0].shapeOnly).toBe(true);
    expect(candidates[0].purposes).toHaveLength(3);
  });

  it("agrees when the purposes are the same job worded differently", async () => {
    // Isolated from the gamma noise: the two rank steps on their own DO agree.
    const candidates = await promotionCandidates(wsId, { minFlows: 3 });
    expect(candidates.length).toBeGreaterThan(0);
    // And the raw purposes are carried through unmerged, so a human judges.
    expect(candidates[0].purposes.some((p) => p.includes("shortfall"))).toBe(true);
    expect(candidates[0].purposes.some((p) => p.includes("duplicate"))).toBe(true);
  });

  it("skips hand-written fragments — there is no contract to promote", async () => {
    const candidates = await promotionCandidates(wsId);
    expect(candidates.every((c) => !c.occurrences.some((o) => o.stepId === "hand"))).toBe(true);
  });

  it("reports nothing at all for a workspace with one flow", async () => {
    const [solo] = await db
      .insert(workspaces)
      .values({ name: `promo-solo-${stamp}`, description: "phase-6; safe to delete" })
      .returning();
    expect(await promotionCandidates(solo.id)).toEqual([]);
    await db.delete(workspaces).where(eq(workspaces.id, solo.id));
  });
});
