/**
 * The manual builder's client half (compiled-builder phase 7, D-330): pure helpers over what the server returns. The server
 * lists every action (`canvasActions`) and applies it; this module only groups the list by where it sits and puts the state
 * into words and a graph. It builds no op, no step and no expression — there is nothing here that could.
 */
import { describeComb, fieldLabel, type EFlow, type EStep, type Diagnostic, type ESource, type StepShape, type DecideTest, type SplitSide, type SlotValue, type SlotView, type Comb, type Pred, type Operand, type Agg } from "@foundry/flow-edit";
import type { StepPorts } from "@/lib/flow-field-drop";
import { canvasFromRawModel, endOutputFrom, END_ID, START_ID, startEntryFrom, startInputsFrom, withEnd, withStart, type CanvasFrame, type CanvasGraph } from "@/lib/canvas-model";

export type CanvasWhere =
  | { at: "palette"; under?: string }
  | { at: "port"; stepId: string; port: string }
  | { at: "stages"; stepId: string }
  | { at: "step"; stepId: string }
  | { at: "flow" };

export interface ActionView {
  id: string;
  where: CanvasWhere;
  kind?: "reader" | "transform" | "call" | "gate" | "condition" | "merge" | "loop";
  label: string;
  op?: { op: string; [k: string]: unknown };
  /** A value the person types; the server judges it. `ty` is the engine's type, shown as a hint only. */
  slot?: { ty: unknown; what: string };
  /** A condition on ONE value (phase C): what it tests — for grouping and wording; `of` when it continues that chain. */
  decide?: { subject: string; field: string; counts: boolean; cmp: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; words: string; cmpWords: string; of?: string; rows?: true };
  /** A Split (phase C): the rows divided by a test on one field — the matched rows and the rest, each its own path. */
  split?: { subject: string; field: string; cmp: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; words: string; cmpWords: string };
  /** Phase C: a change to what an existing condition compares — the engine's words, and what it compares now. */
  retest?: { testStep: string; subject: string; field: string; cmp: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; words: string; cmpWords: string; current: { cmp: string; value: string }; stage?: number };
  /** For a source offered to an input: where it comes from — the engine's words, the picker's group (phase C). */
  group?: string;
}

/** What a value test compares, and in which words — a Decide's or a Split's, both the engine's. */
export const valueTestOf = (a: ActionView) => a.decide ?? a.split ?? a.retest;
export interface ValueTestGroup { key: string; kind: "decide" | "split" | "retest"; words: string; of?: string; subject: string; set: ActionView[] }
/**
 * Value tests (Decide and Split, their words the engine's), one group per tested value — the comparisons of one value are ONE form,
 * never one control each.
 */
export function decideGroups(actions: ActionView[]): ValueTestGroup[] {
  const out = new Map<string, ValueTestGroup>();
  for (const a of actions) {
    const t = valueTestOf(a);
    if (!t || !a.slot) continue;
    const kind = a.decide ? "decide" : a.split ? "split" : "retest", of = a.decide?.of;
    // Keyed by the engine's words, not the field alone: a list's count (`n`) and a row field named `n` are two values.
    const key = `${kind}|${of ?? a.retest?.testStep ?? ""}|${a.retest?.stage ?? ""}|${t.subject}|${t.words}`;
    if (!out.has(key)) out.set(key, { key, kind, words: t.words, subject: t.subject, ...(of ? { of } : {}), set: [] });
    out.get(key)!.set.push(a);
  }
  return [...out.values()];
}

export interface CanvasView {
  state: EFlow; sig: string; actions: ActionView[]; diagnostics: Diagnostic[]; complete: boolean;
  /** Present when this is the flow's WORKING COPY — no revision holds it — with what the goal asked that it does not do (D-342). */
  working?: { notBuilt: string[] };
  /** Unset ports the receiver fills with whoever starts the run (the mail tool's `to`). Absent from an older server. */
  requesterPorts?: Array<{ stepId: string; port: string }>;
  /** Each step's structure (phase Z) — typed inputs and their values, typed output fields, a condition's paths, who reads it. */
  shape?: Record<string, StepShape>;
  /** Per input (`step.port`): the steps it may NOT read, each with the engine's reason (phase C). Absent from an older server. */
  unreadable?: Record<string, Array<{ stepId: string; why: string }>>;
  /** Per reader step that carries its own query: the query in words (code-written clauses) and as it runs. Absent from an older server. */
  queries?: Record<string, QueryView>;
}
/** A reader's query: `written` for this automation by the builder, or a `table` reader built from the schema. */
export interface QueryView { kind: "written" | "table"; datasource: string; clauses: Array<{ label: string; text: string; note?: string }>; sql: string; params: string[] }
/** An input's offered sources in the engine's groups, in first-seen order; actions with no group (typed values, run-time choices) last. */
export function portGroups(actions: ActionView[]): Array<{ group: string | null; actions: ActionView[] }> {
  const out = new Map<string | null, ActionView[]>();
  for (const a of actions) { const g = a.group ?? null; out.set(g, [...(out.get(g) ?? []), a]); }
  return [...out.entries()].sort(([a], [b]) => (a === null ? 1 : 0) - (b === null ? 1 : 0)).map(([group, actions]) => ({ group, actions }));
}
export type CanvasOpen = CanvasView | { legacy: string };
export type CanvasActResult = CanvasView | { refused: string };
export type CanvasSaveResult = { status: "complete"; revision: number } | { status: "incomplete"; holes: number };

