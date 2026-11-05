import { describe, expect, it } from "vitest";
import { apply, type EngineOp } from "./ops.js";
import { emptyFlow, type EFlow } from "./model.js";
import { complete, sampleLiteral, walk, rng } from "./walk.js";
import { groupsOf, optionsOf } from "./options.js";
import { SYNTHETIC as cat } from "./synthetic.js";

describe("options (phase 4 task 2): legal moves as a closed enum", () => {
  it("every offered op applies, on states along random walks — one definition of legality", () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const steps = walk(emptyFlow("t"), cat, 1 + (seed % 14), seed);
      const states: EFlow[] = [emptyFlow("t"), ...steps.map((s) => s.flow), ...complete(steps.at(-1)?.flow ?? emptyFlow("t"), cat, seed).map((s) => s.flow)];
      for (const f of states) {
        const opts = optionsOf(f, cat, { inputRoles: ["period"], cron: "0 9 * * 1" });
        expect(new Set(opts.map((o) => o.id)).size).toBe(opts.length);
        for (const o of opts) {
          if (o.op) { const r = apply(f, o.op, cat); expect(r.ok, `${o.label}: ${r.ok ? "" : r.error}`).toBe(true); checked++; }
          else expect(o.literal).toBeTruthy();
        }
      }
    }
    expect(checked).toBeGreaterThan(1000); // CONTROL: the loop judged many options
  });
  it("never offers a removal (construction grows monotonically)", () => {
    const f = walk(emptyFlow("t"), cat, 12, 7).at(-1)!.flow;
    const ops = optionsOf(f, cat).map((o) => o.op?.op);
    expect(ops.some((x) => x === "remove_step" || x === "unbind" || x === "remove_input")).toBe(false);
  });
  it("a literal slot builds an op from a value, and an input is offered only for a role the goal asks each run", () => {
    const f = [{ op: "add_reader", id: "r", ref: "store.widgets" } as EngineOp].reduce((g, op) => (apply(g, op, cat) as { flow: EFlow }).flow, emptyFlow("t"));
    const lit = optionsOf(f, cat).find((o) => o.literal && o.group === "fill r.as_of")!;
    expect(apply(f, lit.literal!.make(sampleLiteral(lit.literal!.ty, cat, rng(3)).replace(/.*/, "2026-06-30"), "goal"), cat).ok).toBe(true);
    expect(optionsOf(f, cat).some((o) => o.op?.op === "declare_input")).toBe(false);
    expect(optionsOf(f, cat, { inputRoles: ["period"] }).filter((o) => o.op?.op === "declare_input").length).toBeGreaterThan(0);
    expect(optionsOf(f, cat).some((o) => o.op?.op === "set_schedule")).toBe(false);
  });
  it("groups partition the options", () => {
    const f = walk(emptyFlow("t"), cat, 10, 11).at(-1)!.flow;
    const opts = optionsOf(f, cat);
    expect(groupsOf(opts).reduce((a, g) => a + g.n, 0)).toBe(opts.length);
  });
});
