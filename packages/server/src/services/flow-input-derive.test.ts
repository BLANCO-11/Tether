/** Phase 2 task 8 (D-272): an input's type comes from what consumes it, not from the drafter. */
import { describe, expect, it } from "vitest";
import { deriveInputTypes } from "./flow-input-inherit.js";

const ifaces = {
  "fin.past_due": { params: [{ name: "due_before", type: "date" }, { name: "min_cents", type: "integer" }] },
  "fin.by_ts": { params: [{ name: "since", type: "string", format: "date-time" }] },
};
const flow = (inputs: unknown[], steps: unknown[]) => ({ id: "f", inputs, steps }) as never;
const read = (ref: string, binds: Record<string, string>) => ({
  id: `r_${ref.split(".")[1]}`, kind: "datasource", ref,
  inputs: Object.entries(binds).map(([name, inputId]) => ({ name, source: { from: "input", inputId } })),
});

describe("deriveInputTypes", () => {
  it("I1-style: as_of declared DATETIME, feeding a date parameter, becomes DATE", () => {
    const r = deriveInputTypes(flow([{ id: "as_of", type: "DATETIME" }], [read("fin.past_due", { due_before: "as_of" })]), ifaces, {}, { override: true });
    expect(r.model.inputs![0]!.type).toBe("DATE");
  });
  it("an integer parameter types its input INT; a code contract types its input too", () => {
    const code = { id: "calc", kind: "code", inputs: [{ name: "cut", source: { from: "input", inputId: "cut" } }] };
    const r = deriveInputTypes(
      flow([{ id: "min", type: "STRING" }, { id: "cut", type: "STRING" }], [read("fin.past_due", { min_cents: "min" }), code]),
      ifaces,
      { calc: { stepId: "calc", purpose: "p", input: [{ name: "cut", type: "string", format: "date" }], output: [] } },
      { override: true },
    );
    expect(r.model.inputs!.map((i) => i.type)).toEqual(["INT", "DATE"]);
  });
  it("CONTROL: override false leaves a non-STRING input for the checker to report", () => {
    const r = deriveInputTypes(flow([{ id: "as_of", type: "DATETIME" }], [read("fin.past_due", { due_before: "as_of" })]), ifaces, {}, { override: false });
    expect(r.changed).toEqual([]);
  });
  it("CONTROL: disagreeing consumers, an untyped consumer, and a defaults that would not parse are left alone", () => {
    const two = deriveInputTypes(flow([{ id: "d", type: "STRING" }], [read("fin.past_due", { due_before: "d" }), read("fin.by_ts", { since: "d" })]), ifaces, {}, { override: true });
    expect(two.changed).toEqual([]);
    const none = deriveInputTypes(flow([{ id: "d", type: "STRING" }], [read("fin.unknown", { x: "d" })]), ifaces, {}, { override: true });
    expect(none.changed).toEqual([]);
    const bad = deriveInputTypes(flow([{ id: "d", type: "STRING", defaults: "June" }], [read("fin.past_due", { due_before: "d" })]), ifaces, {}, { override: true });
    expect(bad.changed).toEqual([]);
  });
});

describe("deriveInputTypes — a month is a conversion of a DATE (D-272)", () => {
  const monthIfaces = { ...ifaces, "hr.summary": { params: [{ name: "period", type: "string", format: "month" }] } };
  it("R10-style: a STRING period feeding a month parameter becomes DATE + transform month on that binding", () => {
    const r = deriveInputTypes(flow([{ id: "period", type: "STRING" }], [read("hr.summary", { period: "period" })]), monthIfaces, {}, { override: true });
    expect(r.model.inputs![0]).toMatchObject({ id: "period", type: "DATE" });
    expect(r.model.inputs![0]).not.toHaveProperty("format");
    expect((r.model.steps[0] as { inputs: Array<{ source: unknown }> }).inputs[0]!.source).toEqual({ from: "input", inputId: "period", transform: "month" });
  });
  it("one DATE input feeding a date AND a month parameter: cut only where the month is needed", () => {
    const r = deriveInputTypes(flow([{ id: "d", type: "STRING" }], [read("fin.past_due", { due_before: "d" }), read("hr.summary", { period: "d" })]), monthIfaces, {}, { override: true });
    expect(r.model.inputs![0]!.type).toBe("DATE");
    const [a, b] = r.model.steps as Array<{ inputs: Array<{ source: { transform?: string } }> }>;
    expect(a!.inputs[0]!.source.transform).toBeUndefined();
    expect(b!.inputs[0]!.source.transform).toBe("month");
  });
  it("CONTROL: conservative mode writes no month tag and touches no binding (D-272)", () => {
    const r = deriveInputTypes(flow([{ id: "period", type: "STRING" }], [read("hr.summary", { period: "period" })]), monthIfaces, {}, { override: false });
    expect(r.model.inputs![0]).toEqual({ id: "period", type: "STRING" });
    expect((r.model.steps[0] as { inputs: Array<{ source: { transform?: string } }> }).inputs[0]!.source.transform).toBeUndefined();
  });
});

describe("a hand-written flow's STRING input takes its consumers' type (phase 7, regression net)", () => {
  const q = (paramsExpr: string) => ({ id: "overdue", kind: "query", ref: "fin.past_due", paramsExpr });
  it("reads a literal paramsExpr whose value is exactly {{ inputs.x }} — the seeds' form", () => {
    const r = deriveInputTypes(flow([{ id: "as_of", type: "STRING", defaults: "2026-06-30" }], [q('[{"due_before": "{{ inputs.as_of }}", "min_cents": 5}]')]), ifaces, {}, { override: false });
    expect(r.model.inputs![0]!.type).toBe("DATE");
  });
  it("CONTROL: a template that BUILDS a value from the input says nothing about its type", () => {
    const r = deriveInputTypes(flow([{ id: "period", type: "STRING" }], [q('[{"due_before": "{{ inputs.period }}-01"}]')]), ifaces, {}, { override: false });
    expect(r.changed).toEqual([]);
  });
  it("CONTROL: a default the new type would not parse keeps the declaration", () => {
    const r = deriveInputTypes(flow([{ id: "as_of", type: "STRING", defaults: "yesterday" }], [q('[{"due_before": "{{ inputs.as_of }}"}]')]), ifaces, {}, { override: false });
    expect(r.changed).toEqual([]);
  });
});

describe("writeRevision applies it, before the checker (a derivation nothing calls is I-120)", () => {
  it("calls deriveInputTypes with override:false, ahead of the save gate (blockingOf)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./flow.service.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function gateRevisionModel(")); // writeRevision's checks, since D-318
    expect(body.length).toBeGreaterThan(1000);
    const derive = body.indexOf("deriveInputTypes(model, interfaces, contracts, { override: false })");
    const check = body.indexOf("blockingOf(model, await g.catalogue(model))");
    expect(derive).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(derive);
  });
});
