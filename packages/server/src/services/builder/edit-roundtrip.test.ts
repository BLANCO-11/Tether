/**
 * D-321's premise, measured rather than assumed: a flow the builder SAVED can be read back as an engine state and extended.
 * A complete flow is put through the real save funnel (`gateRevisionModel`, which normalises what it stores), stored as
 * jsonb would store it, read back with `holes: []` as `editStart` does, and must check clean. Then the builder's own
 * construction options (never the walk, which also removes) extend it, and the result must be additive (`editProblems`)
 * and still pass the funnel.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { apply, checkState, complete, emptyFlow, engineReaderKinds, errorsOf, optionsOf, walk, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import type { RefInterface } from "../manifest-builder.service.js";
import { gateRevisionModel } from "../flow.service.js";
import { compilerRenderInputs } from "../flow-typecheck.js";
import { namespaceFor } from "../kestra-client.service.js";
import type { FlowModel } from "../flow-compiler.service.js";
import { editProblems } from "./build.js";

// Loaded here, not imported from the property test: importing a test file runs its suites (a 3-minute side effect).
type Fixture = { workspace: string; cat: CatalogueSnapshot; ifaces: Record<string, RefInterface> };
const CATALOGUES: Fixture[] = JSON.parse(readFileSync(new URL("../__fixtures__/engine-catalogues.json", import.meta.url), "utf8"));
const gate = (f: EFlow, fx: Fixture, cat: CatalogueSnapshot) =>
  gateRevisionModel(f as unknown as FlowModel, { catalogue: async () => cat, refNames: Object.keys(fx.ifaces), interfaces: fx.ifaces, allowedModels: [], contracts: {}, compile: { namespace: namespaceFor("rt", "ws", "draft"), withSchedule: false, labels: {} } });

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

describe("a saved flow is an engine state the builder can extend (D-321)", () => {
  it("round-trips through the save funnel and storage, and additive extension keeps it valid", async () => {
    let saved = 0, extended = 0, opsStored = 0;
    const failures: string[] = [];
    for (const fx of CATALOGUES) {
      const cat = { ...fx.cat, renderInputs: compilerRenderInputs };
      for (let seed = 1; seed <= 40; seed++) {
        const steps = walk(emptyFlow("rt_flow"), cat, 1 + (seed % 12), seed);
        const done = steps.concat(complete(steps.at(-1)?.flow ?? emptyFlow("rt_flow"), cat, seed)).at(-1)?.flow;
        if (!done || done.holes.length || errorsOf(checkState(done, cat)).length) continue;
        let gated: FlowModel;
        try {
          ({ model: gated } = await gate(done, fx, cat));
        } catch { continue; } // the funnel's verdict is the property test's subject, not this one's
        const stored = JSON.parse(JSON.stringify({ ...gated, version: 2 })) as EFlow;
        // I-297: an operation read is STORED as `query` (so the runtime runs it as an operation)…
        for (const s of stored.steps as Array<{ kind: string; ref?: string }>) if (s.ref && cat.refs[s.ref]?.kind === "operation" && s.kind !== "tool") { opsStored++; if (s.kind !== "query") failures.push(`[${fx.workspace}] seed ${seed}: operation ${s.ref} stored as ${s.kind}`); }
        // …and reads back as the engine's reader, exactly as editStart does.
        const start: EFlow = engineReaderKinds({ ...stored, inputs: stored.inputs ?? [], holes: [] });
        saved++;
        const back = errorsOf(checkState(start, cat));
        if (back.length) { failures.push(`[${fx.workspace}] seed ${seed}: stored flow does not read back: ${back[0]!.message}`); continue; }
        // Extend by construction options only — what the builder offers on an edit.
        const r = rng(seed);
        let f = start;
        for (let k = 0; k < 4; k++) {
          const opts = optionsOf(f, cat, {}).filter((o) => o.op);
          if (!opts.length) break;
          const res = apply(f, opts[Math.floor(r() * opts.length)]!.op!, cat);
          if (res.ok) f = res.flow;
        }
        const broke = editProblems(start, f);
        if (broke.length) failures.push(`[${fx.workspace}] seed ${seed}: not additive: ${broke.join(" · ")}`);
        if (errorsOf(checkState(f, cat)).length) failures.push(`[${fx.workspace}] seed ${seed}: extension is invalid`);
        if (!f.holes.length) {
          try { await gate(f, fx, cat); extended++; } catch (e) { failures.push(`[${fx.workspace}] seed ${seed}: extension refused by the funnel: ${(e as Error).message}`); }
        }
      }
    }
    console.log(`saved ${saved} · operation reads stored ${opsStored} · extended to completion ${extended} · failures ${failures.length}`);
    expect(opsStored).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    expect(saved).toBeGreaterThan(50);
    expect(extended).toBeGreaterThan(0);
  }, 300_000);
});
