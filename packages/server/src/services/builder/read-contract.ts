/**
 * A written read's CONTRACT — fixed by code BEFORE the proposer is called (plans/builder-stability-2026-10-01, phase 1).
 *
 * The builder was stable while every reader's interface was declared before the model saw the goal. A read written for a goal
 * has no declaration, so this is it: which parameters the read takes (named and typed here, from the person's own words), whether
 * every row must carry the address of the person it is sent to, and which of the person's words the read is responsible for. The
 * proposer fills in the SQL form against it and is checked against it; it decides none of it, and nothing it says re-reads the goal.
 *
 * Pure: no database, no model. The model's typed values decide the form; nothing of a domain.
 */
import { FILLS_NONE, type GoalSpec } from "./goal-spec.js";
import { withReader } from "./plan.js";


/** A parameter's type, as the read's filter must take it: a month (one `month` filter), a day, a number, or text. */
export type ContractType = "month" | "date" | "number" | "text";
export interface ContractParam {
  /** Code's name — stable across revisions of the read, so an answer given to it survives one. */
  name: string;
  type: ContractType;
  /** The person's words this parameter stands for. */
  words: string;
  /** For the two ends of a stated range of days: which end (the read keeps days on or after the start, on or before the end). */
  end?: "start" | "end";
  /** The spec value it comes from — `fills` is set by code from this, never by a model. */
  value: number;
}
/**
 * The PRESENT, as a read may compare with it (2026-10-04: "invoices past their due date", "open for more than 30 minutes" — a read
 * could not be written, because the only parameters were the values the goal STATES, and the present is never stated). Two optional
 * parameters the automation fills itself when it runs — never asked, never the person's: the day it runs, and the moment it runs.
 */
export const RUN_PARAMS = { run_day: { at: "day" as const, format: "date", words: "the day it runs" }, run_time: { at: "time" as const, format: "datetime", words: "the moment it runs" } };
export type RunParam = keyof typeof RUN_PARAMS;
export const isRunParam = (name: string): name is RunParam => Object.prototype.hasOwnProperty.call(RUN_PARAMS, name);

export interface ReadContract {
  params: ContractParam[];
  /** The words for the people each row is about who are sent something — every row must carry their address. */
  address?: string;
  /** builder-behaviour P7 (R17): a call made per row takes the row's IDENTITY — every row returns the column declared its key. */
  identity?: boolean;
  /**
   * The columns the REST of the build reads from these rows, by the names it reads them (2026-10-02, L02: a stage over the read
   * named `high_risk_count`, and the read — written after — had no such column). Fixed here, so the read returns them; never a
   * name the read chose, re-mapped afterwards.
   */
  fields?: Array<{ name: string; words: string }>;
  /**
   * The FLOW summarises these rows (a group stage over the read — "for each site, count …"): the read returns the rows themselves.
   * Summarised in the read as well, the flow's group counted rows that were already counts (2026-10-04: every site's count was 1).
   */
  rows?: string;
  /** The person's words the read carries out: what it reads, and the values it takes. */
  words: string[];
  /**
   * builder-behaviour P3 (R7): words ANOTHER part of the plan carries — an action, its recipient or its wording, the schedule, an
   * approval, a test the flow applies to each item. Never the read's to account for: a source quote that runs on into "email the
   * owner a heads up" made the read writer ask the person about sending an email (B15, B17).
   */
  owned?: string[];
}

/** The roles a read takes as a parameter. Recipients, channels, subjects and message words are an action's, never a read's. */
const PARAM_ROLES = new Set(["period", "date", "threshold", "count", "other"]);
const BASE: Record<string, string> = { period: "period", date: "as_of", threshold: "threshold", count: "count", other: "value" };

