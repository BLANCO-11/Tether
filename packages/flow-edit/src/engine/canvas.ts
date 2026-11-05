/**
 * The CANVAS adapter (compiled-builder phase 7, D-328): the manual builder's every gesture, as `legalMoves` offers it. The
 * canvas is the second front end on the same ops, holes and legal moves the LLM builder uses — so it can reach every flow the
 * builder can (`optionsOf`'s ops are all here, asserted), and no state the checker refuses (the property test walks it).
 *
 * Where each action sits on the canvas:
 * - `palette` — drop a new step: at the top level, or (`under`) into a condition's arm;
 * - `port` — a call's or reader's input: the type-compatible sources, a value the person types, or clearing it;
 * - `stages` — a transform's pipeline editor: the next stage (the combinators), or one that takes a value;
 * - `step` — a node's menu: choose its component, gate it, test it in a condition, continue its chain, make it the result,
 *   remove it;
 * - `flow` — the flow's settings: its inputs and its schedule.
 * - for each (phase F): the palette drops a loop over a list; `palette` with `under` a loop places a step inside it; the loop's
 *   node menu holds its settings and closes it (its output, one row per item); the output's menu changes each row's result.
 *
 * ⚠ Nothing here writes an expression. A person types a VALUE only, into a typed slot (`CanvasSlot`); `apply` judges it with
 * the same `literalFits` it applies to a goal's quote, so a value that does not fit is refused by name, never saved. The raw
 * jq/Pebble box has no counterpart here — there is no op it could become.
 *
 * ⚠ A person's edits are not the builder's construction: removal (`remove_step`, `unbind`, `remove_input`) and clearing a
 * schedule are offered here, where `optionsOf` deliberately does not offer them.
 */
import type { CatalogueSnapshot } from "../typecheck/signature.js";
import { render, type Ty } from "../typecheck/types.js";
import { legalMoves } from "./legal.js";
import { armOfStep, chainHead, loopOfStep, type EFlow, type Hole } from "./model.js";
import { apply, fieldLabel, MAX_CONCURRENCY, readableTy, readersOf, type Applied, type BindSource, type EngineOp } from "./ops.js";
import type { Cmp } from "../ir/combinators.js";
import { decideTest, splitSide } from "./shape.js";
import { decideField, decideOps, personNumber, retestOps, rowFieldsBefore, splitOps, stageRetestOps, testOf, type DecideSpec } from "./value-tests.js";
import { describeComb, freshStepId, inputIdFor, INPUT_TYPES, runTimeChoices, sourceWords, whenWords } from "./options.js";
import { adversarialLiteral, rng, sampleLiteral } from "./walk.js";

export type CanvasWhere =
  | { at: "palette"; under?: string }
  | { at: "port"; stepId: string; port: string }
  | { at: "stages"; stepId: string }
  | { at: "step"; stepId: string }
  | { at: "flow" };

/** A value the person types. `make` turns it into the op; `apply` then judges the value (the constants rule). */
/**
 * A value the person types, and the move it makes. `kind` is the op the move ends in — declared, so nothing learns an action's kind
 * by calling `make` with a made-up value. `make` may refuse a value in words (a number field given words).
 */
export interface CanvasSlot { ty: Ty; what: string; kind: EngineOp["op"]; make: (value: string) => EngineOp | EngineOp[] | { refused: string } }
/** What a Decide action tests (phase C) — for a front end to word it; the ops are the truth. `of` set: an else-if continuing `of`. */
/**
 * A condition on ONE value (phase C). `words` (the value tested, "the count of read_1") and `cmpWords` ("is more than") are the
 * engine's own wording, carried so no front end keeps a second copy that drifts.
 */
export interface DecideChoice { subject: string; field: string; counts: boolean; cmp: Cmp; words: string; cmpWords: string; of?: string; rows?: true }

/** A Split (phase C, D-373): the rows divided, the value tested on each row. Words are the engine's, as for a Decide. */
export interface SplitChoice { subject: string; field: string; cmp: Cmp; words: string; cmpWords: string }

/**
 * A change to what an existing condition compares (phase C): the condition keeps its field and its paths; the comparison and the
 * value change. `current` is what it compares now, for a form to start from. Words are the engine's, as for a Decide.
 */
export interface RetestChoice { testStep: string; subject: string; field: string; cmp: Cmp; words: string; cmpWords: string; current: { cmp: Cmp; value: string };
  /** A transform's own filter stage (0-based), changed on the transform — absent for a condition's test. */
  stage?: number }

