/**
 * TEST ONLY: a scripted GoalSpec as the PLAN reply that means the same (P1-D13). The builder's tests were written against the spec,
 * shape and wiring calls; a new goal now takes one plan call, lowered by `planToSpec`. This answers that call from the spec a test
 * already scripts, so every downstream assertion (what is asked, what is built) still tests the same thing.
 * Every clause is listed as `joining`, so a scripted spec is never charged with coverage it was not written to have.
 */
import { EDIT_NOT_ADDITIVE, type GoalSpec } from "../goal-spec.js";
import type { Plan } from "../plan.js";
import { INPUT_IDS } from "../inputs.js";

const DATA: ReadonlySet<string> = new Set(["period", "date", "threshold", "count"]);

const CMP_TEST: Record<string, string> = { gt: "above", ge: "at_least", lt: "below", le: "at_most", eq: "equals", ne: "not_equals" };

/**
 * `fields`: the address fields the plan schema offers (`recipient.field`). A scripted spec written before the plan chose a recipient's
 * field (P7-D1) names none; its people are then the chosen source's address field whose name shares a word with theirs, else its first
 * — the reading those scripts were written against. TEST ONLY: the product never ranks; the model chooses from the closed list.
 */
export function planReplyFor(prompt: string, spec: GoalSpec, fields: readonly string[] = []): Plan {
  const cl = [...prompt.matchAll(/^(C\d+): (.*)$/gm)].map((m) => ({ id: m[1]!, text: m[2]! }));
  const ids = cl.map((c) => c.id);
  // A part cites the clauses that share a word with its quote, as a plan does; only clauses no part cites are `joining` (words that
  // join the others are nobody's data — the read is never excused for words a part of the plan really carries).
  const ws = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2));
  const cites = (q: string | undefined) => { const w = ws(q ?? ""); return cl.filter((c) => [...ws(c.text)].some((x) => w.has(x))).map((c) => c.id); };
  const w = spec.wiring;
  const recipientOf = (ref: string) => spec.values.find((v) => v.role === "recipient" && v.fills?.startsWith(`${ref}.`));
  const listSource = (k: string | undefined) => (k?.startsWith("reader:") ? Number(k.slice(7)) : 0);
  const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2);
  const fieldFor = (r: NonNullable<ReturnType<typeof recipientOf>>): string => {
    if (r.field) return r.field === "none" || r.field === "new_read" || r.field.includes(".") ? r.field : fields.find((f) => f.endsWith(`.${r.field}`)) ?? r.field;
    const own = fields.filter((f) => spec.sources.some((x) => f.startsWith(`${x.ref}.`)));
    if (!own.length) return spec.sources.some((x) => x.ref.endsWith(".new_read") || x.ref.includes(".table.")) ? "new_read" : "none";
    const said = words(r.quote);
    return own.find((f) => words(f.slice(f.lastIndexOf(".") + 1)).some((w) => said.includes(w))) ?? own[0]!;
  };
  const inputOf = (v: string | null | undefined) => (v?.startsWith("input:") ? v.slice(6) : "none");
  const citedAll = [...spec.sources.map((x) => x.quote), ...spec.sinks.map((x) => x.quote), ...spec.values.map((v) => v.quote), ...spec.conditions.map((c) => c.quote),
    ...(spec.unclear ?? []).map((u) => u.quote), ...(spec.schedule ? [spec.schedule.quote] : []), ...(w?.paths ?? []).map((x) => x.quote), ...(w?.each ? [w.each.quote] : [])].flatMap((q) => cites(q));
  return {
    sources: spec.sources.map((s) => ({ ref: s.ref, quote: s.quote, clauses: cites(s.quote) })),
    each: w?.each ? { over: listSource(w.each.over), quote: w.each.quote, clauses: [], groups: false } : null,
    rows: [
      ...(spec.shapes ?? []).flatMap((sh) => sh.stages.filter((st) => st.op === "filter" && st.field).map((st) => ({ clauses: [], field: st.field!, about: "", test: (st.test ?? "equals") as Plan["rows"][number]["test"], value: st.against || inputOf(st.value) !== "none" ? "" : st.value ?? "", against: st.against ?? "", input: inputOf(st.value) }))),
      ...spec.conditions.filter((c) => c.field && c.test).map((c) => ({ clauses: [], field: c.field!, about: "", test: c.test! as Plan["rows"][number]["test"], value: c.value ?? "", against: "", input: "none" })),
    ],
    schedule: spec.schedule ? { cron: spec.schedule.cron, quote: spec.schedule.quote, clauses: [] } : null,
    conditions: (w?.paths ?? []).map((p) => ({
      quote: p.quote, clauses: [],
      over: p.subject === "item" ? "each_item" as const : p.test === "none" ? "no_row" as const : p.test === "compare" && p.measure === "count" ? "row_count" as const : "any_row" as const,
      where: p.subject === "item" && p.measure ? [{ field: `${spec.sources[0]?.ref}.${p.measure}`, about: "", test: CMP_TEST[p.cmp ?? "eq"]! as Plan["rows"][number]["test"], value: p.value ?? "", against: "", input: "none" }] : [],
      count: p.test === "compare" && p.measure === "count" ? { test: CMP_TEST[p.cmp ?? "gt"]!, value: p.value ?? "" } : null,
    })),
    actions: spec.sinks.map((x, i) => {
      const a = w?.actions[i];
      const r = recipientOf(x.ref);
      return {
        ref: x.ref, quote: x.quote, clauses: cites(x.quote),
        on: a?.path === "otherwise" ? "otherwise" as const : typeof a?.path === "number" ? `if:${a.path}` as Plan["actions"][number]["on"] : "always" as const,
        per_item: a?.per === "item",
        approve_first: a?.approve ? { quote: a.approve, clauses: [] } : null,
        // A heading drafted from the action's own words, as the plan is asked for one (`planFindings`).
        heading: x.quote || "the update", message: "", sends: "rows" as const,
        // A recipient the goal names that is not a written address is the people the rows are about (`peopleInRows`).
        recipient: r
          ? (r.from === "requester" ? { from: "requester" as const, words: r.quote, field: "n/a" } : /@|#/.test(r.quote) ? { from: "goal" as const, words: r.quote, field: "n/a" } : { from: "rows" as const, words: r.quote, field: fieldFor(r) })
          : { from: "unsaid" as const, words: "", field: "n/a" },
      };
    }),
    values: spec.values.filter((v) => v.role !== "recipient" && !DATA.has(v.role)).map((v) => ({ role: v.role, from: v.from, quote: v.quote, fills: v.fills ?? "none", clauses: [], as: v.as ?? "", named: !!v.named })),
    summary: null,
    // A value about the DATA (a period, a date, a number tested) is an input of the plan: stated by the goal, or given each run.
    inputs: [
      ...(spec.inputs ?? []).map((i) => ({ id: i.id, words: i.words, kind: i.kind, fill: i.fill, relative: i.relative ?? "none", days: i.days ?? 0, fills: i.fills ?? "none", clauses: [] })),
      ...spec.values.filter((v) => DATA.has(v.role)).map((v, k) => ({ id: INPUT_IDS[(spec.inputs?.length ?? 0) + k] ?? "in_d", words: v.quote, kind: v.role === "period" ? "month" as const : v.role === "date" ? "date" as const : "number" as const,
        fill: v.from === "flow_input" ? "each_run" as const : "given" as const, relative: "none" as const, days: 0, fills: v.fills ?? "none", clauses: cites(v.quote) })),
    ],
    unclear: (spec.unclear ?? []).map((u) => ({ quote: u.quote, about: u.about })),
    missing: spec.missing ?? "",
    joining: ids.filter((id) => !citedAll.includes(id)),
    spelling: [],
    ...(/^ALREADY IN THE AUTOMATION$/m.test(prompt) ? { changes_existing: spec.missing === EDIT_NOT_ADDITIVE } : {}),
  };
}

