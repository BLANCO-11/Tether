/**
 * The one builder's constrained construction (compiled-builder phase 4, tasks 2 and 4; D-292/D-294/D-307).
 *
 * Loop: the state's legal options (`optionsOf`) → a strict schema whose enum is exactly those option ids plus the explicit
 * exits → the model picks one → code applies it → repeat. The model never writes an op, an id or an expression; the only
 * free text it may give is a literal VALUE for a typed slot, and that value must be the person's own words (quoted from the
 * goal, a correction or an answer — the constants rule), or the slot becomes a question.
 *
 * ⚠ The four no-loop rules (D-294) are properties of the TRACE, checked by `noLoopProblems` on every build:
 *   1. a hole is asked at most once;   2. at most `MAX_ROUNDS` question rounds;
 *   3. an answer that does not fill its hole leaves a stated incomplete, never a re-ask;
 *   4. no model call is repeated with an unchanged prompt.
 * Construction only adds (options offer no removal), so states grow and none recurs; the move cap bounds the rest.
 */
import { createHash } from "node:crypto";
import { CONFIRMS } from "./reply-intents.js";
import { apply, emptyFlow, groupsOf, literalFits, optionsOf, readableTy, renderType as render, runTimeChoices, type CatalogueSnapshot, type EFlow, type Hole, type Option, type Ty } from "@foundry/flow-edit";
import { NONE_FIT, quoted, readback, type BuilderCatalogue, type CheckedSpec } from "./goal-spec.js";
import { parseStrict, S, type Schema } from "./strict-schema.js";
import { noteBuildState } from "./progress.js";

export const MAX_MOVES = 30;
export const MAX_ROUNDS = 3;
/**
 * A CONVERSATION's clarification rounds are bounded across turns (contract C7) — `MAX_ROUNDS` bounds rounds inside ONE trace, and
 * every turn is its own trace, so it cannot stop the turn cycle. At the bound the builder stops asking and offers accept-or-stop.
 */
export const MAX_CLARIFY_ROUNDS = 5;
/** Above this many options, the choice is made in two steps: a group, then an option within it. */
export const ONE_STEP_LIMIT = 120;
/** A group larger than this is split into parts, so no enum is larger than the size measured to hold (E0.1). */
export const GROUP_LIMIT = 200;
export const EXITS = ["done", "ask_person", "none_fit"] as const;
type Exit = (typeof EXITS)[number];

/** One model call, as the builder sees it: prompt + strict schema in, the raw reply out. */
export type Chooser = (prompt: string, schema: { name: string; schema: Schema }, label: string, model?: string, system?: string) => Promise<string>;

export interface Texts { goal: string[]; answers: string[] }
export interface BuildCall { label: string; promptHash: string; ms: number }
export interface BuildMove { pick: string; label: string; alternatives: number; chooser: "model" | "code"; group?: string; value?: string; provenance?: "goal" | "person" }
/** `options`: when the answer is a choice among components, their refs — for a caller that shows choices; the answer is still words. */
export interface BuildQuestion { holeId: string; ask: string; round: number; answer?: string; filled?: boolean; options?: string[]; /** The port a port question fills — for code; never parsed out of `ask`. */ port?: string;
  /** Only the options are answers: a scheduled flow's month or date is worked out when it runs, never a value typed once (2026-09-29). */
  onlyOptions?: boolean;
  /** What the question SETTLES, computed by code (a value's role and words, a condition's words, a port's component and input) —
   *  the identity an answer is kept under across re-plans, which re-derive `holeId`. */
  about?: string;
  /** The same input of the same component on other steps, open at once: one question, and its answer fills each (2026-09-30: the
   *  sender of three emails was asked three times). Never a declared wording input (a subject, a message) — each step's own. */
  alsoFills?: string[] }
export interface BuildTrace {
  calls: BuildCall[];
  moves: BuildMove[];
  questions: BuildQuestion[];
  /** Options the chooser picked that code refused (a literal that is not the person's words), each once. */
  refused: Array<{ label: string; why: string }>;
  stop: "complete" | "done" | "ask_person" | "none_fit" | "move_cap" | "no_options";
  /** The steps the BUILD started from (empty for a goal; the draft for an edit, D-321) — what "added" is counted against in
   *  every round, and when the person answers later. Not the round's own start, which already holds the build's steps. */
  base?: Array<{ kind: string; ref?: string; id?: string }>;
  /** What the solver could not build, each a stated reason (D-322) — never silence. */
  gaps?: string[];
  /** Holes whose value a spec question already asked — never asked again. */
  covered?: string[];
  /** What the goal asks for that the flow does not do (I-299) — each blocks `complete`. */
  unmet?: string[];
  /** The unmet entries that are the builder's own (the solver's `internal`): stated, never put to the person as a question. */
  internal?: string[];
  /** P7 (R15): steps that cannot run whatever their ports hold (the solver's `blocked`) — their ports are never asked. */
  blocked?: string[];
  /** Z9: the verified address of the person building ("me"). */
  requester?: string;
  /** Z5: the values already in the automation this build changes. */
  known?: Array<{ stepId: string; ref: string; port: string; value: string }>;
}