export interface CanvasAction {
  id: string;
  where: CanvasWhere;
  /** What the kind of the dropped step is, for a palette entry — the palette groups by it. */
  kind?: "reader" | "transform" | "call" | "gate" | "condition" | "merge" | "loop";
  label: string;
  op?: EngineOp;
  /** Several of the engine's own moves, applied in order and all-or-nothing (a run-time month: declare the input, bind it). */
  ops?: EngineOp[];
  slot?: CanvasSlot;
  decide?: DecideChoice;
  split?: SplitChoice;
  retest?: RetestChoice;
  /** For a source offered to an input: where it comes from, for the picker's groups (phase C) — the engine's words. */
  group?: string;
}

const STRING_TY: Ty = { t: "Text" };

/** Every action the canvas offers on a state, in a stable order. Ids are `c1…cN` in that order. */
export function canvasActions(f: EFlow, cat: CatalogueSnapshot): CanvasAction[] {
  const out: Array<Omit<CanvasAction, "id">> = [];
  const push = (a: Omit<CanvasAction, "id">) => out.push(a);
  // The same fresh ids `optionsOf` chooses, so the two front ends produce the same op for the same choice.
  const read = freshStepId(f, "read"), shape = freshStepId(f, "shape"), call = freshStepId(f, "call"), gate = freshStepId(f, "gate");
  const flow = { at: "flow" } as const, palette = (under?: string) => ({ at: "palette" as const, ...(under ? { under } : {}) });
  for (const m of legalMoves(f, cat)) {
    switch (m.op) {
      case "declare_input":
        for (const [type, format, words] of INPUT_TYPES) {
          const variants = m.needsDefault ? [{ required: false }] : [{}, { required: false }];
          for (const v of variants) push({ where: flow, label: `ask for a value each run, as ${words}${"required" in v ? " (optional)" : ""}`, slot: { ty: STRING_TY, what: "what the value is called", kind: "declare_input", make: (name) => ({ op: "declare_input", id: inputIdFor(f, name), type, ...(format ? { format } : {}), ...v }) } });
        }
        break;
      case "remove_input":
        for (const id of m.ids) push({ where: flow, label: `stop asking for ${id}`, op: { op: "remove_input", id } });
        break;
      case "retype_input":
        // Changing how an input is asked keeps the input: what reads it is re-judged, never moved to a new one beside it.
        for (const t of m.to) {
          const words = INPUT_TYPES.find(([type, format]) => type === t.type && format === t.format)?.[2] ?? (t.type === "STRING" ? "text" : t.type.toLowerCase());
          push({ where: flow, label: `ask for ${t.id} as ${words} instead`, op: { op: "retype_input", ...t } });
        }
        break;
      case "add_reader":
        for (const ref of m.refs) push({ where: palette(), kind: "reader", label: `read ${ref}`, op: { op: "add_reader", id: read, ref } });
        if (m.unchosen) push({ where: palette(), kind: "reader", label: "read data (choose which later)", op: { op: "add_reader", id: read } });
        for (const b of [...m.unders, ...m.insides]) for (const ref of m.refs) push({ where: palette(b), kind: "reader", label: `read ${ref}`, op: { op: "add_reader", id: read, ref, under: b } });
        break;
      case "choose_reader":
        for (const ref of m.refs) push({ where: { at: "step", stepId: m.stepId }, label: `read ${ref}`, op: { op: "choose_reader", stepId: m.stepId, ref } });
        break;
      case "add_transform":
        for (const st of m.stages) push({ where: palette(), kind: "transform", label: `from ${m.from}: ${describeComb(st)}`, op: { op: "add_transform", id: shape, from: m.from, pipeline: [st] } });
        for (const b of [...m.unders, ...m.insides]) for (const st of m.stages) push({ where: palette(b), kind: "transform", label: `from ${m.from}: ${describeComb(st)}`, op: { op: "add_transform", id: shape, from: m.from, pipeline: [st], under: b } });
        break;
      case "append_stage":
        for (const st of m.stages) push({ where: { at: "stages", stepId: m.stepId }, label: `then ${describeComb(st)}`, op: { op: "append_stage", stepId: m.stepId, stage: st } });
        for (const l of m.literals) push({ where: { at: "stages", stepId: m.stepId }, label: `then ${l.what}`, slot: { ty: l.ty, what: `${l.what} (${render(l.ty)})`, kind: "append_stage", make: (v) => ({ op: "append_stage", stepId: m.stepId, stage: l.make(v) }) } });
        break;
      case "add_call":
        for (const ref of m.refs) push({ where: palette(), kind: "call", label: `call ${ref} once`, op: { op: "add_call", id: call, ref } });
        for (const fo of m.fanouts) push({ where: palette(), kind: "call", label: `call ${fo.ref} once per row of ${fo.over}, ${fo.row.port} ← ${fo.row.field}`, op: { op: "add_call", id: call, ...fo } });
        for (const b of m.unders) for (const ref of m.refs) push({ where: palette(b), kind: "call", label: `call ${ref} once`, op: { op: "add_call", id: call, ref, under: b } });
        for (const b of m.insides) for (const ref of m.refs) push({ where: palette(b), kind: "call", label: `call ${ref} once per item`, op: { op: "add_call", id: call, ref, under: b } });
        break;
      case "bind": {
        const at = { at: "port" as const, stepId: m.stepId, port: m.port };
        for (const s of m.sources) push({ where: at, label: sourceWords(s), group: sourceGroup(f, m.stepId, s), op: { op: "bind", stepId: m.stepId, port: m.port, source: s } });
        if (m.literal) { const lt = m.literal; push({ where: at, label: `a value you type (${render(lt)})`, slot: { ty: lt, what: `${m.port} (${render(lt)})`, kind: "bind", make: (v) => ({ op: "bind", stepId: m.stepId, port: m.port, source: { from: "literal", value: v, provenance: "person" } }) } }); }
        for (const c of runTimeChoices(f, m.stepId, m.port, m.literal)) push({ where: at, label: c.label, ops: c.ops });
        break;
      }
      case "unbind":
        push({ where: { at: "port", stepId: m.stepId, port: m.port }, label: "clear it", op: { op: "unbind", stepId: m.stepId, port: m.port, owner: "person" } });
        break;
      case "add_gate":
        for (const b of m.before) push({ where: { at: "step", stepId: b }, kind: "gate", label: "a person approves before this runs", slot: { ty: { t: "Text", refine: [{ r: "SingleLine" }] }, what: "the question the approver is asked", kind: "add_gate", make: (summary) => ({ op: "add_gate", id: gate, before: b, summary }) } });
        break;
      case "set_output":
        for (const s of m.steps) push({ where: { at: "step", stepId: s }, label: "this is the flow's result", op: { op: "set_output", stepId: s } });
        break;
      case "set_schedule":
        if (m.set) push({ where: flow, label: f.schedule ? "change the schedule" : "run on a schedule", slot: { ty: STRING_TY, what: "when it runs (a cron: minute hour day month weekday)", kind: "set_schedule", make: (cron) => ({ op: "set_schedule", cron }) } });
        if (m.clear) push({ where: flow, label: "stop running on a schedule", op: { op: "set_schedule", cron: null } });
        break;
      case "remove_step":
        for (const s of m.steps) {
          // A condition on one value (phase C) goes with its test: removing the condition alone would leave the test as a step of its
          // own. The test is removed right after, in the same action (all-or-nothing).
          const tests = decideTestsOf(f, s);
          // builder-behaviour P7 (E03): the ONLY step of an "otherwise" goes with it — an otherwise with nothing on it is "otherwise do
          // nothing", which is no otherwise at all. Left, it was a hole ("guards nothing yet") and the edit could never be finished.
          const guard = armOfStep(f).get(s), g = guard ? f.steps.find((x) => x.id === guard) : undefined;
          const emptied = g?.kind === "branch" && g.elseOf && !g.conditions?.length && !f.steps.some((x) => x.kind === "branch" && x.elseOf === g.id)
            && [...armOfStep(f)].filter(([, b]) => b === g.id).length === 1 ? [g.id] : [];
          const all = [...tests, ...emptied];
          push({ where: { at: "step", stepId: s }, label: "remove this step", ...(all.length ? { ops: [{ op: "remove_step", stepId: s }, ...all.map((t) => ({ op: "remove_step" as const, stepId: t }))] } : { op: { op: "remove_step", stepId: s } }) });
        }
        break;
      case "add_branch":
        for (const s of m.subjects) for (const test of ["any", "none"] as const) push({ where: { at: "step", stepId: s }, kind: "condition", label: `only when ${whenWords([{ stepId: s, test }])}`, op: { op: "add_branch", id: freshStepId(f, "when"), when: [{ stepId: s, test }] } });
        break;
      case "add_otherwise":
        if (m.closes) push({ where: { at: "step", stepId: m.of }, kind: "condition", label: `otherwise (when ${m.of} does not hold)`, op: { op: "add_otherwise", id: freshStepId(f, "otherwise"), of: m.of } });
        for (const s of m.subjects) for (const test of ["any", "none"] as const) push({ where: { at: "step", stepId: m.of }, kind: "condition", label: `otherwise, when ${whenWords([{ stepId: s, test }])}`, op: { op: "add_otherwise", id: freshStepId(f, "elif"), of: m.of, when: [{ stepId: s, test }] } });
        break;
      case "add_merge":
        for (const src of m.sources) push({ where: palette(), kind: "merge", label: `one value from whichever ran of ${src.join(", ")}`, op: { op: "add_merge", id: freshStepId(f, "merged"), sources: src } });
        break;
      // ── for each (phase F) ──
      case "add_loop":
        for (const over of m.overs) push({ where: palette(), kind: "loop", label: `for each row of ${over}`, op: { op: "add_loop", id: freshStepId(f, "each"), over } });
        break;
      case "set_loop": {
        const l = f.steps.find((x) => x.id === m.stepId);
        if (l?.kind !== "for_each") break;
        const at = { at: "step" as const, stepId: m.stepId };
        push({ where: at, kind: "loop", label: `how many items run at once (now ${l.concurrency})`, slot: { ty: { t: "Int" }, what: `items at once, 1 to ${MAX_CONCURRENCY}`, kind: "set_loop",
          make: (v) => { const n = Number(v.trim()); return Number.isInteger(n) ? { op: "set_loop", stepId: m.stepId, concurrency: n } : { refused: `"${v}" is not a whole number of items` }; } } });
        push({ where: at, kind: "loop", label: l.onError === "stop" ? "if one item fails, keep going with the others" : "if one item fails, stop the run", op: { op: "set_loop", stepId: m.stepId, onError: l.onError === "stop" ? "continue" : "stop" } });
        break;
      }
      case "close_loop":
        for (const r of m.results) push({ where: { at: "step", stepId: m.loop }, kind: "loop", label: `finish the loop: one row per item, each with ${r}'s value`, op: { op: "close_loop", id: freshStepId(f, `${m.loop}_rows`), loop: m.loop, result: r } });
        break;
      case "set_loop_result":
        for (const r of m.results) push({ where: { at: "step", stepId: m.stepId }, kind: "loop", label: `take each row's result from ${r}`, op: { op: "set_loop_result", stepId: m.stepId, result: r } });
        break;
    }
  }
  out.push(...decideActions(f, cat));
  out.push(...splitActions(f, cat));
  out.push(...retestActions(f, cat));
  out.push(...stageRetestActions(f, cat));
  return out.map((a, i) => ({ id: `c${i + 1}`, ...a }));
}

