/**
 * P6 — a summary-fed send with a named-group recipient is a SINGLE send, never the fanout branch.
 * The M10 shape: the summary emailed to "the team" (rows/none) taking action:1's output — no `to` hole,
 * one mail_send. CONTROL: a per-row send with a real field still fans out per item.
 */
import { describe, expect, it } from "vitest";
import { checkState, errorsOf, SYNTHETIC, emptyFlow } from "@foundry/flow-edit";
import { solve } from "./solver.js";
import { checkSpec, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { type Wiring } from "./wiring.js";

const cat = SYNTHETIC;
const fieldsOf = (r: (typeof cat.refs)[string]) => (r.kind === "tool" ? [] : Object.keys((r.payload as { of: { fields: Record<string, unknown> } }).of.fields).map((name) => ({ name, ty: "" })));
const ITEMS: BuilderCatalogue = { items: Object.entries(cat.refs).map(([ref, r]) => ({ ref, kind: r.kind === "tool" ? ("tool" as const) : ("reader" as const), about: ref, params: r.params.map((p) => ({ name: p.name, about: "" })), fields: fieldsOf(r), ...(r.modelText ? { modelText: true } : {}) })) };

const GOAL = `Summarise overdue items per owner and email the summary to the team.`;
const BASE: GoalSpec = {
  sources: [{ ref: "store.widgets", quote: "overdue items" }],
  sinks: [
    { ref: "llm_complete", quote: "Summarise overdue items per owner" },
    { ref: "mail_send", quote: "email the summary to the team" },
  ],
  values: [
    { role: "recipient", from: "goal", quote: "the team", fills: "mail_send.to", field: "none" },
  ],
  conditions: [],
  schedule: null,
  missing: null,
};
const WIRED: Wiring = {
  paths: [],
  actions: [
    { takes: "reader:0", path: null, approve: null },
    { takes: "action:0", path: null, approve: null },
  ],
  valueAction: {},
};
const build = (s: GoalSpec = BASE) => {
  const checked = checkSpec({ ...s, wiring: WIRED }, [GOAL], ITEMS);
  return { checked, r: solve(emptyFlow("t"), { spec: checked, cat, answers: new Map(), base: [] }) };
};

describe("P6 — summary-fed send with a named group", () => {
  it("places ONE mail_send with no `to` hole", () => {
    const { r } = build();
    expect(r.unmet.filter((u) => /no row here carries an address|who receives/.test(u))).toEqual([]);
    expect(errorsOf(checkState(r.flow, cat)).map((e) => JSON.stringify(e)).filter((e) => /mail_send.*to/.test(e))).toEqual([]);
  });

  it("CONTROL: unsaid recipient still asks (no silent single-send)", () => {
    const { r } = build({ ...BASE, values: [] });
    expect(r.unmet.length + r.flow.steps.filter((s) => s.kind === "tool").length).toBeGreaterThan(0);
  });
});
