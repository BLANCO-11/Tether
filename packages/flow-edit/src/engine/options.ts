/**
 * The CHOICES a builder is offered (compiled-builder phase 4, task 2): `legalMoves` flattened into labelled options, each one
 * concrete `EngineOp` (or a typed literal slot), with step ids chosen by code — so a chooser (the model now, laya in phase 6)
 * picks an id from an enum and never writes an op, an id or an expression.
 *
 * ⚠ CONSTRUCTION ONLY: `unbind`, `remove_step` and `remove_input` are not offered. A build only adds, so its states grow
 * monotonically and a build can never revisit one (D-294's "no loop", by construction). Taking something back is an EDIT,
 * a person's request, not a chooser's move.
 */
import type { Comb, Operand, Part, Pred } from "../ir/combinators.js";
import type { CatalogueSnapshot } from "../typecheck/signature.js";
import { render, type Ty } from "../typecheck/types.js";
import { legalMoves } from "./legal.js";
import type { EFlow, EInputType } from "./model.js";
import { fieldLabel, type BindSource, type EngineOp, type When } from "./ops.js";

export interface Option {
  id: string;
  /** The move family and target — the level-1 choice when the options are too many for one enum. */
  group: string;
  label: string;
  op?: EngineOp;
  /** A literal slot: the chooser supplies the VALUE, which the caller must prove quoted (the constants rule). */
  literal?: { ty: Ty; what: string; make: (value: string, provenance: "goal" | "person") => EngineOp };
}

// ── words ────────────────────────────────────────────────────────────────────
const operand = (o: Operand) => ("field" in o ? o.field : "input" in o ? `input ${o.input}` : JSON.stringify(o.lit.value));
const CMP: Record<string, string> = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥" };
function pred(p: Pred): string {
  if ("cmp" in p) return `${operand(p.left)} ${CMP[p.cmp]} ${operand(p.right)}`;
  if ("isNull" in p) return `${p.isNull} is empty`;
  if ("notNull" in p) return `${p.notNull} is present`;
  if ("isBlank" in p) return `${p.isBlank} is blank`;
  if ("and" in p) return p.and.map(pred).join(" and ");
  if ("or" in p) return p.or.map(pred).join(" or ");
  return `not (${pred(p.not)})`;
}
const parts = (ps: Part[]) => ps.map((x) => ("text" in x ? JSON.stringify(x.text) : "field" in x ? `{${x.field}}` : `{${x.opt}?}`)).join(" ");
/** One stage, in words — for an option label; never shown as the flow's own description. */
export function describeComb(c: Comb): string {
  switch (c.op) {
    case "filter": return `keep rows where ${pred(c.where)}`;
    case "project": return `keep ${c.fields.map((f) => ("from" in f && f.from !== f.name ? `${f.name}=${f.from}` : f.name)).join(", ")}`;
    case "template": return `add ${c.as} = ${parts(c.parts)}`;
    case "join_text": return `one text ${c.as} of ${parts(c.parts)} per row`;
    case "count": return `count rows as ${c.as}`;
    case "sort": return `sort by ${[c.by].flat().join(", ")} ${c.dir === "asc" ? "ascending" : "descending"}`;
    case "limit": return `at most ${c.n.value} rows`;
    case "distinct": return `one row per ${c.by}`;
    case "first": return "the first row";
    case "coalesce": return `${c.field}, or ${[c.with].flat().map(operand).join(", or ")}`;
    case "convert": return `${c.as} = ${c.field} as ${c.to === "text" ? "text" : "major units"}`;
    case "derive": return `add ${c.as}`;
    case "group": return `group by ${c.by.join(", ")}: ${c.aggs.map((a) => `${a.fn}${a.field ? ` ${a.field}` : ""}`).join(", ")}`;
    case "summarize": return `totals: ${c.aggs.map((a) => `${a.fn}${a.field ? ` ${a.field}` : ""}`).join(", ")}`;
    case "take": return `the list in ${c.field}`;
    case "keep_if": return `keep it if ${pred(c.where)}`;
  }
}
export const sourceWords = (s: BindSource) =>
  s.from === "input" ? `flow input ${s.inputId}` : s.from === "field" ? `${s.stepId}.${fieldLabel(s.field)}` : s.from === "column" ? `every ${s.stepId}.${fieldLabel(s.field)}` : s.from === "text" ? `${s.stepId} as text` : JSON.stringify(s.value);
export const whenWords = (w: When[]) => w.map((x) => `${x.stepId} has ${x.test === "any" ? "rows" : "no rows"}`).join(" and ");

// ── ids ──────────────────────────────────────────────────────────────────────
/** A fresh step/input id with this base: `read_1`, `read_2`, … — code's, not the chooser's. */
export function freshStepId(f: EFlow, base: string): string {
  for (let n = 1; ; n++) { const id = `${base}_${n}`; if (!f.steps.some((s) => s.id === id) && !f.inputs.some((i) => i.id === id)) return id; }
}
/** The input id a role or a person's name for it becomes — shared with the canvas, so both front ends name an input alike. */
export const inputIdFor = (f: EFlow, name: string) => { const b = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^([^a-z])/, "v_$1").slice(0, 40) || "value"; return f.inputs.some((i) => i.id === b) || f.steps.some((s) => s.id === b) ? freshStepId(f, b) : b; };

