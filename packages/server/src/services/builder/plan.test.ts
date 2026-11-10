/**
 * The one-plan prototype's code half (P1-D13): clauses by code, equivalent plans normalised to one form, coverage checked exactly.
 * The model half is measured, not tested (phase-1 EVIDENCE "one plan").
 */
import type { COND_TESTS } from "./goal-spec.js";
import { describe, expect, it } from "vitest";
import { addressed, clauses, makePlan, normalisePlan, planFindings, planSchema, planToSpec, type Plan } from "./plan.js";
import { enumCount, ENUM_BUDGET, schemaProblem } from "./strict-schema.js";
import { cannotReasons, checkSpec, NONE_FIT } from "./goal-spec.js";
import type { BuilderCatalogue } from "./goal-spec.js";

const CAT: BuilderCatalogue = { items: [
  { ref: "ds.items", kind: "reader", about: "items", fields: [{ name: "amount", ty: "number" }, { name: "due", ty: "date" }, { name: "level", ty: "text", values: ["high", "low"] }] },
  { ref: "tether_email_send", kind: "tool", about: "email", params: [{ name: "to", about: "" }] },
  { ref: "chat_post_message", kind: "tool", about: "post", params: [{ name: "text", about: "" }] },
  { ref: "chat_list_channels", kind: "tool", about: "list", lookup: true },
] };
const GOAL = "for each overdue item: if the amount is over 100 email a@b.example, otherwise post it";
const CS = clauses(GOAL);

const email = (on: Plan["actions"][number]["on"], extra: Partial<Plan["actions"][number]> = {}): Plan["actions"][number] =>
  ({ ref: "tether_email_send", clauses: ["C2"], on, per_item: true, approve_first: null, heading: "", message: "", recipient: { from: "goal", words: "a@b.example" }, ...extra });
const post = (on: Plan["actions"][number]["on"]): Plan["actions"][number] =>
  ({ ref: "chat_post_message", clauses: ["C3"], on, per_item: true, approve_first: null, recipient: { from: "not_a_message", words: "" } });
const base = (p: Partial<Plan>): Plan => ({ sources: [{ ref: "ds.items", clauses: ["C1"], also: [] }], each: { over: 0, clauses: ["C1"] }, rows: [], schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [], ...p });
const t = (field: string, test: (typeof COND_TESTS)[number], value = "") => ({ field: `ds.items.${field}`, about: "", test, value });

describe("clauses, by code", () => {
  it("splits at the goal's own openers and phrase punctuation, and keeps an address or a decimal whole", () => {
    expect(CS.map((c) => c.text)).toEqual(["for each overdue item", "if the amount is over 100 email a@b.example", "otherwise post it"]);
    expect(clauses("if x is 9.5 then stop").map((c) => c.text)).toEqual(["if x is 9.5", "then stop"]);
    expect(clauses("check it. then post")).toHaveLength(2); // CONTROL: a stop before a space does end a clause
  });
  it("a lone joiner between clauses is dropped and ids renumber (S4: no bare 'and' clause)", () => {
    expect(clauses("For each overdue loan email the borrower, and if the fine is over 250 escalate").map((c) => c.text)).toEqual([
      "For each overdue loan email the borrower",
      "if the fine is over 250 escalate",
    ]);
    expect(clauses("Email the team a summary and archive it").map((c) => c.id)).toEqual(["C1"]);
  });
});

describe("the plan's schema", () => {
  it("is in the strict subset, offers no lookup as an action, and lists fields once", () => {
    const s = planSchema(CAT, CS);
    expect(schemaProblem(s)).toBeNull();
    expect(JSON.stringify(s)).not.toContain("chat_list_channels");
    expect(enumCount(s)).toBeLessThan(ENUM_BUDGET);
    expect(JSON.stringify(s).match(/ds\.items\.amount/g)).toHaveLength(1); // one $defs list, referenced
  });
  it("CONTROL: a $ref carrying another keyword is refused before sending (Azure 400)", () => {
    expect(schemaProblem({ type: "object", properties: { f: { $ref: "#/$defs/x", description: "d" } }, required: ["f"], additionalProperties: false, $defs: { x: { type: "string" } } })).toMatch(/cannot carry other keywords/);
  });
  it("a recipient applies only to a tool whose declaration has an address port", () => {
    expect(addressed(CAT, "tether_email_send")).toBe(true);
    expect(addressed(CAT, "chat_post_message")).toBe(false);
  });
});

