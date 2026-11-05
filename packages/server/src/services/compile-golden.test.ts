/**
 * The compile golden (phase C, C0 — 2026-09-29): a fixed, seeded set of COMPLETE engine flows over the deployment's catalogues,
 * each put through the save funnel (lowering + `flowCompiler.compile`), and the hash of its YAML pinned.
 *
 * Why it exists: phase C adds value conditions and a split, and phase F a loop — and both promise that EVERY flow the engine can
 * already build compiles byte-identically afterwards. The deployment holds too few saved revisions to stand for that (9 on
 * 2026-09-29), so this pins what the engine's own walks build: branches, otherwise, elif, merges, fan-out, transforms, gates.
 *
 * A diff here is not a failure to paper over: it means an existing flow now compiles to different YAML — i.e. the next deploy of an
 * ARMED flow would change what its schedule runs. Regenerate (`UPDATE_GOLDEN=1`) only when that change is the intent, and say so.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { complete, emptyFlow, holesOf, checkState, walk, type CatalogueSnapshot, type EFlow } from "@foundry/flow-edit";
import { compilerRenderInputs } from "./flow-typecheck.js";
import { gateRevisionModel } from "./flow.service.js";
import type { FlowModel } from "./flow-compiler.service.js";
import { namespaceFor } from "./kestra-client.service.js";
import type { RefInterface } from "./manifest-builder.service.js";

/** The deployment's catalogues, as the property test reads them — read here directly so that file's walks do not run with this one. */
const CATALOGUES: Array<{ workspace: string; cat: CatalogueSnapshot; ifaces: Record<string, RefInterface> }> =
  JSON.parse(readFileSync(new URL("./__fixtures__/engine-catalogues.json", import.meta.url), "utf8"));

const FILE = new URL("./__fixtures__/compile-golden.json", import.meta.url);
const WALKS = 300;
const SEED0 = 90_000;

type Golden = Record<string, { flow: EFlow; hash: string }>;

async function compileHash(f: EFlow, fx: (typeof CATALOGUES)[number]): Promise<string> {
  const cat: CatalogueSnapshot = { ...fx.cat, renderInputs: compilerRenderInputs };
  try {
    const { compiled } = await gateRevisionModel(structuredClone(f) as unknown as FlowModel, {
      catalogue: async () => cat, refNames: Object.keys(fx.ifaces), interfaces: fx.ifaces, allowedModels: [], contracts: {},
      compile: { namespace: namespaceFor("golden", "ws", "draft"), withSchedule: false, labels: {} },
    });
    return compiled.hash;
  } catch (e) {
    return `REFUSED ${(e as Error).message.slice(0, 120)}`;
  }
}

/** The corpus: seeded walks, stored as FLOWS — so a later change to what the engine offers cannot change what is compared. */
async function corpus(): Promise<Golden> {
  const out: Golden = {};
  for (let i = 0; i < WALKS; i++) {
    const fx = CATALOGUES[i % CATALOGUES.length]!;
    const cat: CatalogueSnapshot = { ...fx.cat, renderInputs: compilerRenderInputs };
    const seed = SEED0 + i;
    const steps = walk(emptyFlow("golden"), cat, 1 + (i % 30), seed);
    const last: EFlow = complete(steps.at(-1)?.flow ?? emptyFlow("golden"), cat, seed).at(-1)?.flow ?? steps.at(-1)?.flow ?? emptyFlow("golden");
    if (!last.steps.length || holesOf(checkState(last, cat)).length) continue;
    out[`${fx.workspace}#${seed}`] = { flow: last, hash: await compileHash(last, fx) };
  }
  return out;
}

const kinds = (f: EFlow): string[] => f.steps.map((x) => x.kind === "branch" ? (x.elseOf ? (x.conditions?.length ? "elif" : "else") : "if") : x.kind);

describe("the compile golden — every flow the engine builds today compiles byte-identically", () => {
  it(`${WALKS} seeded walks, stored: every flow compiles to the YAML it did`, async () => {
    if (process.env.UPDATE_GOLDEN || !existsSync(FILE)) { writeFileSync(FILE, JSON.stringify(await corpus()) + "\n"); return; }
    const pinned = JSON.parse(readFileSync(FILE, "utf8")) as Golden;
    const entries = Object.entries(pinned);
    // CONTROL: the golden covers real flows, not an empty set that passes for ever — and the constructs later phases touch.
    expect(entries.filter(([, g]) => g.hash.startsWith("sha256:")).length).toBeGreaterThan(100);
    for (const k of ["if", "elif", "else", "merge", "transform", "tool"]) expect(entries.some(([, g]) => kinds(g.flow).includes(k)), `no golden flow has a ${k}`).toBe(true);
    const changed: string[] = [];
    for (const [key, g] of entries) {
      const fx = CATALOGUES.find((c) => c.workspace === key.slice(0, key.lastIndexOf("#")))!;
      if ((await compileHash(g.flow, fx)) !== g.hash) changed.push(key);
    }
    expect(changed, `flows whose compiled YAML changed: ${changed.slice(0, 10).join(", ")}`).toEqual([]);
  }, 300_000);
});
