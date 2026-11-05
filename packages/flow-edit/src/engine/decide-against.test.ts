/** A Decide may compare two fields of the same subject ("its spend is more than its budget", 2026-10-01) — units by declaration. */
import { describe, expect, it } from "vitest";
import { checkState, emptyFlow, errorsOf, type EFlow } from "./model.js";
import { apply, type EngineOp } from "./ops.js";
import { decideOps, personNumber } from "./value-tests.js";
import { SYNTHETIC } from "./synthetic.js";
import { T } from "../typecheck/types.js";
import type { CatalogueSnapshot } from "../typecheck/signature.js";

const cat: CatalogueSnapshot = { ...SYNTHETIC, refs: { ...SYNTHETIC.refs,
  "store.centres": { kind: "operation", params: [], payload: T.rows(T.record({ name: T.text(), spend: T.minor(T.int()), spent: T.number(), budget: T.number(), cap: T.option(T.number()) })) },
} };
const run = (ops: EngineOp[], start: EFlow): EFlow => ops.reduce((f, op) => { const r = apply(f, op, cat); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, start);
const base = run([{ op: "add_reader", id: "read", ref: "store.centres" }], emptyFlow("t"));
const pipe = (f: EFlow, id: string) => (f.steps.find((s) => s.id === id) as { pipeline: unknown[] }).pipeline;

describe("decideOps `against` — a field compared with another field of the same rows", () => {
  it("like units compare directly, and the flow checks clean", () => {
    const d = decideOps(base, cat, { subject: "read", measure: "spent", cmp: "gt", value: "its budget", from: "goal", against: "budget" });
    if (typeof d === "string") throw new Error(d);
    const f = run(d.ops, base);
    expect(errorsOf(checkState(f, cat))).toEqual([]);
    expect(pipe(f, d.test)).toEqual([{ op: "filter", where: { cmp: "gt", left: { field: "spent" }, right: { field: "budget" } } }]);
  });
  it("an amount declared in MINOR units is converted before it is compared with one that is not", () => {
    const d = decideOps(base, cat, { subject: "read", measure: "spend", cmp: "gt", value: "its budget", from: "goal", against: "budget" });
    if (typeof d === "string") throw new Error(d);
    const f = run(d.ops, base);
    expect(errorsOf(checkState(f, cat))).toEqual([]);
    expect(pipe(f, d.test)).toEqual([{ op: "convert", field: "spend", as: "spend_whole", to: "minor_to_major" }, { op: "filter", where: { cmp: "gt", left: { field: "spend_whole" }, right: { field: "budget" } } }]);
  });
  it("a field that may be empty is guarded — empty does not hold", () => {
    const d = decideOps(base, cat, { subject: "read", measure: "spent", cmp: "gt", value: "its cap", from: "goal", against: "cap" });
    if (typeof d === "string") throw new Error(d);
    expect(pipe(run(d.ops, base), d.test)).toEqual([{ op: "filter", where: { and: [{ notNull: "cap" }, { cmp: "gt", left: { field: "spent" }, right: { field: "cap" } }] } }]);
  });
  it("CONTROL: a field that is not there, or of another kind, is refused by name; without `against` the value is a literal", () => {
    expect(decideOps(base, cat, { subject: "read", measure: "spent", cmp: "gt", value: "x", from: "goal", against: "nope" })).toMatch(/no field `nope`/);
    expect(decideOps(base, cat, { subject: "read", measure: "spent", cmp: "gt", value: "x", from: "goal", against: "name" })).toMatch(/not the same kind of value/);
    expect(decideOps(base, cat, { subject: "read", measure: "spent", cmp: "gt", value: "its budget", from: "goal" })).toEqual(expect.stringMatching(/./));
  });
});

describe("a person's number against an amount declared in MINOR units (the units trap, 2026-10-02)", () => {
  it("“over 10000” on a cents amount compares 1,000,000 cents — and shows the person 10000 again", async () => {
    const { splitOps } = await import("./value-tests.js");
    const d = decideOps(base, cat, { subject: "read", measure: "spend", cmp: "gt", value: "10000", from: "goal", quote: "over 10000" });
    if (typeof d === "string") throw new Error(d);
    const f = run(d.ops, base);
    expect(errorsOf(checkState(f, cat))).toEqual([]);
    expect(pipe(f, d.test)).toEqual([{ op: "filter", where: { cmp: "gt", left: { field: "spend" }, right: { lit: { value: 1000000, from: "goal", quote: "over 10000" } } } }]);
    expect(personNumber(T.minor(T.int()), 1000000)).toBe("10000");
    const s = splitOps(base, cat, { subject: "read", field: "spend", cmp: "gt", value: "10000", from: "goal" });
    if (typeof s === "string") throw new Error(s);
    expect(JSON.stringify(s.ops)).toContain('"value":1000000');
  });
  it("CONTROL: a number that is not in minor units is compared as said", () => {
    const d = decideOps(base, cat, { subject: "read", measure: "spent", cmp: "gt", value: "10000", from: "goal" });
    if (typeof d === "string") throw new Error(d);
    expect(JSON.stringify(pipe(run(d.ops, base), d.test))).toContain('"value":10000,');
    expect(personNumber(T.number(), 10000)).toBe("10000");
  });
});
