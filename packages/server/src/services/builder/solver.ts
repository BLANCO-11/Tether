/**
 * The solver (compiled-builder phase 5, D-322): a confirmed GoalSpec in, a flow out — by CODE, over phase 3's legal moves. The model
 * read the goal (the spec, with each stated value mapped to the parameter it fills); nothing here calls a model.
 *
 * Every decision is one of: what the confirmed spec names (readers, actions, schedule); the person's words where they FIT the port's
 * type; a run input where the spec says the value is asked each run; the requester where the port falls back to them; data where the
 * person named a group rather than an address ("customers"); or a binding the TYPES force (one candidate). Anything else is left open:
 * a value hole becomes the person's question, a structural hole a stated incomplete. No rule reads a component's name (I-292): only
 * types, declared flags (`fallsBackToRequester`, `modelText`), the spec, and the person's words.
 *
 * Continuable: run again after the person answers, it adds only what the spec still lacks (counted against `base`, the steps the
 * BUILD started from) and fills only what is still open — so the question rounds never rebuild anything.
 */
import { inUnit, timeOfWords, apply, chainHead as engineChainHead, collectOf, loopMembers, loopOfStep, decideOps, decideTest, splitOps, splitSide, freshStepId, typePipeline, withContext, TypeOf as T, legalMoves, literalFits, readableTy, rowOf, type CatalogueSnapshot, type EFlow, type EngineOp, type Comb, type Pred, type Hole, type Move, type Part, type PortSig } from "@foundry/flow-edit";
import type { Ty } from "@foundry/flow-edit";
import { BY_FLOW, DAYS_TESTS, FILLS_NONE, NONE_FIT, RECIPIENT_FIELD_NONE, UNSAID, VALUED_TESTS, type CheckedSpec, type CondTest, type GoalSpec } from "./goal-spec.js";
import { keyHole, noAddressText, refusalText, type BuildMove } from "./build.js";

import { CMP, GROUP_ROWS, INPUT_REF, lowerShape, shapeNeeds } from "./shape.js";
import { noteBuildState } from "./progress.js";
import { askedFor, endForPort, flowDecls, isPeriod, operandTypes, operandsFor, portForm, relativeWords, unreadInputs, type End, type SpecInput } from "./inputs.js";
import { pathHasActions, restatedCuts, sameShapes, supersededShapes, unreadShapes, type ItemTest } from "./wiring.js";
import { sanitizeAttachBaseName } from "../mail-attachments.js";

type Value = GoalSpec["values"][number];
export interface SolveInput {
  spec: CheckedSpec;
  cat: CatalogueSnapshot;
  /** The person's answers to the spec's own questions (`spec:<i>:<role>`), by value index. */
  answers: Map<number, string>;
  /** The person's answers to "what counts as …?" for a condition whose value the goal only describes (`cond:<i>:<role>`), by index. */
  condAnswers?: Map<number, string>;
  /** Slice 5e: the person's answers to a shape's questions, by `<shape>:<stage>`. */
  shapeAnswers?: Map<string, string>;
  /** The steps the build started from: `[]` for a goal, the draft's for an edit (D-321). */
  base: Array<{ kind: string; ref?: string; id?: string }>;
  /**
   * D-324 — the words of a PER-ROW message nobody stated. `"propose"`: draft one from the row's own fields (what `understand` does, to
   * show it in the readback); a list: apply exactly these, the ones the person confirmed; absent: draft nothing (the port stays a
   * question — a resumed build, whose templates are already in the flow).
   */
  drafts?: "propose" | Draft[];
  /** The holes a person has already answered: a drafted wording never fills one — the person's words win over a draft. */
  answered?: ReadonlySet<string>;
  /**
   * Z9 (I-325): the VERIFIED address of the person building (a signed-in identity, never a body field). A value the spec reads as the
   * requester ("me") on an address port whose receiver does not send to the run's requester itself — or would, but the flow runs on a
   * schedule, so nobody starts it — is bound to it, provenance `person`.
   */
  requester?: string;
  /**
   * Z5 (I-322): the values already in the automation, by the component and input they fill. An open input of the SAME component that
   * the flow already fills with exactly ONE value takes it (provenance `person` — the person gave it); several different ones stay a
   * question. Never across components: which input a value means is the person's words' to say (the spec's `earlier`), not a guess.
   */
  known?: KnownValue[];
}
export interface KnownValue { stepId: string; ref: string; port: string; value: string }

/** A drafted per-row message: `ref.port` gets a template of the row's fields, which the person confirmed in the readback. */
/** `sink`: the goal's action it belongs to — two actions on ONE tool (the team's email, the customer's) each have their own. */
export interface Draft { ref: string; port: string; parts: Part[]; text: string; sink?: number }
export interface SolveResult {
  flow: EFlow;
  moves: BuildMove[];
  /** Why something the spec names was not built — each a stated gap, never silence. */
  gaps: string[];
  /** Holes whose value was asked by a spec question already (answered or not) — never asked again (D-294). */
  covered: string[];
  /**
   * What the GOAL asks for that this flow does not do (I-299): no action at all, a stated condition not built, a stated schedule not
   * set. A flow with any of these is never `complete` — it would run green and do less than the person said, which is a silent guess.
   */
  unmet: string[];
  /** The unmet entries that are the BUILDER's own — a part it could not place, a condition with nothing on it — never the person's to
   * settle by more words: stated, never asked (2026-10-02, P4-I2). */
  internal: string[];
  /** The per-row templates placed (or, under `"propose"`, drafted) — what the readback shows as "Each … will say". */
  drafts: Draft[];
  /**
   * P7 (R15): calls that cannot run for a reason no value in their ports would settle (whose address no data holds) — their ports
   * are never asked: a subject for an email nobody can receive is a question with no use.
   */
  blocked: string[];
  /** P7 (R15): calls made WITHOUT an optional address nothing here holds — what was asked is done, and the person is told whose. */
  without: string[];
  /** D-325: per-row sends that skip the rows with no address, by reader step and field — stated in the readback. */
  /** Rows left out for having no `field` (D-325) — and, on a list several actions share, the actions that did not need it (`alsoFor`). */
  skips: Array<{ reader: string; field: string; alsoFor?: string[] }>;
}

const bare = (t: Ty): Ty => (t.t === "Option" ? t.of : t);
/** A field DECLARED a number: its comparand is a number, whatever the test — the ONE rule `condStages` and spec-match both read. */
export const isNumberTy = (fty: Ty | undefined): boolean => !!fty && (bare(fty).t === "Int" || bare(fty).t === "Number");
const elemOf = (t: Ty): Ty => { const b = bare(t); return b.t === "List" ? bare(b.of) : b; };
const isAddress = (t: Ty) => elemOf(t).t === "Address";
/**
 * The goal's words for a value, without the quotation marks the person put AROUND them: `with the subject "Low leave balances"`
 * means the subject is Low leave balances — the marks say where the words start and end, they are not part of them (2026-10-01:
 * the subject was sent as `"Low leave balances"`, marks and all). Only a matching outer pair is removed.
 */
export const unquote = (w: string): string => {
  const t = w.trim();
  const m = /^(["'“‘«])([\s\S]*)(["'”’»])$/.exec(t);
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»" };
  return m && pairs[m[1]!] === m[3] && m[2]!.trim() ? m[2]!.trim() : t;
};
const INPUT_OF: Record<string, { type: "STRING" | "DATE" | "DATETIME" | "INT" | "FLOAT" | "BOOLEAN"; format?: "month" }> = {
  Text: { type: "STRING" }, Month: { type: "STRING", format: "month" }, Date: { type: "DATE" }, DateTime: { type: "DATETIME" }, Int: { type: "INT" }, Number: { type: "FLOAT" }, Bool: { type: "BOOLEAN" },
};
/** Words of a phrase or an identifier, for comparing the person's words with a column name (their words; no vocabulary here). */
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).map((w) => w.replace(/(ies|es|s)$/, "")));
const overlap = (a: string, b: string) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n; };