export const emptyTrace = (): BuildTrace => ({ calls: [], moves: [], questions: [], refused: [], stop: "done" });
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ── the state, in words ──────────────────────────────────────────────────────
/** What the model is shown of the state: each step's kind, what it reads, and its type — rendered by code. */
export function describeState(f: EFlow, cat: CatalogueSnapshot): string[] {
  const lines = f.steps.map((s) => {
    const ty = readableTy(f, cat, s.id);
    const what = s.kind === "datasource" ? `reads ${s.ref ?? "(not chosen)"}` : s.kind === "tool" ? `calls ${s.ref}${s.over ? ` once per row of ${s.over.stepId}` : ""}` : s.kind === "transform" ? `reshapes ${s.from}` : s.kind === "approval" ? "waits for a person's approval" : s.kind === "branch" ? (s.conditions?.length ? `condition: ${s.conditions.map((c) => `${c.left.stepId} has ${c.op === "any" ? "rows" : "no rows"}`).join(" and ")}${s.elseOf ? ` (otherwise of ${s.elseOf})` : ""}` : `otherwise of ${s.elseOf}`) : s.kind === "merge" ? `whichever ran of ${s.sources.join(", ")}` : s.kind === "for_each" ? `for each row of ${s.over.stepId} (${s.concurrency} at a time, ${s.onError === "stop" ? "stops if one fails" : "keeps going if one fails"})` : `one row per item of ${s.loop}, each with the result of ${s.result}`;
    const bound = "inputs" in s ? s.inputs.filter((b) => b.source).map((b) => b.name) : [];
    return `- ${s.id}: ${what}${bound.length ? `; set: ${bound.join(", ")}` : ""}${typeof ty === "string" ? "" : ` → ${render(ty)}`}`;
  });
  const holes = f.holes.map((h) => `- undecided: ${h.reason}${h.owner === "person" ? " (the person's to answer)" : ""}`);
  return [...(f.inputs.length ? [`inputs: ${f.inputs.map((i) => `${i.id} (${i.type}${i.defaults !== undefined ? `, default ${i.defaults}` : ""})`).join(", ")}`] : []), ...(lines.length ? lines : ["- (no steps yet)"]), ...holes, ...(f.schedule ? [`schedule: ${f.schedule.cron}`] : []), ...(f.output ? [`result: ${f.output.stepId}`] : [])];
}

const RULES = [
  "You build an automation ONE move at a time by choosing from the listed options. You never write steps yourself.",
  "- Build what the confirmed goal says: its readers, its actions, its values, its conditions. Nothing else.",
  "- An option marked \"a value\" needs `value`: copy it EXACTLY from the goal or the person's answers. If nobody stated it, choose `ask_person` instead — never guess a value.",
  "- `done` when the automation does everything the goal asks and has a result; `ask_person` when the next decision is the person's; `none_fit` when the goal needs something no option can do.",
  "- `value` is \"\" unless the chosen option needs one.",
  "- `ask_person` is only for a VALUE the person must give (an address, a date, a number). Which step is the result, and what a condition guards, are yours to choose from the options.",
  "- Place every reader and action the goal names even while a value they need is unknown: an unfilled value is asked of the person AFTER, so it is never a reason to stop or to ask first.",
];

function prompt(spec: CheckedSpec, items: BuilderCatalogue, f: EFlow, cat: CatalogueSnapshot, texts: Texts, choices: Array<{ id: string; label: string }>, what: string, note?: string): string {
  return [
    ...RULES,
    "",
    "THE GOAL, AS THE PERSON CONFIRMED IT",
    ...readback(spec, items).map((l) => `- ${l}`),
    "",
    "THE PERSON'S WORDS",
    ...texts.goal.map((t) => `- goal: ${t}`),
    ...texts.answers.map((t) => `- answer: ${t}`),
    "",
    "THE AUTOMATION SO FAR",
    ...describeState(f, cat),
    ...(note ? ["", note] : []),
    "",
    what,
    ...choices.map((c) => `- ${c.id}: ${c.label}`),
    ...EXITS.map((e) => `- ${e}`),
  ].join("\n");
}

const choiceSchema = (ids: string[]): Schema => S.obj({ pick: S.oneOf([...ids, ...EXITS]), value: S.str("the literal value, copied from the person's words; \"\" when the option needs none") });

interface Picked { option?: Option; exit?: Exit; value: string }

