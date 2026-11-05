/**
 * A chat EDIT (phase X, D-336/D-337): a change to the automation as it is, made by choosing ONE of the actions the canvas offers
 * on its current state (`canvasActions`, phase 7) — never by writing an op. The model picks an action id from an enum; code
 * decides everything else:
 *
 *   - the palette is not offered: ADDING is the builder's (`build` route), so there is one way to add and it is the measured one;
 *   - a value the action needs must be the person's words (the constants rule) — otherwise the person is asked for it;
 *   - the step, when the words do not name it and several steps offer the same action — the person is asked which (I-137: the
 *     model guessed 4 times in 5 on a genuinely ambiguous referent);
 *   - a destructive action (removing a step or an input, clearing a field, no longer running on a schedule) is confirmed first;
 *   - anything else is applied by `canvasApply`, which judges a typed value with `literalFits`, and saved by the canvas's funnel.
 *
 * So an edit cannot produce a state the canvas could not: the same list, the same apply, the same save (P1).
 *
 * Pure over (message, state, catalogue, chooser). Loading and saving is `chat-edit.service.ts`.
 */
import { actionKind, canvasActions, canvasApply, type Applied, type CanvasAction, type CanvasWhere, type CatalogueSnapshot, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { describeState, type Chooser } from "./build.js";
import { NONE_FIT, quoted } from "./goal-spec.js";
import { S, parseStrict, type Schema } from "./strict-schema.js";
/** S2 patch-first (2026-10-08): a patch cascades downstream at most this many edges. Structural: a count of graph edges, never a domain word. */
export const PATCH_CASCADE_DEPTH = 3;

/** Over this many listed actions, the step is chosen first and then the action at it — the gateway's enum limit (M12's lesson). */
export const ACTION_LIMIT = 400;
/** S2 patch-first additions (2026-10-08): the place a chat edit may act. Palette additions (a new step, one op) ride the pin path; the new step's holes stay open for the caller. A bare `declare_input` slot alone still rebuilds — its NAME is an internal identifier no person is asked for (P4 R8) — unless bound beside it in the same action (a run-time choice). */
export const editable = (f: EFlow, cat: CatalogueSnapshot): CanvasAction[] => canvasActions(f, cat).filter((a) =>
  a.where.at === "palette" ? !!a.op && ["add_reader", "add_call", "add_transform", "add_branch", "add_otherwise", "add_merge", "add_loop", "add_gate"].includes(a.op.op)
  : a.slot?.kind !== "declare_input"
  // builder-behaviour P7 (E07): clearing a REQUIRED port alone never makes a change whole either — it leaves the port open ("make it a
  // month I pick each time" chose "clear it", and the automation could not be finished). From chat it is planned again whole.
  && !(a.op?.op === "unbind" && requiredPort(f, cat, a.op.stepId, a.op.port)));
/** Whether `port` of step `stepId` is required by its component's declaration. */
const requiredPort = (f: EFlow, cat: CatalogueSnapshot, stepId: string, port: string): boolean => {
  const s = f.steps.find((x) => x.id === stepId) as { ref?: string } | undefined;
  return !!s?.ref && !!cat.refs[s.ref]?.params.find((p) => p.name === port)?.required;
};

/** S2 patch-first additions (2026-10-08): the op kinds an edit may ADD, REMOVE, or PATCH on an existing step. Structural: op kinds only, never a component name. */
export const ADD_OPS: ReadonlyArray<EngineOp["op"]> = ["add_reader", "add_call", "add_transform", "add_branch", "add_otherwise", "add_merge", "add_loop", "add_gate", "declare_input"];
export const REMOVE_OPS: ReadonlyArray<EngineOp["op"]> = ["remove_step", "remove_input", "unbind"];
export const PATCH_OPS: ReadonlyArray<EngineOp["op"]> = ["bind", "choose_reader", "append_stage", "retest", "retype_input", "set_output", "set_schedule", "set_loop", "set_loop_result", "close_loop"];
/** S2 patch-first additions (2026-10-08): the class an action's ops fall in — add when any op adds, else remove when any op removes, else patch. Structural: op kinds only. */
export function editClassOf(a: Pick<CanvasAction, "op" | "ops">): "add" | "remove" | "patch" {
  const ops = [...(a.op ? [a.op] : []), ...(a.ops ?? [])].map((op) => op.op);
  if (ops.some((k) => (ADD_OPS as ReadonlyArray<string>).includes(k))) return "add";
  if (ops.some((k) => (REMOVE_OPS as ReadonlyArray<string>).includes(k))) return "remove";
  return "patch";
}
/** The op an action ends in — the engine's own answer (a slot declares its kind), never learned by calling `make`. */
const opOf = (a: CanvasAction): EngineOp["op"] => actionKind(a);
/** Removing a step or an input, clearing a field, stopping a schedule — never applied without the person's yes. An action of several
 *  ops (a condition on one value removed with its test, phase C) is destructive when ANY of them is. */
export const isDestructive = (a: CanvasAction): boolean =>
  [...(a.op ? [a.op] : []), ...(a.ops ?? [])].some((op) => op.op === "remove_step" || op.op === "remove_input" || op.op === "unbind" || (op.op === "set_schedule" && op.cron === null));
const stepOfWhere = (w: CanvasWhere): string | null => ("stepId" in w ? w.stepId : null);
export function placeWords(w: CanvasWhere): string {
  switch (w.at) {
    case "step": return `step ${w.stepId}`;
    case "port": return `${w.port} of ${w.stepId}`;
    case "stages": return `the pipeline of ${w.stepId}`;
    case "flow": return "the automation";
    case "palette": return "the palette";
  }
}
/** An action's identity that survives a new listing: its place and its label. Ids are positional and a state moves. */
export interface ActionKey { where: CanvasWhere; label: string }
export const keyOf = (a: CanvasAction): ActionKey => ({ where: a.where, label: a.label });
export const findByKey = (acts: CanvasAction[], k: ActionKey): CanvasAction | undefined => acts.find((a) => a.label === k.label && JSON.stringify(a.where) === JSON.stringify(k.where));

export type EditDecision =
  | { status: "apply"; action: CanvasAction; value?: string; meant?: string; shapeColumns?: string[] }
  | { status: "confirm"; action: CanvasAction; value?: string }
  | { status: "which_step"; action: CanvasAction; candidates: CanvasAction[]; value?: string }
  | { status: "ask_value"; action: CanvasAction; why?: string }
  | { status: "none_fit" };

/**
 * The output columns a decided edit was asked to carry, model-filled on the
 * decision itself — the delta-check's input. Typed, never mined from the
 * message by regex (`outputShapeRequest`, deleted). Null when the decision
 * carries no column request.
 */
export function editShapeOf(d: EditDecision): string[] | null {
  if (d.status !== "apply" || !d.shapeColumns?.length) return null;
  return d.shapeColumns;
}

const actionLine = (a: CanvasAction) => `- ${a.id} — at ${placeWords(a.where)}: ${a.label}${a.slot ? ` (needs a value: ${a.slot.what})` : ""}`;

export function editPrompt(message: string, f: EFlow, cat: CatalogueSnapshot, acts: CanvasAction[]): string {
  return [
    "A person asks to CHANGE an automation. Choose the ONE listed change that does what they ask. You do not write changes; you choose one.",
    "Rules:",
    "- Choose only from CHANGES. If none of them does what the person asks, choose `none_fit`.",
    "- `step_words`: the person's words that name the step the change is about, copied exactly. Empty when their words name no step.",
    "- The same change listed at several steps, and the message does not say which: choose any one of them and leave `step_words` empty — the person is then asked which. That is not `none_fit`.",
    "- `value`: for a change that needs a value, the value copied EXACTLY from the message. Empty when the message does not state one — never supply one yourself.",
    "- `shape_columns`: the output columns the message asks the automation to return, copied exactly — empty when it asks for no column change.",
    "",
    "THE AUTOMATION AS IT IS",
    ...describeState(f, cat),
    "",
    "CHANGES",
    ...acts.map(actionLine),
    "",
    "MESSAGE",
    message,
  ].join("\n");
}

const editSchema = (ids: string[]): Schema => S.obj({
  action: S.oneOf([...ids, NONE_FIT]),
  step_words: S.str("the message's words that name the step, copied exactly; empty when it names none"),
  value: S.str("the value copied exactly from the message; empty when it states none"),
  ...{ value_meant: S.str("when the change takes one of a LISTED set of values and the message names one in its own words: that listed value, exactly; else empty") },
  shape_columns: S.arr(S.str("one output column the message asks the automation to return"), 12, "the output columns the message asks the automation to return, copied exactly; empty when it asks for no column change"),
});
const placeSchema = (places: string[]): Schema => S.obj({ place: S.oneOf([...places, NONE_FIT]) });

/**
 * Choose the action — one call, or two when the list is over `ACTION_LIMIT`: the PLACE first (a step, or the automation), then
 * the action at it. Returns the action, the step words and the value, or `none_fit`. `calls` counts what was made.
 */
export async function chooseEdit(message: string, f: EFlow, cat: CatalogueSnapshot, chooser: Chooser): Promise<{ pick: CanvasAction | null; stepWords: string; value: string; valueMeant?: string; shapeColumns: string[]; calls: number; acts: CanvasAction[] }> {
  const all = editable(f, cat);
  if (!all.length) return { pick: null, stepWords: "", value: "", shapeColumns: [], calls: 0, acts: all };
  let acts = all, calls = 0;
  if (all.length > ACTION_LIMIT) {
    const places = [...new Set(all.map((a) => stepOfWhere(a.where) ?? "the_automation"))];
    const schema = placeSchema(places);
    const raw = await chooser([
      "A person asks to CHANGE an automation. Say which step the change is about, or `the_automation` for the automation as a whole (its inputs, its schedule, its result). `none_fit` when it is about none of them.",
      "", "THE AUTOMATION AS IT IS", ...describeState(f, cat), "", "MESSAGE", message,
    ].join("\n"), { name: "chat_edit_place", schema }, "chat:edit:place");
    calls++;
    const place = parseStrict<{ place: string }>(schema, raw, "chat:edit:place").place;
    if (place === NONE_FIT) return { pick: null, stepWords: "", value: "", shapeColumns: [], calls, acts: all };
    acts = all.filter((a) => (stepOfWhere(a.where) ?? "the_automation") === place);
  }
  const schema = editSchema(acts.map((a) => a.id));
  const raw = await chooser(editPrompt(message, f, cat, acts), { name: "chat_edit", schema }, "chat:edit");
  calls++;
  const r = parseStrict<{ action: string; step_words: string; value: string; value_meant?: string; shape_columns?: string[] }>(schema, raw, "chat:edit");
  const shapeColumns = Array.isArray(r.shape_columns) ? r.shape_columns.map((c) => String(c).trim()).filter(Boolean) : [];
  return { pick: r.action === NONE_FIT ? null : acts.find((a) => a.id === r.action) ?? null, stepWords: r.step_words, value: r.value, ...(r.value_meant?.trim() ? { valueMeant: r.value_meant.trim() } : {}), shapeColumns, calls, acts: all };
}

/**
 * Code's half: what happens to the chosen action. `acts` is every editable action on the state (for the sibling check).
 * Also the tail a resumed question continues from (`chat-edit.service.ts`), with `stepNamed` true once the person chose the step.
 */
export function decide(message: string, a: CanvasAction, acts: CanvasAction[], opts: { stepWords?: string; value?: string; valueMeant?: string; stepNamed?: boolean; shapeColumns?: string[] }): EditDecision {
  const texts = [message];
  const shape = opts.shapeColumns?.map((c) => c.trim()).filter(Boolean) ?? [];
  const shaped = shape.length ? { shapeColumns: shape } : {};
  // The same action at other steps: when the words did not name one, the person says which (D-337).
  const at = stepOfWhere(a.where);
  if (at && !opts.stepNamed) {
    const siblings = acts.filter((x) => x !== a && x.label === a.label && x.where.at === a.where.at && stepOfWhere(x.where) !== at && ("port" in x.where ? "port" in a.where && x.where.port === a.where.port : true));
    const named = !!opts.stepWords?.trim() && quoted(opts.stepWords, texts);
    if (siblings.length && !named) return { status: "which_step", action: a, candidates: [a, ...siblings], ...(opts.value ? { value: opts.value } : {}) };
  }
  if (a.where.at === "palette" && !a.slot) {
    if (editClassOf(a) === "add") return { status: "apply", action: a, ...shaped };
    return { status: "none_fit" };
  }
  if (a.slot) {
    const v = opts.value?.trim() ?? "";
    if (!v) return { status: "ask_value", action: a };
    // The constants rule: a value is the person's words. One the message does not contain is not used — the person is asked.
    if (!quoted(v, texts)) return { status: "ask_value", action: a, why: `“${v}” is not in your message` };
    // the listed value the person's words NAME — tried only when their own words do not fit, and held to the
    // list by the engine's own check (`apply` refuses a value outside it). Their words stay what is said back to them.
    return { status: "apply", action: a, value: v, ...(opts.valueMeant && opts.valueMeant !== v ? { meant: opts.valueMeant } : {}), ...shaped };
  }
  if (isDestructive(a)) return { status: "confirm", action: a };
  return { status: "apply", action: a, ...shaped };
}

/** Apply a decided action to the state it was listed for. A value that does not fit is `apply`'s refusal, by name. */
export const applyEdit = (f: EFlow, cat: CatalogueSnapshot, a: CanvasAction, value?: string): Applied => canvasApply(f, cat, a, value);

/** The op kind an action makes — for the trace and the tests. */
export const editOpKind = opOf;
/** S2 patch-first (2026-10-08): the downstream steps an op's touched steps reach within `PATCH_CASCADE_DEPTH` edges. Structural: follows `dependsOn`/binding reads, never a domain word. */
export function cascadeWithin(state: EFlow, touched: readonly string[], depth: number = PATCH_CASCADE_DEPTH): string[] {
  const readsOf = (id: string): string[] => {
    const out = new Set<string>();
    for (const s of state.steps) {
      if (s.id === id) continue;
      if (s.dependsOn.includes(id)) out.add(s.id);
      if (s.kind === "transform" && s.from === id) out.add(s.id);
      if (s.kind === "tool" && s.over?.stepId === id) out.add(s.id);
      if (s.kind === "branch" && (s.elseOf === id || s.conditions?.some((c) => c.left.stepId === id))) out.add(s.id);
      if (s.kind === "merge" && s.sources.includes(id)) out.add(s.id);
      if (s.kind === "for_each" && s.over.stepId === id) out.add(s.id);
      if (s.kind === "collect" && (s.loop === id || s.result === id)) out.add(s.id);
      if ("inputs" in s && s.inputs.some((b) => b.source && "stepId" in b.source && b.source.stepId === id)) out.add(s.id);
    }
    if (state.output?.stepId === id) out.add("(the result)");
    return [...out].filter((x) => state.steps.some((s) => s.id === x));
  };
  const seen = new Set<string>(touched);
  let frontier = [...touched];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const r of readsOf(id)) if (!seen.has(r)) { seen.add(r); next.push(r); }
    frontier = next;
  }
  return [...seen].filter((x) => !touched.includes(x));
}