const inside = (part: string, whole: string) => { const a = part.toLowerCase().trim(), b = whole.toLowerCase().trim(); return !!a && !!b && b.includes(a); };
const lastDay = (month: string) => { const [y, m] = month.split("-").map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
/** A range that is exactly one calendar month (1st to its last day). */
const wholeMonth = (r: { from: string; to: string }) => r.from.endsWith("-01") && r.from.slice(0, 7) === r.to.slice(0, 7) && r.to === lastDay(r.from.slice(0, 7));

/**
 * The contract for the read written for `choice` (a `<datasource>.new_read` the spec chose). Its parameters are the spec's stated
 * values that fill no other component; with several written reads in one spec, a value goes to the read only when it names it.
 */
export function readContract(spec: GoalSpec, choice: string, texts: readonly string[], address?: string, identity = false): ReadContract {
  const choices = new Set(spec.sources.map((x) => x.ref).filter((r) => r.endsWith(".new_read")));
  // A value a BRANCH tests is the flow's, never the read's (2026-10-02, a user's "if the amount is over 10000 … otherwise …": the
  // read took “over 10000” as its parameter, kept only those rows, and the "otherwise" arm could never run). Known only once the
  // wiring is understood — so the contract is computed again then (`reconcileWrittenReads`), and a read that took one is rewritten.
  // Only a path the FLOW compares a value in (a per-item test, a count, a split) owns that value; "whether any row holds" compares
  // nothing — the value in its words is what the rows are (P1-D13: "if anyone took 3 or more" is the read's threshold).
  const branchQuotes = (spec.wiring?.paths ?? []).filter((p) => p.test === "compare" || p.test === "split").map((p) => p.quote);
  const sourceIx = spec.sources.flatMap((x, i) => (x.ref === choice ? [i] : []));
  const params: ContractParam[] = [];
  const used = new Map<string, number>();
  const named = (base: string) => { const n = (used.get(base) ?? 0) + 1; used.set(base, n); return n === 1 ? base : `${base}_${n}`; };
  // builder-inputs P1-D3: the read's parameters are the plan's INPUTS placed on it — typed by their kind, whether or not their value is
  // known (each is then given, asked each run, or worked out from the run date by the solver). Stated words no longer decide whether a
  // parameter exists: "a period I pick each time" is a parameter as surely as "august 2026" is.
  spec.values.forEach((v, value) => {
    if (!v.input || (v.fills && v.fills !== FILLS_NONE) || choices.size !== 1) return;
    const inp = spec.inputs?.find((i) => i.id === v.input);
    if (!inp || inp.at !== "read") return;
    const words = v.quote.trim();
    if (inp.kind === "date_range") { const base = named("period"); params.push({ name: `${base}_start`, type: "date", words, end: "start", value }, { name: `${base}_end`, type: "date", words, end: "end", value }); return; }
    const t: ContractType = inp.kind === "month" ? "month" : inp.kind === "date" ? "date" : inp.kind === "number" ? "number" : "text";
    params.push({ name: named(inp.kind === "month" ? "period" : inp.kind === "date" ? "as_of" : inp.kind === "number" ? "threshold" : "value"), type: t, words, value });
  });
  // A value the goal STATES for the read's own test (its words, no plan input) is a parameter too — with the switch on as off
  // (builder-behaviour P1, R20: "below 8" stated in a row test of the read was no input, and the read took nothing for it).
  spec.values.forEach((v, value) => {
    if (v.input) return; // placed above, as an input
    if (!PARAM_ROLES.has(v.role) || (v.from !== "goal" && v.from !== "earlier")) return;
    const free = !v.fills || v.fills === FILLS_NONE;
    if (!(free ? choices.size === 1 : v.fills!.startsWith(`${choice}.`))) return;
    const words = v.quote.trim();
    if (!words) return;
    if (branchQuotes.some((q) => inside(words, q))) return;
    // Step 4: the model's role types the parameter — a threshold/count without a stated
    // number is asked as a blank; code never mines the words for one.
    if ((v.role === "threshold" || v.role === "count") && !v.named && !/\d/.test(words)) return;
    const base = named(BASE[v.role]!);
    if (v.role === "threshold" || v.role === "count") { params.push({ name: base, type: "number", words, value }); return; }
    if (v.role === "other") { params.push({ name: base, type: "text", words, value }); return; }
    // Step 4: the model's input kind decides the form — a `date_range` input is the read's
    // two ends; anything else is one parameter of the value's own role.
    if (v.input && v.role === "period") {
      params.push({ name: `${base}_start`, type: "date", words, end: "start", value }, { name: `${base}_end`, type: "date", words, end: "end", value });
      return;
    }
    params.push({ name: base, type: v.role === "period" ? "month" : "date", words, value });
  });
  const words = [...spec.sources.filter((x) => x.ref === choice).map((x) => x.quote), ...new Set(params.map((p) => p.words))];
  // The fields the rest of the spec names ON this read (`<choice>.<field>`), and a when's measured field over it.
  const fields = new Map<string, string>();
  const own = (f: string | null | undefined, words: string) => { if (f?.startsWith(`${choice}.`)) { const n = f.slice(choice.length + 1); if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !fields.has(n)) fields.set(n, words); } };
  for (const c of spec.conditions) own(c.field, c.quote);
  const flowSums = (spec.shapes ?? []).find((sh) => sh.over === choice && sh.stages.some((st) => st.op === "group"));
  for (const sh of spec.shapes ?? []) for (const st of sh.stages) { own(st.field, st.quote); own(st.against, st.quote); for (const b of st.by ?? []) own(b, st.quote); for (const m of st.measures ?? []) own(m.field, st.quote); }
  // A test of EACH item of a loop over this read measures a field of its rows: the read returns it.
  const loop = spec.wiring?.each?.over;
  // The loop's list: the read itself, or a list shaped over it (builder-behaviour P1: a loop over the read's filtered rows is still its rows).
  const loopIx = loop?.startsWith("reader:") ? Number(loop.slice(7))
    : loop?.startsWith("list:") && spec.shapes?.[Number(loop.slice(5))]?.over === choice ? sourceIx[0] ?? -1 : -1;
  for (const p of spec.wiring?.paths ?? []) {
    const i = p.subject.startsWith("reader:") ? Number(p.subject.slice(7)) : p.subject === "item" ? loopIx : -1;
    if (!sourceIx.includes(i)) continue;
    // builder-behaviour P1 (R10): EVERY field an item's tests read — and a field one is compared with (B15: `auto_renew`). First, so
    // a fact's own words (what it holds) describe its column.
    for (const t of p.where ?? []) { own(`${choice}.${t.field}`, t.about ? `${t.about} — for each row; a count of the related rows that hold it is fine (none counts as no)` : p.quote); if (t.against) own(`${choice}.${t.against}`, p.quote); }
    if (p.measure && p.measure !== "count" && p.measure !== "value") own(`${choice}.${p.measure}`, p.quote);
  }
  // builder-behaviour P7 (R15): the address field the plan CHOSE for people the rows name, when this written read is all the data —
  // the read returns that column by that name, so the solver binds the field the plan chose (E04: the table's `vendors_contact_email`
  // became a written read's, which named its own column — the chosen field was not there, and the email had no recipient).
  if (choices.size === 1 && choices.has(choice) && spec.sources.every((x) => x.ref === choice))
    for (const v of spec.values) if (v.role === "recipient" && v.field && v.field !== "none" && v.field !== "new_read") own(`${choice}.${v.field}`, `the address of “${v.quote.trim()}”`);
  const owned = [
    ...spec.sinks.map((x) => x.quote),
    ...(spec.schedule?.quote ? [spec.schedule.quote] : []),
    ...(spec.wiring?.actions ?? []).flatMap((a) => (a.approve ? [a.approve] : [])),
    // every condition the FLOW applies — on each item, or as its own list of the rows (a chain) — is the flow's, not the read's
    ...(spec.wiring?.paths ?? []).filter((p) => p.subject === "item" || p.subject.startsWith("list:")).map((p) => p.quote),
    ...spec.values.filter((v) => v.fills && v.fills !== FILLS_NONE && !spec.sources.some((x) => v.fills!.startsWith(`${x.ref}.`))).map((v) => v.quote),
    // words that only join the others or say why ("otherwise do nothing", "so we can follow up") — nobody's data (B17)
    ...(spec.joining ?? []),
  ].filter((q) => q?.trim());
  // P7 (B23): the READ's own quote is the read's, inside whatever other phrase repeats it — "email each customer their loyalty points
  // balance" owns "email", never "loyalty points balance", which the read must account for (it was excused, and a read with no balance
  // was accepted in silence). The read's quotes are taken out of every owned phrase before it excuses anything.
  const mine = spec.sources.filter((x) => x.ref === choice).map((x) => x.quote.trim()).filter(Boolean);
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownedOut = owned.map((q) => mine.reduce((acc, m) => acc.replace(new RegExp(esc(m), "ig"), " "), q).replace(/\s+/g, " ").trim()).filter((q) => /[a-z0-9]/i.test(q));
  // builder-behaviour P1 (R4): a written read computes its summary as its form allows (a grouped select, or rows with a summary join);
  // the contract holds only what the FLOW reads of it (a measure it sorts by or tests — `fields`, above). A stricter contract made
  // reads that were right fail (2026-10-04: B09's per-vendor summary join, B22's group key taken for a column).
  const rows = flowSums?.stages.find((st) => st.op === "group")?.quote;
  return { params, ...(rows ? { rows } : {}), ...(address ? { address } : {}), ...(identity ? { identity } : {}), ...(fields.size ? { fields: [...fields].map(([name, w]) => ({ name, words: w })) } : {}), words, ...(ownedOut.length ? { owned: ownedOut } : {}) };
}