/** The Decide tests only this condition reads — removed with it. */
function decideTestsOf(f: EFlow, branchId: string): string[] {
  const b = f.steps.find((x) => x.id === branchId);
  if (!b || b.kind !== "branch") return [];
  return (b.conditions ?? []).map((c) => c.left.stepId).filter((t) => decideTest(f, t) && !f.steps.some((x) => x.id !== branchId && x.kind === "branch" && (x.conditions ?? []).some((c) => c.left.stepId === t)));
}

/** A row test's words: "read_1 has a row whose name" (then "is blanco"). */
const rowWords = (subject: string, field: string) => `${subject} has a row whose ${fieldLabel(field)}`;
const CMP_WORDS: Record<Cmp, string> = { gt: "is more than", ge: "is at least", lt: "is less than", le: "is at most", eq: "is", ne: "is not" };
const ORDERED_CMPS: Cmp[] = ["gt", "lt", "eq", "ge", "le"];
const TEXT_CMPS: Cmp[] = ["eq", "ne"];

/**
 * A condition on ONE value, as one gesture (phase C, D-371): "only when the count of X is more than …", "only when X's total is …",
 * "only when X has a row whose name is …" (a row test: some row passes), and the same as an else-if of each chain. The value typed becomes the engine's own two moves — a test transform ending in
 * `keep_if` (placed ahead of the chain for an else-if), then the has-rows condition on it — applied all-or-nothing. Nothing new
 * reaches the compiler.
 */