export function solve(start: EFlow, input: SolveInput): SolveResult {
  const { spec: { spec }, cat, answers, base } = input;
  let f = start;
  const moves: BuildMove[] = [];
  const gaps: string[] = [];
  /** See `internal` on the result: what the builder failed to place, recorded where it fails. */
  const internal = new Set<string>();
  const ours = (msg: string) => { internal.add(msg); unmet.push(msg); };
  const covered = new Set<string>();
  const drafts: Draft[] = [];
  const unmet: string[] = [];
  const blocked = new Set<string>();
  const without: string[] = [];
  /** D-325: the readers whose rows with no address are skipped, and by which field — for the readback. */
  const skips: SolveResult["skips"] = [];
  const doOp = (op: EngineOp, label: string, alternatives = 1): boolean => {
    const r = apply(f, op, cat);
    if (!r.ok) { gaps.push(`${label}: ${r.error}`); return false; }
    f = r.flow;
    moves.push({ pick: op.op, label, alternatives, chooser: "code" });
    noteBuildState(f, cat);
    return true;
  };
  /** Several ops as ONE move (a Decide, a Split): all applied, or none — never a test left behind with no condition on it. */
  const doOps = (ops: EngineOp[], label: string): boolean => {
    let g = f;
    for (const op of ops) { const r = apply(g, op, cat); if (!r.ok) { gaps.push(`${label}: ${r.error}`); return false; } g = r.flow; }
    f = g;
    for (const op of ops) moves.push({ pick: op.op, label, alternatives: 1, chooser: "code" });
    noteBuildState(f, cat);
    return true;
  };
  const count = (g: { steps: ReadonlyArray<{ kind: string }> }, kind: string, ref: string) => g.steps.filter((x) => x.kind === kind && (x as { ref?: string }).ref === ref).length;
  const moveOf = <K extends Move["op"]>(op: K, pred: (m: Extract<Move, { op: K }>) => boolean = () => true) => legalMoves(f, cat).find((m): m is Extract<Move, { op: K }> => m.op === op && pred(m as Extract<Move, { op: K }>));
  /**
   * The values for `ref.port` — of ACTION `sink` when it is known (Phase Y, I-310): a value the wiring gives to one action is that
   * action's alone, and a value whose tool several actions use, given to none, belongs to none of them (it is asked, never handed to
   * whichever call is placed first — both channels went to one post step).
   */
  const valuesFor = (ref: string, port: string, sink?: number) => spec.values.map((v, i) => ({ v, i })).filter(({ v, i }) => {
    if (v.fills !== `${ref}.${port}`) return false;
    if (sink === undefined || sink < 0) return true;
    const owner = spec.wiring?.valueAction?.[i];
    if (owner !== undefined) return owner === sink;
    return spec.sinks.filter((x) => x.ref === ref).length <= 1;
  });
  // builder-inputs P1: the plan's inputs. A flow input's run inputs are named by kind and order (`askedFor`), so a continued build
  // finds the same ones; `realised` records each input a step or a placed filter actually takes — the completeness check reads it.
  const specInputs: SpecInput[] = spec.inputs ?? [];
  const asked = askedFor(specInputs);
  const inputCtx = { of: (id: string) => specInputs.find((i) => i.id === id), asked };
  const realised = new Set<string>();
  const portHoles = (stepId: string) => f.holes.filter((h): h is Hole & { site: { at: "port"; stepId: string; port: string } } => h.site.at === "port" && h.site.stepId === stepId);
  /**
   * P1 (RC-1/RC-2): the ADDRESS a placed call could not settle (a refused literal, or nobody the data can address) keeps a PORT
   * HOLE — the flow's own state reads "not set" beside the finding, never the requester fallback a hole-less port renders as
   * ("emails it to you" while the findings say it cannot send). The engine opens one for a required port; an optional one it
   * leaves hole-less gets it here, in the engine's own shape (a mirror of its `portHoles`). Binding closes it like any other.
   */
  function holeFor(stepId: string, port: string): void {
    if (f.holes.some((h) => h.site.at === "port" && h.site.stepId === stepId && h.site.port === port)) return;
    const ref = (f.steps.find((s) => s.id === stepId) as { ref?: string } | undefined)?.ref;
    const sig = ref ? cat.refs[ref]?.params.find((p) => p.name === port) : undefined;
    if (!sig) return;
    let id = `h_${stepId}_${port}`;
    for (let n = 2; f.holes.some((h) => h.id === id); n++) id = `h_${stepId}_${port}_${n}`;
    f = { ...f, holes: [...f.holes, { id, site: { at: "port", stepId, port }, why: "required", ty: sig.ty, owner: "person", reason: `\`${stepId}\` needs \`${port}\` — nothing the automation reads supplies it` }] };
    noteBuildState(f, cat);
  }

  // 0 · the schedule the goal states
  if (spec.schedule && !f.schedule && moveOf("set_schedule", (m) => m.set)) doOp({ op: "set_schedule", cron: spec.schedule.cron }, `run on the schedule the goal states (${spec.schedule.cron})`);

  // 1 · readers, exactly as confirmed
  const want = (xs: Array<{ ref: string }>, kind: string) => xs.filter((x) => x.ref !== NONE_FIT && x.ref !== UNSAID).map((x) => x.ref).filter((ref, i, a) => a.indexOf(ref) === i).flatMap((ref) => {
    const named = xs.filter((x) => x.ref === ref).length;
    return Array.from({ length: Math.max(0, named - (count(f, kind, ref) - count({ steps: base }, kind, ref))) }, () => ref);
  });
  for (const ref of want(spec.sources, "datasource")) {
    if (!moveOf("add_reader", (m) => m.refs.includes(ref))) { gaps.push(`the reader \`${ref}\` cannot be added here`); continue; }
    doOp({ op: "add_reader", id: freshStepId(f, "read"), ref }, `read ${ref}`);
  }
  // The readers this build works on: the spec's own sources — and, in an edit, a reader ALREADY in the flow that a shape is over
  // ("only the ones who joined in 2026" narrows rows it reads; with no new source the test attached to nothing, 2026-10-01).
  const readers = () => f.steps.filter((s) => s.kind === "datasource" && s.ref && (spec.sources.some((x) => x.ref === s.ref) || (spec.shapes ?? []).some((sh) => sh.over === s.ref))).map((s) => s.id);
  /** Phase Y: the reader step each spec source became — the k-th source of a ref is the k-th reader of it, in order. */
  const sourceStep: Array<string | undefined> = spec.sources.map((x, i) => {
    const same = f.steps.filter((s) => s.kind === "datasource" && s.ref === x.ref).map((s) => s.id);
    return same[spec.sources.slice(0, i).filter((y) => y.ref === x.ref).length];
  });
  /** Phase Y: the list step each shape became — its OWN step, never appended to another list (I-314). */
  const listStep = new Map<number, string>();
  const superseded = supersededShapes(spec);
  const cuts = restatedCuts(spec), same = sameShapes(spec), unread = unreadShapes(spec);
  /** Phase C: a split path's other side — its rest's condition, and each side's rows (what the actions on it take). */
  const restStep: Array<string | undefined> = [];
  const exitRows: Array<{ matched: string; rest: string } | undefined> = [];
  /** Phase Y: the call step each spec action became, by index — what the wiring's `action:<j>` and value owners name. */
  const sinkStep: Array<string | undefined> = [];
  const w = spec.wiring;
  /** Phase F (D-381): the goal's loop, once placed; its output (placed when an action after it takes what happened); per-item templates. */
  let loopId: string | undefined;
  let collectId: string | undefined;
  let itemOtherwise: string | undefined;
  const itemTemplates = new Map<number, { field: string; placed: Array<{ port: string; as: string; parts: Part[]; text: string }> }>();
  /** The step a wiring key names: a shaped list's own step, a reader's rows (through its condition filter), an action's call. */
  function stepOfKey(k: string | undefined): string | undefined {
    if (!k) return undefined;
    const [kind, n] = k.split(":") as [string, string];
    // A shape a condition superseded (a split's side, a Decide's count) names the rows it was made from.
    if (kind === "list" && superseded.has(Number(n))) { const over = spec.shapes?.[Number(n)]?.over; const r = over ? sourceStep[spec.sources.findIndex((x) => x.ref === over)] : undefined; return r ? dataOf(r) : undefined; }
    if (kind === "list") return listStep.get(same.get(Number(n)) ?? Number(n));
    if (kind === "reader") { const r = sourceStep[Number(n)]; return r ? dataOf(r) : undefined; }
    if (kind === "action") return sinkStep[Number(n)];
    // Z6: a step the automation already has (a change names it by id; the wiring check admitted only real ones).
    if (kind === "step") return f.steps.some((s) => s.id === n) ? n : undefined;
    return undefined;
  }
  /** What action `i` takes, as a step — `undefined` when unsaid or nothing. */
  const takesStep = (i: number | undefined) => {
    if (i === undefined || i < 0) return undefined;
    const a = w?.actions[i];
    // Phase C: an action on a side of a split takes THAT side's rows — whether it names the split's list or leaves it unsaid.
    const side = typeof a?.path === "number" && w!.paths[a.path]?.test === "split" ? exitRows[a.path]?.matched
      : typeof a?.path === "string" ? exitRows[Number(a.path.slice(5))]?.rest : undefined;
    // A side's rows are what its path carries: an action taking a list there takes that side (a hand-written half is superseded).
    if (side && a!.takes !== "nothing" && !a!.takes.startsWith("action:")) return side;
    // Phase F: the item is the loop's (inside it); with no loop — one send per item is today's fan-out — the for-each's list.
    if (a?.takes === "item") return loopId ?? stepOfKey(w?.each?.over);
    if (a?.takes === "each") return collectId;
    return stepOfKey(a?.takes);
  };
  for (const r of readers()) fillPorts(r);

  // 1b · the conditions the FLOW applies (D-326): one filter per condition, on a `where_N` step over the reader, which the actions then
  // read instead of the reader. Only what the spec states — a field of this reader, a test, and the goal's own words (or none).
  const placedConds = new Set<number>();
  const placedStages = new Set<string>();
  const shapeNotes: string[] = [];
  const skipsShape: Array<{ reader: string; field: string }> = [];
  /** The computed inputs a run-day stage may read, typed — whatever N a stage names is typed on demand. */
  // A test's value as words: a GIVEN input IS its stated words ("2 days"), read exactly as a literal (E01, v5: an input id carries no
  // digits, so "N days before" was never declared and the list was not built).
  const said = (v: string | undefined | null) => { const g = v && INPUT_REF.test(v) ? specInputs.find((i) => `input:${i.id}` === v && i.fill === "given") : undefined; return g ? g.words : v ?? ""; };
  const runDayInputs = (): Record<string, Ty> => {
    const out: Record<string, Ty> = { [RUN_DAY]: T.date(), ...operandTypes(specInputs) };
    for (const sh of spec.shapes ?? []) for (const st of sh.stages) if (st.test && DAYS_TESTS.has(st.test)) { const n = Number(/\d+/.exec(said(st.value))?.[0]); if (Number.isInteger(n)) out[daysBefore(n)] = T.date(); }
    for (const v of input.shapeAnswers?.values() ?? []) { const n = Number(/\d+/.exec(v)?.[0]); if (Number.isInteger(n)) out[daysBefore(n)] = T.date(); }
    for (const c of spec.conditions) if (c.test && DAYS_TESTS.has(c.test)) { const n = Number(/\d+/.exec(said(c.value))?.[0]); if (Number.isInteger(n)) out[daysBefore(n)] = T.date(); }
    for (const v of input.condAnswers?.values() ?? []) { const n = Number(/\d+/.exec(v)?.[0]); if (Number.isInteger(n)) out[daysBefore(n)] = T.date(); }
    return out;
  };
  for (const r of readers()) {
    const ref = (f.steps.find((x) => x.id === r) as { ref?: string }).ref!;
    const conds = spec.conditions.map((c, i) => ({ c, i })).filter(({ c }) => (!c.by || c.by === BY_FLOW) && c.field && c.field !== FILLS_NONE && c.test && c.field.slice(0, c.field.lastIndexOf(".")) === ref);
    // Phase C: a shape the wiring's own condition makes (a split's side, a Decide's count) is that condition's — not built twice.
    for (const si of superseded.keys()) (spec.shapes ?? [])[si]?.stages.forEach((_, j) => placedStages.add(`${si}:${j}`));
    // …and the stages of a compared list that restate its comparison (after its total) are the comparison's, not the list's.
    for (const [si, k] of cuts) (spec.shapes ?? [])[si]?.stages.forEach((_, j) => { if (j >= k) placedStages.add(`${si}:${j}`); });
    // …and a shape the same as an earlier one, once cut, IS that one — built once.
    // (only when that one IS built: two identical lists nothing reads would otherwise each count the other as done)
    for (const si of same.keys()) if (!unread.has(si)) (spec.shapes ?? [])[si]?.stages.forEach((_, j) => placedStages.add(`${si}:${j}`));
    const shaped = (spec.shapes ?? []).map((sh, si) => ({ sh: cuts.has(si) ? { ...sh, stages: sh.stages.slice(0, cuts.get(si)) } : sh, si })).filter(({ sh, si }) => sh.over === ref && !superseded.has(si) && !same.has(si) && !unread.has(si));
    if (!conds.length && !shaped.length) continue;
    // This BUILD's lists, placed in an earlier round — never the filters of the automation an edit started from (2026-10-01: "only
    // the ones who joined in 2026" took the existing "active interns" filter as its own list, and placed nothing).
    const started = new Set(base.flatMap((b) => (b.id ? [b.id] : [])));
    const existing = f.steps.filter((x) => x.kind === "transform" && x.from === r && x.id.startsWith("where") && !started.has(x.id));
    if (existing.length) { // continuing a build: its lists are the shapes', in order
      conds.forEach(({ i }) => placedConds.add(i));
      shaped.forEach(({ si, sh }, k) => { sh.stages.forEach((_, j) => placedStages.add(`${si}:${j}`)); if (existing[k]) listStep.set(si, existing[k]!.id); });
      continue;
    }
    const rowTy = readableTy(f, cat, r);
    const row = typeof rowTy === "string" ? null : rowOf(rowTy);
    if (!row || row.t !== "Record") continue;
    const stages: Comb[] = [];
    const placed: number[] = [];
    for (const { c, i } of conds) {
      const field = c.field!.slice(c.field!.lastIndexOf(".") + 1);
      // A value the goal only described ("too long") is the person's answer to the question code asked — provenance `person`.
      const answered = !c.value?.trim() ? input.condAnswers?.get(i)?.trim() : undefined;
      if (VALUED_TESTS.has(c.test!) && !c.value?.trim() && !answered) continue; // unanswered: stated unmet below, never guessed
      const st = condStages(field, (row.fields as Record<string, Ty>)[field], c.test!, answered ?? c.value ?? "", c.quote, answered ? "person" : "goal", input.spec.texts ?? [], inputCtx);
      if (typeof st === "string") { gaps.push(`the condition “${c.quote}”: ${st}`); continue; }
      stages.push(...st); placed.push(i);
    }
    // Slice 5e: the spec's shape — the engine's own combinators, lowered and TYPED over the rows as the conditions left them. Phase Y
    // (I-314): each shape is its OWN list — the conditions' filters, then its stages — never stacked on another shape's output, where
    // the fields it names may no longer exist (a second list "owe more than 10000" after the first one's `group`).
    const prefix = [...stages];
    const lists: Array<{ si: number; pipeline: Comb[] }> = [];
    for (const { sh, si } of shaped) {
      const inTy = (rowTy as Ty).t === "Envelope" ? (rowTy as Extract<Ty, { t: "Envelope" }>).of : (rowTy as Ty); // as the engine reads a reader into a transform
      const base = withContext({ inputs: runDayInputs() }, () => typePipeline(inTy, prefix));
      if (!base.ok) break;
      const lo = lowerShape(sh.stages, base.ty, { answers: new Map([...(input.shapeAnswers ?? new Map<string, string>())].filter(([k]) => k.startsWith(`${si}:`)).map(([k, v]) => [Number(k.split(":")[1]), v])), valued: VALUED_TESTS, inputs: runDayInputs(), rowParts: (fs) => draftParts(fs, "", false), filterStages: (fd, ty, te, va, qu, fr) => condStages(fd, ty, te, va, qu, fr, input.spec.texts ?? [], inputCtx) });
      lists.push({ si, pipeline: [...prefix, ...lo.pipeline] });
      stages.push(...lo.pipeline);
      for (const k of lo.placed) placedStages.add(`${si}:${k}`);
      for (const p of lo.problems) gaps.push(`the step “${p}”`);
      shapeNotes.push(...lo.problems.map((p) => `the step ${p} — not built`), ...lo.waiting.map((k) => `the step “${sh.stages[k]!.quote}” needs ${shapeNeeds(sh.stages[k]!, VALUED_TESTS) === "count" ? "how many" : "what counts"} — asked, and not answered`));
      if (lo.narrowed.length) skipsShape.push(...lo.narrowed.map((n) => ({ reader: r, field: n })));
    }
    declareReadInputs(stages);
    const condLabel = conds.filter(({ i }) => placed.includes(i)).map(({ c }) => `“${c.quote}”`).join(" and ");
    if (lists.length) {
      for (const l of lists) {
        const id = freshStepId(f, "where");
        if (l.pipeline.length && doOp({ op: "add_transform", id, from: r, pipeline: l.pipeline }, `from ${r}: the list “${spec.shapes![l.si]!.stages.at(-1)?.quote ?? ""}”${condLabel ? `, only the rows where ${condLabel}` : ""}`)) { listStep.set(l.si, id); placed.forEach((i) => placedConds.add(i)); }
      }
    } else if (stages.length && doOp({ op: "add_transform", id: freshStepId(f, "where"), from: r, pipeline: stages }, `from ${r}: only the rows where ${condLabel}`)) placed.forEach((i) => placedConds.add(i));
  }

  // 2a · Phase Y — the paths the goal states (`wiring.paths`): a condition on a list ("has rows" / "has none"), each the engine's own
  // `add_branch`, the next ones its `add_otherwise`, and the closing `otherwise` when an action runs on none of them.
  const pathStep: Array<string | undefined> = [];
  let otherwiseStep: string | undefined;
  /** An existing link of a chain that already says this — a later round of the build finds it again rather than doubling it. */
  const sameLink = (of: string | undefined, when?: { stepId: string; test: "any" | "none" }) => f.steps.find((s): s is Extract<typeof s, { kind: "branch" }> => s.kind === "branch"
    && (of ? s.elseOf === of : !s.elseOf)
    && (when ? s.conditions?.length === 1 && s.conditions[0]!.op === when.test && s.conditions[0]!.left.stepId === when.stepId : !s.conditions?.length))?.id;
  let last: string | undefined;
  for (const [p, path] of (w?.paths ?? []).entries()) {
    // Phase F: a condition on the item is decided inside the loop, once the loop is placed (2c).
    if (path.subject === "item") continue;
    // A condition with nothing on it guards nothing — stated, never placed empty (it would be a hole nobody can settle).
    if (!pathHasActions(w!, p)) { ours(`the condition “${path.quote}” has nothing to do on it`); continue; }
    // Z6 (I-323): the goal's condition IS one of the automation's existing paths — its actions go on it; nothing new is placed.
    if (path.subject.startsWith("in:")) {
      const b = path.subject.slice(3);
      if (f.steps.some((s) => s.id === b && s.kind === "branch")) pathStep[p] = b;
      else ours(`the condition “${path.quote}” names a path that is not in the automation`);
      continue;
    }
    const subject = stepOfKey(path.subject);
    if (!subject) { unmet.push(`the condition “${path.quote}” tests a list that was not built`); continue; }
    // Phase C: a Split — the engine's own ops (`splitOps`): both sides, each its own chain; the chain being built here is untouched.
    if (path.test === "split") {
      const made = splitOps(f, cat, { subject, field: path.measure!, cmp: path.cmp!, value: path.value!, from: "goal", quote: path.value! });
      if (typeof made === "string") { unmet.push(`the condition “${path.quote}”: ${made}`); continue; }
      const want = JSON.stringify((made.ops[0] as { pipeline: unknown }).pipeline);
      const again = f.steps.find((s) => s.kind === "transform" && s.from === subject && JSON.stringify(s.pipeline) === want && splitSide(f, s.id)?.side === "matched");
      if (again) { const m = splitSide(f, again.id)!; pathStep[p] = m.branchId; restStep[p] = splitSide(f, m.pair)?.branchId; exitRows[p] = { matched: again.id, rest: m.pair }; continue; }
      if (!doOps(made.ops, `split ${subject}: the rows where ${path.measure} ${path.cmp} ${path.value}, and the rest (“${path.quote}”)`)) { ours(`the condition “${path.quote}” could not be placed`); continue; }
      pathStep[p] = made.when[0]; restStep[p] = made.when[1]; exitRows[p] = { matched: made.matched, rest: made.rest };
      continue;
    }
    // Phase C: a Decide — one value compared (`decideOps`): the test and its condition, an else-if when the chain has begun.
    if (path.test === "compare") {
      const vs = againstField(subject, path.value!, path.measure!);
      const made = decideOps(f, cat, { subject, measure: path.measure!, cmp: path.cmp!, value: path.value!, from: "goal", quote: path.value!, ...(vs ? { against: vs } : {}), ...(last ? { of: last } : {}) });
      if (typeof made === "string") { unmet.push(`the condition “${path.quote}”: ${made}`); continue; }
      const want = JSON.stringify((made.ops[0] as { pipeline: unknown }).pipeline);
      const again = f.steps.find((s): s is Extract<typeof s, { kind: "branch" }> => s.kind === "branch" && (last ? s.elseOf === last : !s.elseOf) && s.conditions?.length === 1
        && (() => { const t = f.steps.find((x) => x.id === s.conditions![0]!.left.stepId); return t?.kind === "transform" && t.from === subject && JSON.stringify(t.pipeline) === want; })());
      if (again) { pathStep[p] = last = again.id; continue; }
      if (!doOps(made.ops, `${last ? "otherwise, when" : "only when"} ${path.measure === "count" ? `the count of ${subject}` : `${subject}'s ${path.measure}`} ${path.cmp} ${path.value} (“${path.quote}”)`)) { ours(`the condition “${path.quote}” could not be placed`); continue; }
      pathStep[p] = last = made.branch;
      continue;
    }
    const when = { stepId: subject, test: path.test };
    const found = sameLink(last, when);
    if (found) { pathStep[p] = last = found; continue; }
    const id = freshStepId(f, "when");
    const ok = !last ? doOp({ op: "add_branch", id, when: [when] }, `only when ${subject} ${path.test === "any" ? "has rows" : "has none"} (“${path.quote}”)`)
      : doOp({ op: "add_otherwise", id, of: last, when: [when] }, `otherwise, when ${subject} ${path.test === "any" ? "has rows" : "has none"} (“${path.quote}”)`);
    if (!ok) { ours(`the condition “${path.quote}” could not be placed`); continue; }
    pathStep[p] = last = id;
  }
  if (last && w?.actions.some((a) => a.path === "otherwise" && !a.per)) {
    const found = sameLink(last);
    const id = found ?? freshStepId(f, "otherwise");
    if (found || doOp({ op: "add_otherwise", id, of: last }, "otherwise (none of the conditions holds)")) otherwiseStep = id;
  }

  // 2c · Phase F (D-381) — the goal's for-each: a bounded list of the rows it names, the loop over it, and the conditions on each item
  // (a Decide chain inside). ONE rule: the goal says "for each" → a loop, whatever is inside it — a loop of one call runs in batches
  // (D-370), so there is no second path for one send per item.
  const perItem = (w?.actions ?? []).map((a, i) => ({ a, i })).filter(({ a, i }) => !!a.per && !!spec.sinks[i] && spec.sinks[i]!.ref !== NONE_FIT && spec.sinks[i]!.ref !== UNSAID && !!cat.refs[spec.sinks[i]!.ref]);
  const itemPaths = (w?.paths ?? []).map((p, k) => ({ p, k })).filter(({ p }) => p.subject === "item");
  const sendsFromData = (i: number) => { const r = recipientOf(spec.sinks[i]!.ref, i); return !!r.addrPort && (r.named || (!r.stated && r.addrPort.required && !r.addrPort.fallsBackToRequester)); };
  if (w?.each && perItem.length) placeLoop(w.each);
  if (!loopId) for (const { p, k } of itemPaths) if (w!.actions.some((a) => a.path === k)) unmet.push(`the condition “${p.quote}” on each item was not placed: there is no loop for it to be inside`);

  // 2 · actions, exactly as confirmed — one per spec action, IN ORDER, so the wiring's indexes name them (Phase Y). An edit's own calls
  // of the same tool are not re-placed (`base`); an action placed in an earlier round of this build is found again, not doubled.
  const reused = new Set<string>();
  // Phase F: the actions inside the loop first, so its output has a result to carry when an action after it takes what happened.
  const order = loopId ? [...perItem.map(({ i }) => i), ...spec.sinks.keys()].filter((i, k, xs) => xs.indexOf(i) === k) : [...spec.sinks.keys()];
  for (const i of order) {
    const x = spec.sinks[i]!;
    const ref = x.ref;
    if (ref === NONE_FIT || ref === UNSAID) continue;
    const sig = cat.refs[ref];
    if (!sig) { gaps.push(`the action \`${ref}\` is not in the catalogue`); continue; }
    const again = f.steps.filter((s) => s.kind === "tool" && s.ref === ref && !reused.has(s.id)).slice(count({ steps: base }, "tool", ref));
    if (again.length) { reused.add(again[0]!.id); sinkStep[i] = again[0]!.id; continue; }
    const a = w?.actions[i];
    // builder-behaviour P1 (R6): an action whose condition was not kept is NOT placed as if it ran always — it is unmet, with why.
    if (a?.orphan) { unmet.push(a.orphan === "otherwise" ? `“${x.quote}” should happen otherwise (when none of the conditions holds), and no condition was built for it to be the alternative to` : `“${x.quote}” should happen only when “${a.orphan}”, and that condition was not built`); continue; }
    const inLoop = !!a?.per && !!loopId;
    if (a?.per && w?.each && !loopId) unmet.push(`“${x.quote}” should happen for each item (“${w.each.quote}”), and the loop was not built`);
    const under = inLoop ? (a!.path === "otherwise" ? itemOtherwise : typeof a!.path === "number" ? pathStep[a!.path] : loopId)
      : a?.path === "otherwise" ? otherwiseStep : typeof a?.path === "number" ? pathStep[a.path] : typeof a?.path === "string" ? restStep[Number(a.path.slice(5))] : undefined;
    // The loop's output is placed with the first action after it that takes what happened to each item.
    if (a?.takes === "each" && !collectId) closeLoop(x.quote);
    if (a && a.path !== null && !under) unmet.push(`“${x.quote}” should happen only ${a.path === "otherwise" ? "otherwise" : typeof a.path === "string" ? `for the rest of “${w!.paths[Number(a.path.slice(5))]?.quote}”` : `when “${w!.paths[a.path as number]?.quote}”`}, and that condition was not built`);
    const takes = takesStep(i);
    // P6: a send taking a summary/modelText producer's output is a SINGLE send of computed content — the named group resolves once
    // (confirm/correct), never per-row. The fanout branch would refuse on field:none and hole; skip it.
    const takesProducer = takes !== undefined && f.steps.some((s) => s.id === takes && s.kind === "tool" && cat.refs[s.ref]?.modelText);
    const summaryFed = takesProducer || (a?.takes.startsWith("action:") === true && takes !== undefined);
    const { addrPort, stated, said, named, refused, field: chosen } = recipientOf(ref, i);
    // P1 (RC-1): the platform's reason for refusing a stated address travels with the PORT it refused — stated once the call is
    // placed (below), in the one wording the question for that port reads (`refusalText`), never dropped for a generic re-ask.
    const refusal = refused && addrPort ? { port: addrPort.name, words: unquote(said), why: refused } : null;
    // The address comes from the DATA when the person named people rather than an address — words that are not an address, for a
    // port that does not fall back to the requester (or that they did not ask to be themselves).
    const needsData = !!addrPort && !summaryFed && (named || (!stated && addrPort.required && !addrPort.fallsBackToRequester));
    const id = freshStepId(f, "call");
    const at = under ? { under } : {};
    if (inLoop && needsData) {
      // Inside the loop: the address is the item's own field — the one the loop's list keeps (D-325 narrowed it when it may be empty).
      if (!placeInLoop(ref, i, id, under!, addrPort!.name)) continue;
    } else if (needsData) {
      // I-300: a recipient the person NAMED that no row can supply is unmet — the call is placed so the flow shows it, but a port
      // that falls back to the requester would otherwise send it to whoever runs it, which is not who the person said.
      if (!placeFanout(ref, addrPort!.name, id, said, takes, under, i, chosen)) {
        // P1 (RC-2/RC-6): no field is theirs — the person can still GIVE an address, so the finding is partQuestion's exact
        // wording (asked once), and the port keeps its hole. An optional address the call may go without stays `without`, as before.
        const unreachable = chosen === RECIPIENT_FIELD_NONE && (addrPort!.required || addrPort!.fallsBackToRequester);
        if (unreachable) {
          if (said) unmet.push(noAddressText(id, addrPort!.name, said));
          else unmet.push(`“${said}” — nothing this automation reads holds their address`);
          blocked.add(id);
        } else if (chosen === RECIPIENT_FIELD_NONE) without.push(`“${said}” — nothing this automation reads holds their address, so ${ref} goes without its ${addrPort!.name}`);
        else gaps.push(`\`${ref}\`'s \`${addrPort!.name}\` should come from the data${stated ? ` (“${stated.v.quote}”)` : ""}, but no row here carries an address for it`);
        if (!doOp({ op: "add_call", id, ref, ...at }, `call ${ref} once`)) continue;
        if (unreachable) holeFor(id, addrPort!.name);
      }
    } else if (!inLoop && takes && keyPortOf(ref) && placeFanout(ref, keyPortOf(ref)!, id, "", takes, under, i)) {
      // P7 (R17): a call whose declaration takes ONE row's identity (a required Key port) is about one row: over the list it takes it
      // runs once per row, that row's identity bound — whoever receives it (a typed address is still bound below). Placed once, the
      // identity had nothing to come from (B16b: "if any P1 … page the on call" with the on-call's address given).
    } else if (!doOp({ op: "add_call", id, ref, ...at }, inLoop ? `call ${ref} for each item of ${loopId}` : `call ${ref} once${under ? ` under ${under}` : ""}`)) continue;
    else if (inLoop) bindMessages(id, ref, loopId!, itemTemplates.get(i)?.placed ?? []);
    sinkStep[i] = id;
    // P7 (R24): an action per group that sends the rows sends THAT group's own rows — its content port reads the item's field.
    const content = inLoop ? a?.content : undefined;
    const cport = content ? contentPortOf(ref) : undefined;
    if (content && cport && !portBound(id, cport)) doOp({ op: "bind", stepId: id, port: cport, source: { from: "field", stepId: loopId!, field: content } }, `${id}.${cport} ← each group's own rows (${content})`);
    // P1 (RC-1): the refused literal's reason, stated for the port it refused once the call exists — and that port keeps a HOLE,
    // so the flow's own state reads "not set" beside the finding (never the requester fallback the readback would otherwise show).
    if (refusal) { unmet.push(refusalText(id, refusal.port, refusal.words, refusal.why)); holeFor(id, refusal.port); }
    reused.add(id); // a second action of this tool is its own call, never this one found again
    fillPorts(id);
  }
  // 2b · Phase Y — a person approves an action first, where the goal says so: the engine's gate, spliced before it.
  for (const [i, a] of (w?.actions ?? []).entries()) {
    if (!a.approve || !sinkStep[i]) continue;
    // An action done once per item is approved ONCE, before the loop it runs in. Per-item approval (P4-I4) is refused by the engine
    // until a decision can be delivered to its own item — Kestra v1.3.29 resumes the first paused task (builder-behaviour P5, measured).
    const before = loopOfStep(f as never).get(sinkStep[i]!) ?? sinkStep[i]!;
    if (f.steps.some((s) => s.kind === "approval" && f.steps.find((t) => t.id === before)?.dependsOn.includes(s.id))) continue;
    if (!doOp({ op: "add_gate", id: freshStepId(f, "approve"), before, summary: a.approve }, `a person approves before ${before}${before !== sinkStep[i] ? ` (the loop ${sinkStep[i]} runs in)` : ""} (“${a.approve}”)`)) ours(`the approval “${a.approve}” could not be placed`);
  }

  // Continuing a build: a step placed in an earlier round gets the values answered since (fillPorts touches only OPEN ports).
  for (const s of f.steps) if (s.kind === "tool" || s.kind === "datasource") fillPorts(s.id);
  // Z8 (I-326): wording drafted from the goal, for inputs still open once everything the person said and the data are placed —
  // provenance `drafted`, which the engine admits only on a heading or a message, and the readback says so.
  for (const [i, a] of (w?.actions ?? []).entries()) {
    const id = sinkStep[i];
    if (!id || !a.drafts) continue;
    for (const [port, text] of Object.entries(a.drafts)) {
      if (!portHoles(id).some((h) => h.site.port === port && !input.answered?.has(h.id))) continue;
      // A message drafted for an action that carries DATA is only ever the note beside a file that carries it — never words in place
      // of rows nothing else delivers.
      const toolRef = (f.steps.find((s) => s.id === id && s.kind === "tool") as { ref?: string } | undefined)?.ref ?? "";
      if (cat.refs[toolRef]?.params.find((p) => p.name === port)?.message && !cat.refs[toolRef]?.params.find((p) => p.name === port)?.heading && a.takes !== "nothing" && !filedPortOf(id, toolRef, i)) continue;
      const sig = cat.refs[f.steps.find((s) => s.id === id && s.kind === "tool") ? (f.steps.find((s) => s.id === id) as { ref: string }).ref : ""]?.params.find((p) => p.name === port);
      if (sig && literalFits(text, elemOf(sig.ty), cat) === null) doOp({ op: "bind", stepId: id, port, source: { from: "literal", value: text, provenance: "drafted" } }, `${id}.${port} ← “${text}” (drafted)`);
    }
  }

  // 3 · the result: an action's model-written output is the deliverable; otherwise the data the actions consume.
  if (f.holes.some((h) => h.site.at === "output")) {
    const m = moveOf("set_output");
    const calls = f.steps.filter((s) => s.kind === "tool");
    const modelText = calls.filter((s) => s.kind === "tool" && cat.refs[s.ref]?.modelText).map((s) => s.id);
    const consumed = calls.flatMap((s) => (s.kind === "tool" ? [s.over?.stepId, ...s.inputs.map((b) => (b.source && "stepId" in b.source ? b.source.stepId : undefined))] : [])).filter((x): x is string => !!x);
    // A condition's test (a Decide's hidden transform) is part of the condition, not data anyone asked for — never the result.
    // Phase F: with a loop, what it did (its output) or the list it ran over — never whichever step came last (an unreached list).
    const looped = loopId ? [...(collectId ? [collectId] : []), (f.steps.find((s) => s.id === loopId) as { over: { stepId: string } }).over.stepId] : [];
    const pick = m && ([...modelText, ...looped, ...consumed.reverse(), ...[...f.steps].reverse().map((s) => s.id)].find((id) => m.steps.includes(id) && !decideTest(f, id)));
    if (pick) doOp({ op: "set_output", stepId: pick }, `the result is ${pick}`, m!.steps.length);
  }
  // I-300, judged on the FINAL flow (a later round places nothing, so a check made while placing would vanish): a sending step whose
  // address port falls back to the requester, left unbound although the person named — or was asked — who receives it, would send
  // it to whoever runs it. Not who they said.
  const loose = spec.values.filter((v) => v.role === "recipient" && (!v.fills || v.fills === FILLS_NONE));
  const withAddr = spec.sinks.filter((x) => cat.refs[x.ref]?.params.some((p) => isAddress(p.ty)));
  if (loose.length && withAddr.length > 1) unmet.push(`a recipient (“${loose[0]!.quote || "asked"}”) is not tied to one of the ${withAddr.length} actions that send`);
  // Per ACTION, never per tool (2026-10-02: two emails of one tool — "emailing the customer a reminder" and "otherwise email the
  // reminder straight away" — shared the first's recipient, and the second, unbound, was reported as "no row here carries an address
  // for the customer" although every row did; the fact was that its own words name nobody).
  for (const t of f.steps) {
    if (t.kind !== "tool" || !spec.sinks.some((x) => x.ref === t.ref)) continue;
    const i = Object.entries(sinkStep).find(([, id]) => id === t.id)?.[0];
    const r = recipientOf(t.ref, i === undefined ? undefined : Number(i));
    if (!r.addrPort?.fallsBackToRequester || t.inputs.some((b) => b.name === r.addrPort!.name)) continue;
    // P1 (RC-1): a REFUSED address is never "no address here" — the platform's reason is the finding for this port, and the port
    // keeps a hole (the flow says "not set", never the requester fallback).
    if (r.refused) { unmet.push(refusalText(t.id, r.addrPort.name, unquote(r.said), r.refused)); holeFor(t.id, r.addrPort.name); continue; }
    if (!r.stated) {
      // Its own words name nobody, and another action of this tool sends to people the goal names: whoever runs it is a guess.
      const sib = Object.entries(sinkStep).map(([k, id]) => ({ k: Number(k), id })).find(({ k, id }) => id !== t.id && spec.sinks[k]?.ref === t.ref && recipientOf(t.ref, k).said && recipientOf(t.ref, k).stated?.v.from !== "requester");
      if (sib && i !== undefined) unmet.push(`“${spec.sinks[Number(i)]!.quote}” does not say who receives it (“${spec.sinks[sib.k]!.quote}” goes to “${recipientOf(t.ref, sib.k).said}”)`);
      continue;
    }
    if (r.stated.v.from === "requester") continue;
    // P1 (RC-2/RC-6): the data holds no address for them — the person CAN give one, so this exact wording is partQuestion's to
    // turn into a question, and the port keeps its hole so findings and flow state agree.
    if (r.said) { unmet.push(noAddressText(t.id, r.addrPort.name, r.said)); holeFor(t.id, r.addrPort.name); }
    else unmet.push(`\`${t.id}.${r.addrPort.name}\` was asked (who receives it) and not answered`);
  }
  // A condition the spec lists with no field to test, whose words ARE a test that was placed — a path (new, or an existing one a change
  // named) or a shape's filter stage — is built, by that test. Matched on the person's words, never guessed; only claims that TEST rows
  // count (a loop over every row does not carry "past its promised date" — its filter does; F01, 2026-09-30).
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const tests = [...(w?.paths ?? []).flatMap((pth, k) => (pathStep[k] ? [pth.quote] : [])),
    ...(spec.shapes ?? []).flatMap((sh, si) => sh.stages.flatMap((st, k) => (st.op === "filter" && placedStages.has(`${si}:${k}`) ? [st.quote] : [])))].map(norm).filter(Boolean);
  for (const [i, s] of spec.conditions.entries()) {
    if (s.field && s.field !== FILLS_NONE) continue;
    const q = norm(s.quote);
    if (q && tests.some((t) => t.includes(q) || q.includes(t))) placedConds.add(i);
  }
  for (const [i, s] of spec.conditions.entries()) {
    if ((s.by && s.by !== BY_FLOW) || placedConds.has(i)) continue;
    unmet.push(!s.field || s.field === FILLS_NONE ? `the condition “${s.quote}” is not built: nothing here states how to test it`
      : s.test && VALUED_TESTS.has(s.test) && !s.value?.trim() && !input.condAnswers?.get(i)?.trim() ? `the condition “${s.quote}” needs a value for \`${s.field}\` — asked, and not answered`
      : `the condition “${s.quote}” could not be applied to \`${s.field}\``);
  }
  unmet.push(...shapeNotes);
  for (const [si, sh] of (spec.shapes ?? []).entries()) {
    if (unread.has(si)) continue; // judged below, once what was built is known
    if (!readers().some((r) => (f.steps.find((x) => x.id === r) as { ref?: string }).ref === sh.over)) continue;
    const first = sh.stages.findIndex((_, k) => !placedStages.has(`${si}:${k}`));
    if (first >= 0 && !shapeNotes.some((x) => x.includes(`“${sh.stages[first]!.quote}”`))) unmet.push(`the step “${sh.stages[first]!.quote}” could not be built`);
  }
  skips.push(...skipsShape);
  // A port that must be the row's identity (a dedupe key) and is still open: nothing here declares which row each call is about, and
  // no typed value may stand in — one typed key for every row would suppress all but the first.
  for (const h of f.holes) if (keyHole(h) && h.site.at === "port") unmet.push(`\`${h.site.stepId}.${h.site.port}\` must be the identity of the row each call is about, and nothing read here declares one`);
  // E5.5: the person's words that fill no parameter and that no placed schedule or condition carries — “too long”, “top 5”,
  // “daily” — are part of what they asked for. Stated unmet, so the flow is never complete while silently doing less (I-299).
  const lower = (t: string) => t.toLowerCase().trim();
  // A condition carries its quote AND its compared value ("7 days" as the value of "about to expire" is used, not unused — D19).
  const carriers = [...(f.schedule && spec.schedule ? [spec.schedule.quote] : []), ...spec.conditions.flatMap((c) => [c.quote, ...(c.value?.trim() ? [c.value] : [])]),
    ...(spec.shapes ?? []).flatMap((sh, si) => sh.stages.flatMap((x, k) => (placedStages.has(`${si}:${k}`) ? [x.quote, ...(x.value?.trim() ? [x.value] : [])] : []))),
    // Phase C: a condition the wiring states that was BUILT carries its words and its compared value ("more than 10" of a Decide).
    ...(w?.paths ?? []).flatMap((p, i) => (pathStep[i] ? [p.quote, ...(p.value?.trim() ? [p.value] : [])] : [])),
    // Phase F: the words saying how often an action runs are carried by it when it was placed ("in one message" of a single post).
    ...(w?.actions ?? []).flatMap((a, i) => (a.perWords && sinkStep[i] ? [a.perWords] : [])), ...(w?.each && loopId ? [w.each.quote] : [])].map(lower);
  // A list nothing reads was not built: each of its stages must be something that WAS — its words carried by a built claim, or the
  // same test as a built condition (the field and value an item's condition or its otherwise tests). Else the goal asked for it and
  // nothing does it: stated, never a dead filter that reads back as if it did.
  const lastPart = (x?: string) => (x ?? "").slice((x ?? "").lastIndexOf(".") + 1);
  // …including what a READER already does: an input that selects rows by a field, bound to a value, keeps only those rows.
  const readerTests = f.steps.flatMap((st) => st.kind !== "datasource" ? [] : (st.inputs ?? []).flatMap((b) => {
    const sel = cat.refs[(st as { ref: string }).ref]?.params.find((p) => p.name === b.name)?.selects;
    return sel && b.source && typeof b.source === "object" && (b.source as { from?: string }).from === "literal" ? [{ field: sel, value: String((b.source as { value: unknown }).value) }] : [];
  }));
  const builtTests = [...readerTests, ...(w?.paths ?? []).flatMap((p, i) => (pathStep[i] && p.measure ? [{ field: p.measure, value: p.value ?? "" }] : [])),
    ...spec.conditions.flatMap((c, i) => (placedConds.has(i) && c.field ? [{ field: lastPart(c.field), value: c.value ?? "" }] : []))];
  // Only a claim that TESTS rows carries a filter's words — never the loop's own words ("for each order past its promised date" runs
  // over every row; F01, 2026-10-01: the date filter was built, read by nothing, and the loop emailed every customer).
  // …and what a READ carries out (`covered`, by a reader that was built): "active employees who are not allocated to any project",
  // written as one read, is done by that read — its shape stage over those words is not a list left unbuilt (2026-10-02, H07).
  const builtRefs = new Set(f.steps.flatMap((st) => (st.kind === "datasource" && (st as { ref?: string }).ref ? [(st as { ref: string }).ref] : [])));
  const carried = (spec.covered ?? []).filter((c) => builtRefs.has(c.by)).map((c) => norm(c.quote));
  const testWords = [...tests, ...carried, ...spec.conditions.flatMap((c, i) => (placedConds.has(i) ? [norm(c.quote)] : []))].filter(Boolean);
  // A list that IS a condition's own test (`supersededShapes`) is built by that condition — never "read by no action".
  for (const si of unread) if (!superseded.has(si)) for (const st of spec.shapes![si]!.stages) {
    const q = norm(st.quote);
    const sameTest = !!st.field && builtTests.some((t) => t.field === lastPart(st.field ?? undefined) && norm(t.value) === norm(st.value ?? ""));
    if (sameTest || (q && testWords.some((c) => c.includes(q) || q.includes(c)))) continue;
    const loopsAll = w?.each?.over.startsWith("reader:") && spec.sources[Number(w.each.over.slice(7))]?.ref === spec.shapes![si]!.over;
    unmet.push(`the list “${st.quote}” is read by no action, so nothing built does it${loopsAll ? ` — the for each “${w!.each!.quote}” runs over every row, not over this list` : ""}`);
  }
  for (const v of spec.values) {
    if (v.input) continue; // a plan input's use is judged below (P1-D4), once
    if (v.role === "recipient" || v.from === "requester" || (v.fills && v.fills !== FILLS_NONE) || !v.quote.trim()) continue;
    const q = lower(v.quote);
    if (carriers.some((c) => c.includes(q) || q.includes(c))) continue;
    // P9: a threshold/count whose quote sits inside a built read's covered band clause is used by that CASE WHEN
    // (e.g. upper bound "9.49" next to arm edge "9.5"). Compare with the same `norm` carried uses (dots → spaces).
    const nq = norm(v.quote);
    if (nq && carried.some((c) => c.includes(nq) || nq.includes(c))) continue;
    unmet.push(`the goal says “${v.quote}” (${v.role}), and nothing built here uses it`);
  }
  // Part of the goal the spec never touched and never stated (checkSpec's `unaccounted`) — the flow does less than asked.
  for (const c of input.spec.unaccounted ?? []) unmet.push(`the goal also says “${c}”, and nothing built here does it`);
  // E5.5: words the model could not tie to anything, still unsettled after the person was asked — never built around as a guess.
  for (const u of spec.unclear ?? []) unmet.push(u.assumed ? `“${u.quote}” was read as ${u.assumed}, and that was not confirmed` : u.missing ? `“${u.quote}” is not in the data — ${u.missing}` : `“${u.quote}” is unclear — what it refers to was not settled`);
  // A flow that only reads and shapes is complete: its result is the data. Unmet only when the goal DID ask for something to be done.
  if (!f.steps.some((x) => x.kind === "tool") && spec.sinks.length) unmet.push(spec.sinks.some((x) => x.ref !== UNSAID) ? "none of the actions the goal names could be placed" : "the goal asks for something to be done, and what was not settled");
  if (spec.schedule && !f.schedule) unmet.push(`the schedule “${spec.schedule.quote || spec.schedule.cron}” could not be set`);
  // builder-inputs P1-D4: complete is judged on the BUILT flow — every input the plan names is taken by a step or a placed filter;
  // every run input the flow asks for is read (the engine's own test); and every part of the plan code could not lower is stated.
  // …or an item's test that reads it, once that test is built (builder-behaviour P1: E08's "100" compared per item was "used by nothing").
  const placedInput = (id: string) => (spec.shapes ?? []).some((sh, si) => sh.stages.some((st, k) => st.value === `input:${id}` && placedStages.has(`${si}:${k}`)))
    || (w?.paths ?? []).some((p, k) => ((p.subject === "item" && !!p.where?.some((t) => t.input === id)) || p.input === id) && !!pathStep[k]);
  // Judged on the flow as it NOW is, never on what this round did: a build continued over several turns bound its ports earlier.
  const portTaken = (fills: string) => { const ref = fills.slice(0, fills.lastIndexOf(".")), port = fills.slice(fills.lastIndexOf(".") + 1); return f.steps.some((st) => (st as { ref?: string }).ref === ref && portBound(st.id, port)); };
  const taken = (id: string) => spec.values.some((v) => v.input === id && !!v.fills && v.fills !== FILLS_NONE && portTaken(v.fills));
  for (const i of specInputs) if (!(i.at === "flow" ? placedInput(i.id) : realised.has(i.id) || taken(i.id))) unmet.push(`the input “${i.words}” is used by nothing built`);
  for (const id of unreadInputs(f, cat)) unmet.push(`the automation asks for \`${id}\` on every run, and nothing built reads it`);
  unmet.push(...(spec.planGaps ?? []));
  gaps.push(...unmet);
  // Each gap once: several claims can state the same missing thing (three lists sharing one stage), and a person reads a list of what
  // is not done — a repeat reads as three problems.
  return { flow: f, moves, gaps, covered: [...covered], unmet: [...new Set(unmet)], internal: [...internal].filter((u) => unmet.includes(u)), drafts, skips, blocked: [...blocked].filter((id) => f.steps.some((s) => s.id === id)), without: [...new Set(without)] };

  /**
   * Phase F (D-381): the loop over the rows the for-each names. Its list is its own bounded step — the catalogue's own cap, and, for a
   * send whose only address may be empty, D-325's rule (the rows with none skipped, kept to be seen) — with the per-item messages
   * added as fields BEFORE the loop reads it. Then the loop, and the goal's conditions on each item as ONE Decide chain inside it:
   * every test first (a test inside a loop cannot be placed ahead of its chain), then the links, then the otherwise.
   */
  /**
   * The OTHER field of `subject` a compared value's words name ("more than its budget" → `budget_amount`) — so the test compares two
   * fields of the same row, never the words as a number (2026-10-01: “its budget” is not a number). Words holding a digit are a
   * value. A field's own words, its singular or plural, or the ONE field that starts or ends with them; never the measured field.
   */
  function againstField(subject: string, words: string, measure: string): string | undefined {
    if (/\d/.test(words)) return undefined;
    const ty = readableTy(f, cat, subject);
    if (typeof ty === "string") return undefined;
    const rec = rowOf(ty);
    if (rec.t !== "Record") return undefined;
    // Step 4: the model's `against` names the field (`ref.field`); code never mines words for one.
    const names = Object.keys(rec.fields as Record<string, Ty>).filter((n) => n !== measure);
    return names.length === 1 ? names[0] : undefined;
  }


  /**
   * The flow inputs a pipeline reads, declared once: the run day and the days before it (computed at firing time — never asked, never a
   * default), and the run inputs a test against a plan input reads (asked each run, or worked out from the run date). ONE place, for a
   * list's filters and an item's test alike.
   */
  function declareReadInputs(stages: Comb[]) {
    const text = JSON.stringify(stages);
    if (text.includes(`"input":"${RUN_DAY}"`) && !f.inputs.some((x) => x.id === RUN_DAY)) doOp({ op: "declare_input", id: RUN_DAY, type: "DATE", computed: "currentDate" }, "the day it runs (computed when it runs)");
    for (const m of text.matchAll(/"input":"days_before_(\d+)"/g)) {
      const n = Number(m[1]), id = daysBefore(n);
      if (!f.inputs.some((x) => x.id === id)) doOp({ op: "declare_input", id, type: "DATE", computed: "currentDate", offsetDays: -n }, `${n} days before the day it runs (computed when it runs)`);
    }
    for (const [id, d] of flowDecls(specInputs, asked)) if (text.includes(`"input":"${id}"`) && !f.inputs.some((x) => x.id === id))
      doOp({ op: "declare_input", ...d } as EngineOp, d.computed ? `${id} (computed when it runs)` : `ask for ${id} each run`);
  }

  /**
   * builder-behaviour P1 (R10): the test of ONE item, from EVERY test the plan states — each lowered by `condStages` (the list filters'
   * own lowering: every test kind, inputs, run-date tests, null rules) and held together as ONE `keep_if` on the item, so the condition
   * holds when all of them do. A comparison with another field is the same comparison, both sides narrowed when they may be empty.
   */
  function itemTest(subject: string, p: { quote: string; where: readonly ItemTest[] }): Comb[] | string {
    const ty = readableTy(f as never, cat, subject);
    const rec = typeof ty === "string" ? null : rowOf(ty.t === "Envelope" ? ty.of : ty);
    if (!rec || rec.t !== "Record") return `${subject} gives no item to test`;
    return itemTestOf(p.where, rec.fields as Record<string, Ty>, p.quote, input.spec.texts ?? [], inputCtx);
  }

  function placeLoop(each: NonNullable<typeof w>["each"] & object) {
    const from = stepOfKey(each.over);
    if (!from) { unmet.push(`the for each “${each.quote}” runs over a list that was not built`); return; }
    const overOf = (id: string) => f.steps.find((s) => s.id === id) as { kind: string; from?: string } | undefined;
    // A later round of the build finds its loop again.
    const had = f.steps.find((s): s is Extract<typeof s, { kind: "for_each" }> => s.kind === "for_each" && (s.over.stepId === from || overOf(s.over.stepId)?.from === from));
    if (had) loopId = had.id;
    else {
      // Its list: the one a per-row send runs over (`rowList`, shared with the fan-out) — unless the list named is already a bounded
      // one that nothing has to be skipped from, which the loop takes as it is.
      const sends = perItem.filter(({ i }) => sendsFromData(i)).map(({ i }) => { const r = recipientOf(spec.sinks[i]!.ref, i); return { i, ref: spec.sinks[i]!.ref, quote: r.said, field: r.field }; });
      const skipsNothing = sends.every((x) => !nullableAddressField(from, x.quote, x.field) && !nullableKeyField(from, x.ref));
      const as = overOf(from)?.kind === "transform" && skipsNothing && apply(f, { op: "add_loop", id: freshStepId(f, "each"), over: from }, cat).ok ? from : rowList(from, sends);
      if (!as) { unmet.push(`the for each “${each.quote}” needs a list with a row limit, and \`${from}\` offers none`); return; }
      for (const x of sends) {
        const field = addressField(as, x.quote, x.field);
        if (field) itemTemplates.set(x.i, { field, placed: rowMessages(x.ref, as, field, x.i) });
      }
      // Every OTHER call inside the loop is its item's too: one that sends to nobody still runs once per item, and a call that
      // carries nothing of its item makes the same call for every one (2026-10-01: a ticket "Urgent customer waiting" per ticket,
      // naming none). Its item's message goes on its message ports nobody's words fill — required or not: here it is what makes
      // each call this item's (a send's address already does). Every word is a field's name or value (D-324), read back.
      for (const { i } of perItem) if (!itemTemplates.has(i) && !sends.some((x) => x.i === i)) itemTemplates.set(i, { field: "", placed: rowMessages(spec.sinks[i]!.ref, as, "", i, true) });
      const id = freshStepId(f, "each");
      if (!doOp({ op: "add_loop", id, over: as }, `for each row of ${as} (“${each.quote}”)`)) { ours(`the for each “${each.quote}” could not be placed`); return; }
      loopId = id;
    }
    // The conditions on each item: a Decide chain inside the loop — `decideOps`, the top level's and the canvas's own function (D-382:
    // an else-if's test runs ahead of its chain inside the loop as it does outside). A later round finds each link again.
    let lastIn: string | undefined;
    for (const { p, k } of itemPaths) {
      if (!pathHasActions(w!, k)) { ours(`the condition “${p.quote}” has nothing to do on it`); continue; }
      if (p.where?.length) {
        const pipeline = itemTest(loopId!, { quote: p.quote, where: p.where });
        if (typeof pipeline === "string") { unmet.push(`the condition “${p.quote}”: ${pipeline}`); continue; }
        const want = JSON.stringify(pipeline);
        const again = f.steps.find((s): s is Extract<typeof s, { kind: "branch" }> => s.kind === "branch" && (lastIn ? s.elseOf === lastIn : !s.elseOf) && s.conditions?.length === 1
          && (() => { const t = f.steps.find((x) => x.id === s.conditions![0]!.left.stepId); return t?.kind === "transform" && t.from === loopId && JSON.stringify(t.pipeline) === want; })());
        if (again) { pathStep[k] = lastIn = again.id; continue; }
        declareReadInputs(pipeline);
        const test = freshStepId(f, "test"), branch = freshStepId(f, lastIn ? "elif" : "when");
        const ops: EngineOp[] = lastIn
          ? [{ op: "add_transform", id: test, from: loopId!, pipeline, before: engineChainHead(f as never, lastIn) }, { op: "add_otherwise", id: branch, of: lastIn, when: [{ stepId: test, test: "any" }] }]
          : [{ op: "add_transform", id: test, from: loopId!, pipeline }, { op: "add_branch", id: branch, when: [{ stepId: test, test: "any" }] }];
        if (!doOps(ops, `for each item, ${lastIn ? "otherwise when" : "only when"} ${p.where.map((t) => `its ${t.field} ${t.test}${t.value ? ` ${t.value}` : t.against ? ` its ${t.against}` : t.input ? ` the input ${t.input}` : ""}`).join(" and ")} (“${p.quote}”)`)) { ours(`the condition “${p.quote}” could not be placed`); continue; }
        pathStep[k] = lastIn = branch;
        continue;
      }
      const vs = againstField(loopId!, p.value!, p.measure!);
      const made = decideOps(f, cat, { subject: loopId!, measure: p.measure!, cmp: p.cmp!, value: p.value!, from: "goal", quote: p.value!, ...(vs ? { against: vs } : {}), ...(lastIn ? { of: lastIn } : {}) });
      if (typeof made === "string") { unmet.push(`the condition “${p.quote}”: ${made}`); continue; }
      const want = JSON.stringify((made.ops[0] as { pipeline: unknown }).pipeline);
      const again = f.steps.find((s): s is Extract<typeof s, { kind: "branch" }> => s.kind === "branch" && (lastIn ? s.elseOf === lastIn : !s.elseOf) && s.conditions?.length === 1
        && (() => { const t = f.steps.find((x) => x.id === s.conditions![0]!.left.stepId); return t?.kind === "transform" && t.from === loopId && JSON.stringify(t.pipeline) === want; })());
      if (again) { pathStep[k] = lastIn = again.id; continue; }
      if (!doOps(made.ops, `for each item, ${lastIn ? "otherwise when" : "only when"} its ${p.measure} ${p.cmp} ${p.value} (“${p.quote}”)`)) { ours(`the condition “${p.quote}” could not be placed`); continue; }
      pathStep[k] = lastIn = made.branch;
    }
    if (lastIn && w!.actions.some((a) => a.per && a.path === "otherwise")) {
      const found = f.steps.find((s) => s.kind === "branch" && s.elseOf === lastIn && !s.conditions?.length)?.id;
      const id = found ?? freshStepId(f, "otherwise");
      if (found || doOp({ op: "add_otherwise", id, of: lastIn }, "for each item, otherwise (none of its conditions holds)")) itemOtherwise = id;
    }
  }

  /** Phase F: a send inside the loop — to the item's own address field, with its per-item message (placed on the list) bound. */
  function placeInLoop(ref: string, i: number, id: string, under: string, port: string): boolean {
    const r = recipientOf(ref, i);
    const t = itemTemplates.get(i);
    const field = t?.field ?? addressField(loopId!, r.said, r.field);
    if (!field && r.field === RECIPIENT_FIELD_NONE) {
      // An address the call cannot go without: not done, its ports never asked. One it may go without (an optional assignee): the
      // call is made without it — what was asked is done — and the person is told whose address nothing holds.
      // An address that, left out, goes to whoever runs it (`fallsBackToRequester`) is never "without": the named people would
      // become someone else (cp3 B24: an email "to the customer's account manager" sent to the runner).
      const optional = !cat.refs[ref]?.params.find((q) => q.name === port)?.required && !r.addrPort?.fallsBackToRequester;
      if (!optional) {
        // P1 (RC-2/RC-6): the loop's rows carry no address for them — the person can still GIVE one, so the finding is
        // partQuestion's exact wording (asked once, never a terminal), and the port keeps its hole.
        if (r.said) unmet.push(noAddressText(id, port, r.said));
        else unmet.push(`“${r.said}” — nothing this automation reads holds their address`);
        blocked.add(id);
        const placed = doOp({ op: "add_call", id, ref, under }, `call ${ref} for each item`);
        if (placed) holeFor(id, port);
        return placed;
      }
      without.push(`“${r.said}” — nothing this automation reads holds their address, so ${ref} goes without its ${port}`);
      if (!doOp({ op: "add_call", id, ref, under }, `call ${ref} for each item, without ${port}`)) return false;
      bindMessages(id, ref, loopId!, t?.placed ?? []);
      return true;
    }
    if (!field) {
      blocked.add(id);
      gaps.push(`\`${ref}\`'s \`${port}\` should come from each item, but the items carry no address for it`);
      // P1 (RC-2/RC-6): the plan chose a field these items do not carry — same askable finding (an address the person can give),
      // one wording for the data's limit wherever the send runs.
      if (r.said) unmet.push(noAddressText(id, port, r.said));
      else unmet.push(`the goal says who receives \`${ref}\` for each item, but the items carry no address for them`);
      const placed = doOp({ op: "add_call", id, ref, under }, `call ${ref} for each item`);
      if (placed) holeFor(id, port);
      return placed;
    }
    if (!doOp({ op: "add_call", id, ref, under }, `call ${ref} for each item of ${loopId}`)) return false;
    doOp({ op: "bind", stepId: id, port, source: { from: "field", stepId: loopId!, field } }, `${id}.${port} ← the item's ${field}`);
    bindMessages(id, ref, loopId!, t?.placed ?? []);
    return true;
  }

  /**
   * Phase F: the loop's output — one row per item with what happened — for an action after it. Each row's result is the first step
   * inside that runs for EVERY item (the engine refuses one under a condition inside: its value would be missing for the others).
   */
  function closeLoop(quote: string) {
    if (!loopId) return;
    const had = collectOf(f, loopId);
    if (had) { collectId = had.id; return; }
    const id = freshStepId(f, `${loopId}_rows`);
    const body = loopMembers(f, loopId);
    // A condition's test is part of the condition, not what happened (and read by the output it would stop being a condition).
    const fits = (r: string) => !decideTest(f, r) && apply(f, { op: "close_loop", id, loop: loopId!, result: r }, cat).ok;
    let pick = [...perItem.map(({ i }) => sinkStep[i]).filter((x): x is string => !!x), ...body].find(fits);
    // Every step inside runs on one of its paths only (merging them is owed, I-317): each row's result is then the item's own fields —
    // what happened to it is still its `ff_ok` / `ff_error`. Stated in the trace, never a guess at which path's value is wanted.
    if (!pick) {
      const ty = readableTy(f, cat, loopId);
      const row = typeof ty === "string" ? null : rowOf(ty);
      const names = row?.t === "Record" ? Object.keys(row.fields) : [];
      const own = freshStepId(f, "item");
      if (names.length && doOp({ op: "add_transform", id: own, from: loopId, pipeline: [{ op: "project", fields: names.map((n) => ({ name: n, from: n })) }] }, `each item's own fields, as the loop's result (every step inside runs on one path only)`)) pick = own;
    }
    if (!pick) { ours(`“${quote}” takes what happened to each item, and the loop's output could not be placed`); return; }
    if (doOp({ op: "close_loop", id, loop: loopId, result: pick }, `the loop's output: one row per item, each with what ${pick} gave`)) collectId = id;
  }

  /** The Address field of `stepId`'s rows (or its one record) to send by: a non-empty one first, then by the person's words. */
  function addressField(stepId: string, quote: string, chosen?: string): string | null {
    const ty = readableTy(f, cat, stepId);
    if (typeof ty === "string") return null;
    const row = rowOf(ty);
    if (row.t !== "Record") return null;
    const fields = Object.entries(row.fields as Record<string, Ty>);
    // P7 (R15): the plan chose WHOSE address it is — that field or nothing; a nearby person's address is never ranked in.
    if (chosen === RECIPIENT_FIELD_NONE) return null;
    if (chosen && chosen !== "new_read") return fields.some(([n, t]) => n === chosen && (t.t === "Address" || (t.t === "Option" && t.of.t === "Address"))) ? chosen : null;
    const rank = (xs: Array<[string, Ty]>) => [...xs].sort((a, b) => overlap(quote, b[0]) - overlap(quote, a[0]))[0]?.[0] ?? null;
    return rank(fields.filter(([, t]) => t.t === "Address")) ?? rank(fields.filter(([, t]) => t.t === "Option" && t.of.t === "Address"));
  }

  /** A fan-out of `ref` over a bounded list whose rows carry an address for `port`. Adds the bounding stage if the engine needs one. */
  function placeFanout(ref: string, port: string, id: string, quote: string, takes?: string, under?: string, sink?: number, chosen?: string): boolean {
    if (chosen === RECIPIENT_FIELD_NONE) return false;
    // Phase Y: over the list the action TAKES when the goal says which — never whichever list happens to be first.
    const onTakes = (over: string) => !takes || over === takes || f.steps.some((s) => s.id === over && s.kind === "transform" && s.from === takes);
    const find = () => moveOf("add_call")?.fanouts.filter((fo) => fo.ref === ref && fo.row.port === port && onTakes(fo.over)) ?? [];
    let fos = find();
    if (!fos.length) {
      // The engine fans out only over a transform (a bounded list): the smallest stage that makes one — the catalogue's own cap.
      for (const r of takes ? [takes] : readers().map(dataOf)) {
        if (f.steps.some((s) => s.kind === "transform" && s.from === r)) continue;
        if (!rowList(r, [{ ref, quote, field: chosen }], under)) continue;
        // One list is enough: bounding every other reader too would state skips for rows no action sends to (measured on D10/R10:
        // "rows of oncall_now with no contact_email get no message", where nothing messages them).
        if (find().length) break;
      }
      fos = find();
    }
    // P7 (R15): the plan's chosen field, or nothing — never the nearest name.
    if (chosen && chosen !== "new_read") fos = fos.filter((fo) => fo.row.field === chosen);
    if (!fos.length) return false;
    // Which column: the one whose name shares the most words with how the person named them; ties keep the catalogue's order.
    const best = [...fos].sort((a, b) => overlap(quote, b.row.field) - overlap(quote, a.row.field))[0]!;
    const placed = rowMessages(ref, best.over, best.row.field, sink);
    if (!doOp({ op: "add_call", id, ...best, ...(under ? { under } : {}) }, `call ${ref} once per row of ${best.over}, ${best.row.port} ← ${best.row.field}`, fos.length)) return false;
    bindMessages(id, ref, best.over, placed);
    return true;
  }

  /**
   * THE list a per-row send runs over (a fan-out's, or a loop's), made from `from`: the catalogue's own row cap, and D-325 (the
   * person's decision) — when the only address the rows carry may be EMPTY, the rows with none are skipped by a filter before the
   * send, stated in the readback, and a second step keeps exactly the skipped rows, so the run shows them; the same for a row's
   * identity when a call dedupes on it (a Key port). One definition for both, so a loop and a fan-out can never skip differently.
   */
  function rowList(from: string, sends: Array<{ ref: string; quote: string; field?: string }>, under?: string): string | null {
    const limit = moveOf("add_transform", (m) => m.from === from)?.stages.find((st) => st.op === "limit");
    if (!limit) return null;
    // A row is dropped when ANY send it feeds cannot reach its address: the engine will not bind an address that may be empty (it must
    // be narrowed first), and a list is narrowed for every action that reads it. Several sends sharing ONE list (a loop) therefore
    // drop a row for all of them when one cannot use it — stated, never silent (2026-10-01): a ticket with no team address gets no
    // customer email either. Narrowing per send, per item, is owed to the engine (a condition inside a condition is not built).
    const needs = sends.map((x) => new Set([nullableAddressField(from, x.quote, x.field), nullableKeyField(from, x.ref)].filter((n): n is string => !!n)));
    const narrow = [...new Set(needs.flatMap((ns) => [...ns]))];
    const alsoFor = (n: string) => sends.filter((_, k) => !needs[k]!.has(n)).map((x) => x.quote);
    const id = freshStepId(f, "shape");
    const pipeline = [...narrow.map((n) => ({ op: "filter", where: { notNull: n } }) as const), limit];
    // A send guarded by a condition runs where that condition is, so it reads only what runs BEFORE it: its list goes ahead of the
    // condition's first link (2026-10-01: built after it, the per-row send was refused and fell back to ONE message to nobody).
    const ahead = chainHead(under);
    const before = ahead ? { before: ahead } : {};
    if (!doOp({ op: "add_transform", id, from, pipeline, ...before }, `from ${from}: ${narrow.map((n) => `rows with a ${n}, `).join("")}at most ${(limit as { n: { value: number } }).n.value} rows`)) return null;
    for (const n of narrow) if (doOp({ op: "add_transform", id: freshStepId(f, "unreached"), from, pipeline: [{ op: "filter", where: { isNull: n } }], ...before }, `from ${from}: the rows with no ${n} (skipped, kept to be seen)`)) skips.push({ reader: readerOf(from), field: n, ...(alsoFor(n).length ? { alsoFor: alsoFor(n) } : {}) });
    return id;
  }
  /** The first link of the condition chain `under` belongs to (walking each otherwise back to its IF); none for a loop or no place. */
  function chainHead(under?: string): string | undefined {
    let b = under ? f.steps.find((x) => x.id === under) : undefined;
    if (b?.kind !== "branch") return undefined;
    for (let n = 0; b?.kind === "branch" && b.elseOf && n < f.steps.length; n++) b = f.steps.find((x) => x.id === (b as { elseOf: string }).elseOf);
    return b?.id;
  }
  /** The READER step a list is read from — which the readback names by its component, never a step between (“rows of where 1”). */
  function readerOf(stepId: string): string {
    let s = f.steps.find((x) => x.id === stepId);
    for (let n = 0; s?.kind === "transform" && n < f.steps.length; n++) s = f.steps.find((x) => x.id === (s as { from: string }).from);
    return s?.kind === "datasource" ? s.id : stepId;
  }
  /** D-324: a per-row send's message text, as a field of each row of `over` — added BEFORE anything reads the list (a read list is fixed). */
  function rowMessages(ref: string, over: string, addressField: string, sink?: number, optional = false) {
    // A template that shows a minor-units amount reads its converted field: the conversion is placed on the list first, once.
    const rowTy = readableTy(f, cat, over);
    const row = typeof rowTy === "string" ? null : rowOf(rowTy);
    const converts = row?.t === "Record" ? minorConverts(row.fields as Record<string, Ty>) : [];
    const used = (parts: Part[]) => converts.filter((c) => parts.some((p) => ("field" in p ? p.field : "opt" in p ? p.opt : undefined) === (c as { as: string }).as));
    return messageTemplates(ref, over, addressField, sink, optional).filter((d) => used(d.parts).every((c) => (f.steps.find((x) => x.id === over) as { pipeline?: Comb[] } | undefined)?.pipeline?.some((st) => JSON.stringify(st) === JSON.stringify(c))
        || doOp({ op: "append_stage", stepId: over, stage: c }, `each row of ${over} gets ${(c as { as: string }).as}: ${(c as { field: string }).field} in whole units`)) &&
      doOp({ op: "append_stage", stepId: over, stage: { op: "template", as: d.as, parts: d.parts } }, `each row of ${over} gets ${d.as}: “${d.text}”`));
  }
  /** …and bound to the call from each row (`rows`: the list for a fan-out, the loop for a call inside it — its item is one row). */
  function bindMessages(id: string, ref: string, rows: string, placed: ReturnType<typeof rowMessages>) {
    for (const d of placed) if (doOp({ op: "bind", stepId: id, port: d.port, source: { from: "field", stepId: rows, field: d.as } }, `${id}.${d.port} ← ${rows}.${d.as}`)) drafts.push({ ref, port: d.port, parts: d.parts, text: d.text, ...(d.sink !== undefined ? { sink: d.sink } : {}) });
  }

  /**
   * The address field to send by when a reader's rows carry NO always-present address but do carry one that may be empty: the
   * nullable `Address` whose name shares the most words with how the person named them (ties keep the catalogue's order). `null`
   * when the rows have a non-null address (nothing to skip) or none at all (nothing to send by).
   */
  /**
   * The identity field to dedupe by when `ref` takes a Key and the reader's rows carry exactly ONE key that may be empty (a query
   * reports every column nullable through its joins). `null` when there is a non-null key, none, or more than one to choose from.
   */
  /** P7 (R24): where an action's content goes — its declared message port (not a heading), else its declared data port. */
  function contentPortOf(ref: string): string | undefined {
    const ps = cat.refs[ref]?.params ?? [];
    return (ps.find((q) => q.message && !q.heading) ?? ps.find((q) => q.data))?.name;
  }

  /** P7 (R17): the port a tool DECLARES takes one row's identity (a required Key), or none. */
  function keyPortOf(ref: string): string | undefined {
    return cat.refs[ref]?.params.find((p) => p.required && elemOf(p.ty).t === "Key")?.name;
  }

  function nullableKeyField(reader: string, ref: string): string | null {
    if (!cat.refs[ref]?.params.some((p) => elemOf(p.ty).t === "Key")) return null;
    const ty = readableTy(f, cat, reader);
    if (typeof ty === "string") return null;
    const row = rowOf(ty);
    if (row.t !== "Record") return null;
    const fields = Object.entries(row.fields as Record<string, Ty>);
    if (fields.some(([, t]) => t.t === "Key")) return null;
    const opt = fields.filter(([, t]) => t.t === "Option" && t.of.t === "Key").map(([n]) => n);
    return opt.length === 1 ? opt[0]! : null;
  }

  function nullableAddressField(reader: string, quote: string, chosen?: string): string | null {
    const ty = readableTy(f, cat, reader);
    if (typeof ty === "string") return null;
    const row = rowOf(ty);
    if (row.t !== "Record") return null;
    const fields = Object.entries(row.fields as Record<string, Ty>);
    if (chosen === RECIPIENT_FIELD_NONE) return null;
    if (chosen && chosen !== "new_read") return fields.some(([n, t]) => n === chosen && t.t === "Option" && t.of.t === "Address") ? chosen : null;
    if (fields.some(([, t]) => t.t === "Address")) return null;
    const opt = fields.filter(([, t]) => t.t === "Option" && t.of.t === "Address").map(([n]) => n);
    return [...opt].sort((a, b) => overlap(quote, b) - overlap(quote, a))[0] ?? null;
  }

  /**
   * The message ports (declared `message`) of a per-row call that nothing the person said fills, each with a template of the row's own
   * fields — `"propose"` drafts it, a confirmed list supplies it, otherwise none. Fields: the row's scalars in the catalogue's order,
   * never the address the call is sent to, at most six; an optional field is written only when present. Nothing is invented: every
   * word is a field's name or its value.
   */
  function messageTemplates(ref: string, over: string, addressField: string, sink?: number, optional = false): Array<{ port: string; as: string; parts: Part[]; text: string; sink?: number }> {
    if (!input.drafts) return [];
    const rowTy = readableTy(f, cat, over);
    if (typeof rowTy === "string") return [];
    const row = rowOf(rowTy);
    if (row.t !== "Record") return [];
    const out: Array<{ port: string; as: string; parts: Part[]; text: string }> = [];
    for (const p of cat.refs[ref]?.params ?? []) {
      // THIS action's value (a value another action on the same tool owns is that one's, never a reason to leave this one undrafted).
      if (!p.message || (!p.required && !optional) || valuesFor(ref, p.name, sink).length) continue;
      // P7 (R24): the port that carries a group's own rows is not drafted — it IS those rows.
      if (sink !== undefined && w?.actions[sink]?.content && p.name === contentPortOf(ref)) continue;
      const confirmed = Array.isArray(input.drafts) ? input.drafts.find((d) => d.ref === ref && d.port === p.name && (d.sink === undefined || sink === undefined || d.sink === sink)) : undefined;
      if (Array.isArray(input.drafts) && !confirmed) continue;
      const parts = confirmed?.parts ?? draftParts(row.fields as Record<string, Ty>, addressField);
      if (!parts.length) continue;
      let as = `${p.name}_text`;
      for (let n = 2; (row.fields as Record<string, Ty>)[as] || out.some((o) => o.as === as); n++) as = `${p.name}_text_${n}`;
      out.push({ port: p.name, as, parts, text: confirmed?.text ?? partsText(parts), ...(sink !== undefined ? { sink } : {}) });
    }
    return out;
  }

  /** The step an action reads a reader's data THROUGH: its condition filter when one was placed (D-326), else the reader itself. */
  function dataOf(r: string): string {
    // Phase Y: a shaped list is ITS OWN list, never "the reader's rows" — only a conditions-only filter stands for the reader.
    const lists = new Set(listStep.values());
    return (f.steps.find((x) => x.kind === "transform" && x.from === r && x.id.startsWith("where") && !lists.has(x.id)) as { id: string } | undefined)?.id ?? r;
  }

  /**
   * Who receives `ref`'s call, as the person said it: the address port (the one a stated recipient FILLS wins — I-300: preferring a
   * port that does not fall back to the requester picked `cc` over `to`), the value (mapped to it, or a recipient mapped to no
   * parameter when this is the ONE confirmed action that sends), their words (quoted, or their answer), and whether those words are
   * a group rather than an address.
   */
  function recipientOf(ref: string, sink?: number) {
    const sig = cat.refs[ref]!;
    const filled = sig.params.find((p) => isAddress(p.ty) && valuesFor(ref, p.name, sink).some(({ v }) => v.role === "recipient"));
    const addrPort = filled ?? sig.params.find((p) => isAddress(p.ty) && p.required && !p.fallsBackToRequester) ?? sig.params.find((p) => isAddress(p.ty) && !p.fallsBackToRequester) ?? sig.params.find((p) => isAddress(p.ty));
    const loose = spec.values.map((v, i) => ({ v, i })).filter(({ v }) => v.role === "recipient" && (!v.fills || v.fills === FILLS_NONE));
    const oneSender = spec.sinks.filter((x) => cat.refs[x.ref]?.params.some((p) => isAddress(p.ty))).length === 1;
    const stated = addrPort ? valuesFor(ref, addrPort.name, sink)[0] ?? (oneSender ? loose[0] : undefined) : undefined;
    const said = stated ? (stated.v.from === "goal" || stated.v.from === "earlier" ? stated.v.quote.trim() : stated.v.from === "ask_person" ? answers.get(stated.i)?.trim() ?? "" : "") : "";
    // Words SHAPED like an address are an address, never "people the data must supply" — an address the platform refuses (a reserved
    // domain, 2026-10-01) is stated with the platform's reason (`refused`), and never sent to the requester or looked up in the rows.
    const misfit = !!addrPort && !!said ? literalFits(said, elemOf(addrPort.ty), cat) : null;
    const shaped = ADDRESS_SHAPE.test(said);
    const named = misfit !== null && !shaped;
    const refused = misfit !== null && shaped ? misfit : null;
    // P7 (R15): the address field the PLAN chose for these people (`none`: no field is theirs) — undefined when it chose none.
    const field = stated?.v.field;
    return { addrPort, stated, said, named, refused, field };
  }

  /**
   * The VALUE the person's words stand for on a port of type `slot`: the words themselves when they fit,
   * else null, and the port stays a question. Words are never bound raw where the port's type or the column's values say otherwise.
   */
  function asValue(words: string, slot: Ty): { value: string; note: string } | null {
    if (literalFits(words, slot, cat) === null) return { value: words, note: "" };
    return null;
  }

  /**
   * The stated value for a port when the person's words give it MORE than once (2026-10-01: "1 August to 14 August 2026" and
   * "1 August" both mapped to `start_date`; the range was first, does not read as one date, and the date the person stated was
   * asked for). The first whose words READ as the port's type wins; else the first, as before (an answer, a run input, the requester).
   */
  /** The port a stated FILE for this call takes its rows through (declared: a port that `needs` a `fromStep` port), or undefined. */
  function filedPortOf(stepId: string, ref: string, sink: number): string | undefined {
    const ps = cat.refs[ref]?.params ?? [];
    const bound = (name: string) => !!(f.steps.find((x) => x.id === stepId) as { inputs?: Array<{ name: string; source: unknown }> } | undefined)?.inputs?.some((b) => b.name === name && !!b.source);
    return ps.find((p) => p.needs && ps.find((q) => q.name === p.needs)?.fromStep && (bound(p.name) || !!statedFor(ref, p.name, sink, elemOf(p.ty))))?.needs;
  }

  function statedFor(ref: string, port: string, sink: number, slot: Ty) {
    const all = valuesFor(ref, port, sink);
    const edge = cat.refs[ref]?.params.find((p) => p.name === port)?.edge;
    const stated = ({ v }: { v: GoalSpec["values"][number] }) => v.from === "goal" || v.from === "earlier";
    const reads = all.find((x) => stated(x) && !!asValue(unquote(x.v.quote), slot));
    if (reads || !edge || bare(slot).t !== "Date") return reads ?? all[0];
    // A stated PERIOD gives both of its ends, by the operators (2026-10-01: "1 to 15 august 2026" filled the read's end and its start
    // was asked — or was split into "1" and "15 august 2026", and "1" is no date). The other end's words, read as a period on their
    // own or joined to this end's words in order (start words first), give this end its day.
    const lower = (e: string) => e === "ge" || e === "gt";
    const period = (w: string) => specInputs.some((si) => si.kind === "date_range" && si.words === w);
    const mine = all.find(stated);
    // builder-inputs P1: a SPAN input is its two ends. The plan maps it to ONE parameter (`fills` is one \`ref.param\`); the reader's
    // other end — the same type, the opposite operator, by its own declaration — is that input too (2026-10-04, C1: "let me choose the
    // dates each time" made the start a run input and the end kept the date given before).
    if (!all.length) for (const p of cat.refs[ref]?.params ?? []) {
      if (p.name === port || !p.edge || lower(p.edge) === lower(edge) || bare(elemOf(p.ty)).t !== "Date") continue;
      const o = valuesFor(ref, p.name, sink).find((x) => x.v.input && specInputs.find((si) => si.id === x.v.input)?.kind === "date_range");
      if (o) return o;
    }
    for (const p of cat.refs[ref]?.params ?? []) {
      if (p.name === port || !p.edge || lower(p.edge) === lower(edge)) continue;
      for (const o of valuesFor(ref, p.name, sink).filter(stated)) {
        if (period(unquote(o.v.quote))) return o;
        if (!mine) continue;
        const joined = lower(edge) ? `${unquote(mine.v.quote)} to ${unquote(o.v.quote)}` : `${unquote(o.v.quote)} to ${unquote(mine.v.quote)}`;
        if (period(joined)) return { v: { ...mine.v, quote: joined }, i: mine.i };
      }
    }
    return all[0];
  }

  /** Fill a step's open ports: the person's words, a run input, the requester, the data as text, or a binding the types force. */
  function fillPorts(stepId: string) {
    const step = f.steps.find((s) => s.id === stepId);
    if (!step || !("ref" in step) || !step.ref) return;
    const ref = step.ref;
    // Phase Y: which spec action this step is, and what it takes (the wiring) — the one source its data comes from.
    const sink = sinkStep.indexOf(stepId);
    const takes = takesStep(sink);
    const takesNothing = sink >= 0 && w?.actions[sink]?.takes === "nothing";
    // A FILE the goal states for this call (a port that NEEDS a port only a step's output fills — "a csv report") carries what the
    // call takes: the rows go into the file, never ALSO into the words a person reads (2026-10-04: "convert it to a csv report and
    // email it to me" put the whole list into the email's body as well — 379 KB, refused by the mail route). The message is then
    // its own words: drafted from the goal, else asked.
    const filed = filedPortOf(stepId, ref, sink);
    for (const h of portHoles(stepId)) {
      const port = h.site.port;
      const sig = cat.refs[ref]?.params.find((p) => p.name === port);
      if (!sig) continue;
      // The present a written read compares with (`runParams`): the engine's own value when it runs — the day, or the moment. Never
      // asked: nobody is asked what "now" is.
      const run = spec.runParams?.find((x) => x.fills === `${ref}.${port}`);
      if (run) {
        const c = run.at === "day" ? { id: RUN_DAY, type: "DATE", computed: "currentDate", said: "the day it runs" } : { id: RUN_TIME, type: "DATETIME", computed: "runTimestamp", said: "the moment it runs" };
        if (!f.inputs.some((x) => x.id === c.id)) doOp({ op: "declare_input", id: c.id, type: c.type, computed: c.computed } as EngineOp, `${c.said} (computed when it runs)`);
        doOp({ op: "bind", stepId, port, source: { from: "input", inputId: c.id } }, `${stepId}.${port} ← ${c.id} (${c.said})`);
        continue;
      }
      const slot = elemOf(sig.ty);
      const mapped = statedFor(ref, port, sink, slot);
      if (mapped) {
        const { v, i } = mapped;
        const words = v.from === "goal" || v.from === "earlier" ? unquote(v.quote) : v.from === "ask_person" ? answers.get(i)?.trim() : undefined;
        if (v.from === "ask_person") covered.add(h.id); // its question was the spec's — never asked a second time
        if (words !== undefined && words !== "") {
          const got = asValue(words, slot);
          if (got) { if (doOp({ op: "bind", stepId, port, source: { from: "literal", value: got.value, provenance: v.from === "goal" ? "goal" : "person" } }, `${stepId}.${port} ← “${got.value}”${got.note}${v.from === "earlier" ? " (as given before)" : ""}`) && v.input) realised.add(v.input); continue; }
          // P1 (RC-1): words that SHAPE as this port's value but the platform refuses them (an address off the allowed domain):
          // the reason is stated with the port — a refused value and a value the data cannot supply never share one finding.
          const why = literalFits(words, slot, cat);
          if (why !== null && isAddress(slot) && ADDRESS_SHAPE.test(words.trim())) unmet.push(refusalText(stepId, port, unquote(words), why));
          if (v.from === "ask_person") continue; // an answer that does not fit: a stated incomplete, never re-asked
        }
        // builder-inputs P1: a value relative to the run date is the engine's computed input for it — chosen from the plan's closed list,
        // never matched from the person's words (RUN_WORDS needed "the previous month" exactly; "previous month" was asked as a month).
        if (v.from === "flow_input" && v.relative) { if (bindRelative(stepId, port, sig.ty, sig.edge, v) && v.input) realised.add(v.input); continue; }
        if (v.from === "flow_input") { runInput(stepId, port, sig.ty, v); if (v.input && portBound(stepId, port)) realised.add(v.input); continue; }
        // Left to the receiver only while it WILL fill it: on a schedule nobody starts the run, so the engine opens the port as a
        // question (`scheduled_recipient`) — and "me" is then the person building it, bound like any other address port.
        if (v.from === "requester" && sig.fallsBackToRequester && h.why !== "scheduled_recipient") continue;
        if (v.from === "requester" && input.requester && literalFits(input.requester, slot, cat) === null
          && doOp({ op: "bind", stepId, port, source: { from: "literal", value: input.requester, provenance: "person" } }, `${stepId}.${port} ← “${input.requester}” (you — “${v.quote}”)`)) continue;
        // The person said it goes to THEM: with no address known it is theirs to give — never the data's own address column (which
        // would send it to everyone in the rows), and never a guess.
        if (v.from === "requester") continue;
      }
      // Z5: the same component's same input, filled with one value elsewhere in this automation — the person gave it; reused, stated.
      if (!mapped && input.known?.length) {
        const same = [...new Set(input.known.filter((k) => k.ref === ref && k.port === port && k.stepId !== stepId).map((k) => k.value))];
        if (same.length === 1 && literalFits(same[0]!, slot, cat) === null
          && doOp({ op: "bind", stepId, port, source: { from: "literal", value: same[0]!, provenance: "person" } }, `${stepId}.${port} ← “${same[0]}” (as given before)`)) continue;
      }
      // D-323: a value the CATALOGUE states for this port ("Use 'prod'"), when the person's words fill nothing here — after them, before
      // a question. It must still fit the port; a stale default is left to the question below, never forced.
      if (!mapped && sig.default !== undefined && literalFits(sig.default, slot, cat) === null
        && doOp({ op: "bind", stepId, port, source: { from: "literal", value: sig.default, provenance: "catalogue" } }, `${stepId}.${port} ← “${sig.default}” (the catalogue's stated value)`)) continue;
      // A reader that takes a parameter for the very column the goal's words filter on (`line_status` = “fulfilled”) takes those
      // words — the filter's value is the parameter's value, quoted by the person (2026-09-27: the builder asked "what should the line
      // status be?" after the goal said "fulfilled"). Only an `equals` over the field the parameter SELECTS (its declared `selects`,
      // from the reader's own definition — `status` selects `ticket_status`); by name only for a reader that declares none (a named
      // query, whose SQL the builder does not read). 2026-10-01: name-matching asked "what should the status be?" after "open ticket".
      if (step.kind !== "tool" && !mapped) {
        const field = `${ref}.${sig.selects ?? port}`;
        const same = (spec.shapes ?? []).filter((sh) => sh.over === ref).flatMap((sh) => sh.stages).find((st) => st.op === "filter" && st.test === "equals" && st.field === field && st.value?.trim())
          ?? spec.conditions.find((c) => c.test === "equals" && c.field === field && c.value?.trim());
        const v = same?.value?.trim();
        const got = v ? asValue(v, slot) : null;
        if (got && doOp({ op: "bind", stepId, port, source: { from: "literal", value: got.value, provenance: "goal" } }, `${stepId}.${port} ← “${got.value}”${got.note || " (the goal's words for this column)"}`)) continue;
      }
      // A reader's WHEN nobody mentioned — a date, a moment, a month — is given each time the flow runs (a run input): nothing is
      // guessed, and it is the value a run naturally varies by. Any other reader parameter is a filter: the person's words or asked.
      if (step.kind !== "tool") { if (!mapped && ["Date", "DateTime", "Month"].includes(slot.t)) runInput(stepId, port, sig.ty, { role: slot.t === "Month" ? "period" : "date", from: "flow_input", quote: "" }); continue; }
      const m = moveOf("bind", (x) => x.stepId === stepId && x.port === port);
      const srcs = m?.sources ?? [];
      // The data as text goes into the call's ONE open unrefined text port — its body/input — when there is exactly one.
      const plainText = bare(sig.ty).t === "Text" && !(bare(sig.ty) as { refine?: unknown[] }).refine?.length;
      const openPlain = portHoles(stepId).filter((x) => { const p = cat.refs[ref]?.params.find((q) => q.name === x.site.port); return p && bare(p.ty).t === "Text" && !(bare(p.ty) as { refine?: unknown[] }).refine?.length; });
      // D-326: a reader that a condition filtered is read THROUGH its filter — the raw rows are not a candidate beside it.
      // A reader whose rows the goal filtered or shaped is read THROUGH that — unless the goal says this action takes the rows as they are.
      const filtered = new Set(f.steps.filter((x) => x.kind === "transform" && x.id.startsWith("where")).map((x) => (x as { from: string }).from));
      const live = srcs.filter((s) => !("stepId" in s) || !filtered.has(s.stepId) || s.stepId === takes);
      // Phase Y (I-314): what the action TAKES, when the goal says; nothing when it says the action carries only fixed words; else
      // every candidate — and below, a choice among several is never made by recency (it is left to the constrained choice).
      // P7 (R17): a FAN-OUT's row is a row of its own list (`over`, made FROM what it takes — bounded, narrowed): that row's fields are
      // what it takes, one row at a time. Filtered to `takes` alone, a row's identity (a Key port) was never offered and stayed open.
      const rowsOf = step.kind === "tool" ? (step as { over?: { stepId?: string } }).over?.stepId : undefined;
      const fromTakes = (xs: typeof live) => (takesNothing ? [] : takes ? xs.filter((s) => "stepId" in s && (s.stepId === takes || (!!rowsOf && s.stepId === rowsOf))) : xs);
      const asText = fromTakes(live.filter((s) => s.from === "text"));
      const one = <T,>(xs: T[]) => (takes ? xs[0] : xs.length === 1 ? xs[0] : undefined);
      // Not in a per-row call: the whole list as text is not that row's content (the row's own fields are, and choosing among them
      // is the person's to say).
      const perRow = runsPerRow(stepId);
      // Per row, two ways, and they differ in ONE thing: a fan-out's whole list is never its row's content; a call inside a loop's
      // item IS its row — as text, into a port declared to take DATA (what a model reads), never into words a person reads (the
      // email that sent a customer every field of their ticket, 2026-10-01).
      const fanout = step.kind === "tool" && !!step.over;
      const contentPorts = (params: NonNullable<CatalogueSnapshot["refs"][string]>["params"]) => (perRow && !fanout
        ? params.filter((q) => q.data)
        : filed ? params.filter((q) => q.data)
        : [...params.filter((q) => q.data), ...params.filter((q) => q.message && !q.data), ...(openPlain.length === 1 ? params.filter((q) => q.name === openPlain[0]!.site.port) : [])]);
      // Phase Y (I-313): the goal SAID what this action takes — it goes into the action's content port: the one declared to take the
      // data, else the one declared to carry a message, else its only open plain text port. Stated, so neither a question nor D-324's
      // type-fit refusal applies (that rule is against GUESSING a message; this is the person's own connection).
      if (takes && !fanout) {
        // The content port is the first, in that order, that can actually TAKE it — a legal binding from what it takes (a whole list
        // does not fit a one-line title; the description beside it does). From the engine's listed moves, never from port names.
        const params = cat.refs[ref]?.params ?? [];
        // A port ALREADY holding it is the content port (a later round of the build no longer lists a move for a bound port).
        const holds = (name: string) => (f.steps.find((x) => x.id === stepId) as { inputs?: Array<{ name: string; source: unknown }> } | undefined)?.inputs?.some((b) => b.name === name && !!b.source && typeof b.source === "object" && (b.source as { stepId?: string }).stepId === takes);
        const fits = (name: string) => holds(name) || (moveOf("bind", (x) => x.stepId === stepId && x.port === name)?.sources ?? []).some((c) => c.from === "text" && "stepId" in c && c.stepId === takes);
        const content = contentPorts(params).find((q) => fits(q.name));
        if (content?.name === port && one(asText)) {
          const s = one(asText)!;
          doOp({ op: "bind", stepId, port, source: s }, `${stepId}.${port} ← ${"stepId" in s ? s.stepId : ""} as text (what the goal says it takes)`, 1);
          continue;
        }
        // Any OTHER text port is not where that content goes (the email's subject is not its summary): the person's words, or asked.
        if (content && bare(sig.ty).t === "Text") continue;
      }
      // A port DECLARED to take the data takes it, whatever other text ports are open (a model's instruction beside its input).
      if (sig.data && one(asText) && !fanout) {
        const s = one(asText)!;
        doOp({ op: "bind", stepId, port, source: s }, `${stepId}.${port} ← ${"stepId" in s ? s.stepId : ""} as text (its declared data port)`, asText.length);
        continue;
      }
      if (plainText && !filed && openPlain.filter((x) => !cat.refs[ref]?.params.find((q) => q.name === x.site.port)?.data).length === 1 && !openPlain.some((x) => cat.refs[ref]?.params.find((q) => q.name === x.site.port)?.data && x.site.port !== port) && one(asText) && !perRow) {
        const s = one(asText)!;
        doOp({ op: "bind", stepId, port, source: s }, `${stepId}.${port} ← ${"stepId" in s ? s.stepId : ""} as text`, asText.length);
        continue;
      }
      // Otherwise only a binding the TYPES force: exactly one candidate that is not a run input.
      const data = fromTakes(live.filter((s) => s.from !== "input" && s.from !== "text"));
      // Never the words a person reads (D-324): the one field that happens to fit a message port by TYPE is not what it says — an
      // address or a code would be sent as the message. A message is the person's words or a confirmed template, else a question.
      if (sig.required && data.length === 1 && !sig.message) doOp({ op: "bind", stepId, port, source: data[0]! }, `${stepId}.${port} ← the only fitting ${data[0]!.from}`, 1);
    }
    // Phase Y: what the goal says this action takes goes into its content port even when that port is OPTIONAL (no hole ever asks for
    // it — a ticket's free description beside its required one-line title). The same order and fit as above.
    const cur = f.steps.find((x) => x.id === stepId) as { inputs?: Array<{ name: string; source: unknown }>; over?: unknown } | undefined;
    const fanoutCall = step.kind === "tool" && !!step.over, loopCall = runsPerRow(stepId) && !fanoutCall;
    if (takes && step.kind === "tool" && !fanoutCall) {
      const params = cat.refs[ref]?.params ?? [];
      const srcOf = (name: string) => (moveOf("bind", (x) => x.stepId === stepId && x.port === name)?.sources ?? []).find((c) => c.from === "text" && "stepId" in c && c.stepId === takes);
      // (inside a loop, the item goes to a DATA port only — its words for a person are its row's message, above)
      const order = loopCall || filed ? params.filter((q) => q.data) : [...params.filter((q) => q.data), ...params.filter((q) => q.message && !q.data)];
      const content = order.find((q) => srcOf(q.name));
      const already = order.some((q) => cur?.inputs?.some((b) => b.name === q.name && b.source && typeof b.source === "object" && "stepId" in (b.source as object) && (b.source as { stepId: string }).stepId === takes));
      if (content && !already && !cur?.inputs?.some((b) => b.name === content.name && b.source)) doOp({ op: "bind", stepId, port: content.name, source: srcOf(content.name)! }, `${stepId}.${content.name} ← ${takes} as text (what the goal says it takes)`, 1);
    }
    const boundOn = (name: string) => !!(f.steps.find((x) => x.id === stepId) as { inputs?: Array<{ name: string; source: unknown }> } | undefined)?.inputs?.some((b) => b.name === name && !!b.source);
    // A value the goal STATES for an optional port is bound as stated: no hole ever asks for an optional port, so the loop above never
    // reaches it, and "as a csv" was read back to the person and then silently not built (2026-10-01). Addresses and a person's words
    // keep their own rules (the recipient, D-324), so only the other ports are taken here.
    // An optional ADDRESS port is taken here too when the person wrote the address out (2026-10-02: "email a@b.com the list" on a
    // `to` that falls back to the requester has no hole, so a stated address was never bound and was then reported as "no row
    // carries an address"). "Me" (the requester) and people the rows name keep their own rules: the words must BE an address.
    for (const p of cat.refs[ref]?.params ?? []) {
      if (p.required || p.message || boundOn(p.name)) continue;
      const mapped = statedFor(ref, p.name, sink, elemOf(p.ty));
      if (!mapped) continue;
      const { v, i } = mapped;
      if (isAddress(p.ty) && !((v.from === "goal" || v.from === "earlier") && literalFits(unquote(v.quote), elemOf(p.ty), cat) === null)) continue;
      const words = v.from === "goal" || v.from === "earlier" ? unquote(v.quote) : v.from === "ask_person" ? answers.get(i)?.trim() : undefined;
      let got = words ? asValue(words, elemOf(p.ty)) : null;
      // the person's words, else the listed value they NAME (the plan's `as`, "Excel" → xlsx), held to the
      // port's own type — and a stated value that fits neither is SAID, never dropped (it was: "an excel report" built an email with no
      // file, and said nothing).
      if (!got && v.as) got = asValue(v.as, elemOf(p.ty));
      if (!got && words) gaps.push(`the goal says “${words}” for \`${stepId}.${p.name}\`, and that is not a value it takes`);
      if (!got) continue;
      doOp({ op: "bind", stepId, port: p.name, source: { from: "literal", value: got.value, provenance: v.from === "goal" ? "goal" : "person" } }, `${stepId}.${p.name} ← “${got.value}”${got.note}`);
    }
    // A filled port that NEEDS another (declared: a file's name or format needs its rows) gets it from what this call takes — the one
    // source the goal connected, else the only one. Never a whole list into a per-row call; a need nothing answers is a stated gap.
    for (const p of cat.refs[ref]?.params ?? []) {
      if (!p.needs || !boundOn(p.name) || boundOn(p.needs)) continue;
      const cands = (moveOf("bind", (x) => x.stepId === stepId && x.port === p.needs)?.sources ?? []).filter((c) => c.from === "text" && "stepId" in c);
      const pick = runsPerRow(stepId) ? undefined : takes ? cands.find((c) => "stepId" in c && c.stepId === takes) : cands.length === 1 ? cands[0] : undefined;
      if (pick && doOp({ op: "bind", stepId, port: p.needs, source: pick }, `${stepId}.${p.needs} ← ${"stepId" in pick ? pick.stepId : ""} as text (\`${p.name}\` needs it)`, 1)) continue;
      gaps.push(`\`${stepId}.${p.needs}\` is needed for \`${p.name}\`, and which data goes in it is not said`);
    }
    // A file with rows (and usually a format) but no NAME: draft one from the call's subject or the sink's words.
    // Measured 2026-10-07: "email me the result as Excel" bound format+rows and save refused without attach_name.
    // Not provenance `drafted` — the engine admits that only on heading/message ports; this is quoted from the goal.
    for (const p of cat.refs[ref]?.params ?? []) {
      if (!p.needs || !boundOn(p.needs) || boundOn(p.name)) continue;
      const one = ((elemOf(p.ty) as { refine?: Array<{ r: string }> }).refine ?? []).some((r) => r.r === "OneOf");
      if (one) continue; // format — must be stated
      const heading = (cat.refs[ref]?.params ?? []).find((q) => q.heading);
      const subj = heading
        ? (f.steps.find((s) => s.id === stepId) as { inputs?: Array<{ name: string; source?: { from?: string; value?: string } }> } | undefined)
            ?.inputs?.find((b) => b.name === heading.name && b.source?.from === "literal")?.source?.value
        : undefined;
      const sinkQuote = sink >= 0 ? spec.sinks[sink]?.quote?.trim() : undefined;
      // Prefer subject (already a label); sink quotes are prose and need the mail basename rule.
      const draft = sanitizeAttachBaseName(subj?.trim() || sinkQuote || "report");
      if (!draft || literalFits(draft, elemOf(p.ty), cat) !== null) continue;
      doOp(
        { op: "bind", stepId, port: p.name, source: { from: "literal", value: draft, provenance: "goal" } },
        `${stepId}.${p.name} ← “${draft}” (from ${subj?.trim() ? "subject" : "the goal"})`,
      );
    }
  }

  /**
   * Does this call run once per ROW — a fan-out (its own `over`) or a call inside a loop (once per item)? The ONE test: a per-row
   * call's message is its row's own words (D-324), never the whole list or the whole item as text, which would send every field
   * of the row — internal addresses included — to whoever it goes to (2026-10-01: a loop's email to the customer did exactly that).
   * A loop's item may still go, as text, to a port declared to take DATA (a model's input): that is its row, read by a model.
   */
  function runsPerRow(stepId: string): boolean {
    const s = f.steps.find((x) => x.id === stepId);
    return s?.kind === "tool" && (!!s.over || loopOfStep(f).has(stepId));
  }

  /** Is this port bound now? */
  function portBound(stepId: string, port: string): boolean {
    return !!(f.steps.find((x) => x.id === stepId) as { inputs?: Array<{ name: string; source: unknown }> } | undefined)?.inputs?.some((b) => b.name === port && !!b.source);
  }
  /**
   * builder-inputs P1: one end of a parameter, worked out from the run date — the engine's computed input for the plan's relative value,
   * at the end the parameter's own comparison says (`ge` a start, `le`/`lt` an end; a month parameter its month). An end the engine
   * cannot compute is stated, never approximated.
   */
  function bindRelative(stepId: string, port: string, ty: Ty, edge: PortSig["edge"], v: Value): boolean {
    const form = portForm(ty);
    const end: End = edge === "ge" || edge === "gt" ? "start" : edge === "le" || edge === "lt" ? "end" : "single";
    const c = form ? endForPort(v.relative, v.days, end, form, edge) : null;
    const said = relativeWords(v.relative, v.days);
    if (!c) { unmet.push(`“${v.quote}” (${said}) cannot be worked out when it runs for \`${stepId}.${port}\``); return false; }
    if (!f.inputs.some((x) => x.id === c.id) && !doOp({ op: "declare_input", id: c.id, type: c.type, ...(c.format ? { format: c.format } : {}), computed: c.computed, ...(c.offsetDays !== undefined ? { offsetDays: c.offsetDays } : {}) }, `${c.id} (computed when it runs)`)) return false;
    return doOp({ op: "bind", stepId, port, source: { from: "input", inputId: c.id } }, `${stepId}.${port} ← ${c.id} (“${v.quote}”: ${said}, worked out when it runs)`);
  }

  /** A run input of the port's type, bound to it: the person gives this value each time the flow runs. */
  function runInput(stepId: string, port: string, ty: Ty, v: Value) {
    const kind = INPUT_OF[elemOf(ty).t];
    if (!kind) { gaps.push(`\`${stepId}.${port}\` cannot be a run input (its type has no input form)`); return; }
    const id = freshStepId(f, port.replace(/[^a-z0-9_]/gi, "_").toLowerCase());
    // A value worked out when it runs ("today", "last month") is the plan's `relative` choice, from a closed list (`bindRelative`) —
    // never matched from the person's words here (builder-behaviour phase 5 deleted the `RUN_WORDS` phrase list).
    const needsDefault = moveOf("declare_input")?.needsDefault;
    // An input nobody can give at run time (a schedule supplies none) with no default renders EMPTY (2026-10-01: a daily flow's
    // `as_of` was "" and its read failed). It stays the port's open question — asked now, with "the day it runs" among the answers.
    if (needsDefault) { gaps.push(`\`${stepId}.${port}\` cannot be asked each run — nothing supplies a run input here, so its value is asked now`); return; }
    if (!doOp({ op: "declare_input", id, type: kind.type, ...(kind.format ? { format: kind.format } : {}), ...(needsDefault ? { required: false } : {}) }, `ask for ${port} each run (${v.role})`)) return;
    doOp({ op: "bind", stepId, port, source: { from: "input", inputId: id } }, `${stepId}.${port} ← run input ${id}`);
  }
}

/** The flow input a run-day condition compares with: the day the flow runs, computed by the engine at firing time. */
/**
 * builder-behaviour P1 (R10): ONE item's test from every test the plan states — the list filters' own lowering (`condStages`: every
 * test kind, inputs, run-date tests, null rules) per test, held together as ONE `keep_if` on the item (it holds when all do). A test
 * against another field compares the two, each narrowed first when it may be empty. Pure: the item's fields are given.
 */
export function itemTestOf(where: readonly ItemTest[], fields: Record<string, Ty>, quote: string, texts: readonly string[] = [], inputs?: Parameters<typeof condStages>[7]): Comb[] | string {
  const pre: Comb[] = [];
  const preds: Pred[] = [];
  for (const t of where) {
    const fty = fields[t.field];
    if (!fty) return `the items have no field \`${t.field}\``;
    if (t.against) {
      const aty = fields[t.against];
      if (!aty) return `the items have no field \`${t.against}\``;
      const cmp = CMP[t.test as CondTest];
      if (!cmp) return `“${t.test}” does not compare two fields`;
      for (const [n, ty] of [[t.field, fty], [t.against, aty]] as const) if (ty.t === "Option") preds.push({ notNull: n });
      preds.push({ cmp, left: { field: t.field }, right: { field: t.against } });
      continue;
    }
    // A yes/no test of a NUMBER is the truth of a count (a read returns "has an interview" as how many related rows hold it): yes is more
    // than none, no is none — and an empty count (no related row at all) is none.
    const base = fty.t === "Option" ? fty.of : fty;
    if ((t.test === "is_true" || t.test === "is_false") && (base.t === "Int" || base.t === "Number")) {
      const zero = { lit: { value: 0, from: "catalogue" as const } };
      preds.push(t.test === "is_true"
        ? (fty.t === "Option" ? { and: [{ notNull: t.field }, { cmp: "gt", left: { field: t.field }, right: zero }] } : { cmp: "gt", left: { field: t.field }, right: zero })
        : (fty.t === "Option" ? { or: [{ isNull: t.field }, { and: [{ notNull: t.field }, { cmp: "le", left: { field: t.field }, right: zero }] }] } : { cmp: "le", left: { field: t.field }, right: zero }));
      continue;
    }
    const st = condStages(t.field, fty, t.test as CondTest, t.input ? `input:${t.input}` : t.value ?? "", quote, "goal", texts, inputs);
    if (typeof st === "string") return st;
    for (const c of st) if (c.op === "filter") preds.push(c.where); else pre.push(c);
  }
  if (!preds.length) return "it states no test";
  return [...pre, { op: "keep_if", where: preds.length === 1 ? preds[0]! : { and: preds } }];
}

export const RUN_DAY = "run_day";
/** The flow input for the moment the flow runs — an instant, computed by the engine at firing time. */
export const RUN_TIME = "run_time";
/** The flow input for N days before the day it runs. */
export const daysBefore = (n: number) => `days_before_${n}`;
/**
 * The filter stages for one condition (D-326) over a field of type `fty`, or why it cannot be one. A literal carries provenance `goal`
 * and the condition's own words; a maybe-empty field is narrowed first (ordering a null is a type error, and "above 5" never holds for
 * an empty one). The engine type-checks the result again when it is placed.
 */
/** An email address's SHAPE — a local part, an @, a domain with a dot. Whether it may be SENT to is the engine's (`literalFits`). */
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function condStages(field: string, fty: Ty | undefined, test: CondTest, value: string, quote: string, from: "goal" | "person" = "goal", texts: readonly string[] = [], inputs?: { of: (id: string) => SpecInput | undefined; asked: ReturnType<typeof askedFor> }): Comb[] | string {
  if (!fty) return `no field \`${field}\``;
  // builder-inputs P1: a comparison with a plan INPUT. Given: the input's words, compared as any stated value is. Otherwise the run
  // inputs it is (asked each run, or worked out from the run date) — a span or a month as its first and last day, one value by the
  // test's own comparison — the engine's `{ input }` operand, typed against the declared input.
  const im = /^input:([a-z0-9_]+)$/.exec(value.trim());
  if (im) {
    const i = inputs?.of(im[1]!);
    if (!i) return `no input ${im[1]}`;
    if (i.fill === "given") return condStages(field, fty, test, i.words, quote, from, texts);
    const b0 = bare(fty);
    const isDate = b0.t === "Date" || b0.t === "DateTime";
    const ops = operandsFor(i, inputs!.asked, CMP[test], isDate);
    if (typeof ops === "string") return ops;
    // A date input read by its month compares MONTHS: the field's month (\`convert … month\`) with the input's (its \`cut\`).
    const byMonth = ops.some((o) => o.cut === "month");
    const at = byMonth ? `${field}_month` : b0.t === "DateTime" ? `${field}_day` : field;
    return [
      ...(fty.t === "Option" ? [{ op: "filter", where: { notNull: field } } as Comb] : []),
      ...(byMonth ? [{ op: "convert", field, as: at, to: "month" } as Comb] : b0.t === "DateTime" ? [{ op: "convert", field, as: at, to: "date" } as Comb] : []),
      ...ops.map((o): Comb => ({ op: "filter", where: { cmp: o.cmp, left: { field: at }, right: o.cut ? { input: o.id, cut: o.cut } : { input: o.id } } })),
    ];
  }
  const opt = fty.t === "Option", b = bare(fty);
  const lit = (v: string | number | boolean) => ({ lit: { value: v, from, quote } });
  const narrow: Comb[] = opt ? [{ op: "filter", where: { notNull: field } }] : [];
  if (test === "is_empty") return opt ? [{ op: "filter", where: { isNull: field } }] : b.t === "Text" ? [{ op: "filter", where: { isBlank: field } }] : `\`${field}\` is never empty`;
  if (test === "not_empty") return opt ? narrow : b.t === "Text" ? [{ op: "filter", where: { not: { isBlank: field } } }] : `\`${field}\` is never empty`;
  // Slice 5d: a date against the day the flow RUNS — the computed input `RUN_DAY` (the compiler's `currentDate`, rendered at firing
  // time). A moment is compared by its calendar day, so a timestamp and a date compare like with like.
  if (test === "date_passed" || test === "date_not_passed") {
    if (b.t !== "Date" && b.t !== "DateTime") return `\`${field}\` is not a date`;
    const day = b.t === "DateTime" ? `${field}_day` : field;
    const conv: Comb[] = b.t === "DateTime" ? [{ op: "convert", field, as: day, to: "date" }] : [];
    return [...narrow, ...conv, { op: "filter", where: { cmp: test === "date_passed" ? "lt" : "ge", left: { field: day }, right: { input: RUN_DAY } } }];
  }
  // Slice 5d: a date against N days before the day it runs — a computed input `days_before_N`, the day it runs minus N.
  if (test === "older_than_days" || test === "within_days") {
    // P7 (R23): on an AGE — a number declaring the length of time it counts — "older than N days" is that age above N days, in its
    // own unit (B20: `age_mins` is minutes since opening; a days-ago test on it was "not a date" and the whole group was lost).
    const age = durationTest(test, fty, value);
    if (age !== null) return typeof age === "string" ? `“${value}”: ${age}` : [...narrow, { op: "filter", where: { cmp: age.cmp, left: { field }, right: lit(age.value) } }];
    if (b.t !== "Date" && b.t !== "DateTime") return `\`${field}\` is not a date`;
    if (!value.trim()) return "the goal states no number of days";
    const n = Number(/\d+/.exec(value)?.[0]);
    if (!Number.isInteger(n) || n < 0 || n > 3650) return `“${value}” is not a number of days`;
    const day = b.t === "DateTime" ? `${field}_day` : field;
    const conv: Comb[] = b.t === "DateTime" ? [{ op: "convert", field, as: day, to: "date" }] : [];
    return [...narrow, ...conv, { op: "filter", where: { cmp: test === "older_than_days" ? "lt" : "ge", left: { field: day }, right: { input: daysBefore(n) } } }];
  }
  if (test === "is_true" || test === "is_false") return b.t === "Bool" ? [...narrow, { op: "filter", where: { cmp: "eq", left: { field }, right: lit(test === "is_true") } }] : `\`${field}\` is not true/false`;
  const cmp = CMP[test]!;
  if (!value.trim()) return "the goal states no value to compare with";
  let v: string | number = value.trim();
  // An amount declared in minor units (cents) against a person's whole-unit number: scaled, as a condition's test is (`literalFor`).
  if (isNumberTy(fty)) {
    // P7 (R23): a length of time said with its unit, on a number that DECLARES its time unit, in that unit — the engine's one rule
    // (`timeOfWords`/`inUnit`), never the digits with the unit word thrown away ("3 days" on minutes was compared as 3).
    const tu = "unit" in b && b.unit && b.unit !== "minor" ? b.unit : undefined;
    const said = tu ? timeOfWords(v) : null;
    if (tu && said) { const c = inUnit(said, tu); if (typeof c === "string") return `“${value}”: ${c}`; v = c; }
    else { const n = Number(v.replace(/[^0-9.\-]/g, "")); if (!Number.isFinite(n) || !/\d/.test(v)) return `“${value}” is not a number`; v = "unit" in b && b.unit === "minor" ? Math.round(n * 100) : n; }
  }
  // A date the words state is read by the SAME reader as a port's ("20 june 2026" → 2026-06-20; a year left out from the goal's one
  // year): compared raw, the words were refused as "not a datetime" and the condition was not built. A moment is compared by its
  // calendar day, as the run-day tests do — so a timestamp and a stated day compare like with like.
  if (b.t === "Date" || b.t === "DateTime") {
    const at = b.t === "DateTime" ? `${field}_day` : field;
    const conv: Comb[] = b.t === "DateTime" ? [{ op: "convert", field, as: at, to: "date" }] : [];
    // Step 4: the value is the model's ISO day (`YYYY-MM-DD`); words are never mined for one.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return `“${value}” is not a date`;
    return [...narrow, ...conv, { op: "filter", where: { cmp, left: { field: at }, right: lit(v) } }];
  }
  return [...narrow, { op: "filter", where: { cmp, left: { field }, right: lit(v) } }];
}

/**
 * P7 (R23): a days-ago test ("older than 3 days", "within 7 days") on a number that DECLARES the length of time it counts (an age):
 * the age compared with the days in its unit — older is `gt`, within is `le`. `null` when the field is not such a number; a reason
 * when the days cannot be said in its unit (working minutes). The ONE rule: the solver lowers by it, the spec match expects it.
 */
export function durationTest(test: string, fty: Ty | undefined, value: string): { cmp: "gt" | "le"; value: number } | string | null {
  if (test !== "older_than_days" && test !== "within_days") return null;
  const b = fty ? bare(fty) : undefined;
  const tu = b && (b.t === "Int" || b.t === "Number") && "unit" in b && b.unit && b.unit !== "minor" ? b.unit : undefined;
  if (!tu) return null;
  const n = Number(/\d+(?:\.\d+)?/.exec(value)?.[0]);
  if (!Number.isFinite(n)) return `“${value}” is not a number of days`;
  const v = inUnit({ n, unit: "days" }, tu);
  return typeof v === "string" ? v : { cmp: test === "older_than_days" ? "gt" : "le", value: v };
}

const SCALAR_TEXT = new Set(["Text", "Int", "Number", "Date", "DateTime", "Month", "Bool"]);
/** A field name as words: `days_overdue` → "Days overdue". */
const label = (n: string) => { const w = n.replace(/_/g, " ").trim(); return w.charAt(0).toUpperCase() + w.slice(1); };
/** A template from a row's scalar fields (not the address it is sent to): "Label: value", joined by " · ". */
/** Is this an amount its owner declared in minor units (cents)? Read off the type — declared, never a name. */
const inMinor = (t: Ty) => { const b = bare(t); return (b.t === "Int" || b.t === "Number") && "unit" in b && b.unit === "minor"; };
/** The field a minor-units amount is shown through, once converted to whole units — fresh on these rows. */
export const wholeField = (n: string, fields: Record<string, Ty>) => { let as = `${n}_whole`; for (let k = 2; fields[as]; k++) as = `${n}_whole_${k}`; return as; };
/**
 * The conversions a row's minor-units amounts need before a person reads them (÷100): one per amount — an empty one stays empty,
 * shown as missing like any other optional field (2026-10-01: "Budget cents: 120000").
 */
export function minorConverts(fields: Record<string, Ty>): Comb[] {
  return Object.entries(fields).filter(([, t]) => inMinor(t)).map(([n]) => ({ op: "convert", field: n, as: wholeField(n, fields), to: "minor_to_major" }) as Comb);
}
export function draftParts(fields: Record<string, Ty>, addressField: string, convert = true): Part[] {
  // A group's own rows (P7) are what ONE action sends — never a field another action's message shows.
  const picked = Object.entries(fields).filter(([n, t]) => n !== addressField && n !== GROUP_ROWS && SCALAR_TEXT.has(bare(t).t)).slice(0, 6);
  const req = picked.filter(([, t]) => t.t !== "Option"), opt = picked.filter(([, t]) => t.t === "Option");
  // An amount in minor units is shown converted, and labelled so: "Budget cents (whole units): 1200", never 120000 as if it were.
  const shown = (n: string, t: Ty) => (convert && inMinor(t) ? { field: wholeField(n, fields), words: `${label(n)} (whole units)` } : { field: n, words: label(n) });
  const parts: Part[] = [];
  req.forEach(([n, t], i) => { const x = shown(n, t); parts.push({ text: `${i ? " · " : ""}${x.words}: ` }, { field: x.field }); });
  opt.forEach(([n, t], i) => { const x = shown(n, t); parts.push({ opt: x.field, pre: `${req.length || i ? " · " : ""}${x.words}: `, post: "" }); });
  return parts;
}
/** A template as the person reads it in the readback: fields in braces. */
export const partsText = (parts: Part[]) => parts.map((p) => ("text" in p ? p.text : "field" in p ? `{${p.field}}` : `${p.pre}{${p.opt}}${p.post}`)).join("");

/** The fields of a step's rows, for tests and reports. */
export const rowFields = (f: EFlow, cat: CatalogueSnapshot, id: string): string[] => { const t = readableTy(f, cat, id); if (typeof t === "string") return []; const r = rowOf(t); return r.t === "Record" ? Object.keys(r.fields) : []; };
export { FILLS_NONE };
