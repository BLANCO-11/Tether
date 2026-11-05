/**
 * **The three places that ask "does this step name something in the manifest?"
 * must give the same answer.**
 *
 * They did not, and the cost was measured on the running deployment:
 * `checkFlowRefs` exempted a step-local read (a step carrying its own `sql` +
 * `datasourceRef`), while `flowCompiler.refsOf` and `flowService.writeRevision`
 * tested the step KIND alone. So such a flow saved cleanly, test-ran cleanly,
 * and then `flowApprovalService.approve` refused it — *"references 1 thing(s)
 * this workspace no longer has"* — because `refsOf` handed it a ref
 * `refFingerprints()` has no key for. **5 of 11 flows were unpublishable, and a
 * flow carrying a cron was therefore unschedulable, publishing being the only
 * path that deploys a Kestra Schedule.**
 *
 * Every assertion below carries its control, because the failure mode of a
 * disagreement test is that both sides agree on nothing.
 */
import { describe, expect, it } from "vitest";
import { namesManifestRef } from "./sql-projection.js";
import { flowCompiler, type FlowModel } from "./flow-compiler.service.js";
import { checkFlowRefs } from "./flow-validator.service.js";

const localRead = {
  id: "read_partners",
  kind: "query" as const,
  ref: "ML_ZERO_DB.partners",
  paramsExpr: "[{}]",
  sql: "SELECT id, email FROM partners",
  datasourceRef: "ML_ZERO_DB",
};
const registeredRead = {
  id: "read_invoices",
  kind: "datasource" as const,
  ref: "finance_demo.invoices_overdue",
  paramsExpr: "[{}]",
};
const model = (steps: unknown[]) => ({ id: "f", steps } as unknown as FlowModel);

describe("namesManifestRef", () => {
  it("a step-local read names nothing in the manifest", () => {
    expect(namesManifestRef(localRead)).toBe(false);
  });

  it("CONTROL: the same step without its SQL does", () => {
    const { sql: _s, datasourceRef: _d, ...bare } = localRead;
    expect(namesManifestRef(bare)).toBe(true);
  });

  it("⚠ needs BOTH keys — half the shape is still a manifest ref", () => {
    const { datasourceRef: _d, ...halfA } = localRead;
    const { sql: _s, ...halfB } = localRead;
    expect(namesManifestRef(halfA)).toBe(true);
    expect(namesManifestRef(halfB)).toBe(true);
  });

  it("a non-calling kind never names one", () => {
    expect(namesManifestRef({ kind: "transform" })).toBe(false);
    expect(namesManifestRef({ kind: "code" })).toBe(false);
  });
});

describe("refsOf agrees with checkFlowRefs — the publish defect", () => {
  it("⚠ a step-local read contributes NO ref, so publishing has nothing to call missing", () => {
    expect(flowCompiler.refsOf(model([localRead]))).toEqual([]);
    // The same model, through the validator, with an empty manifest.
    expect(checkFlowRefs(model([localRead]), [])).toEqual([]);
  });

  it("CONTROL: a registered read contributes its ref to BOTH", () => {
    expect(flowCompiler.refsOf(model([registeredRead]))).toEqual([registeredRead.ref]);
    expect(checkFlowRefs(model([registeredRead]), []).map((f) => f.rule)).toEqual(["unknown_ref"]);
    expect(checkFlowRefs(model([registeredRead]), [registeredRead.ref])).toEqual([]);
  });

  it("a mixed flow contributes only the registered half", () => {
    const m = model([localRead, registeredRead]);
    expect(flowCompiler.refsOf(m)).toEqual([registeredRead.ref]);
    expect(checkFlowRefs(m, [registeredRead.ref])).toEqual([]);
  });

  /**
   * The property stated as the two sides of one equation: for every step, the
   * validator demands a registration exactly when the compiler contributes a
   * ref. A future kind added to one filter and not the other turns this red.
   */
  it("⚠ for every step shape, refs contributed == registrations demanded", () => {
    const shapes = [
      localRead,
      registeredRead,
      { ...localRead, id: "half", datasourceRef: undefined },
      { id: "t", kind: "transform", expr: "[.[]]" },
      { id: "c", kind: "code", inputExpr: "[]", outputKeys: ["x"] },
    ];
    for (const step of shapes) {
      const m = model([step]);
      const contributed = flowCompiler.refsOf(m).length;
      const demanded = checkFlowRefs(m, []).filter((f) => f.rule === "unknown_ref").length;
      expect({ id: (step as { id: string }).id, contributed }).toEqual({
        id: (step as { id: string }).id,
        contributed: demanded,
      });
    }
  });
});