export const isLegacy = (o: CanvasOpen): o is { legacy: string } => "legacy" in o;

const sameWhere = (a: CanvasWhere, b: CanvasWhere) => JSON.stringify(a) === JSON.stringify(b);
export const actionsAt = (v: CanvasView, where: CanvasWhere) => v.actions.filter((a) => sameWhere(a.where, where));

/** The palette at a place (top level, or inside a condition), grouped by what kind of step each entry drops. */
export function paletteGroups(v: CanvasView, under?: string): Array<{ kind: NonNullable<ActionView["kind"]>; title: string; actions: ActionView[] }> {
  const TITLE: Record<NonNullable<ActionView["kind"]>, string> = { reader: "Read data", transform: "Shape data", call: "Do something", merge: "Join the branches", gate: "Approval", condition: "Condition", loop: "For each" };
  const here = actionsAt(v, under ? { at: "palette", under } : { at: "palette" });
  const order: Array<NonNullable<ActionView["kind"]>> = ["reader", "transform", "call", "merge"];
  return order.map((kind) => ({ kind, title: TITLE[kind], actions: here.filter((a) => a.kind === kind) })).filter((g) => g.actions.length);
}

/** One entry under a kind in "Add a step": the action, in short words, where it goes, and a heading to group it under. */
export interface StepChoice { action: ActionView; title: string; detail?: string; group?: string; place?: string; /** The place in words: "for each each_1", "condition when_1". */ placeTitle?: string; /** A Decide: every comparison of one value, offered as one form. */ decideSet?: ActionView[]; decideWords?: string }
export interface StepKindMenu { kind: NonNullable<ActionView["kind"]>; title: string; blurb: string; unavailable: string; choices: StepChoice[] }

const lastSeg = (ref: string) => ref.split(".").pop() ?? ref;
/** "<source>.table.<name>" is a whole table (D-311); anything else is a saved operation or query. */
const refWhat = (ref: string) => { const p = ref.split("."); return { source: p[0], table: p.length > 2 && p[p.length - 2] === "table" }; };

function choiceOf(a: ActionView): StepChoice {
  const op = (a.op ?? {}) as Record<string, unknown>;
  const place = a.where.at === "palette" ? a.where.under : undefined;
  const ref = typeof op.ref === "string" ? op.ref : undefined;
  switch (a.kind) {
    case "reader": {
      if (!ref) return { action: a, title: "Choose the data later", place };
      const w = refWhat(ref);
      return { action: a, title: lastSeg(ref), detail: w.table ? "whole table" : "operation", group: w.source, place };
    }
    case "transform": {
      const i = a.label.indexOf(": ");
      return { action: a, title: i >= 0 ? a.label.slice(i + 2) : a.label, group: typeof op.from === "string" ? `from ${op.from}` : undefined, place };
    }
    case "call":
      return { action: a, title: ref ? lastSeg(ref) : a.label, detail: typeof op.over === "string" ? `once per row of ${op.over}` : "once", group: ref?.includes(".") ? ref.split(".")[0] : undefined, place };
    case "gate":
      return { action: a, title: `Before ${a.where.at === "step" ? a.where.stepId : "this step"}`, place };
    case "condition":
      return { action: a, title: a.label.replace(/^./, (c) => c.toUpperCase()), group: a.where.at === "step" ? `on ${a.where.stepId}` : undefined, place };
    case "loop":
      return { action: a, title: typeof op.over === "string" ? `Each row of ${op.over}` : a.label, detail: "one item at a time, on its own path", place };
    default:
      return { action: a, title: a.label.replace(/^./, (c) => c.toUpperCase()), place };
  }
}

/**
 * Every action that ADDS a step, arranged by the kind of step it adds — the palette's and the ones the engine lists on a step (a
 * condition on a list, an approval before an action), which the flat palette never showed. Always all six kinds, in one order; a
 * kind with nothing to add says why. Only arranges what the engine listed.
 */