/** One choice: in one step when the options are few, else a group first and then an option in it. */
async function choose(opts: Option[], mk: (choices: Array<{ id: string; label: string }>, what: string) => string, choose: Chooser, trace: BuildTrace, seen: Set<string>, label: string): Promise<Picked | "repeat"> {
  const call = async (choices: Array<{ id: string; label: string }>, what: string, lab: string) => {
    const p = mk(choices, what);
    const h = hash(p);
    if (seen.has(h)) return "repeat" as const; // rule 4: never ask the same thing twice
    seen.add(h);
    const t0 = Date.now();
    const schema = choiceSchema(choices.map((c) => c.id));
    const raw = await choose(p, { name: "choice", schema }, lab);
    trace.calls.push({ label: lab, promptHash: h, ms: Date.now() - t0 });
    return parseStrict<{ pick: string; value: string }>(schema, raw, lab);
  };
  const resolve = (r: { pick: string; value: string }, pool: Option[]): Picked => (EXITS as readonly string[]).includes(r.pick) ? { exit: r.pick as Exit, value: r.value } : { option: pool.find((o) => o.id === r.pick)!, value: r.value };
  if (opts.length <= ONE_STEP_LIMIT) {
    const r = await call(opts.map((o) => ({ id: o.id, label: o.label })), "OPTIONS (choose one)", label);
    return r === "repeat" ? r : resolve(r, opts);
  }
  // Two steps. Groups larger than GROUP_LIMIT are split into parts so no enum exceeds it.
  const parts: Array<{ id: string; label: string; members: Option[] }> = [];
  for (const g of groupsOf(opts)) {
    const members = opts.filter((o) => o.group === g.group);
    for (let i = 0; i < members.length; i += GROUP_LIMIT) {
      const chunk = members.slice(i, i + GROUP_LIMIT);
      parts.push({ id: `g${parts.length + 1}`, label: `${g.group} — ${chunk.length} options${members.length > GROUP_LIMIT ? `, part ${i / GROUP_LIMIT + 1}` : ""} (e.g. ${chunk[0]!.label})`, members: chunk });
    }
  }
  const g = await call(parts.map((p) => ({ id: p.id, label: p.label })), "GROUPS OF OPTIONS (choose the group your next move is in)", `${label}:group`);
  if (g === "repeat") return g;
  if ((EXITS as readonly string[]).includes(g.pick)) return { exit: g.pick as Exit, value: "" };
  const part = parts.find((p) => p.id === g.pick)!;
  const r = await call(part.members.map((o) => ({ id: o.id, label: o.label })), `OPTIONS IN "${part.label.split(" — ")[0]}" (choose one)`, `${label}:move`);
  return r === "repeat" ? r : resolve(r, part.members);
}

export interface Construction { flow: EFlow; trace: BuildTrace; asked: string[] }

/**
 * Build from `start` until the chooser is done, the moves run out, or nothing is legal. `asked`: holes handed to the person
 * (by `ask_person`, or by a value nobody stated) — never re-offered to the chooser.
 */
