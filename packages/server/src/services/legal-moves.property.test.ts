/**
 * The property test (compiled-builder phase 3, task 4; P1): random LEGAL move sequences over every catalogue on the
 * deployment (committed as `__fixtures__/engine-catalogues.json` by `scenarios/engine-catalogues.ts`). Every reached state
 * must have zero checker errors with its hole invariants intact, and every COMPLETE state must pass the real save funnel
 * (`gateRevisionModel`, D-318) — normalise, lowering, D-22, declared inputs, step refs, feeder compatibility, `assertValid`,
 * the type gate and the compile. A failure is a bug in an op's precondition: fix the op, never this test.
 *
 * `ENGINE_WALKS` sets the size (default 1,000 per run here; the gate run is 10,000 — `logs/property-10k.log`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canvasWalk, splitSide, loopOfStep, checkState, complete, DISABLED_PRECONDITIONS, emptyFlow, fuzzFlow, type Ty, errorsOf, holesOf, renderDiagnostic, walk, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { compilerRenderInputs } from "./flow-typecheck.js";
import { gateRevisionModel } from "./flow.service.js";
import { batchedCall, type FlowModel } from "./flow-compiler.service.js";
import type { RefInterface } from "./manifest-builder.service.js";
import { namespaceFor } from "./kestra-client.service.js";

type Fixture = { workspace: string; cat: CatalogueSnapshot; ifaces: Record<string, RefInterface> };
export const CATALOGUES: Fixture[] = JSON.parse(readFileSync(new URL("./__fixtures__/engine-catalogues.json", import.meta.url), "utf8"));
const WALKS = Number(process.env.ENGINE_WALKS ?? 1000);

export async function funnel(f: EFlow, fx: Fixture): Promise<string | null> {
  const cat: CatalogueSnapshot = { ...fx.cat, renderInputs: compilerRenderInputs };
  try {
    await gateRevisionModel(f as unknown as FlowModel, {
      catalogue: async () => cat,
      refNames: Object.keys(fx.ifaces),
      interfaces: fx.ifaces,
      allowedModels: [],
      contracts: {},
      compile: { namespace: namespaceFor("prop", "ws", "draft"), withSchedule: false, labels: {} },
    });
    return null;
  } catch (e) { return (e as Error).message; }
}

/** The catalogue with every reader column's `Option` stripped — the soundness fuzz's negative control (task 8). */
const strip = (t: Ty): Ty => (t.t === "Option" ? strip(t.of) : t.t === "Record" ? { t: "Record", fields: Object.fromEntries(Object.entries(t.fields).map(([k, v]) => [k, strip(v)])) } : t.t === "Rows" || t.t === "List" ? ({ ...t, of: strip(t.of) } as Ty) : t);
export const weakened = (c: CatalogueSnapshot): CatalogueSnapshot => ({ ...c, refs: Object.fromEntries(Object.entries(c.refs).map(([k, v]) => [k, v.kind === "tool" ? v : { ...v, payload: strip(v.payload) }])) });