function decideActions(f: EFlow, cat: CatalogueSnapshot): Array<Omit<CanvasAction, "id">> {
  const out: Array<Omit<CanvasAction, "id">> = [];
  const arms = f.steps.some((s) => s.kind === "branch") ? armOfStep(f) : new Map<string, string>();
  // Chains a person can continue: each link that is not already closed by an else.
  const openLinks = f.steps.filter((b) => b.kind === "branch" && !arms.has(b.id) && !f.steps.some((x) => x.kind === "branch" && x.elseOf === b.id) && (b.conditions?.length ?? 0) > 0).map((b) => b.id);
  const made = (spec: DecideSpec) => (v: string) => { const r = decideOps(f, cat, { ...spec, value: v }); return typeof r === "string" ? { refused: r } : r.ops; };
  for (const x of f.steps) {
    if (arms.has(x.id) || x.kind === "branch" || x.kind === "approval") continue;
    const ty = readableTy(f, cat, x.id);
    if (typeof ty === "string") continue;
    const inner = ty.t === "Envelope" ? ty.of : ty;
    const counts = inner.t === "List" || inner.t === "Rows";
    const rec = counts ? null : inner.t === "Record" ? inner : null;
    if (!counts && !rec) continue;
    // A list: its count, and each field of its rows (a row test). One record: each of its fields.
    const rowFields = counts && inner.of.t === "Record" ? Object.entries(inner.of.fields).map(([k, t]): [string, Ty, boolean] => [k, t, true]) : [];
    const fields: Array<[string, Ty, boolean]> = counts ? [["n", { t: "Int" }, false], ...rowFields] : Object.entries(rec!.fields).map(([k, t]): [string, Ty, boolean] => [k, t, false]);
    for (const [field, fty0, rows] of fields) {
      const fty = fty0.t === "Option" ? fty0.of : fty0; // a value that may be empty: empty does not hold (`decideOps`)
      const words = rows ? rowWords(x.id, field) : counts ? `the count of ${x.id}` : `${x.id}'s ${fieldLabel(field)}`;
      for (const cmp of cmpsFor(fty)) {
        const spec: DecideSpec = { subject: x.id, measure: rows || !counts ? field : "count", cmp, value: "", from: "person" };
        const slot = (make: CanvasSlot["make"], kind: EngineOp["op"]) => ({ ty: fty, what: `${words} ${CMP_WORDS[cmp]} … (${render(fty)})`, kind, make });
        const base = { subject: x.id, field, counts: counts && !rows, cmp, words, cmpWords: CMP_WORDS[cmp], ...(rows ? { rows: true as const } : {}) };
        out.push({ where: { at: "step", stepId: x.id }, kind: "condition", label: `only when ${words} ${CMP_WORDS[cmp]} …`, decide: base, slot: slot(made(spec), "add_branch") });
        for (const of of openLinks)
          out.push({ where: { at: "step", stepId: of }, kind: "condition", label: `otherwise, when ${words} ${CMP_WORDS[cmp]} …`, decide: { ...base, of }, slot: slot(made({ ...spec, of }), "add_otherwise") });
      }
    }
  }
  return out;
}