export async function construct(spec: CheckedSpec, items: BuilderCatalogue, cat: CatalogueSnapshot, texts: Texts, chooser: Chooser, start: EFlow = emptyFlow("flow"), prior?: { trace: BuildTrace; asked: string[]; seen: Set<string> }): Promise<Construction & { seen: Set<string> }> {
  const trace = prior?.trace ?? emptyTrace();
  const asked = new Set(prior?.asked ?? []);
  const seen = prior?.seen ?? new Set<string>();
  const refusedIds = new Set<string>();
  const inputRoles = spec.spec.values.filter((v) => v.from === "flow_input").map((v) => v.role);
  let f = start;
  trace.base ??= start.steps.map((x) => ({ kind: x.kind, ...("ref" in x && x.ref ? { ref: x.ref } : {}) }));
  const base = { steps: trace.base } as unknown as EFlow;
  // `done` with decisions still open is refused ONCE, and the next prompt says what is open — so it is a different prompt,
  // never a re-ask of the same one (D-294 rule 4). A second `done` ends construction as a stated incomplete.
  let note: string | undefined;
  let doneRefused = false;
  for (let n = 0; ; n++) {
    if (n >= MAX_MOVES) { trace.stop = "move_cap"; break; }
    // A hole handed to the person is not the chooser's any more: its filling options are not offered.
    // Offered: what is legal, not handed to the person, and within the CONFIRMED spec — a reader or action the person did not
    // confirm, or one more of it than they confirmed, is not the goal they agreed to (the readback is the contract, D-304).
    const offered = optionsOf(f, cat, { inputRoles, cron: spec.spec.schedule?.cron ?? null }).filter((o) => !refusedIds.has(o.label) && !asked.has(holeOf(f, o)?.id ?? "") && withinSpec(spec, f, base, o));
    if (!offered.length) { trace.stop = "no_options"; break; }
    // A structural decision with exactly ONE legal option, once everything else is settled, is not a choice: code takes it.
    // Only then — taken earlier, "the result is read_1" would be forced before the steps that should be the result exist.
    const pending = f.holes.filter((h) => h.owner === "chooser" && !asked.has(h.id));
    if (pending.length && pending.every((h) => h.site.at !== "port") && !unmet(spec, f, base).length) {
      const forced = pending.map((h) => offered.filter((o) => holeOf(f, o)?.id === h.id)).find((xs) => xs.length === 1)?.[0];
      if (forced?.op) {
        const r = apply(f, forced.op, cat);
        if (!r.ok) throw new Error(`a forced option was refused by apply (a legality bug): ${forced.label} — ${r.error}`);
        f = r.flow;
        trace.moves.push({ pick: forced.id, label: forced.label, alternatives: 1, chooser: "code", group: forced.group });
        noteBuildState(f, cat);
        if (!f.holes.length && spec.spec.sinks.every((s) => callsOf(f, s.ref) > callsOf(base, s.ref))) { trace.stop = "complete"; break; }
        continue;
      }
    }
    const pick = await choose(offered, (choices, what) => prompt(spec, items, f, cat, texts, choices, what, note), chooser, trace, seen, `build:${n}`);
    if (pick === "repeat") { trace.stop = "done"; break; }
    if (pick.exit === "ask_person") {
      // Only a VALUE is the person's to give (`answer` fills a port and nothing else). With none open, `ask_person` hands
      // over nothing: it is refused like an early `done`, once, with what is open named.
      const h = f.holes.find((x) => x.owner === "chooser" && x.site.at === "port" && !asked.has(x.id));
      if (h) { asked.add(h.id); continue; }
    }
    if (pick.exit === "done" || pick.exit === "ask_person") {
      const open = [...f.holes.filter((h) => h.owner === "chooser" && !asked.has(h.id)).map((h) => h.reason), ...unmet(spec, f, base)];
      if (open.length && !doneRefused) {
        doneRefused = true;
        trace.refused.push({ label: pick.exit, why: `still open: ${open.join("; ")}` });
        note = `NOT DONE YET — still open, and an option below does each: ${open.join("; ")}.`;
        continue;
      }
      if (pick.exit === "ask_person") { trace.stop = "ask_person"; break; }
    }
    if (pick.exit) { trace.stop = pick.exit; break; }
    const o = pick.option!;
    let op = o.op;
    let provenance: "goal" | "person" | undefined;
    if (o.literal) {
      const inGoal = quoted(pick.value, texts.goal), inAnswer = quoted(pick.value, texts.answers);
      const bad = !pick.value.trim() ? "no value was given" : !inGoal && !inAnswer ? `“${pick.value}” is not the person's words` : literalFits(pick.value.trim(), o.literal.ty, cat);
      if (bad) {
        // The value is still needed and nobody stated it: the slot becomes a question, never a guess (the constants rule).
        trace.refused.push({ label: o.label, why: bad });
        refusedIds.add(o.label);
        const h = holeOf(f, o);
        if (h) asked.add(h.id);
        continue;
      }
      provenance = inGoal ? "goal" : "person";
      op = o.literal.make(pick.value.trim(), provenance);
    }
    const r = apply(f, op!, cat);
    if (!r.ok) throw new Error(`an offered option was refused by apply (a legality bug): ${o.label} — ${r.error}`);
    f = r.flow;
    trace.moves.push({ pick: o.id, label: o.label, alternatives: offered.length, chooser: "model", group: o.group, ...(o.literal ? { value: pick.value.trim(), provenance } : {}) });
    noteBuildState(f, cat);
    // Complete when nothing is undecided and every action the spec asks for has been ADDED — counted against `start`, so on an
    // edit (D-321) an action the flow already had does not make the edit done before it has added anything.
    if (!f.holes.length && trace.moves.length && spec.spec.sinks.every((s) => callsOf(f, s.ref) > callsOf(base, s.ref))) { trace.stop = "complete"; break; }
  }
  return { flow: f, trace, asked: [...asked], seen };
}

/** An option within the confirmed spec: a reader it names (no more of it than named), an action it names (likewise). */
function withinSpec(spec: CheckedSpec, f: EFlow, start: EFlow, o: Option): boolean {
  const op = o.op ?? (o.literal ? o.literal.make("x", "goal") : undefined);
  if (!op) return true;
  const named = (xs: Array<{ ref: string }>, ref: string) => xs.filter((x) => x.ref === ref).length;
  const reads = (g: EFlow, ref: string) => g.steps.filter((x) => x.kind === "datasource" && x.ref === ref).length;
  if (op.op === "add_reader" && op.ref) return reads(f, op.ref) - reads(start, op.ref) < named(spec.spec.sources, op.ref);
  if (op.op === "choose_reader") return named(spec.spec.sources, op.ref) > 0;
  if (op.op === "add_call") return callsOf(f, op.ref) - callsOf(start, op.ref) < named(spec.spec.sinks, op.ref);
  return true;
}

