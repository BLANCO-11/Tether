/**
 * The property test, pure half (compiled-builder phase 3, task 4): random legal walks over synthetic catalogues; every reached
 * state must have ZERO checker errors, every listed move must apply, and the hole invariants must hold. The server half
 * (`legal-moves.property.test.ts`) adds the real save funnel and the deployment's catalogues.
 */
import { describe, expect, it } from "vitest";
import { checkState, emptyFlow, errorsOf } from "./model.js";
import { SYNTHETIC, syntheticCatalogue } from "./synthetic.js";
import { walk } from "./walk.js";
import { renderDiagnostic } from "../typecheck/diagnostic.js";

function run(seeds: number, cats: (i: number) => typeof SYNTHETIC) {
  const failures: string[] = [];
  let states = 0;
  for (let i = 0; i < seeds; i++) {
    const cat = cats(i);
    const len = 1 + (i % 30);
    let steps;
    try { steps = walk(emptyFlow("prop"), cat, len, 1000 + i); } catch (e) { failures.push((e as Error).message); continue; }
    for (const [k, st] of steps.entries()) {
      states++;
      const errs = errorsOf(checkState(st.flow, cat));
      if (errs.length) { failures.push(`seed ${1000 + i} step ${k} after ${JSON.stringify(st.op)}:\n${errs.map(renderDiagnostic).join("\n")}\nflow: ${JSON.stringify(st.flow).slice(0, 1500)}`); break; }
    }
  }
  return { failures, states };
}

describe("legal moves never reach an invalid state (P1), pure half", () => {
  it("the fixed synthetic catalogue", () => {
    const r = run(600, () => SYNTHETIC);
    expect(r.failures.slice(0, 3)).toEqual([]);
    expect(r.states).toBeGreaterThan(3000);
  }, 120_000);
  it("random synthetic catalogues", () => {
    const r = run(600, (i) => syntheticCatalogue(7 + i));
    expect(r.failures.slice(0, 3)).toEqual([]);
  }, 120_000);
});
