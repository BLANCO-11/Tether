/**
 * The pipeline → `expr` lowering at the write funnel (compiled-builder 2d). Pure: a hand-built catalogue, no database.
 */
import { describe, expect, it } from "vitest";
import { TypeOf as T, checkFlow, type CatalogueSnapshot } from "@foundry/flow-edit";
import { lowerPipelinesWith, PipelineError } from "./flow-pipeline.js";
import { validateGeneratedExpr } from "./flow-expression.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

const CAT: CatalogueSnapshot = {
  refs: {
    "fleet_demo.readings": {
      kind: "operation",
      params: [],
      payload: T.rows(T.record({ device_id: T.text(), temp_c: T.number(), owner: T.option(T.address()) })),
    },
  },
};
const model = (pipeline: unknown, inputs: FlowModel["inputs"] = []): FlowModel => ({
  id: "f",
  inputs,
  steps: [
    { id: "read", kind: "query", ref: "fleet_demo.readings", inputs: [] },
    { id: "hot", kind: "transform", from: "read", pipeline, dependsOn: ["read"] },
  ],
} as unknown as FlowModel);

describe("lowerPipelinesWith", () => {
  it("lowers a typed pipeline to the transform shape, declares its fields, and passes D-22", () => {
    const m = lowerPipelinesWith(model([
      { op: "filter", where: { cmp: "gt", left: { field: "temp_c" }, right: { input: "limit" } } },
      { op: "filter", where: { notNull: "owner" } },
      { op: "project", fields: [{ name: "to", from: "owner" }, { name: "device", from: "device_id" }] },
    ], [{ id: "limit", type: "FLOAT", required: true } as never]), CAT);
    const hot = m.steps[1] as { expr: string; fields: string[] };
    expect(hot.expr).toMatch(/^\{\{ .* \| jq\('.*' ~ \(inputs\.limit \| toJson\) ~ '.*'\) \| first \}\}$/);
    expect(hot.fields).toEqual(["to", "device"]);
    expect(validateGeneratedExpr(hot.expr, "hot.expr")).toEqual([]);
  });

  it("refuses an ill-typed pipeline by stage, and never lowers it", () => {
    expect(() => lowerPipelinesWith(model([
      { op: "filter", where: { notNull: "owner" } },
      { op: "template", as: "t", parts: [{ field: "temp" }] },
    ]), CAT)).toThrow(/stage 2 \(template\).*no field "temp"/);
  });

  it("refuses a pipeline that reads no step", () => {
    const m = model([{ op: "count", as: "n" }]);
    (m.steps[1] as unknown as { from: string }).from = "nope";
    expect(() => lowerPipelinesWith(m, CAT)).toThrow(PipelineError);
  });

  it("the checker types the pipeline's output exactly, so a downstream read of a missing field is caught", () => {
    const m = model([{ op: "project", fields: [{ name: "device", from: "device_id" }] }]);
    const diags = checkFlow(m as never, CAT);
    expect(diags.filter((d) => d.code === "FT0901")).toEqual([]);
    const bad = model([{ op: "project", fields: [{ name: "device", from: "nope" }] }]);
    expect(checkFlow(bad as never, CAT).map((d) => d.code)).toContain("FT0901");
  });
});

describe("the jq-text column scan defers to the pipeline's types", () => {
  it("does not read a field an earlier stage DERIVED as a missing column (I-276 shape)", async () => {
    const { checkRefOutputFields } = await import("./flow-ref-columns.js");
    const m = lowerPipelinesWith(model([
      { op: "derive", as: "band", expr: { case: [{ when: { cmp: "gt", left: { field: "temp_c" }, right: { lit: { value: 5, from: "test" } } }, then: { lit: { value: "hot", from: "test" } } }], else: { lit: { value: "ok", from: "test" } } } },
      { op: "join_text", as: "text", parts: [{ field: "band" }], sep: ",", empty: "-" },
    ]), CAT);
    expect(checkRefOutputFields(m, { "fleet_demo.readings": { columns: ["device_id", "temp_c", "owner"] } })).toEqual([]);
  });
  it("…while the pipeline's own typing still refuses a genuinely missing field", () => {
    expect(() => lowerPipelinesWith(model([{ op: "join_text", as: "text", parts: [{ field: "band" }], sep: ",", empty: "-" }]), CAT)).toThrow(/no field "band"/);
  });
});