/** The input types a builder offers, in words — one list for both front ends. */
export const INPUT_TYPES: ReadonlyArray<readonly [EInputType, "month" | undefined, string]> = [["STRING", "month", "a month (YYYY-MM)"], ["DATE", undefined, "a date"], ["DATETIME", undefined, "a date and time"], ["INT", undefined, "a whole number"], ["FLOAT", undefined, "a number"], ["STRING", undefined, "text"], ["BOOLEAN", undefined, "yes/no"]];

export interface OptionContext {
  /** Values the goal says are asked each run (GoalSpec `flow_input`), by role: offered as `declare_input`. */
  inputRoles?: string[];
  /** The confirmed schedule, if the goal states one: offered as `set_schedule` with exactly this cron. */
  cron?: string | null;
}

/** Every construction option for a state, in a stable order. Ids are `o1…oN` in that order. */
export function optionsOf(f: EFlow, cat: CatalogueSnapshot, ctx: OptionContext = {}): Option[] {
  const out: Array<Omit<Option, "id">> = [];
  const push = (o: Omit<Option, "id">) => out.push(o);
  const read = freshStepId(f, "read"), shape = freshStepId(f, "shape"), call = freshStepId(f, "call"), gate = freshStepId(f, "gate");
  for (const m of legalMoves(f, cat)) {
    switch (m.op) {
      case "declare_input":
        for (const role of ctx.inputRoles ?? []) {
          if (f.inputs.some((i) => i.id === role || i.id.startsWith(`${role}_`))) continue;
          const id = inputIdFor(f, role);
          for (const [type, format, words] of INPUT_TYPES) push({ group: `input ${role}`, label: `ask for ${role} each run, as ${words}`, op: { op: "declare_input", id, type, ...(format ? { format } : {}), ...(m.needsDefault ? { required: false } : {}) } });
        }
        break;
      case "add_reader":
        for (const ref of m.refs) push({ group: "add a reader", label: `read ${ref}`, op: { op: "add_reader", id: read, ref } });
        for (const b of m.unders) for (const ref of m.refs) push({ group: `add under ${b}`, label: `read ${ref}, only when ${b} holds`, op: { op: "add_reader", id: read, ref, under: b } });
        break;
      case "choose_reader":
        for (const ref of m.refs) push({ group: `choose ${m.stepId}`, label: `${m.stepId} reads ${ref}`, op: { op: "choose_reader", stepId: m.stepId, ref } });
        break;
      case "add_transform":
        for (const st of m.stages) push({ group: `shape ${m.from}`, label: `from ${m.from}: ${describeComb(st)}`, op: { op: "add_transform", id: shape, from: m.from, pipeline: [st] } });
        for (const b of m.unders) for (const st of m.stages) push({ group: `add under ${b}`, label: `from ${m.from}: ${describeComb(st)}, only when ${b} holds`, op: { op: "add_transform", id: shape, from: m.from, pipeline: [st], under: b } });
        break;
      case "append_stage":
        for (const st of m.stages) push({ group: `extend ${m.stepId}`, label: `${m.stepId}, then ${describeComb(st)}`, op: { op: "append_stage", stepId: m.stepId, stage: st } });
        for (const l of m.literals) push({ group: `extend ${m.stepId}`, label: `${m.stepId}, then ${l.what} (a value: ${render(l.ty)})`, literal: { ty: l.ty, what: l.what, make: (v) => ({ op: "append_stage", stepId: m.stepId, stage: l.make(v) }) } });
        break;
      case "add_call":
        for (const ref of m.refs) push({ group: "add an action", label: `call ${ref} once`, op: { op: "add_call", id: call, ref } });
        for (const fo of m.fanouts) push({ group: "add an action", label: `call ${fo.ref} once per row of ${fo.over}, ${fo.row.port} ← ${fo.row.field}`, op: { op: "add_call", id: call, ...fo } });
        for (const b of m.unders) for (const ref of m.refs) push({ group: `add under ${b}`, label: `call ${ref} once, only when ${b} holds`, op: { op: "add_call", id: call, ref, under: b } });
        break;
      case "bind":
        for (const s of m.sources) push({ group: `fill ${m.stepId}.${m.port}`, label: `${m.stepId}.${m.port} ← ${sourceWords(s)}`, op: { op: "bind", stepId: m.stepId, port: m.port, source: s } });
        if (m.literal) { const lt = m.literal; push({ group: `fill ${m.stepId}.${m.port}`, label: `${m.stepId}.${m.port} ← a value stated by the person (${render(lt)})`, literal: { ty: lt, what: `${m.stepId}.${m.port}`, make: (v, provenance) => ({ op: "bind", stepId: m.stepId, port: m.port, source: { from: "literal", value: v, provenance } }) } }); }
        break;
      case "add_gate":
        for (const b of m.before) push({ group: "add a gate", label: `a person approves before ${b} runs`, op: { op: "add_gate", id: gate, before: b, summary: `Approve ${b}?` } });
        break;
      case "set_output":
        for (const s of m.steps) push({ group: "declare the result", label: `the result is ${s}`, op: { op: "set_output", stepId: s } });
        break;
      case "set_schedule":
        if (m.set && ctx.cron && !f.schedule) push({ group: "schedule", label: `run on the schedule the goal states (${ctx.cron})`, op: { op: "set_schedule", cron: ctx.cron } });
        break;
      case "add_branch":
        for (const s of m.subjects) for (const test of ["any", "none"] as const) push({ group: "add a condition", label: `only when ${whenWords([{ stepId: s, test }])}`, op: { op: "add_branch", id: freshStepId(f, "when"), when: [{ stepId: s, test }] } });
        break;
      case "add_otherwise":
        if (m.closes) push({ group: `continue ${m.of}`, label: `otherwise (when ${m.of} does not hold)`, op: { op: "add_otherwise", id: freshStepId(f, "otherwise"), of: m.of } });
        for (const s of m.subjects) for (const test of ["any", "none"] as const) push({ group: `continue ${m.of}`, label: `otherwise, when ${whenWords([{ stepId: s, test }])}`, op: { op: "add_otherwise", id: freshStepId(f, "elif"), of: m.of, when: [{ stepId: s, test }] } });
        break;
      case "add_merge":
        for (const src of m.sources) push({ group: "merge", label: `one value from whichever ran of ${src.join(", ")}`, op: { op: "add_merge", id: freshStepId(f, "merged"), sources: src } });
        break;
      case "remove_input": case "retype_input": case "unbind": case "remove_step": break; // construction only (see the module note)
    }
  }
  return out.map((o, i) => ({ id: `o${i + 1}`, ...o }));
}