export function addStepKinds(v: CanvasView): StepKindMenu[] {
  const KINDS: Array<Omit<StepKindMenu, "choices">> = [
    { kind: "reader", title: "Read data", blurb: "A saved operation or a whole table.", unavailable: "No data source can be read here." },
    { kind: "transform", title: "Shape data", blurb: "Filter, group, count or pick fields from a list.", unavailable: "Read some data first." },
    { kind: "condition", title: "Condition", blurb: "Run the next steps only when a value holds — a count, a total, a field — or when a list has rows.", unavailable: "Read or shape a list first." },
    { kind: "gate", title: "Approval", blurb: "A person approves before an action runs.", unavailable: "Add an action first." },
    { kind: "call", title: "Do something", blurb: "Send, post, create or summarise.", unavailable: "No action is available here." },
    { kind: "merge", title: "Join paths", blurb: "One value from whichever condition path ran.", unavailable: "Needs two condition paths that each give a value." },
    { kind: "loop", title: "For each", blurb: "Run steps once per item of a list — each item takes its own path. The steps after it read one row per item.", unavailable: "Needs a list with a row limit first (Shape data, then keep the first …)." },
  ];
  const adds = v.actions.filter((a) => a.kind && (a.where.at === "palette" || a.kind === "condition" || a.kind === "gate"));
  const plain = adds.filter((a) => !valueTestOf(a));
  const decides = decideGroups(adds).map((g): StepChoice => {
    const lead = g.kind === "split" ? "Split" : g.of ? "Otherwise, when" : "When";
    return { action: g.set[0]!, title: `${lead} ${g.words} …`, group: g.of ? `continue ${g.of}` : `on ${g.subject}`, decideSet: g.set, decideWords: `${lead} ${g.words}` };
  });
  const titled = (c: StepChoice): StepChoice => (c.place ? { ...c, placeTitle: placeWords(v, c.place) } : c);
  return KINDS.map((k) => ({ ...k, choices: [...plain.filter((a) => a.kind === k.kind).map(choiceOf), ...(k.kind === "condition" ? decides : [])].map(titled) }));
}

/** Where a step dropped `under` a step goes, in words: inside a condition's path, or inside a loop (phase F). */
export const placeWords = (v: CanvasView, under: string) => (v.state.steps.find((s) => s.id === under)?.kind === "for_each" ? `for each ${under}` : `condition ${under}`);

/** The conditions a step can be dropped into — each is its own palette. */
export const armsWithPalette = (v: CanvasView) => [...new Set(v.actions.flatMap((a) => (a.where.at === "palette" && a.where.under ? [a.where.under] : [])))];

const sourceText = (s: ESource | null): string => {
  if (!s) return "not set";
  switch (s.from) {
    case "input": return `the run's input ${s.inputId}`;
    case "step": return `${s.stepId}.${fieldLabel(s.field)}`;
    case "whole": return `${s.stepId}, as text`;
    case "literal": return JSON.stringify(s.value);
  }
};

/** A step in words — what it reads, what it does, and every binding — never its stored expression. */
export function stepLines(step: EStep): string[] {
  switch (step.kind) {
    case "datasource": return [step.ref ? `Reads ${step.ref}` : "Reads data — which is not chosen yet", ...step.inputs.map((b) => `${b.name} ← ${sourceText(b.source)}`)];
    case "tool": return [`Calls ${step.ref}${step.over ? `, once per row of ${step.over.stepId}` : " once"}`, ...step.inputs.map((b) => `${b.name} ← ${sourceText(b.source)}`)];
    case "transform": return [`From ${step.from}:`, ...step.pipeline.map((c) => `· ${describeComb(c)}`)];
    case "approval": return [`A person approves: “${step.summary}”`];
    case "branch": return [step.conditions?.length ? `${step.elseOf ? "Otherwise, when" : "Only when"} ${step.conditions.map((c) => `${c.left.stepId} has ${c.op === "any" ? "rows" : "no rows"}`).join(" and ")}` : `Otherwise (when ${step.elseOf} does not hold)`];
    case "merge": return [`One value from whichever ran of ${step.sources.join(", ")}`];
    case "for_each": return [`For each row of ${step.over.stepId}`, `${step.concurrency} at a time`, step.onError === "stop" ? "Stops the run if one item fails" : "Keeps going if one item fails"];
    case "collect": return [`One row per item of ${step.loop}`, `Each row's result: ${step.result}`];
  }
}

/** The ports a step shows: every one the engine lists an action for, and every one already bound. */
export function portsOfStep(v: CanvasView, stepId: string): string[] {
  const s = v.state.steps.find((x) => x.id === stepId);
  const bound = s && "inputs" in s ? s.inputs.map((b) => b.name) : [];
  const listed = v.actions.flatMap((a) => (a.where.at === "port" && a.where.stepId === stepId ? [a.where.port] : []));
  const holes = v.state.holes.flatMap((h) => (h.site.at === "port" && h.site.stepId === stepId ? [h.site.port] : []));
  return [...new Set([...holes, ...bound, ...listed])];
}