describe("normalisePlan: equivalent plans read the same", () => {
  it("CONTROL: with nothing folded there are no otherwise words — and the goal's \"otherwise\" stays its action's", () => {
    expect(normalisePlan(base({ conditions: [{ clauses: ["C2"], over: "each_item", where: [t("amount", "above", "100")], count: null }], actions: [email("if:0"), post("otherwise")] })).otherwise_said).toBeUndefined();
  });
  it("CONTROL: one condition's own test never leaves it — the other items still run the otherwise", () => {
    const one = normalisePlan(base({ conditions: [{ clauses: ["C2"], over: "each_item", where: [t("amount", "above", "100")], count: null }], actions: [email("if:0"), post("otherwise")] }));
    expect(one.conditions[0]!.where).toHaveLength(1);
    expect(one.rows).toHaveLength(0);
  });
});

describe("the causes of F05's and S02's variance (2026-10-02)", () => {
  const one = (p: Partial<Plan> = {}) => base({ conditions: [{ clauses: ["C2"], over: "each_item", where: [t("amount", "above", "100")], count: null }], actions: [email("if:0"), post("otherwise")], ...p });
  it("CONTROL: an “else if” clause's condition is its own — never dropped", () => {
    const cs = clauses("if the amount is over 100 email a@b.example, else if it is over 50 post it");
    const p = base({ each: null, conditions: [{ clauses: ["C1"], over: "any_row", where: [t("amount", "above", "100")], count: null }, { clauses: ["C2"], over: "any_row", where: [], count: null }], actions: [email("if:0", { per_item: false }), { ...post("otherwise"), per_item: false }] });
    expect(normalisePlan(p).conditions).toHaveLength(2);
  });
  it("an EDIT: rows the automation already reads are its existing list — filtered, never read again; an action may run on an existing path", () => {
    const edit = { current: ["reads ds.items"], existing: { lists: [{ key: "step:read_1" as const, words: "the items", ref: "ds.items" }], producers: [], paths: [{ key: "in:check_1" as const, words: "when any is late" }] } };
    const cs = clauses("only the ones over 100, and when any is late also email a@b.example");
    const p = base({ sources: [{ ref: "ds.items", clauses: ["C1"], list: "step:read_1" }], each: null, rows: [{ ...t("amount", "above", "100"), field: "ds.items.amount", clauses: ["C1"] }], actions: [{ ref: "tether_email_send", quote: "email a@b.example", clauses: ["C2"], on: "in:check_1", per_item: false, approve_first: null, heading: "Late items", message: "", recipient: { from: "goal", words: "a@b.example" } }] });
    const { spec } = planToSpec(p, cs, CAT, "only the ones over 100, and when any is late also email a@b.example", edit);
    expect(spec.sources).toEqual([]); // CONTROL of the edit: the existing step is not read a second time
    expect(spec.shapes?.[0]).toMatchObject({ over: "ds.items", stages: [{ field: "ds.items.amount", test: "above", value: "100" }] });
    expect(spec.wiring?.paths).toEqual([expect.objectContaining({ subject: "in:check_1" })]);
    expect(spec.wiring?.actions[0]).toMatchObject({ path: 0 });
    expect(JSON.stringify(planSchema(CAT, cs))).not.toMatch(/step:read_1|changes_existing/); // a new goal's schema is unchanged
    // An action on a NEW condition over an existing list acts on the condition's rows, never the whole list it names.
    const onCond = base({ sources: [{ ref: "ds.items", clauses: ["C1"], list: "step:read_1" }], each: null, conditions: [{ quote: "", clauses: ["C1"], over: "any_row", where: [{ ...t("amount", "above", "100"), field: "ds.items.amount" }], count: null }], actions: [{ ref: "tether_email_send", quote: "email a@b.example", clauses: ["C2"], on: "if:0", takes: "step:read_1", per_item: false, approve_first: null, heading: "x", message: "", recipient: { from: "goal", words: "a@b.example" } }] });
    const lowered = planToSpec(onCond, cs, CAT, "only the ones over 100, and when any is late also email a@b.example", edit).spec;
    expect(lowered.wiring?.actions[0]!.takes).toBe(lowered.wiring?.paths[0]!.subject);
    expect(lowered.wiring?.paths[0]!.subject).not.toBe("step:read_1");
    expect(JSON.stringify(planSchema(CAT, cs, edit))).toMatch(/step:read_1.*in:check_1|in:check_1.*step:read_1/);
  });
  it("a value never fills who receives, nor a port only a step's output fills — by declaration", () => {
    const cat: BuilderCatalogue = { items: [...CAT.items.map((i) => (i.ref === "tether_email_send" ? { ...i, params: [{ name: "to", about: "" }, { name: "subject", about: "" }, { name: "attach_rows", about: "", fromStep: true }] } : i))] };
    const fills = JSON.stringify(planSchema(cat, clauses(GOAL)));
    expect(fills).not.toMatch(/"tether_email_send\.to"|"tether_email_send\.attach_rows"/);
    expect(fills).toMatch(/"tether_email_send\.subject"/); // CONTROL: an ordinary input is still offered
  });
  it("each action's recipient belongs to THAT action, whatever words its quote holds (F05)", () => {
    const cs = clauses(GOAL);
    const p = one({ actions: [email("if:0", { quote: "email the customer a reminder", recipient: { from: "goal", words: "a@b.example" } }), email("otherwise", { quote: "email it straight away", recipient: { from: "goal", words: "a@b.example" } })] });
    const { spec } = planToSpec(p, cs, CAT, GOAL);
    const rec = spec.values.map((v, i) => [v, i] as const).filter(([v]) => v.role === "recipient").map(([, i]) => spec.wiring?.valueAction?.[i]);
    expect(rec).toEqual([0, 1]);
    // The F05 shape, through the spec check: the same words ("the customer") for both, held by the FIRST action's quote only.
    const g = "for each overdue item: if the amount is over 100 email the customer a reminder, otherwise email it straight away";
    const cs2 = clauses(g);
    const p2 = one({ actions: [email("if:0", { quote: "email the customer a reminder", recipient: { from: "rows", words: "the customer" } }), email("otherwise", { quote: "email it straight away", recipient: { from: "rows", words: "the customer" } })] });
    const checked = checkSpec(planToSpec(p2, cs2, CAT, g).spec, [g], CAT);
    const owners = checked.spec.values.map((v, i) => [v, i] as const).filter(([v]) => v.role === "recipient").map(([, i]) => checked.spec.wiring?.valueAction?.[i]);
    expect(owners.sort()).toEqual([0, 1]);
  });

});