/** The groups, in first-seen order, with how many options each holds — the level-1 enum. */
export function groupsOf(opts: Option[]): Array<{ group: string; n: number }> {
  const m = new Map<string, number>();
  for (const o of opts) m.set(o.group, (m.get(o.group) ?? 0) + 1);
  return [...m].map(([group, n]) => ({ group, n }));
}

/**
 * A month or a date AS OF THE RUN, for a port of that type (2026-09-29: a weekly report's period was typed as one fixed month,
 * which reads the same month for ever). Each choice is the engine's own two moves — declare the computed run input, bind the port
 * to it — so it is exactly as legal as doing both by hand. Only for a port whose type IS a month or a date (never text, never
 * unknown), and only where the flow does not already have that input (then the plain bind to it is offered instead).
 */
export interface RunTimeChoice { label: string; ops: EngineOp[] }
const RUN_TIME: Array<{ computed: "currentMonth" | "priorMonth" | "currentDate" | "priorDate" | "currentMonthStart" | "priorMonthStart"; name: string; type: EInputType; format?: "month"; label: string; ty: "Month" | "Date" }> = [
  { computed: "currentMonth", name: "run_month", type: "STRING", format: "month", label: "the month it runs", ty: "Month" },
  { computed: "priorMonth", name: "prior_month", type: "STRING", format: "month", label: "the month before it runs", ty: "Month" },
  { computed: "currentDate", name: "run_day", type: "DATE", label: "the day it runs", ty: "Date" },
  { computed: "priorDate", name: "prior_day", type: "DATE", label: "the day before it runs", ty: "Date" },
  { computed: "currentMonthStart", name: "month_start", type: "DATE", label: "the first day of the month it runs", ty: "Date" },
  { computed: "priorMonthStart", name: "prior_month_start", type: "DATE", label: "the first day of the month before it runs", ty: "Date" },
];
/**
 * A date compared BY ITS MONTH (`per: "month"`) is offered the month it runs and the month before — as the engine's own computed
 * dates: any day of a month means that month, so the run day IS "the month it runs", and the first day of the month before is
 * "the month before". Worded as months, because that is what the input asks for.
 */
const BY_MONTH: Partial<Record<(typeof RUN_TIME)[number]["computed"], string>> = { currentDate: "the month it runs", priorMonthStart: "the month before it runs" };
export function runTimeChoices(f: EFlow, stepId: string, port: string, portTy: Ty | null | undefined): RunTimeChoice[] {
  const base = portTy ? (portTy.t === "Option" || portTy.t === "List" ? portTy.of : portTy) : null;
  if (!base || (base.t !== "Month" && base.t !== "Date")) return [];
  const byMonth = base.t === "Date" && "per" in base && base.per === "month";
  return RUN_TIME.filter((c) => c.ty === base.t && (!byMonth || BY_MONTH[c.computed]) && !f.inputs.some((i) => i.computed === c.computed && i.offsetDays === undefined)).map((c) => {
    const id = inputIdFor(f, c.name);
    return {
      label: `${byMonth ? BY_MONTH[c.computed]! : c.label} (worked out when it runs)`,
      ops: [
        { op: "declare_input", id, type: c.type, ...(c.format ? { format: c.format } : {}), computed: c.computed },
        { op: "bind", stepId, port, source: { from: "input", inputId: id } },
      ],
    };
  });
}