/** The binding at a port, in words, or `null` when nothing is bound there. */
export function boundAt(v: CanvasView, stepId: string, port: string): string | null {
  const s = v.state.steps.find((x) => x.id === stepId);
  const b = s && "inputs" in s ? s.inputs.find((x) => x.name === port && x.source) : undefined;
  if (b) return sourceText(b.source);
  // Not empty: the receiver sends it to the person who started the run (2026-09-28: "why is the email to field empty?").
  return v.requesterPorts?.some((r) => r.stepId === stepId && r.port === port) ? REQUESTER_WORDS : null;
}

/** What an unset requester-filled port means, in the words every surface uses. */
export const REQUESTER_WORDS = "you — whoever starts the run";

/** What is still undecided ON a node — drawn on the node itself, not in a separate list. */
export const holesOn = (v: CanvasView, stepId: string) => v.state.holes.filter((h) => h.site.at !== "output" && h.site.stepId === stepId);

/** The graph the canvas draws: the state's own steps, each node flagged with what is still undecided on it. */
export function graphOf(v: CanvasView): CanvasGraph {
  const flagged = new Map<string, string>();
  for (const s of v.state.steps) {
    const hs = holesOn(v, s.id);
    if (hs.length) flagged.set(s.id, hs.map((h) => h.reason).join(" · "));
  }
  // A condition's continuation with no test is the catch-all; with one it is an elif (`conditionExpr` marks that for the adapter).
  // Phase C (D-371): a Decide's test step is part of its condition — not drawn as a card; the condition hangs off what it tests.
  const testOf = new Map(v.state.steps.flatMap((s) => { const t = v.shape?.[s.id]?.testFor && s.kind === "transform" ? s.from : null; return t ? [[s.id, t] as const] : []; }));
  const raw = { steps: v.state.steps.filter((s) => !testOf.has(s.id)).map((s) => (s.kind === "branch" && s.conditions?.length
    ? { ...s, dependsOn: [...new Set(s.dependsOn.map((d) => testOf.get(d) ?? d))], conditionExpr: stepLines(s)[0] } : s)) };
  const g = canvasFromRawModel(raw, flagged);
  const branches = new Set(v.state.steps.filter((s) => s.kind === "branch").map((s) => s.id));
  // Phase Z: the card IS the component — its rows carry the configuration (`cardRows`), so a wire carries no words; a condition's
  // IF / ELSE sits on its rows beside the exits, never repeated on every wire.
  const steps: CanvasGraph = {
    ...g,
    nodes: g.nodes.map((n) => {
      const sh = v.shape?.[n.id];
      if (sh?.perRow) return { ...n, meta: `for each row of ${sh.perRow}` };
      if (sh?.inLoop) return { ...n, meta: `once per item of ${sh.inLoop}` };
      // A Split's exits (phase C): each filter is the rows its path reads — named as that exit, kept as a card because it IS data.
      if (sh?.split) return { ...n, meta: sh.split.side === "matched" ? `split of ${sh.split.subject}: the matching rows` : `split of ${sh.split.subject}: the rest` };
      return n;
    }),
    // Phase C: a link leaving a condition is a PATH (when its step runs), never data — drawn apart.
    edges: g.edges.map((e) => ({ ...e, noLabel: true, ...(e.sourceHandle || branches.has(e.source) ? { kind: "path" as const } : {}) })),
  };
  // The entry and the exit, as every other canvas draws them (2026-09-29: they went missing when chat moved onto this canvas):
  // Start carries the run's inputs and how it is entered, End the declared result. `withEnd` wraps from the outside so a
  // boundary is never taken for a leaf.
  const whole = withEnd(withStart(steps, startInputsFrom(v.state.inputs), startEntryFrom(v.state.schedule, undefined)), endOutputFrom(v.state.output));
  const frames = loopFrames(v, new Set(whole.nodes.map((n) => n.id)));
  // One link can carry several things into one step (`body` AND the attachment's rows from the same list): then — and only then —
  // it says what, since one bare line reads as one use (2026-10-01). A link carrying one thing stays wordless; the card says it.
  const carries = (e: { source: string; target: string }) => {
    const { main, groups, more } = splitInputs(v.shape?.[e.target]?.inputs ?? []);
    const from = (i: SlotView) => "var" in i.value && i.value.var.stepId === e.source;
    return [...[...main, ...more].filter(from).map((i) => humanPort(i.name)), ...groups.filter((g) => g.inputs.some(from)).map((g) => g.label.toLowerCase())];
  };
  return {
    ...whole,
    edges: whole.edges.map((e) => {
      const what = e.kind === "path" ? [] : carries(e);
      return what.length > 1 ? { ...e, noLabel: false, label: what.join(" + "), labelAlways: true } : { ...e, noLabel: true };
    }),
    ...(frames.length ? { frames } : {}),
  };
}