/** The contract as the proposer reads it — the one part of its prompt that is about THIS read. */
export function contractText(c: ReadContract): string {
  const kind: Record<ContractType, string> = {
    month: "a MONTH — use it in ONE \"month\" filter on the date column; it keeps every day of that month",
    date: "a DATE",
    number: "a NUMBER",
    text: "TEXT — a value a column is compared with",
  };
  return [
    "THE READ'S CONTRACT — fixed; a read that does not keep it is refused",
    c.params.length
      ? "  It takes EXACTLY these parameters, by these names — no other parameter, none left out:"
      : "  It takes NO parameters: every value the rule needs is a fixed one.",
    ...c.params.map((p) => `    - "${p.name}": ${kind[p.type]}${p.end ? ` — the ${p.end === "start" ? "FIRST" : "LAST"} day of “${p.words}” (a "${p.end === "start" ? "gte" : "lte"}" filter)` : ""} — for “${p.words}”`),
    ...(c.fields?.length ? ["  Every row RETURNS these columns, by exactly these names (the rest of the automation reads them). Each is an ALIAS: the schema column (or total) that holds it, given this name — the schema's own column is often named otherwise, and a name here is never a column to look for:", ...c.fields.map((f) => `    - "${f.name}" — for “${f.words}”`)] : []),
    ...(c.address ? [`  Every row carries the ADDRESS (an email column) of “${c.address}” — the person that row is sent to — joined from wherever the schema keeps it.`] : []),
    ...(c.rows ? [`  It returns the ROWS themselves, one per item — the automation groups and totals them itself for “${c.rows}”: no "aggregateJoins", no "aggregate" on a column.`] : []),
    ...(c.identity ? ["  Every row carries its IDENTITY: the column the schema declares a row's key (`declared: key`), returned under its own column name."] : []),
    "  It MAY also compare with the PRESENT, through two parameters the automation fills itself each run (never asked; use one only",
    "  when the rule compares with now — \"overdue\", \"open for more than 2 hours\", \"expires within 30 days\"):",
    `    - "run_day": the day it runs — a DATE ({"param": "run_day", "type": "date"}, or a filter's "param" on a date column)`,
    `    - "run_time": the moment it runs — an INSTANT, for minutes and hours: a filter's "param" on a timestamp column, or {"param": "run_time", "type": "datetime"} in a computed value`,
    `  It carries out: ${c.words.map((w) => `“${w}”`).join(", ")}.`,
  ].join("\n");
}

