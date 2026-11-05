/**
 * Spec match (phase 5 task 7, D-303): the compiled flow does what the confirmed spec says — derived from what RUNS (the lowered jq),
 * compared both ways. Built by the real solver and lowered by the real funnel function over the name-free synthetic catalogue.
 */
import { describe, expect, it } from "vitest";
import { emptyFlow, SYNTHETIC as cat, type CatalogueSnapshot } from "@foundry/flow-edit";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { solve } from "./solver.js";
import { lowerPipelinesWith } from "../flow-pipeline.js";
import { derivedFilters, fieldTyIn, specMatch } from "./spec-match.js";

const fieldsOf = (r: CatalogueSnapshot["refs"][string]) => (r.kind === "tool" ? [] : Object.keys((r.payload as { of: { fields: Record<string, unknown> } }).of.fields).map((name) => ({ name, ty: "" })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r) })) };
const W: Partial<GoalSpec> = { sources: [{ ref: "store.widgets", quote: "the widgets" }], sinks: [{ ref: "notify_me", quote: "send me" }], values: [{ role: "date", from: "goal", quote: "2026-06-30", fills: "store.widgets.as_of" }, { role: "recipient", from: "requester", quote: "me", fills: "notify_me.to" }] };
const GOAL = "send me the widgets as of 2026-06-30 in state open, heavier than 5kg";
const build = (s: Partial<GoalSpec>) => {
  const checked = checkSpec({ sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null, ...W, ...s }, [s.conditions?.length ? GOAL : "send me the widgets as of 2026-06-30"], ITEMS);
  const r = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] });
  expect(r.unmet).toEqual([]);
  return { model: lowerPipelinesWith(r.flow as never, cat) as never as Parameters<typeof specMatch>[0], stored: { goalSpec: { spec: checked.spec }, trace: { base: [] } } };
};
const CONDS: GoalSpec["conditions"] = [
  { quote: "in state open", by: "the_flow", field: "store.widgets.state", test: "equals", value: "open" },
  { quote: "heavier than 5kg", by: "the_flow", field: "store.widgets.weight", test: "above", value: "5kg" },
];

describe("spec match types a comparand as the solver does (2026-10-02, H07)", () => {
  it("an EQUALITY on a field declared a number compares with a number — the built `== 4` is the spec's “4”", () => {
    const goal = "send me the widgets as of 2026-06-30 with qty 4";
    const checked = checkSpec({ sources: [], sinks: [], values: [], conditions: [{ quote: "with qty 4", by: "the_flow", field: "store.widgets.qty", test: "equals", value: "4" }], schedule: null, missing: null, ...W }, [goal], ITEMS);
    const r = solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] });
    expect(r.unmet).toEqual([]);
    const model = lowerPipelinesWith(r.flow as never, cat) as never as Parameters<typeof specMatch>[0];
    const stored = { goalSpec: { spec: checked.spec }, trace: { base: [] } };
    expect(derivedFilters(model).map((f) => [f.field, f.op, f.value])).toContainEqual(["qty", "==", 4]);
    expect(specMatch(model, stored, undefined, fieldTyIn(cat.refs))).toEqual([]);
    // CONTROL: without the field's type the old rule reads “4” as text, and the same flow is refused — the type is what decides.
    expect(specMatch(model, stored).join(" ")).toMatch(/`qty` == "4"/);
  });
});

describe("spec match", () => {
  it("a flow built from the spec matches it — filters read from the lowered jq, not the pipeline", () => {
    const { model, stored } = build({ conditions: CONDS });
    expect(derivedFilters(model).map((f) => [f.field, f.op, f.value])).toEqual(expect.arrayContaining([["state", "==", "open"], ["weight", ">", 5]]));
    expect(specMatch(model, stored)).toEqual([]);
  });
  it("NEGATIVE CONTROL: a lowering that changes one operator is refused", () => {
    const { model, stored } = build({ conditions: CONDS });
    const perturbed = { ...model, steps: model.steps.map((s) => (s.kind === "transform" && s.expr ? { ...s, expr: s.expr.replace("(.weight > 5)", "(.weight >= 5)") } : s)) };
    expect(perturbed.steps.some((s) => s.expr?.includes(">= 5"))).toBe(true); // the perturbation happened
    const p = specMatch(perturbed, stored);
    expect(p).toContainEqual(expect.stringMatching(/`weight` > 5 .* no step of the flow applies that/));
    expect(p).toContainEqual(expect.stringMatching(/keeps rows where `weight` >= 5, which the spec does not ask for/));
  });
  it("an action the spec does not ask for is refused; so is a missing one", () => {
    const { model, stored } = build({});
    expect(specMatch(model, stored)).toEqual([]);
    const extra = { ...model, steps: [...model.steps, { id: "call_x", kind: "tool", ref: "ticket_open", inputs: [] }] };
    expect(specMatch(extra, stored)).toEqual([expect.stringMatching(/an? action step for ticket_open, which the spec does not ask for/)]);
    const none = { ...model, steps: model.steps.filter((s) => s.kind !== "tool") };
    expect(specMatch(none, stored)).toContainEqual(expect.stringMatching(/asks for the action notify_me/));
  });
  it("the schedule must be the spec's; an edit that says nothing of when keeps its own", () => {
    const { model, stored } = build({});
    expect(specMatch({ ...model, schedule: { cron: "0 9 * * *" } }, stored)).toEqual([expect.stringMatching(/the spec states no schedule/)]);
    expect(specMatch({ ...model, schedule: { cron: "0 9 * * *" } }, { ...stored, trace: { base: [{ kind: "datasource", ref: "store.widgets", id: "read_1" }] } })).toEqual([]);
  });
  it("no stored spec (every other writer): nothing to match", () => {
    expect(specMatch({ steps: [{ id: "x", kind: "tool", ref: "anything" }] }, { goalSpec: null })).toEqual([]);
  });
});