/**
 * Each loop's box (phase F, F4): the loop's card (its header — the link into the box lands on it), the steps inside, and its
 * output (the link out of the box leaves from it). Read off the engine's shape; a condition's hidden test is not a card, so it is
 * not in the box either.
 */
export function loopFrames(v: CanvasView, drawn: Set<string>): CanvasFrame[] {
  const out: CanvasFrame[] = [];
  for (const s of v.state.steps) {
    const l = s.kind === "for_each" ? v.shape?.[s.id]?.loop : undefined;
    if (!l) continue;
    const members = [s.id, ...l.members, ...(l.collect ? [l.collect] : [])].filter((id) => drawn.has(id));
    out.push({ id: s.id, label: `For each row of ${l.over}`, detail: `${l.concurrency} at a time · ${l.onError === "stop" ? "stops if one fails" : "keeps going if one fails"}${l.members.length ? "" : " · nothing inside yet"}`, members });
  }
  return out;
}

/** The entry and exit cards are drawn, not authored: no link begins or ends on them. */
export const isBoundaryNode = (id: string) => id === START_ID || id === END_ID;

// ── tokens: a component's configuration as a workflow tool draws it ─────────────
/** One token of a component's configuration: a field, an operator, a value, a variable (step output), a run input, or a note. */
export interface Token { t: string; k: "field" | "op" | "value" | "var" | "input" | "dim" | "warn" }
/** A field token, in words for a loop's own `ff_` fields ("loop: worked"). */
const F = (t: string): Token => ({ t: fieldLabel(t), k: "field" });
const O = (t: string): Token => ({ t, k: "op" });
const V = (t: string): Token => ({ t, k: "value" });
const operandTok = (o: Operand): Token => ("field" in o ? F(o.field) : "input" in o ? { t: o.input, k: "input" } : V(typeof o.lit.value === "string" ? `"${o.lit.value}"` : String(o.lit.value)));
const CMP: Record<string, string> = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥" };
export function predTokens(p: Pred): Token[] {
  if ("cmp" in p) return [operandTok(p.left), O(CMP[p.cmp]!), operandTok(p.right)];
  if ("isNull" in p) return [F(p.isNull), O("is empty")];
  if ("notNull" in p) return [F(p.notNull), O("is not empty")];
  if ("isBlank" in p) return [F(p.isBlank), O("is blank")];
  if ("and" in p) return p.and.flatMap((x, i) => (i ? [O("and"), ...predTokens(x)] : predTokens(x)));
  if ("or" in p) return p.or.flatMap((x, i) => (i ? [O("or"), ...predTokens(x)] : predTokens(x)));
  return [O("not"), ...predTokens(p.not)];
}
const FN: Record<Agg["fn"], string> = { sum: "Sum", avg: "Average", min: "Min", max: "Max", count: "Count", count_where: "Count where", collect: "Collect", first: "First", distinct_count: "Count distinct", collect_distinct: "Collect distinct", share: "Share where", join: "Join" };
const aggRow = (a: Agg) => ({ op: FN[a.fn], tokens: [...(a.field ? [F(a.field)] : []), ...(a.where && (a.fn === "count_where" || a.fn === "share") ? predTokens(a.where) : []), O("→"), F(a.as)] });
const partsText = (ps: Array<{ text: string } | { field: string } | { opt: string }>) => V(`"${ps.map((x) => ("text" in x ? x.text : `{${"field" in x ? x.field : x.opt}}`)).join("")}"`);
/** One stage of a transform as the operation rows a list-operator node shows: an operation name and its tokens. */
export function stageRows(c: Comb): Array<{ op: string; tokens: Token[] }> {
  switch (c.op) {
    case "filter": return [{ op: "Filter", tokens: predTokens(c.where) }];
    case "keep_if": return [{ op: "Keep if", tokens: predTokens(c.where) }];
    case "project": return [{ op: "Keep", tokens: c.fields.map((x) => F("from" in x && x.from !== x.name ? `${x.from} → ${x.name}` : x.name)) }];
    case "template": return [{ op: "Add", tokens: [F(c.as), O("="), partsText(c.parts)] }];
    case "join_text": return [{ op: "Join as text", tokens: [partsText(c.parts)] }];
    case "count": return [{ op: "Count", tokens: [O("→"), F(c.as)] }];
    case "sort": return [{ op: "Sort", tokens: [...[c.by].flat().map(F), O(c.dir === "asc" ? "ascending" : "descending")] }];
    case "limit": return [{ op: "Limit", tokens: [V(String(c.n.value))] }];
    case "distinct": return [{ op: "Unique", tokens: [F(c.by)] }];
    case "first": return [{ op: "First row", tokens: [] }];
    case "coalesce": return [{ op: "If empty", tokens: [F(c.field), O("use"), ...[c.with].flat().map(operandTok)] }];
    case "convert": return [{ op: "Convert", tokens: [F(c.field), O("→"), V(c.to === "minor_to_major" ? "÷ 100" : c.to), O("as"), F(c.as)] }];
    case "derive": return [{ op: "Compute", tokens: [O("→"), F(c.as)] }];
    case "group": return [{ op: "Group by", tokens: c.by.map(F) }, ...c.aggs.map(aggRow)];
    case "summarize": return c.aggs.map(aggRow);
    case "take": return [{ op: "Take list", tokens: [F(c.field)] }];
  }
}
/** A variable reference as a token: `where_1 · text`, `read_1`, `read_1 · email`. */
export const varToken = (r: { stepId: string; field?: string; asText?: boolean }): Token => ({ t: `${r.stepId}${r.field ? ` · ${fieldLabel(r.field)}` : r.asText ? " · text" : ""}`, k: "var" });