/**
 * What a proposed read does against its contract, from its COMPILED parameters (`paramsSchema`) — each a sentence the proposer fixes:
 * a parameter left out, one not in the contract, one of the wrong type. Only clear mismatches: a month is the `month` operator's
 * parameter (`per: "month"`), a number is a number, and neither is the other's.
 */
export function contractFindings(c: ReadContract, paramsSchema: Record<string, { type?: string; format?: string; per?: string }>, outputs?: readonly string[], summarises = false): string[] {
  const out: string[] = [];
  if (c.rows && summarises) out.push(`the automation totals these rows itself (“${c.rows}”): return the rows, one per item — no "aggregateJoins" and no "aggregate" on a column`);
  if (outputs) for (const f of c.fields ?? []) if (!outputs.includes(f.name)) out.push(`the contract's column "${f.name}" (for “${f.words}”) is not returned — return it as a column with exactly that "alias"`);
  const want = new Map(c.params.map((p) => [p.name, p]));
  for (const p of c.params) {
    const got = paramsSchema[p.name];
    if (!got) { out.push(`the contract's parameter "${p.name}" (for “${p.words}”) is not used — every contract parameter is a filter's "param"`); continue; }
    const month = got.per === "month", num = got.type === "number" || got.type === "integer";
    const why = p.type === "month" && !month ? `is a MONTH: use it in one "month" filter`
      : p.type !== "month" && month ? `is not a month: compare with it directly, never in a "month" filter`
      : p.type === "number" && !num ? "is a NUMBER: compare a numeric column or value with it"
      : p.type !== "number" && num ? `is ${p.type === "text" ? "TEXT" : "a DATE"}, not a number` : null;
    if (why) out.push(`the contract's parameter "${p.name}" (for “${p.words}”) ${why}`);
  }
  // The present (`RUN_PARAMS`): optional, and of its own kind — the day a date, the moment an instant (cut to its day it would compare
  // "open for 30 minutes" at midnight).
  for (const [name, r] of Object.entries(RUN_PARAMS)) {
    const got = paramsSchema[name];
    if (!got) continue;
    if (r.at === "time" && got.format !== "datetime") out.push(`"run_time" is the moment it runs — an instant, never a month or a number`);
    if (r.at === "day" && (got.per === "month" || got.type === "number" || got.type === "integer")) out.push(`"run_day" is the day it runs — compare a date with it directly`);
  }
  for (const name of Object.keys(paramsSchema)) if (!want.has(name) && !isRunParam(name)) out.push(`"${name}" is not a parameter of the contract — a parameter is a question put to the person: write the value as a fixed one, or leave it out`);
  return out;
}