/** S2 patch-first (2026-10-08): the step ids an engine op writes — the footprint a patch owns. Structural: ids only. Add ops own their new step; inputs own the ports bound to them. */
export function touchedStepsOf(state: EFlow, ops: readonly EngineOp[]): string[] {
  const out: string[] = [];
  const push = (x: unknown) => { if (typeof x === "string" && !out.includes(x)) out.push(x); };
  for (const op of ops) {
    if ("stepId" in op) push(op.stepId);
    if ("step" in op && op.step !== null && typeof op.step === "object" && "id" in op.step) push(op.step.id);
    if ("id" in op && typeof op.id === "string" && (op.op === "add_reader" || op.op === "add_call" || op.op === "add_transform" || op.op === "add_branch" || op.op === "add_otherwise" || op.op === "add_merge" || op.op === "add_loop" || op.op === "add_gate")) push(op.id);
    if ("beforeStepId" in op) push(op.beforeStepId);
    if ("before" in op) push(op.before);
    if ("afterStepId" in op) push(op.afterStepId);
    if ("result" in op) push(op.result);
    if (op.op === "declare_input") for (const s of state.steps) {
      if ("inputs" in s && s.inputs.some((b) => b.source?.from === "input" && b.source.inputId === op.id)) push(s.id);
    }
  }
  return out;
}
/** S2 patch-first additions (2026-10-08): the ids a pin-path addition owns — added steps plus inputs declared beside them. Structural: id sets only. */
export function addedIdsOf(ops: readonly EngineOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if ("id" in op && typeof op.id === "string" && (op.op === "add_reader" || op.op === "add_call" || op.op === "add_transform" || op.op === "add_branch" || op.op === "add_otherwise" || op.op === "add_merge" || op.op === "add_loop" || op.op === "add_gate")) { if (!out.includes(op.id)) out.push(op.id); }
    if (op.op === "declare_input") { if (!out.includes(op.id)) out.push(op.id); }
  }
  return out;
}