/**
 * A Decide's test in the words of what it tests (phase C): "count of read_1 > 3", "sum of amount in read_1 ≥ limit",
 * "read_1 · total = 0" — the value named by where it comes from, never by the hidden step that computes it.
 */
export function testTokens(t: DecideTest, op = "is not empty"): Token[] {
  // A row test: "read_1 has a row where name = blanco" — or, asked as has-none, "has no row where".
  if (t.anyRow) return [varToken({ stepId: t.subject }), O(op === "is empty" ? "has no row where" : "has a row where"), ...predTokens(t.where)];
  const lead = (field: string): Token[] => {
    for (const st of t.before) {
      if (st.op === "count" && st.as === field) return [O("count of"), varToken({ stepId: t.subject })];
      if (st.op === "summarize") {
        const a = st.aggs.find((x) => x.as === field);
        if (a) return a.fn === "count" ? [O("count of"), varToken({ stepId: t.subject })] : [O(`${a.fn} of`), ...(a.field ? [F(a.field), O("in")] : []), varToken({ stepId: t.subject })];
      }
    }
    return [varToken({ stepId: t.subject, field })];
  };
  const p = t.where;
  if ("cmp" in p && "field" in p.left) return [...lead(p.left.field), O(CMP[p.cmp]!), operandTok(p.right)];
  if ("isNull" in p) return [...lead(p.isNull), O("is empty")];
  if ("notNull" in p) return [...lead(p.notNull), O("is not empty")];
  return [varToken({ stepId: t.subject }), ...predTokens(p)];
}
/** One condition's test as tokens: a Decide's value test, or "<list> is (not) empty". */
/** A Split exit's condition (phase C, D-373): "rows of read_1 where score > 50" / "the rest of read_1 (not score > 50)". */
export const splitTokens = (s: SplitSide): Token[] => s.side === "matched"
  ? [O("rows of"), varToken({ stepId: s.subject }), O("where"), ...predTokens(s.where)]
  : [O("the rest of"), varToken({ stepId: s.subject }), { t: "(not", k: "dim" }, ...predTokens(s.where), { t: ")", k: "dim" }];
export const conditionTokens = (c: { var: { stepId: string }; op: string; test?: DecideTest; split?: SplitSide }): Token[] => (c.test ? testTokens(c.test, c.op) : c.split ? splitTokens(c.split) : [varToken(c.var), O(c.op)]);
/** What fills an input, as tokens. */
export function valueTokens(v: SlotValue): Token[] {
  if ("var" in v) return [varToken(v.var)];
  if ("literal" in v) return [V(`"${v.literal}"`), ...("drafted" in v && v.drafted ? [{ t: "drafted", k: "dim" as const }] : [])];
  if ("input" in v) return [{ t: v.input, k: "input" }];
  return [v.unset === "requester" ? { t: REQUESTER_WORDS, k: "dim" } : v.unset === "required" ? { t: "required", k: "warn" } : { t: "—", k: "dim" }];
}

/**
 * The rows a card draws — its configuration, as tokens: a reader's and a call's inputs (name ← value), a transform's operations,
 * a condition's paths (IF / ELIF / ELSE beside its exits). A row fed by a wire names that step, so the wire lands on it.
 */
/**
 * A step's inputs as a person reads them (2026-10-01): the ports that say what it does, each DECLARED group as one thing (a file's
 * rows, name and format read as one "Attachment"), and the optional ports nobody set, folded into "more". Grouping is read off
 * the tool's own declarations (`group`, `needs`) — never off a tool's or a port's name.
 */