/**
 * Change what a condition compares (phase C), on the condition itself: for each Decide test or Split side it tests, one action per
 * comparison its field admits, the value typed — `retestOps`, the one definition, so a Split's rest is regenerated from the new
 * test and the null rule its placing stated is kept. Its paths, and every step on them, stay as they are.
 */
function retestActions(f: EFlow, cat: CatalogueSnapshot): Array<Omit<CanvasAction, "id">> {
  const out: Array<Omit<CanvasAction, "id">> = [];
  for (const b of f.steps) {
    if (b.kind !== "branch") continue;
    for (const c of b.conditions ?? []) {
      const testStep = c.left.stepId, d = decideTest(f, testStep), sp = d ? null : splitSide(f, testStep);
      const t = testOf(d?.where ?? sp?.where ?? { notNull: "" });
      if (!t || (sp && sp.side !== "matched")) continue; // a Split is changed from its matching side; its rest follows
      const subject = d?.subject ?? sp!.subject;
      let fty: Ty | undefined, words: string;
      if (d) {
        const counts = d.before.some((x) => x.op === "count");
        const fd = decideField(f, cat, subject, counts ? "count" : t.field);
        if (typeof fd === "string") continue;
        fty = fd.ty; words = d.anyRow ? rowWords(subject, t.field) : counts ? `the count of ${subject}` : `${subject}'s ${t.field}`;
      } else {
        const ty = readableTy(f, cat, subject);
        const inner = typeof ty === "string" ? null : ty.t === "Envelope" ? ty.of : ty;
        fty = inner && (inner.t === "List" || inner.t === "Rows") && inner.of.t === "Record" ? inner.of.fields[t.field] : undefined;
        words = `the rows of ${subject} where ${t.field}`;
      }
      if (!fty) continue;
      const bare = fty.t === "Option" ? fty.of : fty;
      const current = { cmp: t.cmp, value: personNumber(fty, t.lit.value) };
      for (const cmp of cmpsFor(bare)) {
        out.push({ where: { at: "step", stepId: b.id }, kind: "condition", label: `change to: ${words} ${CMP_WORDS[cmp]} …`,
          retest: { testStep, subject, field: t.field, cmp, words, cmpWords: CMP_WORDS[cmp], current },
          slot: { ty: bare, what: `${words} ${CMP_WORDS[cmp]} … (${render(bare)})`, kind: "retest",
            make: (v) => { const r = retestOps(f, cat, testStep, cmp, v); return typeof r === "string" ? { refused: r } : r; } } });
      }
    }
  }
  return out;
}

/**
 * Change what a transform's filter compares, on the transform itself (2026-09-30: a filter could not be changed once placed): per
 * filter stage that is one comparison on a field, one action per comparison its field admits — `stageRetestOps`, the one
 * definition. A condition's test and a Split side are changed from their condition instead.
 */