/** What the CONFIRMED spec names that the flow does not have yet: a reader not read, an action not added (against `start`). */
function unmet(spec: CheckedSpec, f: EFlow, start: EFlow): string[] {
  const reads = (g: EFlow, ref: string) => g.steps.filter((x) => x.kind === "datasource" && x.ref === ref).length;
  return [
    ...spec.spec.sources.filter((x) => x.ref !== NONE_FIT && reads(f, x.ref) <= reads(start, x.ref)).map((x) => `the goal reads \`${x.ref}\` and nothing reads it yet`),
    ...spec.spec.sinks.filter((x) => x.ref !== NONE_FIT && callsOf(f, x.ref) <= callsOf(start, x.ref)).map((x) => `the goal's action \`${x.ref}\` is not added yet`),
  ];
}

const callsOf = (f: EFlow, ref: string) => f.steps.filter((x) => x.kind === "tool" && x.ref === ref).length;

/**
 * D-321: an edit of a non-empty flow is ADDITIVE. Every step that was there is still there, and every input it had set is
 * set to the same thing. (A gate spliced before a call re-points the call's order, and a stage grows a pipeline — both add;
 * neither is checked here, because neither removes or rebinds anything the person had.) `[]` when that holds.
 */
export function editProblems(start: EFlow, f: EFlow): string[] {
  const out: string[] = [];
  for (const s of start.steps) {
    const now = f.steps.find((x) => x.id === s.id);
    if (!now) { out.push(`step ${s.id} was removed`); continue; }
    if (!("inputs" in s)) continue;
    for (const b of s.inputs.filter((b) => b.source)) {
      const nb = "inputs" in now ? now.inputs.find((x) => x.name === b.name) : undefined;
      if (JSON.stringify(nb?.source) !== JSON.stringify(b.source)) out.push(`${s.id}.${b.name} was rebound`);
    }
  }
  return out;
}

/** The hole an option would fill, if it fills one (a bind of a hole's port, a reader choice, the result). */
function holeOf(f: EFlow, o: Option): Hole | undefined {
  const op = o.op ?? (o.literal ? o.literal.make("x", "goal") : undefined);
  if (!op) return undefined;
  if (op.op === "bind") return f.holes.find((h) => h.site.at === "port" && h.site.stepId === op.stepId && h.site.port === op.port);
  if (op.op === "choose_reader") return f.holes.find((h) => h.site.at === "reader" && h.site.stepId === op.stepId);
  if (op.op === "set_output") return f.holes.find((h) => h.site.at === "output");
  return undefined;
}

// ── questions (task 4) ────────────────────────────────────────────────────────
/** The person's questions for a state: every hole they own, and every hole handed to them — each at most once. */
export function questionsFor(f: EFlow, asked: string[], trace: BuildTrace, round: number, cat?: CatalogueSnapshot): BuildQuestion[] {
  const already = new Set(trace.questions.flatMap((q) => [q.holeId, ...(q.alsoFills ?? [])]));
  const blocked = new Set(trace.blocked ?? []);
  const open = f.holes.filter((h) => (h.owner === "person" || asked.includes(h.id)) && !already.has(h.id) && !keyHole(h) && !(h.site.at === "port" && blocked.has(h.site.stepId)));
  // One question per input of a component: the same port of the same component, of the same type, open on several steps, is asked
  // once. By declaration, never by name: a port the catalogue declares as wording (a subject, a message) is each step's own.
  const groups = new Map<string, Hole[]>();
  for (const h of open) {
    const key = sameInput(f, h, cat);
    const g = key ? groups.get(key) : undefined;
    if (g) g.push(h); else groups.set(key ?? h.id, [h]);
  }
  return [...groups.values()].map(([h, ...rest]) => {
    const q = questionOf(f, h!, trace, round, cat);
    return rest.length ? { ...q, ask: `${q.ask} — for all ${rest.length + 1} of its steps`, alsoFills: rest.map((x) => x.id) } : q;
  });
}
/** The group key of a port hole that may share its question: its component, its port and its type — `null` when it is its own. */
function sameInput(f: EFlow, h: Hole, cat?: CatalogueSnapshot): string | null {
  if (h.site.at !== "port") return null;
  const site = h.site;
  const step = f.steps.find((x) => x.id === site.stepId) as { ref?: string } | undefined;
  const p = step?.ref ? cat?.refs[step.ref]?.params.find((x) => x.name === site.port) : undefined;
  if (!step?.ref || !p || p.heading || p.message) return null;
  return `${step.ref}|${site.port}|${JSON.stringify(h.ty)}`;
}
/**
 * P1 (RC-1): a stated value the platform REFUSED (an address shaped right, off the allowed domain) — ONE wording, keyed
 * `stepId.port`, so the reason reaches both the question for that port and the findings, and a refused value never reads as a
 * missing one (the field report's wrong-cause "no row here carries an address" was this reason, dropped).
 */