export interface InputGroup {
  label: string;
  inputs: SlotView[];
  /** What the group is FED from: the port the others need (a file's rows). */
  feed: SlotView | null;
  /** A member is set and the port it needs is not — the receiver refuses this, so it is shown as a warning. */
  missing: string | null;
}
const isSet = (i: SlotView) => !("unset" in i.value);
export function splitInputs(inputs: SlotView[]): { main: SlotView[]; groups: InputGroup[]; more: SlotView[] } {
  const groups = new Map<string, SlotView[]>();
  const main: SlotView[] = [], more: SlotView[] = [];
  for (const i of inputs) {
    if (i.group) groups.set(i.group, [...(groups.get(i.group) ?? []), i]);
    else if (i.required || isSet(i) || ("unset" in i.value && i.value.unset === "requester")) main.push(i);
    else more.push(i);
  }
  return {
    main,
    more,
    groups: [...groups.entries()].map(([label, members]) => {
      const needed = new Set(members.flatMap((m) => (m.needs ? [m.needs] : [])));
      const feed = members.find((m) => needed.has(m.name)) ?? null;
      const unmet = members.find((m) => m.needs && isSet(m) && !isSet(members.find((x) => x.name === m.needs) ?? m));
      return { label, inputs: members, feed, missing: unmet ? `${humanPort(unmet.name)} is set, so ${humanPort(unmet.needs!)} must be too — choose which step's data goes in it` : null };
    }),
  };
}
/** The card row a group is drawn as — and what a link dropped on it is matched against. */
export const groupRowName = (label: string) => `📎 ${label.toLowerCase()}`;
/** One line for a group: its set values, then where it is fed from — or "none", or the warning. */
export function groupTokens(g: InputGroup): Token[] {
  if (!g.inputs.some(isSet)) return [{ t: "none", k: "dim" }];
  if (g.missing) return [{ t: `needs ${humanPort(g.feed?.name ?? "")}`, k: "warn" }];
  const values = g.inputs.filter((i) => i !== g.feed && "literal" in i.value).map((i) => V((i.value as { literal: string }).literal));
  const from = g.feed && "var" in g.feed.value ? [O("from"), varToken({ stepId: g.feed.value.var.stepId })] : [];
  return [...values.flatMap((t, k) => (k ? [{ t: "·", k: "dim" as const }, t] : [t])), ...from];
}

export function cardRows(v: CanvasView): Map<string, StepPorts> {
  const out = new Map<string, StepPorts>();
  const tok = (tokens: Token[], stepId?: string) => ({ kind: "tokens" as const, tokens, ...(stepId ? { stepId } : {}) });
  for (const step of v.state.steps) {
    const sh = v.shape?.[step.id];
    if (!sh) continue;
    let rows: Array<{ name: string; source: ReturnType<typeof tok> }> = [];
    if (step.kind === "transform") rows = step.pipeline.flatMap(stageRows).map((r) => ({ name: r.op, source: tok(r.tokens) }));
    else if (step.kind === "branch") rows = step.elseOf ? [] : (sh.paths ?? []).map((p) => ({ name: p.label, source: tok(p.conditions.length ? p.conditions.flatMap((c, i) => [...(i ? [O("and")] : []), ...conditionTokens(c)]) : [{ t: "otherwise", k: "dim" }]) }));
    else if (step.kind === "datasource" || step.kind === "tool") {
      // The ports that say what it does, then each declared group as ONE row, then the rest (counted past the card's cap).
      const { main, groups, more } = splitInputs(sh.inputs);
      const row = (i: SlotView) => ({ name: i.name, source: tok(valueTokens(i.value), "var" in i.value ? i.value.var.stepId : undefined) });
      rows = [
        ...main.map(row),
        ...groups.map((g) => ({ name: groupRowName(g.label), source: tok(groupTokens(g), g.feed && "var" in g.feed.value ? g.feed.value.var.stepId : undefined) })),
        ...more.map(row),
      ];
    }
    else if (step.kind === "for_each") rows = [
      { name: "Items", source: tok([O("each row of"), varToken({ stepId: step.over.stepId })], step.over.stepId) },
      { name: "At once", source: tok([V(String(step.concurrency))]) },
      { name: "If one fails", source: tok([{ t: step.onError === "stop" ? "stop the run" : "keep going", k: "dim" }]) },
    ];
    else if (step.kind === "collect") rows = [{ name: "Result", source: tok([varToken({ stepId: step.result }), O("for each item")], step.result) }];
    if (!rows.length) continue;
    out.set(step.id, { fields: rows, wholeFrom: null, bindable: step.kind === "tool" || step.kind === "datasource" });
  }
  return out;
}

/** Every error and undecided item, in words, for the status strip. An error here is a server defect (the canvas cannot make one). */
export const openItems = (v: CanvasView) => v.diagnostics.filter((d) => d.severity === "hole" || d.severity === "error").map((d) => d.message);

