import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { apply, complete, emptyFlow, holesOf, walk, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { db } from "../db/index.js";
import { flowRevisions, workspaces } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { compilerRenderInputs } from "./flow-typecheck.js";
import { undecided, flowService, gateRevisionModel } from "./flow.service.js";
// A fresh engine id for a test flow (the job service that offered one is deleted, phase 8).
const freeFlowId = async (_ws: string, wanted: string) => `${wanted}-${Math.random().toString(36).slice(2, 8)}`;
import { namespaceFor } from "./kestra-client.service.js";
import type { FlowModel } from "./flow-compiler.service.js";
import type { RefInterface } from "./manifest-builder.service.js";

/**
 * Holes in storage (compiled-builder phase 3, task 6; D-319). Two halves, one rule: a REVISION is complete, and an
 * incomplete flow is a working copy on the flow that nothing can approve or run because nothing can name it.
 *
 *  - the funnel (`gateRevisionModel`, the one every revision passes) refuses a state with holes, by the holes — never by
 *    the empty site's symptom — and stores a complete engine state with no hole-shaped key;
 *  - the working copy round-trips, is re-judged on read, refuses an INVALID state (incomplete is allowed, invalid is not),
 *    writes no revision, and is tenant-scoped.
 */

type Fixture = { workspace: string; cat: CatalogueSnapshot; ifaces: Record<string, RefInterface> };
const CATALOGUES: Fixture[] = JSON.parse(readFileSync(new URL("./__fixtures__/engine-catalogues.json", import.meta.url), "utf8"));

const gate = (f: EFlow, fx: Fixture) =>
  gateRevisionModel(f as unknown as FlowModel, {
    catalogue: async () => ({ ...fx.cat, renderInputs: compilerRenderInputs }),
    refNames: Object.keys(fx.ifaces),
    interfaces: fx.ifaces,
    allowedModels: [],
    contracts: {},
    compile: { namespace: namespaceFor("prop", "ws", "draft"), withSchedule: false, labels: {} },
  });

/** A complete engine state from a fixture catalogue: the first seed whose walk + completion leaves no hole. */
function completeState(): { f: EFlow; fx: Fixture } {
  for (let seed = 1; seed < 400; seed++) {
    const fx = CATALOGUES[seed % CATALOGUES.length]!;
    const cat = { ...fx.cat, renderInputs: compilerRenderInputs };
    const steps = walk(emptyFlow("inc"), cat, 1 + (seed % 8), seed);
    const done = complete(steps.at(-1)?.flow ?? emptyFlow("inc"), cat, seed).at(-1)?.flow;
    if (done && done.holes.length === 0 && done.steps.length) return { f: done, fx };
  }
  throw new Error("no complete state in 400 seeds");
}

describe("a working copy is UNDECIDED by one definition (2026-10-04, B08/B12/E05)", () => {
  it("holes, the goal's unmet, or a question the conversation holds; CONTROL: none of them is complete", () => {
    expect(undecided(1)).toBe(true);
    expect(undecided(0, { goalSpec: {}, trace: { unmet: ["the condition was not built"] } })).toBe(true);
    expect(undecided(0, { goalSpec: { conversation: { pending: "reader:0" } }, trace: {} })).toBe(true);
    expect(undecided(0, { goalSpec: { conversation: { pending: null } }, trace: { unmet: [] } })).toBe(false);
    expect(undecided(0)).toBe(false);
  });
});

describe("the funnel: a revision is complete (D-319)", () => {
  it("refuses a state with holes, naming each hole rather than the empty site's symptom", async () => {
    const fx = CATALOGUES[0]!;
    const cat = { ...fx.cat, renderInputs: compilerRenderInputs };
    const r = apply(emptyFlow("inc"), { op: "add_reader", id: "r" }, cat);
    expect(r.ok).toBe(true);
    const f = (r as { flow: EFlow }).flow;
    expect(f.holes.map((h) => h.id).sort()).toEqual(["h_r_reader", "h_result"]); // CONTROL: the state really has two holes
    await expect(gate(f, fx)).rejects.toThrow(/incomplete — 2 undecided: .*`h_result`.*`h_r_reader`|incomplete — 2 undecided: .*`h_r_reader`.*`h_result`/);
    await expect(gate(f, fx)).rejects.not.toThrow(/needs a ref|ref is required/);
  });

  it("accepts a complete engine state and stores no `holes` key", async () => {
    const { f, fx } = completeState();
    expect(f.holes).toEqual([]); // CONTROL: the key is present going in
    const { model } = await gate(f, fx);
    expect("holes" in model).toBe(false);
  });
});

const reachable = await db.select({ id: workspaces.id }).from(workspaces).limit(1).then(() => true, () => false);
const stamp = Date.now();
let wsA = "", wsB = "", flowA = "";

beforeAll(async () => {
  if (!reachable) return;
  const mkWs = async (name: string) => (await db.insert(workspaces).values({ name, description: "compiled-builder D-319 test; safe to delete" }).returning())[0]!.id;
  wsA = await mkWs(`inc-a-${stamp}`);
  wsB = await mkWs(`inc-b-${stamp}`);
  const created = await flowRepo.create({ workspaceId: wsA, name: "incomplete", kestraFlowId: await freeFlowId(wsA, `inc-${stamp}`), description: "D-319 test; safe to delete" });
  flowA = created!.id;
});
afterAll(async () => {
  if (reachable) for (const id of [wsA, wsB]) if (id) await db.delete(workspaces).where(eq(workspaces.id, id));
});

describe.skipIf(!reachable)("the working copy round-trips holes (D-319)", () => {
  const holed = (): EFlow => {
    const r = apply(emptyFlow("inc"), { op: "add_reader", id: "r" }, { refs: {} } as unknown as CatalogueSnapshot);
    return (r as { flow: EFlow }).flow;
  };

  it("stores an incomplete state and reads it back re-judged: holes, never errors, and no revision written", async () => {
    const saved = await flowService.saveIncomplete(wsA, flowA, holed());
    expect(saved.stale).toBe(false);
    const got = await flowService.getIncomplete(wsA, flowA);
    expect(got?.model.holes.map((h) => h.id).sort()).toEqual(["h_r_reader", "h_result"]);
    expect(got?.model.holes.find((h) => h.id === "h_r_reader")).toMatchObject({ site: { at: "reader", stepId: "r" }, owner: "chooser" });
    expect(holesOf(got!.diagnostics)).toHaveLength(2);
    expect(got!.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const revs = await db.select({ id: flowRevisions.id }).from(flowRevisions).where(eq(flowRevisions.flowId, flowA));
    expect(revs).toHaveLength(0);
  });

  it("refuses an INVALID state — incomplete is allowed, invalid is not", async () => {
    const bad = holed();
    bad.holes.push({ id: "ghost", site: { at: "port", stepId: "nope", port: "x" }, why: "required", ty: null, owner: "person", reason: "a hole on a step that does not exist" });
    await expect(flowService.saveIncomplete(wsA, flowA, bad)).rejects.toThrow(/invalid, not merely incomplete/);
  });

  it("reads as STALE once a revision is written after it", async () => {
    await flowService.saveIncomplete(wsA, flowA, holed());
    const flow = await flowRepo.get(wsA, flowA);
    await flowRepo.update(flowA, { draftRevision: flow!.draftRevision + 1 });
    expect((await flowService.getIncomplete(wsA, flowA))?.stale).toBe(true);
    await flowRepo.update(flowA, { draftRevision: flow!.draftRevision });
  });

  it("is tenant-scoped: another workspace reads the flow as not found", async () => {
    await expect(flowService.getIncomplete(wsB, flowA)).rejects.toThrow(/flow not found/);
    await expect(flowService.saveIncomplete(wsB, flowA, holed())).rejects.toThrow(/flow not found/);
  });

  it("clears, and clearing twice is harmless", async () => {
    await flowService.clearIncomplete(wsA, flowA);
    await flowService.clearIncomplete(wsA, flowA);
    expect(await flowService.getIncomplete(wsA, flowA)).toBeNull();
  });
});