function stageRetestActions(f: EFlow, cat: CatalogueSnapshot): Array<Omit<CanvasAction, "id">> {
  const out: Array<Omit<CanvasAction, "id">> = [];
  for (const s of f.steps) {
    if (s.kind !== "transform" || decideTest(f, s.id) || splitSide(f, s.id)) continue;
    s.pipeline.forEach((st, stage) => {
      if (st.op !== "filter") return;
      const t = testOf(st.where), fty = t ? rowFieldsBefore(f, cat, s, stage)?.[t.field] : undefined;
      if (!t || !fty) return;
      const bare = fty.t === "Option" ? fty.of : fty, words = `keep the rows where ${t.field}`;
      const current = { cmp: t.cmp, value: personNumber(fty, t.lit.value) };
      for (const cmp of cmpsFor(bare))
        out.push({ where: { at: "step", stepId: s.id }, kind: "transform", label: `change stage ${stage + 1} to: ${words} ${CMP_WORDS[cmp]} …`,
          retest: { testStep: s.id, subject: s.from, field: t.field, cmp, words, cmpWords: CMP_WORDS[cmp], current, stage },
          slot: { ty: bare, what: `${words} ${CMP_WORDS[cmp]} … (${render(bare)})`, kind: "retest",
            make: (v) => { const r = stageRetestOps(f, cat, s.id, stage, cmp, v); return typeof r === "string" ? { refused: r } : r; } } });
    });
  }
  return out;
}

/** Comparisons a value of this type admits: ordered for numbers and dates, equality for text. */
const cmpsFor = (t: Ty): Cmp[] => t.t === "Int" || t.t === "Number" || t.t === "Date" || t.t === "DateTime" || t.t === "Month" ? ORDERED_CMPS : t.t === "Text" || t.t === "Address" ? TEXT_CMPS : [];
/**
 * A Split, as one gesture (phase C, D-373): "split read_1's rows: amount is more than …". The value typed becomes the engine's own
 * moves — a filter keeping the rows that match, a filter keeping the rest (its test `not` of the first, GENERATED, so the two can
 * never drift apart), and a has-rows condition on each, each opening its own chain: both exits can run in one run, an exit with no
 * rows does not, and a row whose field is null goes to the rest (D-372). The exits' steps read their filter's rows. Nothing new
 * reaches the compiler.
 */
function splitActions(f: EFlow, cat: CatalogueSnapshot): Array<Omit<CanvasAction, "id">> {
  const out: Array<Omit<CanvasAction, "id">> = [];
  const arms = f.steps.some((s) => s.kind === "branch") ? armOfStep(f) : new Map<string, string>();
  for (const x of f.steps) {
    if (arms.has(x.id) || x.kind === "branch" || x.kind === "approval") continue;
    const ty = readableTy(f, cat, x.id);
    if (typeof ty === "string") continue;
    const inner = ty.t === "Envelope" ? ty.of : ty;
    if ((inner.t !== "List" && inner.t !== "Rows") || inner.of.t !== "Record") continue;
    for (const [field, fty0] of Object.entries(inner.of.fields)) {
      const fty = fty0.t === "Option" ? fty0.of : fty0;
      const words = `the rows of ${x.id} where ${fieldLabel(field)}`;
      for (const cmp of cmpsFor(fty)) {
        out.push({ where: { at: "step", stepId: x.id }, kind: "condition", label: `split ${words} ${CMP_WORDS[cmp]} … from the rest`,
          split: { subject: x.id, field, cmp, words, cmpWords: CMP_WORDS[cmp] },
          slot: { ty: fty, what: `${field} ${CMP_WORDS[cmp]} … (${render(fty)})`, kind: "add_branch",
            make: (v) => { const r = splitOps(f, cat, { subject: x.id, field, cmp, value: v, from: "person" }); return typeof r === "string" ? { refused: r } : r.ops; } } });
      }
    }
  }
  return out;
}

/**
 * Where a source offered to step `target`'s input comes from, in the words the picker groups by (phase C): the run's inputs; a
 * step that runs before the condition `target` is under (always there); a step earlier on the same path; a merge (whichever path
 * ran); a split's rows; or, at the top level, an earlier step.
 */
export function sourceGroup(f: EFlow, target: string, s: BindSource): string {
  if (s.from === "input") return "the run's inputs";
  if (s.from === "literal") return "a value";
  const arms = armOfStep(f), here = arms.get(target), src = f.steps.find((x) => x.id === s.stepId);
  const loops = f.steps.some((x) => x.kind === "for_each") ? loopOfStep(f) : new Map<string, string>(), inLoop = loops.get(target);
  if (inLoop && s.stepId === inLoop) return "the item — this run of the loop";
  if (inLoop && loops.get(s.stepId) === inLoop) return "earlier in this loop, for the same item";
  if (src?.kind === "collect") return "a loop's output — one row per item";
  if (src?.kind === "merge") return "a merge — whichever path ran";
  if (splitSide(f, s.stepId)) return "a split's rows";
  if (here && arms.get(s.stepId) === here) return "earlier on this path";
  return here ? "before the condition — always there" : "earlier steps";
}

