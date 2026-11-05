/** D-273: a nullable field feeding a required one must say what a null does. */
import { describe, expect, it } from "vitest";
import { buildFanOutParams, buildCodeInput } from "./render.js";
import { checkFlow, TypeOf as T, type CatalogueSnapshot, type CheckModel } from "./typecheck/index.js";

const shapes = { datasource: { template: "json(outputs.<id>.body)", describes: null, caution: null } } as never;
const read = { kind: "datasource", id: "read", ref: "d.rows", paramsExpr: "[{}]" } as never;

describe("rendering onNull", () => {
  it("fan-out: skip drops the row before the call is built", () => {
    const p = buildFanOutParams(shapes, read, [{ param: "to", source: { from: "step", stepId: "read", field: "email", onNull: "skip" } }]);
    expect(p).toContain("select(.email != null) | {");
  });
  it("code payload over whole rows: skip filters the named fields", () => {
    const c = buildCodeInput(shapes, [{ name: "rows", source: { kind: "step", step: read, field: "", onNull: { vendor_email: "skip", note: "fail" } } }]);
    expect(c).toContain("select(.vendor_email != null)");
    expect(c).not.toContain(".note != null"); // fail does not filter
  });
  it("CONTROL: no rule renders as before", () => {
    const p = buildFanOutParams(shapes, read, [{ param: "to", source: { from: "step", stepId: "read", field: "email" } }]);
    expect(p).not.toContain("!= null");
  });
});

const CAT: CatalogueSnapshot = {
  refs: {
    "d.rows": { kind: "operation", params: [], payload: T.rows(T.record({ email: T.option(T.address()) })) },
    send: { kind: "tool", params: [{ name: "to", ty: T.address(), required: true }], payload: T.opaque() },
  },
};
const model = (onNull?: string): CheckModel =>
  ({
    id: "m",
    steps: [
      { id: "read", kind: "datasource", ref: "d.rows", inputs: [] },
      { id: "s", kind: "tool", ref: "send", dependsOn: ["read"], over: { stepId: "read", field: "" }, inputs: [{ name: "to", source: { from: "step", stepId: "read", field: "email", ...(onNull ? { onNull } : {}) } }] },
    ],
  }) as never;
const codes = (m: CheckModel) => checkFlow(m, CAT).filter((d) => d.severity === "error").map((d) => d.code);

describe("checking onNull", () => {
  it("a nullable field into a required port with NO rule is FT0203", () => {
    expect(codes(model())).toContain("FT0203");
  });
  it("skip or fail resolves it", () => {
    expect(codes(model("skip"))).toEqual([]);
    expect(codes(model("fail"))).toEqual([]);
  });
});