/**
 * The spec once the read is written — BY CODE, never a second understanding call: the choice becomes the written read; each
 * contract parameter's value fills it (a range's one value fills its start, and a copy fills its end); the words the read carries
 * out are covered, except what it reports it could not give (`leftOut`); and words the read now owns are no longer the person's
 * open question (an interpretation it made is asked as its own `assumed` confirmation instead).
 */
export function applyContract(spec: GoalSpec, choice: string, ref: string, c: ReadContract, leftOut: readonly string[], used: readonly string[] = []): GoalSpec {
  // The present a read compares with is the automation's to supply — recorded here, bound by the solver to the engine's own value.
  const run = used.filter(isRunParam).map((name) => ({ fills: `${ref}.${name}`, at: RUN_PARAMS[name].at }));
  const runParams = [...(spec.runParams ?? []).filter((x) => !x.fills.startsWith(`${ref}.`)), ...run];
  const values = spec.values.map((v) => ({ ...v }));
  const copies: GoalSpec["values"] = [];
  for (const p of c.params) {
    if (p.end === "end") { copies.push({ ...spec.values[p.value]!, fills: `${ref}.${p.name}` }); continue; }
    values[p.value] = { ...values[p.value]!, fills: `${ref}.${p.name}` };
  }
  const done = c.words.filter((w) => !leftOut.some((l) => inside(l, w) || inside(w, l)));
  const owns = (q: string) => done.some((w) => inside(q, w));
  return {
    ...spec,
    sources: spec.sources.map((x) => (x.ref === choice ? { ...x, ref } : x)),
    values: [...values, ...copies],
    conditions: spec.conditions.map((x) => (x.by === choice ? { ...x, by: ref } : x)),
    // builder-behaviour P1 (B17): EVERY part that refers to the read follows it — the flow's own lists over it (their source and
    // the fields their stages read) and its summary. Renaming only the source left a chain's two lists over a read that no longer
    // existed, and both conditions were dropped in silence.
    ...(spec.shapes ? { shapes: withReader(spec.shapes, choice, ref) } : {}),
    ...(spec.summary ? { summary: withReader(spec.summary, choice, ref) } : {}),
    ...(spec.unclear ? { unclear: spec.unclear.filter((u) => !owns(u.quote)) } : {}),
    covered: [...(spec.covered ?? []).filter((x) => x.by !== ref), ...done.map((quote) => ({ quote, by: ref }))],
    ...(runParams.length ? { runParams } : {}),
  };
}