describe("planFindings: coverage, exactly", () => {
  it("a whole plan has none", () => {
    const p = base({ conditions: [{ clauses: ["C2"], over: "each_item", where: [t("amount", "above", "100")], count: null }], actions: [email("if:0"), post("otherwise")] });
    expect(planFindings(p, CS, CAT)).toEqual([]);
  });
  it("names each defect: a clause nothing implements, a condition guarding nothing, an unknown field, a value not in the goal", () => {
    const p: Plan = base({ conditions: [{ clauses: ["C2"], over: "each_item", where: [t("amount", "above", "1000")], count: null }, { clauses: [], over: "each_item", where: [{ ...t("x", "is_true") }], count: null }], actions: [email("if:0", { clauses: [] })] });
    const f = planFindings(p, CS, CAT).join("\n");
    expect(f).toMatch(/C3 .* is implemented by nothing/);
    expect(f).toMatch(/condition 1 .* guards no action/);
    expect(f).toMatch(/“1000” is not in the goal's words/);
  });
});

describe("planToSpec: the plan as the spec and wiring the solver builds from", () => {
  const goal = "for each overdue item: if the amount is over 100 ask me to approve before emailing the customer, otherwise email them straight away";
  const cs = clauses(goal);
  const plan: Plan = base({
    sources: [{ ref: "ds.items", quote: "overdue item", clauses: ["C1"] }],
    each: { over: 0, quote: "for each overdue item", clauses: ["C1"] },
    rows: [{ clauses: ["C1"], ...t("due", "date_passed") }],
    conditions: [{ quote: "if the amount is over 100", clauses: ["C2"], over: "each_item", where: [t("amount", "above", "100")], count: null }],
    actions: [
      { ref: "tether_email_send", quote: "emailing the customer", clauses: ["C3"], on: "if:0", per_item: true, approve_first: { quote: "ask me to approve", clauses: ["C2"] }, recipient: { from: "rows", words: "the customer" } },
      { ref: "tether_email_send", quote: "email them straight away", clauses: ["C4"], on: "otherwise", per_item: true, approve_first: null, recipient: { from: "rows", words: "the customer" } },
    ],
  });
  const { spec } = planToSpec(plan, cs, CAT, goal);
  it("the rows at all are a filter shape the loop runs over; each item's test is the loop's own condition", () => {
    expect(spec.shapes).toEqual([{ over: "ds.items", stages: [expect.objectContaining({ op: "filter", field: "ds.items.due", test: "date_passed" })] }]);
    expect(spec.wiring?.each).toEqual({ quote: "for each overdue item", over: "list:0" });
    expect(spec.wiring?.paths).toEqual([{ quote: "if the amount is over 100", subject: "item", test: "compare", measure: "amount", cmp: "gt", value: "100", where: [{ field: "amount", test: "above", value: "100" }] }]);
  });
  it("every action runs where the plan put it, per item, with its approval — and the customer is the rows' people", () => {
    expect(spec.wiring?.actions).toEqual([
      { takes: "item", path: 0, approve: "ask me to approve", per: "item" },
      { takes: "item", path: "otherwise", approve: null, per: "item" },
    ]);
    expect(spec.values.filter((v) => v.role === "recipient").map((v) => [v.quote, v.fills])).toEqual([["the customer", "tether_email_send.to"], ["the customer", "tether_email_send.to"]]);
    expect(spec.sinks.map((x) => x.quote)).toEqual(["emailing the customer", "email them straight away"]);
  });
  it("a part's quote that is not the person's words falls back to its clause's own text", () => {
    const off = planToSpec({ ...plan, sources: [{ ref: "ds.items", quote: "invented words", clauses: ["C1"] }] }, cs, CAT, goal).spec;
    expect(off.sources[0]!.quote).toBe("for each overdue item");
  });
  it("whether any row holds: the tested rows are their own list, and the otherwise takes nothing", () => {
    const g = "if any item is high post it, otherwise email a@b.example";
    const p2: Plan = base({ each: null, conditions: [{ quote: "if any item is high", clauses: ["C1"], over: "any_row", where: [t("level", "equals", "high")], count: null }],
      actions: [{ ...post("if:0"), per_item: false }, { ...email("otherwise"), per_item: false, recipient: { from: "goal", words: "a@b.example" } }] });
    const sp = planToSpec(p2, clauses(g), CAT, g).spec;
    expect(sp.wiring?.paths).toEqual([{ quote: "if any item is high", subject: "list:0", test: "any" }]);
    expect(sp.wiring?.actions.map((a) => a.takes)).toEqual(["list:0", "nothing"]);
  });
});

describe("P2 (RC-3): none_fit must justify itself — one bounded re-ask, with the candidates visible", () => {
  const FIN: BuilderCatalogue = { items: [
    { ref: "fin.table.invoices", kind: "reader", about: "overdue invoices, with due dates" },
    { ref: "hr.staff.attendance", kind: "reader", about: "employees below their department's attendance threshold" },
    { ref: "mail_send", kind: "tool", about: "send an email" },
  ] };
  const HR: BuilderCatalogue = { items: FIN.items.filter((i) => i.ref !== "fin.table.invoices") };
  const GOAL = "read the invoices";
  const planOf = (ref: string): Plan => ({ sources: [{ ref, quote: "the invoices", clauses: ["C1"] }], each: null, rows: [], schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [] });
  /** `makePlan` over scripted answers, recording every prompt it sent. */
  const run = async (cat: BuilderCatalogue, answers: Plan[]) => {
    const prompts: string[] = [];
    const plan = await makePlan(GOAL, cat, async (p) => { prompts.push(p); return JSON.stringify(answers[Math.min(prompts.length - 1, answers.length - 1)]); }, (_s, raw) => JSON.parse(raw) as Plan);
    return { ...plan, prompts };
  };

  it("a none_fit is asked back ONCE with the structured shortlist named in the re-ask", async () => {
    const r = await run(FIN, [planOf(NONE_FIT), planOf("fin.table.invoices")]);
    expect(r.asked).toBe(2);
    expect(r.prompts).toHaveLength(2); // the bound: exactly one re-ask, no more
    expect(r.prompts[1]).toContain("YOUR LAST ANSWER LEFT THIS WRONG");
    expect(r.prompts[1]).toContain("fin.table.invoices"); // the shortlist is visible to the model
    expect(r.prompts[1]).toContain("none_fit:");
    expect(r.plan.sources[0]!.ref).toBe("fin.table.invoices");
    expect(r.findings).toEqual([]);
    // and the refusal RC-3 produced is GONE: the chosen reader lowers to a spec that builds
    const { spec } = planToSpec(r.plan, clauses(GOAL), FIN, GOAL);
    expect(spec.sources).toEqual([{ ref: "fin.table.invoices", quote: "the invoices" }]);
    expect(spec.missing).toBeNull();
    expect(cannotReasons(checkSpec(spec, [GOAL], FIN).spec)).toEqual([]);
  });

  it("FAILING-BEFORE (2026-10-07): zero shared words still questions — already-chosen refs first, catalogue order after", () => {
    const cs = clauses("read the invoices, and read the wifi routers");
    const mixed: Plan = { sources: [{ ref: "hr.staff.attendance", quote: "the invoices", clauses: ["C1"] }, { ref: NONE_FIT, quote: "the wifi routers", clauses: ["C2"] }], each: null, rows: [], schedule: null, conditions: [], actions: [], values: [], missing: "", joining: [] };
    const f = planFindings(mixed, cs, FIN).join("\n");
    expect(f).toContain("none_fit:"); // the old overlap gate said nothing here — the refusal stood unquestioned
    expect(f).toContain("hr.staff.attendance"); // already-chosen first
    expect(f).toContain("fin.table.invoices"); // the rest in catalogue order
  });

  it("a none_fit that PERSISTS is accepted: no second ask, and the finding never leaves as a gap", async () => {
    const r = await run(FIN, [planOf(NONE_FIT), planOf(NONE_FIT)]);
    expect(r.asked).toBe(2);
    expect(r.prompts).toHaveLength(2);
    expect(r.plan.sources[0]!.ref).toBe(NONE_FIT);
    expect(r.findings).toEqual([]); // (e): nothing beyond today's refusal reaches the spec
    const { spec } = planToSpec(r.plan, clauses(GOAL), FIN, GOAL);
    expect(spec.missing).toBe("a part of the goal no listed component provides");
    expect(spec.planGaps ?? []).toEqual([]);
    // the same finding as today: the absent component, then planToSpec's stated missing
    expect(cannotReasons(spec)).toEqual(["No reader here provides “the invoices”.", "a part of the goal no listed component provides"]);
    expect(checkSpec(spec, [GOAL], FIN).spec.unclear).toBeUndefined();
  });

  it("CONTROL: refusal-shaped — an empty workspace offers nothing, so there is no question and no extra call", async () => {
    const EMPTY: BuilderCatalogue = { items: [] };
    const r = await run(EMPTY, [planOf(NONE_FIT)]);
    expect(r.asked).toBe(1); // one call — a workspace with nothing to name still refuses
    expect(r.prompts).toHaveLength(1);
    expect(planFindings(r.plan, clauses(GOAL), EMPTY)).toEqual([]);
    const { spec } = planToSpec(r.plan, clauses(GOAL), EMPTY, GOAL);
    expect(cannotReasons(spec)).toEqual(["No reader here provides “the invoices”.", "a part of the goal no listed component provides"]);
  });


  it("RC-10: an ACTION none_fit is asked back ONCE with the workspace's actions named (R2b)", async () => {
    // "log the outcome" shares no vocabulary with any listed action — the structured shortlist still names
    // what the workspace HAS; a mapping that fits is chosen, or none_fit persists. Never a terminal guess.
    const goal = "read the invoices, log the outcome";
    const cs = clauses(goal);
    const logAct = (ref: string): Plan["actions"][number] => ({ ref, quote: "log the outcome", clauses: [cs[1]!.id], on: "always", per_item: false, approve_first: null, recipient: { from: "goal", words: "a@b.example" } });
    const planWith = (ref: string): Plan => ({ ...planOf("fin.table.invoices"), actions: [logAct(ref)] });
    const prompts: string[] = [];
    const answers = [planWith(NONE_FIT), planWith("mail_send")];
    const r = await makePlan(goal, FIN, async (p) => { prompts.push(p); return JSON.stringify(answers[Math.min(prompts.length - 1, answers.length - 1)]); }, (_s, raw) => JSON.parse(raw) as Plan);
    expect(r.asked).toBe(2);
    expect(prompts[1]).toContain("YOUR LAST ANSWER LEFT THIS WRONG");
    expect(prompts[1]).toContain("mail_send"); // the workspace's actions are visible to the model
    expect(prompts[1]).toContain("log the outcome");
    expect(r.plan.actions[0]!.ref).toBe("mail_send");
    expect(r.findings).toEqual([]);
    // persisting none_fit stays the honest terminal it was: one ask, then refusal
    const prompts2: string[] = [];
    const r2 = await makePlan(goal, FIN, async (p) => { prompts2.push(p); return JSON.stringify(planWith(NONE_FIT)); }, (_s, raw) => JSON.parse(raw) as Plan);
    expect(r2.asked).toBe(2);
    expect(prompts2).toHaveLength(2);
    expect(r2.findings).toEqual([]);
    const { spec } = planToSpec(r2.plan, clauses(goal), FIN, goal);
    expect(cannotReasons(spec)).toContain("No action here does “log the outcome”.");
    // and a workspace with NO actions at all asks nothing (nothing to name)
    const emptyTools: BuilderCatalogue = { items: FIN.items.filter((i) => i.kind !== "tool") };
    const r3 = await makePlan(goal, emptyTools, async () => JSON.stringify(planWith(NONE_FIT)), (_s, raw) => JSON.parse(raw) as Plan);
    expect(r3.asked).toBe(1);
  });

});