/** A test chooser that also answers the PLAN call — from the spec it scripts for `goal_spec`, converted (`planReplyFor`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * The restate (a reply applied to the goal) is DECLINED here, as a model reply that breaks its schema would be: the builder then
 * plans the goal with the reply beside it, which is what these scripted specs were written against. The restate's own rules are
 * tested in `as-meant.test.ts`; what a model makes of it is measured, not scripted.
 */
export function planAware<C extends (...a: any[]) => Promise<string>>(inner: C): C {
  return (async (p: string, schema: { name: string }, label: string) => schema.name === "goal_restate" ? "{}" : schema.name === "goal_plan"
    ? JSON.stringify(planReplyFor(p, JSON.parse(await inner(p, { ...schema, name: "goal_spec" }, label)) as GoalSpec, addressOptions(schema)))
    : inner(p, schema, label)) as unknown as C;
}

/** The address fields a plan schema offers for `recipient.field` — read off the schema the call is made with. */
function addressOptions(schema: unknown): string[] {
  const seen: string[] = [];
  const walk = (x: unknown, key?: string) => {
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (key === "field" && Array.isArray(o.enum) && o.enum.includes("n/a")) seen.push(...(o.enum as string[]).filter((v) => v.includes(".")));
    for (const [k, v] of Object.entries(o)) walk(v, k === "properties" ? key : k);
  };
  walk(schema);
  return [...new Set(seen)];
}