/**
 * Every step input `port` of `target` may NOT read, each with the reason in words (phase C) — so the picker lists it greyed, never
 * silently absent. Structural reasons first (it runs later; it runs on another path; after a condition only a merge carries a
 * path's value; a condition or an approval gives no data); a step that could be read but is not offered does not fit this input.
 * A Decide's test is part of its condition, not a step to read, and is left out.
 */
export function unreadableFor(f: EFlow, cat: CatalogueSnapshot, target: string, port: string): Array<{ stepId: string; why: string }> {
  return unreadableByPort(f, cat)[`${target}.${port}`] ?? [];
}
/** `unreadableFor` for every input of every step that has inputs, keyed `step.port` — one pass over the legal moves. */
export function unreadableByPort(f: EFlow, cat: CatalogueSnapshot): Record<string, Array<{ stepId: string; why: string }>> {
  const offered = new Map<string, Set<string>>();
  for (const m of legalMoves(f, cat)) if (m.op === "bind") offered.set(`${m.stepId}.${m.port}`, new Set(m.sources.flatMap((s) => ("stepId" in s ? [s.stepId] : []))));
  const out: Record<string, Array<{ stepId: string; why: string }>> = {};
  for (const x of f.steps) {
    if (x.kind !== "tool" && x.kind !== "datasource") continue;
    for (const p of (x.ref ? cat.refs[x.ref]?.params : undefined) ?? []) out[`${x.id}.${p.name}`] = unreadableAt(f, x.id, offered.get(`${x.id}.${p.name}`) ?? new Set());
  }
  return out;
}
function unreadableAt(f: EFlow, target: string, offered: Set<string>): Array<{ stepId: string; why: string }> {
  const arms = armOfStep(f), here = arms.get(target);
  // What runs after `target`: anything placed later (a step reads only what is placed before it), and anything reading it.
  const at = f.steps.findIndex((x) => x.id === target);
  const after = new Set<string>([target, ...f.steps.slice(at + 1).map((x) => x.id)]);
  for (let grew = true; grew; ) { grew = false; for (const x of f.steps) if (!after.has(x.id) && [...after].some((a) => readersOf(f, a).includes(x.id))) { after.add(x.id); grew = true; } }
  const loops = f.steps.some((x) => x.kind === "for_each") ? loopOfStep(f) : new Map<string, string>(), inLoop = loops.get(target);
  const pathOf = (b: string) => { const s = f.steps.find((x) => x.id === b); return s?.kind === "branch" ? (!s.elseOf ? "IF" : s.conditions?.length ? "ELSE IF" : "ELSE") : "a"; };
  const out: Array<{ stepId: string; why: string }> = [];
  for (const x of f.steps) {
    if (offered.has(x.id) || decideTest(f, x.id)) continue;
    const there = arms.get(x.id);
    const why = x.id === target ? null
      : after.has(x.id) ? "runs after this step"
      : x.kind === "branch" ? "a condition decides which path runs; it gives no data"
      : x.kind === "approval" ? "an approval gives no data"
      : loops.get(x.id) && loops.get(x.id) !== inLoop ? `runs inside the loop ${loops.get(x.id)}, once per item — after the loop, read its output`
      : x.kind === "for_each" && x.id !== inLoop ? `is the current item only inside the loop ${x.id} — after the loop, read its output`
      : there && there !== here ? (here ? "runs on another path — it has not run here" : `runs only on the ${pathOf(there)} path of ${chainHead(f, there)} — after the condition, read a merge of the paths`)
      : "its output does not fit this input";
    if (why) out.push({ stepId: x.id, why });
  }
  return out;
}

const sameWhere = (a: CanvasWhere, b: CanvasWhere) => JSON.stringify(a) === JSON.stringify(b);
/** The actions at one place on the canvas. */
export const actionsAt = (f: EFlow, cat: CatalogueSnapshot, where: CanvasWhere): CanvasAction[] => canvasActions(f, cat).filter((a) => sameWhere(a.where, where));

/** The holes to draw ON a node: its unset required ports, its unchosen component, its empty arm. */
export const holesOnNode = (f: EFlow, stepId: string): Hole[] => f.holes.filter((h) => h.site.at !== "output" && h.site.stepId === stepId);

/**
 * Take an action. A slot's value goes through `apply` like any op, so a value that does not fit is a refusal naming why —
 * never a saved state. An action is taken only on the state it was listed for (its op carries that state's fresh ids).
 */
