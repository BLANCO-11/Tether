/**
 * build:measure R07 (2026-09-24): a GENERATED reader's parameters must be the
 * ones its step binds. The proposer named `period_start`/`period_end`, the step
 * bound `period`, the call sent neither and the run settled SUCCESS on 0 rows.
 * Two halves: the check sees an inline reader's own declaration, and the
 * proposer is told — and held to — the names the step binds.
 */
import { describe, expect, it } from "vitest";
import { checkFlowParams } from "./flow-validator.service.js";
import { paramContractProblems } from "./db-query-proposal.service.js";

import type { FlowModel } from "./flow-compiler.service.js";

const r07 = (paramOrder: string[], bind = "period"): FlowModel =>
  ({
    id: "post_leave",
    inputs: [{ id: "period", type: "STRING", required: true, description: "A month, YYYY-MM." }],
    steps: [
      {
        id: "fetch",
        kind: "datasource",
        ref: "hr_demo.approved_leave_requests_starting_in_period",
        datasourceRef: "hr_demo",
        sql: "SELECT 1 WHERE $1 IS NOT NULL" + (paramOrder.length > 1 ? " AND $2 IS NOT NULL" : ""),
        sqlParamOrder: paramOrder,
        sqlParamsSchema: Object.fromEntries(paramOrder.map((n) => [n, { type: "string", required: true }])),
        inputs: [{ name: bind, source: { from: "input", inputId: "period" } }],
      },
    ],
  }) as unknown as FlowModel;

describe("checkFlowParams reads an inline reader's OWN declaration", () => {
  it("R07 exactly: refused, naming both halves", () => {
    const f = checkFlowParams(r07(["period_start", "period_end"]), {});
    expect(f.map((x) => x.rule).sort()).toEqual(["missing_required_param", "unknown_param"]);
    expect(f.find((x) => x.rule === "unknown_param")!.message).toContain("period_end (required), period_start (required)");
  });
  it("CONTROL: the matching binding passes, with no catalogue entry at all", () => {
    expect(checkFlowParams(r07(["period"]), {})).toEqual([]);
  });
  it("r8 S1: a reader needing a param, called with the blank [{}], is refused", () => {
    const m = r07(["opened_since"]);
    const st = m.steps[0] as { inputs?: unknown[]; paramsExpr?: string };
    st.inputs = [];
    st.paramsExpr = "[{}]";
    expect(checkFlowParams(m, {}).map((f) => f.rule)).toEqual(["missing_required_param"]);
  });
  it("CONTROL: the blank [{}] to a reader needing nothing passes", () => {
    const m = r07([]);
    const st = m.steps[0] as { inputs?: unknown[]; paramsExpr?: string; sql: string };
    st.inputs = [];
    st.paramsExpr = "[{}]";
    st.sql = "SELECT 1";
    expect(checkFlowParams(m, {})).toEqual([]);
  });
  it("the step's own sql wins over a catalogue entry of the same ref", () => {
    const ifaces = { "hr_demo.approved_leave_requests_starting_in_period": { params: [{ name: "period", required: true }] } };
    expect(checkFlowParams(r07(["period_start", "period_end"]), ifaces)).not.toEqual([]);
  });
});

describe("the proposer is held to the bound names", () => {
  it("R07's proposal is a finding naming what the step passes", () => {
    const p = paramContractProblems([{ name: "period" }], ["period_start", "period_end"]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/passes exactly "period"; your SQL asks for "period_end", "period_start"/);
  });
  it("an EXACT empty contract refuses an invented param, and passes none", () => {
    expect(paramContractProblems([], ["opened_since"], true)[0]).toMatch(/passes NO parameters.*"opened_since"/);
    expect(paramContractProblems([], [], true)).toEqual([]);
  });
  it("CONTROL: the same names in any order pass; no contract checks nothing", () => {
    expect(paramContractProblems([{ name: "a" }, { name: "b" }], ["b", "a"])).toEqual([]);
    expect(paramContractProblems([], ["anything"])).toEqual([]);
  });
});