export const refusalText = (stepId: string, port: string, words: string, why: string) => `the address “${words}” stated for \`${stepId}.${port}\` was refused: ${why}`;
const REFUSAL = /^the address “(.+?)” stated for `([^`]+)` was refused: (.+)$/;
/** The refusal stated for one port, if any — the person's words and the platform's own reason, for the question to carry. */
export const refusalFor = (unmet: readonly string[], stepId: string, port: string): { words: string; why: string } | undefined => {
  for (const u of unmet) { const m = REFUSAL.exec(u); if (m && m[2] === `${stepId}.${port}`) return { words: m[1]!, why: m[3]! }; }
  return undefined;
};
/**
 * P1 (RC-2/RC-6): the DATA holds no address for the recipient the goal names — ONE wording, keyed `stepId.port`, produced here
 * for every site that finds it (the final sweep, a blocked fan-out, a blocked per-item send) so the conversation's
 * `partQuestion` matches exactly what the solver states: the person CAN give an address, so this asks, once. A refused value
 * never shares it (`refusalText`): two causes, two distinguishable strings.
 */
export const noAddressText = (stepId: string, port: string, words: string) => `the goal says who receives \`${stepId}.${port}\` (“${words}”), but no row here carries an address for them`;

function questionOf(f: EFlow, h: Hole, trace: BuildTrace, round: number, cat?: CatalogueSnapshot): BuildQuestion {
  // A month or a date may be the one the flow RUNS in — offered first, beside any value given before (2026-09-29).
  const run = cat && h.site.at === "port" ? runTimeChoices(f, h.site.stepId, h.site.port, portTyNow(f, h, cat)).map((c) => c.label) : [];
  const one = oneOfValues(h.ty) ?? earlierChoices(h, trace, cat);
  // On a schedule nobody starts the run, so a month typed now is the same month for ever: only the run-time choices answer it.
  const onlyOptions = !!f.schedule && run.length > 0;
  const options = onlyOptions ? run : [...run, ...(one ?? [])];
  // P1 (RC-1): a stated value the platform refused — the question carries the real reason beside the plain ask, so the person
  // never meets the generic re-ask with the reason nowhere in sight.
  const refusal = h.site.at === "port" ? refusalFor(trace.unmet ?? [], h.site.stepId, h.site.port) : undefined;
  // A port's anchor: the component (by ref and its ordinal among steps of that ref, never the step id) and the input.
  const st = h.site.at === "port" ? f.steps.find((x) => x.id === (h.site as { stepId: string }).stepId) : undefined;
  const about = h.site.at === "port" ? (st && "ref" in st && st.ref ? `port:${st.ref}#${f.steps.filter((x) => "ref" in x && x.ref === st.ref).indexOf(st)}.${h.site.port}` : `port:${(h.site as { stepId: string }).stepId}.${h.site.port}`) : undefined;
  return { holeId: h.id, ...(about ? { about } : {}), ask: refusal ? `${askFor(h, f)} — “${refusal.words}” was refused: ${refusal.why}` : askFor(h, f), round, ...(h.site.at === "port" ? { port: h.site.port } : {}), ...(options.length ? { options } : {}), ...(onlyOptions ? { onlyOptions } : {}) };
}

/**
 * S4 drafted defaults (2026-10-08): a confirm question over goal-drafted wording ports.
 * The solver binds goal-derived drafts at `drafted` provenance and drops their holes; this builds the
 * ONE confirmation carrying those drafts ("use this?") from the bound inputs. Reject falls back to the
 * open ask. Structural: declared heading/message ports + drafted bindings, never a domain word.
 */
export interface DraftedConfirm { stepId: string; subject?: string; body?: string; holeIds: string[]; }
export function draftedConfirmOf(f: EFlow, cat?: CatalogueSnapshot): DraftedConfirm | null {
  const bound = new Map<string, { stepId: string; port: string; value: string }>();
  for (const s of f.steps) {
    if ((s.kind !== "tool" && s.kind !== "datasource") || !("ref" in s) || !s.ref || !("inputs" in s)) continue;
    const sig = cat?.refs[s.ref];
    for (const b of s.inputs) {
      const src = b.source;
      if (!src || src.from !== "literal") continue;
      if (b.provenance?.from !== "drafted") continue;
      const p = sig?.params.find((q) => q.name === b.name);
      if (!p || (!p.heading && !p.message)) continue;
      bound.set(`${s.id}.${b.name}`, { stepId: s.id, port: b.name, value: src.value });
    }
  }
  if (!bound.size) return null;
  const byPort = new Map<string, { stepId: string; port: string; value: string }>();
  for (const e of bound.values()) {
    if (e.port === "subject" || e.port === "body") byPort.set(e.port, e);
  }
  if (!byPort.size) return null;
  const first = byPort.values().next().value!;
  if ([...byPort.values()].some((e) => e.stepId !== first.stepId)) return null;
  const subject = byPort.get("subject"), body = byPort.get("body");
  return {
    stepId: first.stepId,
    ...(subject ? { subject: subject.value } : {}),
    ...(body ? { body: body.value } : {}),
    holeIds: [...byPort.values()].map((e) => `h_${e.stepId}_${e.port}`),
  };
}