/**
 * A drawn link, as the engine's own action (phase Z, Z2): dragging `from` onto `to` (or onto one of its rows) is the listed `bind`
 * that feeds a port of `to` from `from`. One such action ⇒ take it; several ⇒ the person picks the port; none ⇒ why, in words.
 * The canvas never builds a binding itself — what is not listed cannot be drawn.
 */
export type LinkIntent = { take: ActionView } | { choose: ActionView[] } | { refuse: string };
const humanPort = (p: string) => p.replace(/_+/g, " ");
export function linkIntent(v: CanvasView, from: string, to: string, row?: string): LinkIntent {
  if (isBoundaryNode(from) || isBoundaryNode(to)) return { refuse: "Start and End are drawn from the flow — a link cannot begin or end on them." };
  // A link dropped on a group's row feeds the group's feed port (a file's rows).
  const groupFeed = row === undefined ? undefined : splitInputs(v.shape?.[to]?.inputs ?? []).groups.find((g) => groupRowName(g.label) === row)?.feed?.name;
  const binds = v.actions.filter((a) => a.where.at === "port" && a.where.stepId === to && a.op?.op === "bind"
    && (a.op.source as { stepId?: string } | undefined)?.stepId === from
    && (row === undefined || humanPort(a.where.port) === row || a.where.port === row || a.where.port === groupFeed));
  if (binds.length === 1) return { take: binds[0]! };
  if (binds.length > 1) return { choose: binds };
  const sh = v.shape;
  const out = sh?.[from]?.output;
  const gives = !out ? "nothing another step can read" : "fields" in out ? `${out.list ? "rows of " : ""}${out.fields.map((x) => x.name).join(", ")}` : out.type;
  const target = v.state.steps.find((s) => s.id === to);
  if (from === to) return { refuse: "A step cannot feed itself." };
  if (target?.kind === "transform" || target?.kind === "branch" || target?.kind === "merge") {
    return { refuse: `${to} takes what it reads when it is added — it cannot be re-pointed by a link. Add a new step from ${from} instead.` };
  }
  const already = sh?.[to]?.inputs.some((i) => "var" in i.value && i.value.var.stepId === from);
  if (already) return { refuse: `${to} already takes ${from}'s output${row ? ` — ${row} cannot take it as well` : ""}.` };
  return { refuse: `${row ? `${to}'s ${row}` : `No input of ${to}`} can take what ${from} gives (${gives}).` };
}
/** Removing a drawn link is the listed `unbind` of the port that link feeds — or why not. */
export function unlinkIntent(v: CanvasView, from: string, to: string): LinkIntent {
  if (isBoundaryNode(from) || isBoundaryNode(to)) return { refuse: "That line is drawn from where the flow starts or ends — there is no link to remove." };
  const s = v.state.steps.find((x) => x.id === to);
  const ports = s && "inputs" in s ? s.inputs.filter((b) => b.source && "stepId" in b.source && b.source.stepId === from).map((b) => b.name) : [];
  const clears = v.actions.filter((a) => a.where.at === "port" && a.where.stepId === to && a.op?.op === "unbind" && ports.includes(a.where.port));
  if (clears.length === 1) return { take: clears[0]! };
  if (clears.length > 1) return { choose: clears };
  return { refuse: `This link is not a value you can clear — ${to} runs after ${from} because of where it sits (its condition or what it reads when added).` };
}

/**
 * A step in a few plain words, read off the step itself — never off a name this code knows. A call is its component's name in
 * words, with the first fixed text it was given (its title or subject, whatever that component calls it); a read is what it reads;
 * a list is its first change. Generic by construction: the same rule for a tool or table this code has never seen.
 */
export function stepWords(f: EFlow, id: string): string {
  const s = f.steps.find((x) => x.id === id);
  if (!s) return id;
  const words = (ref: string) => ref.split(".").at(-1)!.replace(/[_-]+/g, " ").trim();
  switch (s.kind) {
    case "tool": {
      const lit = s.inputs.map((b) => b.source).find((x): x is { from: "literal"; value: string } => !!x && typeof x === "object" && (x as { from?: string }).from === "literal" && typeof (x as { value?: unknown }).value === "string" && !!(x as { value: string }).value.trim());
      return lit ? `${words(s.ref)} — “${lit.value}”` : words(s.ref);
    }
    case "datasource": return s.ref ? `read ${words(s.ref)}` : "read (not chosen yet)";
    case "transform": {
      const first = s.pipeline[0];
      if (!first) return "pass the rows on";
      const r = stageRows(first)[0];
      return r ? `${r.op.toLowerCase()} ${r.tokens.map((t) => t.t).join(" ")}`.trim() : "change the rows";
    }
    case "branch": return s.elseOf ? "otherwise" : "condition";
    case "approval": return s.summary ? `ask a person: ${s.summary}` : "ask a person";
    case "merge": return "take whichever path ran";
    case "for_each": return "for each row";
    case "collect": return "one row per item";
  }
  return id;
}