export async function runProperty(walks: number, seed0 = 50_000, opts: { fuzzRuns?: number; weaken?: boolean; front?: "engine" | "canvas" } = {}) {
  const failures: string[] = [];
  const fuzzErrors: string[] = [];
  let states = 0, completeStates = 0;
  /** D-320: how many COMPLETE states carry each construct — a 0 here means the walk never exercised it. */
  const reached = { branch: 0, otherwise: 0, elif: 0, merge: 0, guardedCall: 0, decide: 0, split: 0, forEach: 0, forEachOutput: 0, conditionPerItem: 0, batchedLoop: 0 };
  for (let i = 0; i < walks; i++) {
    const fx = CATALOGUES[i % CATALOGUES.length]!;
    const trueCat: CatalogueSnapshot = { ...fx.cat, renderInputs: compilerRenderInputs };
    const cat = opts.weaken ? weakened(trueCat) : trueCat;
    const seed = seed0 + i;
    let steps;
    try {
      // Both front ends under one invariant (phase 7, task 5): the LLM builder's legal walk, or the canvas's own actions only.
      steps = opts.front === "canvas" ? canvasWalk(emptyFlow("prop_flow"), cat, 1 + (i % 30), seed).map((x) => ({ op: x.a, flow: x.flow })) : walk(emptyFlow("prop_flow"), cat, 1 + (i % 30), seed);
      steps = steps.concat(complete(steps.at(-1)?.flow ?? emptyFlow("prop_flow"), cat, seed));
    } catch (e) { failures.push(`[${fx.workspace}] ${(e as Error).message}`); continue; }
    for (const [k, st] of steps.entries()) {
      states++;
      const ds = checkState(st.flow, cat);
      const errs = errorsOf(ds);
      if (errs.length) { failures.push(`[${fx.workspace}] seed ${seed} step ${k} after ${JSON.stringify(st.op)}:\n${errs.map(renderDiagnostic).join("\n")}`); break; }
      if (k === steps.length - 1 && !holesOf(ds).length) {
        completeStates++;
        const ss = st.flow.steps;
        if (ss.some((x) => x.kind === "branch")) reached.branch++;
        if (ss.some((x) => x.kind === "branch" && x.elseOf && !x.conditions?.length)) reached.otherwise++;
        if (ss.some((x) => x.kind === "branch" && x.elseOf && x.conditions?.length)) reached.elif++;
        if (ss.some((x) => x.kind === "merge")) reached.merge++;
        // Phase C (D-371): a condition deciding on ONE value — its subject is a transform ending in `keep_if`.
        if (ss.some((x) => x.kind === "branch" && x.conditions?.some((c) => { const t = ss.find((y) => y.id === c.left.stepId); return t?.kind === "transform" && t.pipeline.at(-1)?.op === "keep_if"; }))) reached.decide++;
        // Phase C (D-373): a Split — recognised by the engine's own structural rule, not a second copy of it. A canvas gesture only.
        if (ss.some((x) => splitSide(st.flow, x.id))) reached.split++;
        if (ss.some((x) => x.kind === "tool" && x.dependsOn.some((d) => ss.find((y) => y.id === d)?.kind === "branch"))) reached.guardedCall++;
        // Phase F (D-361): a loop, a loop with an output, and a condition inside a loop's body (decided per item).
        if (ss.some((x) => x.kind === "for_each")) reached.forEach++;
        if (ss.some((x) => x.kind === "collect")) reached.forEachOutput++;
        if (ss.some((x) => x.kind === "branch" && loopOfStep(st.flow).has(x.id))) reached.conditionPerItem++;
        // D-370: a loop the compiler runs in batches (one call inside) — compiled through the funnel like any other.
        if (ss.some((x) => x.kind === "for_each" && batchedCall(st.flow as unknown as FlowModel, x as never))) reached.batchedLoop++;
        // P7: on data drawn from the TRUE schema, the flow runs without a runtime error.
        if (opts.fuzzRuns) { const z = fuzzFlow(st.flow, cat, opts.fuzzRuns, seed, trueCat); if (z.errors.length) fuzzErrors.push(`[${fx.workspace}] seed ${seed}: ${z.errors[0]}`); }
        if (opts.weaken) continue; // the control judges the fuzz alone
        const refused = await funnel(st.flow, fx);
        if (refused) failures.push(`[${fx.workspace}] seed ${seed} COMPLETE state refused by the save funnel: ${refused.slice(0, 600)}\nflow: ${JSON.stringify(st.flow)}`);
      }
    }
  }
  return { failures, states, completeStates, fuzzErrors, reached };
}

describe("P1: no legal move sequence reaches a state the checker or the save funnel refuses", () => {
  it(`${WALKS} walks over the deployment's ${CATALOGUES.length} catalogues`, async () => {
    const r = await runProperty(WALKS, 50_000, { fuzzRuns: 20 });
    console.log(`walks ${WALKS} · states ${r.states} · complete ${r.completeStates} · failures ${r.failures.length} · fuzz runtime errors ${r.fuzzErrors.length} (${r.completeStates} flows × 20 runs) · reached ${JSON.stringify(r.reached)}`);
    console.log(`complete states with (D-320): ${JSON.stringify(r.reached)}`);
    if (process.env.ENGINE_DUMP) (await import("node:fs")).writeFileSync(process.env.ENGINE_DUMP, JSON.stringify(r.failures, null, 1));
    expect(r.failures.slice(0, 3)).toEqual([]);
    expect(r.fuzzErrors.slice(0, 3)).toEqual([]);
    expect(r.completeStates).toBeGreaterThan(WALKS / 5);
    // A construct the walk never reaches is one the property test says nothing about.
    // A Split is a canvas gesture, not an engine move — the canvas walk below must reach it.
    for (const [k, n] of Object.entries(r.reached)) if (k !== "split") expect(n, `no complete state with a ${k}`).toBeGreaterThan(0);
  }, 900_000);
});