export function canvasApply(f: EFlow, cat: CatalogueSnapshot, a: CanvasAction, value?: string): Applied {
  if (a.op) return apply(f, a.op, cat);
  if (a.ops) {
    let g = f;
    for (const op of a.ops) { const r = apply(g, op, cat); if (!r.ok) return r; g = r.flow; }
    return { ok: true, flow: g };
  }
  if (!a.slot) return { ok: false, error: "this action has nothing to do" };
  if (value === undefined) return { ok: false, error: `type ${a.slot.what} first` };
  const made = a.slot.make(value);
  if ("refused" in made) return { ok: false, error: made.refused };
  if (!Array.isArray(made)) return apply(f, made, cat);
  let g = f;
  for (const op of made) { const r = apply(g, op, cat); if (!r.ok) return r; g = r.flow; }
  return { ok: true, flow: g };
}

// ── the canvas walk (the property test's adapter) ───────────────────────────

const pick = <X>(r: () => number, xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;
export const CANVAS_WEIGHT: Record<string, number> = { declare_input: 0.6, remove_input: 0.3, retype_input: 0.3, add_reader: 2, choose_reader: 3, add_transform: 3, append_stage: 4, add_call: 2, bind: 6, unbind: 0.5, add_gate: 0.6, set_output: 1, set_schedule: 0.4, remove_step: 0.5, add_branch: 0.8, add_otherwise: 0.8, add_merge: 1.5, retest: 0.6, add_loop: 12, set_loop: 6, close_loop: 20, set_loop_result: 6 };
/** The op an action ends in — its own op, its last op, or what its slot declares. Never learned by calling `make`. */
export const actionKind = (a: CanvasAction): EngineOp["op"] => (a.op ?? a.ops?.at(-1))?.op ?? a.slot!.kind;
const kindOf = actionKind;
/**
 * An action's weight in the walk. A loop (phase F) needs a bounded list first and a step inside before it can close, which a flat
 * weight almost never assembles — measured: 2 closed loops in 500 walks. Placing a step inside a loop still open weighs more.
 */
function weightOf(f: EFlow, a: CanvasAction): number {
  const w = CANVAS_WEIGHT[kindOf(a)] ?? 1;
  const under = a.where.at === "palette" ? a.where.under : undefined;
  return under && f.steps.some((s) => s.id === under && s.kind === "for_each") && !f.steps.some((s) => s.kind === "collect" && s.loop === under) ? w * 6 : w;
}

/** A value a person might type into a slot: usually a fitting one, sometimes a wrong one (which `apply` must refuse). */
function typed(a: CanvasAction, cat: CatalogueSnapshot, r: () => number): string {
  const op = a.slot!.kind;
  if (op === "declare_input") return pick(r, ["period", "region", "cut off", "9lives"]);
  if (op === "set_schedule") return pick(r, ["0 9 * * 1", "30 6 * * *", "every monday", "61 9 * * *"]);
  if (op === "add_gate") return pick(r, ["Send these?", "Proceed with this send?", "two\nlines", "{{ inputs.x }}"]);
  if (op === "set_loop") return pick(r, ["1", "5", "20", "0", "21", "three"]);
  return r() < 0.8 ? sampleLiteral(a.slot!.ty, cat, r) : adversarialLiteral(a.slot!.ty, r);
}

/**
 * A random walk that takes ONLY what the canvas offers (phase 7, task 5): the property test's canvas adapter. Slot values are
 * typed as a person might — usually fitting, sometimes not (which `apply` must refuse). Throws if a listed op action is refused:
 * that is a legality bug, not a walk end. `taken` collects the op kinds taken.
 */
export function canvasWalk(start: EFlow, cat: CatalogueSnapshot, len: number, seed: number, taken?: Set<string>): Array<{ a: string; flow: EFlow }> {
  const r = rng(seed);
  let f = start;
  const out: Array<{ a: string; flow: EFlow }> = [];
  for (let i = 0; i < len; i++) {
    const acts = canvasActions(f, cat);
    if (!acts.length) break;
    const total = acts.reduce((s, a) => s + weightOf(f, a), 0);
    let x = r() * total, a = acts[0]!;
    for (const c of acts) { x -= weightOf(f, c); if (x <= 0) { a = c; break; } }
    const value = a.slot ? typed(a, cat, r) : undefined;
    const res = canvasApply(f, cat, a, value);
    if (!res.ok) {
      if (a.slot) continue; // a typed value that does not fit is refused by name — a legal outcome
      throw new Error(`listed canvas action refused (seed ${seed}, step ${i}): ${a.label} ${JSON.stringify(a.op)} — ${res.error}`);
    }
    taken?.add(kindOf(a));
    f = res.flow;
    out.push({ a: a.label, flow: f });
  }
  return out;
}