/** S4 drafted defaults (2026-10-08): the one confirm ask carrying goal-derived drafts. Reject → open ask. */
export function draftedConfirmAsk(c: DraftedConfirm): string {
  const parts: string[] = [];
  if (c.subject !== undefined) parts.push(`subject “${c.subject}”`);
  if (c.body !== undefined) parts.push(`message “${c.body}”`);
  return `I drafted this ${parts.join(" and ")} from your goal — use it? Reply “yes” to keep it, or tell me what it should say instead.`;
}
/** A port's type as the catalogue declares it NOW (a hole keeps the type it was opened with), else the hole's. */
function portTyNow(f: EFlow, h: Hole, cat: CatalogueSnapshot): Ty | null {
  if (h.site.at !== "port") return h.ty;
  const site = h.site;
  const step = f.steps.find((x) => x.id === site.stepId);
  return (step && "ref" in step && step.ref ? cat.refs[step.ref]?.params.find((p) => p.name === site.port)?.ty : undefined) ?? h.ty;
}
/**
 * Z5: a question whose answer may be one the person already gave in this automation offers those values as its choices — an address,
 * a date, a number that fits the input's type (never free text: a subject is not the choice of another step's body). Several fit, or
 * the builder could not tell which was meant; the person picks, or types another.
 */
function earlierChoices(h: Hole, trace: BuildTrace, cat?: CatalogueSnapshot): string[] | null {
  if (!cat || h.site.at !== "port" || !h.ty || !trace.known?.length) return null;
  const el = h.ty.t === "List" || h.ty.t === "Option" ? h.ty.of : h.ty;
  if (el.t === "Text") return null;
  const fit = [...new Set(trace.known.map((k) => k.value))].filter((v) => literalFits(v, el, cat) === null);
  return fit.length && fit.length <= 6 ? fit : null;
}
/** A closed set's values (I-301): the answer is one of them, so a caller can offer them as choices. */
export const oneOfValues = (ty: Hole["ty"]): string[] | null => {
  const base = ty ? (ty.t === "Option" || ty.t === "List" ? ty.of : ty) : null;
  return ((base as { refine?: Array<{ r: string; values?: string[] }> } | null)?.refine ?? []).find((r) => r.r === "OneOf")?.values ?? null;
};
/** A port that takes a row's identity: no typed answer can fill it (a Key is never a literal), so it is never a question — the solver
 *  states it unmet instead. Asking would be a dead end the person cannot get out of. */
export const keyHole = (h: Hole) => { const t = h.ty?.t === "Option" || h.ty?.t === "List" ? h.ty.of : h.ty; return h.site.at === "port" && t?.t === "Key"; };
/**
 * The question, in words for a PERSON: the port and the action by name, the port's limits in plain language — never a step id or
 * the engine's type syntax (2026-09-27: "What should `call_1` use for `subject` (Text<SingleLine, NonEmpty, MaxLen(250)>)?").
 */
const words = (id: string) => id.replace(/[._]+/g, " ").trim();
// A month is asked in a person's words — the machine's `YYYY-MM` is never the person's to type.
const FORM: Record<string, string> = { Month: "a month, like August 2026", Date: "a date, like 2026-06-30", DateTime: "a date and time, like 2026-06-30T09:00", Int: "a whole number", Number: "a number", Address: "an email address", Bool: "yes or no" };
function askFor(h: Hole, f: EFlow): string {
  if (h.site.at !== "port") return `${h.reason[0]!.toUpperCase()}${h.reason.slice(1)} — what should it be?`;
  const site = h.site;
  const step = f.steps.find((x) => x.id === site.stepId) as { ref?: string } | undefined;
  const base = h.ty ? (h.ty.t === "Option" || h.ty.t === "List" ? h.ty.of : h.ty) : null;
  const refine = (base as { refine?: Array<{ r: string; n?: number; values?: string[] }> } | null)?.refine ?? [];
  const one = refine.find((r) => r.r === "OneOf")?.values;
  const max = refine.find((r) => r.r === "MaxLen")?.n;
  // The value's own form, when it has one a person could get wrong ("20th september 2026" is not a month).
  const form = FORM[base?.t ?? ""];
  const limit = one ? ` — one of: ${one.join(", ")}` : max ? ` (up to ${max} characters)` : form ? ` (${form})` : "";
  // The component by its own name, without the datasource in front of it ("finance demo spend by cost centre").
  const what = step?.ref ? words(step.ref.slice(step.ref.lastIndexOf(".") + 1)) : "";
  // A date compared BY ITS MONTH is asked for as a month: any day of it is the same answer.
  if (base?.t === "Date" && "per" in base && base.per === "month") return `Which month should the ${words(site.port)} be${what ? ` for ${what}` : ""}? (a month, like August 2026)`;
  return `What should the ${words(site.port)} be${what ? ` for ${what}` : ""}?${limit}`;
}