/**
 * ⚠ NEGATIVE CONTROLS (task 5): with one precondition switched off — in the one function that states it, so `legalMoves` and
 * `apply` both stop enforcing it — the same walks must reach a state the checker or the funnel refuses. A control that finds
 * nothing means the property test could not have caught that precondition's absence, and "0 failures" would mean nothing.
 */
describe("P1 through the CANVAS (phase 7): no sequence of canvas actions reaches a state the checker or the save funnel refuses", () => {
  it(`${WALKS} canvas walks over the deployment's ${CATALOGUES.length} catalogues`, async () => {
    const r = await runProperty(WALKS, 60_000, { fuzzRuns: 5, front: "canvas" });
    console.log(`canvas walks ${WALKS} · states ${r.states} · complete ${r.completeStates} · failures ${r.failures.length} · fuzz runtime errors ${r.fuzzErrors.length} · reached ${JSON.stringify(r.reached)}`);
    // Phase C: both value conditions are reached through the canvas and saved through the funnel, not merely listed.
    expect(r.reached.decide, "no complete canvas state with a Decide").toBeGreaterThan(0);
    expect(r.reached.split, "no complete canvas state with a Split").toBeGreaterThan(0);
    // Phase F, F4: a loop, its output and a condition per item are reached through the canvas and saved through the funnel.
    expect(r.reached.forEach, "no complete canvas state with a loop").toBeGreaterThan(0);
    expect(r.reached.forEachOutput, "no complete canvas state with a loop's output").toBeGreaterThan(0);
    expect(r.reached.batchedLoop, "no complete canvas state with a loop that runs in batches").toBeGreaterThan(0);
    expect(r.failures.slice(0, 3)).toEqual([]);
    expect(r.fuzzErrors.slice(0, 3)).toEqual([]);
    expect(r.completeStates).toBeGreaterThan(WALKS / 5);
  }, 900_000);
  it("⚠ NEGATIVE CONTROL: without `fits`, a canvas walk reaches a refused state", async () => {
    DISABLED_PRECONDITIONS.add("fits");
    try {
      const r = await runProperty(400, 92_000, { front: "canvas" });
      console.log(`canvas control fits: ${r.failures.length} failures in 400 walks`);
      expect(r.failures.length).toBeGreaterThan(0);
    } finally { DISABLED_PRECONDITIONS.clear(); }
  }, 600_000);
});

describe("⚠ NEGATIVE CONTROLS: removing one precondition is caught", () => {
  for (const pre of ["fits", "bounded", "literal"] as const) {
    it(`without \`${pre}\``, async () => {
      DISABLED_PRECONDITIONS.add(pre);
      try {
        const r = await runProperty(400, 90_000);
        console.log(`control ${pre}: ${r.failures.length} failures in 400 walks; first: ${r.failures[0]?.split("\n").slice(0, 2).join(" | ").slice(0, 300)}`);
        expect(r.failures.length).toBeGreaterThan(0);
      } finally { DISABLED_PRECONDITIONS.clear(); }
    }, 600_000);
  }
});

/**
 * ⚠ NEGATIVE CONTROL (D-320): with the emission-order placement switched off, a guarded step may read a top-level step placed
 * after its condition begins, or a merge. The compiler emits the whole chain at the head, so that read is of a task that has
 * not run; the funnel does not model emission order, so it is the FUZZ (which evaluates in emission order) that must see it.
 */
describe("⚠ NEGATIVE CONTROL (D-320): removing the emission-order placement is caught", () => {
  it("without `placement`", async () => {
    DISABLED_PRECONDITIONS.add("placement");
    try {
      const r = await runProperty(600, 91_000, { fuzzRuns: 3 });
      console.log(`control placement: ${r.failures.length} funnel/checker failures, ${r.fuzzErrors.length} fuzz errors in 600 walks; first: ${(r.fuzzErrors[0] ?? r.failures[0])?.split("\n")[0]?.slice(0, 300)}`);
      expect(r.failures.length + r.fuzzErrors.length).toBeGreaterThan(0);
    } finally { DISABLED_PRECONDITIONS.clear(); }
  }, 600_000);
});

describe("⚠ NEGATIVE CONTROL (task 8): the fuzz finds the null a weakened type lets through", () => {
  it("every reader column's Option stripped from the TYPES, data still drawn from the true schema", async () => {
    const r = await runProperty(400, 70_000, { fuzzRuns: 20, weaken: true });
    console.log(`control weakened: ${r.fuzzErrors.length} flows with runtime errors of ${r.completeStates}; first: ${r.fuzzErrors[0]?.slice(0, 250)}`);
    expect(r.fuzzErrors.length).toBeGreaterThan(0);
  }, 600_000);
});