/** First-person recipient — the person building ("me"), not a literal address string. */
const ME_RECIPIENT = /^(me|myself|i|us|ourselves)$/i;
const meRecipient = (text: string) => {
  const t = text.trim();
  if (ME_RECIPIENT.test(t)) return true;
  // "send it to me" / "email me" — not a shaped address, but clearly the requester.
  return /\bme\b/i.test(t) && !/@/.test(t);
};

/**
 * Fill a person's hole with their answer, if it is a value of the hole's type. An answer that does not fit leaves the hole
 * as a STATED incomplete (rule 3): it is marked answered and never asked again.
 *
 * `requester` is the verified address of the person building (Z9) — what "me" means on an address port, especially a
 * `scheduled_recipient` hole where the engine cannot fall back to whoever started the run.
 */
export function answer(f: EFlow, q: BuildQuestion, text: string, cat: CatalogueSnapshot, requester?: string): EFlow {
  q.answer = text;
  // One answer for the same input on several steps: each is filled as its own question would be; all or none.
  if (q.alsoFills?.length) {
    let g = f;
    for (const holeId of [q.holeId, ...q.alsoFills]) {
      const one: BuildQuestion = { ...q, holeId, alsoFills: undefined };
      g = answer(g, one, text, cat, requester);
      if (!one.filled) { q.filled = false; return f; }
    }
    q.filled = true;
    return g;
  }
  const h = f.holes.find((x) => x.id === q.holeId);
  if (!h || h.site.at !== "port" || !h.ty) { q.filled = false; return f; }
  const { stepId, port } = h.site;
  // A run-time choice ("the month it runs") is the engine's own two moves: declare the computed input, bind the port to it.
  const choices = runTimeChoices(f, stepId, port, portTyNow(f, h, cat));
  // An option is picked by its label, or by its WORDS — the label without its trailing note ("the day it runs", for "the day it runs
  // (worked out when it runs)"), in any case (2026-10-02, O03: the person typed the option's words and the build stayed open).
  const words = (l: string) => l.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  const picked = choices.find((c) => c.label === text.trim()) ?? choices.find((c) => words(c.label) === words(text));
  if (picked) {
    let g = f;
    for (const op of picked.ops) { const r = apply(g, op, cat); if (!r.ok) { q.filled = false; return f; } g = r.flow; }
    q.filled = true;
    return g;
  }
  // The same rule the question states, held here too so no caller can type past it: a scheduled flow's month is worked out.
  if (f.schedule && choices.length) { q.filled = false; return f; }
  const ty = h.ty.t === "List" ? h.ty.of : h.ty;
  const bare = ty.t === "Option" ? ty.of : ty;
  // "me" on an address port: bind the builder's verified address (solver does the same for from:requester + scheduled_recipient).
  const step = f.steps.find((x) => x.id === stepId) as { ref?: string } | undefined;
  const param = step?.ref ? cat.refs[step.ref]?.params.find((p) => p.name === port) : undefined;
  const addr = bare.t === "Address";
  if (addr && meRecipient(text) && (param?.fallsBackToRequester || h.why === "scheduled_recipient")) {
    if (requester && literalFits(requester, ty, cat) === null) {
      const r = apply(f, { op: "bind", stepId, port, source: { from: "literal", value: requester, provenance: "person" } }, cat);
      q.filled = r.ok;
      return r.ok ? r.flow : f;
    }
    q.filled = false;
    return f;
  }
  // A confirmation fills no value (2026-10-01: "yes", answered to "what should the leave account code be?", was bound as the code).
  if (bare.t !== "Bool" && CONFIRMS.test(text.trim())) { q.filled = false; return f; }
  // Step 4: the person's typed words are the value — no English mining. Fits or the port stays a question.
  const value = text.trim();
  const r = apply(f, { op: "bind", stepId, port, source: { from: "literal", value, provenance: "person" } }, cat);
  q.filled = r.ok;
  return r.ok ? r.flow : f;
}

/** D-294's four rules over a trace; `[]` when all hold. */
export function noLoopProblems(trace: BuildTrace): string[] {
  const out: string[] = [];
  const asked = trace.questions.map((q) => q.holeId);
  const dup = asked.find((h, i) => asked.indexOf(h) !== i);
  if (dup) out.push(`hole ${dup} was asked twice`);
  const rounds = new Set(trace.questions.map((q) => q.round));
  if (rounds.size > MAX_ROUNDS) out.push(`${rounds.size} question rounds (at most ${MAX_ROUNDS})`);
  const reasked = trace.questions.filter((q) => q.answer !== undefined && q.filled === false).filter((q) => trace.questions.some((x) => x !== q && x.holeId === q.holeId));
  if (reasked.length) out.push(`an unfilled answer was re-asked (${reasked[0]!.holeId})`);
  const hashes = trace.calls.map((c) => c.promptHash);
  const rep = hashes.find((h, i) => hashes.indexOf(h) !== i);
  if (rep) out.push(`a model call repeated an unchanged prompt (${rep})`);
  if (trace.moves.length > MAX_MOVES * MAX_ROUNDS) out.push(`${trace.moves.length} moves`);
  return out;
}
