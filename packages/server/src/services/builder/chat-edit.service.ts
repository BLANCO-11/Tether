/**
 * Chat edits, loaded and saved (phase X). `chat-edit.ts` decides; this reads the flow's state the way the canvas does
 * (`loadState`), asks the person when the decision needs them, and saves the way the canvas does (`saveState`, origin `chat`).
 *
 * A question an edit asks carries its PENDING decision (D-338) — the action's place and label, the value, the candidate steps —
 * on the `needs_input` turn. The next message resumes it only when it is an answer to it (an option's value, or, for a value
 * question, the reply itself); anything else is a new message and the pending is dropped. The action is re-found on the state
 * as it is THEN, by place and label: a state that moved in between answers "nothing was done", never an edit to a step that
 * is no longer there.
 */
import type { CanvasAction, CatalogueSnapshot, EFlow } from "@foundry/flow-edit";
import { checkState, errorsOf } from "@foundry/flow-edit";
import { createHash } from "node:crypto";
import { flowRepo } from "../../repositories/flow.repo.js";
import type { RevisionAuthor } from "../revision-author.js";
import type { Chooser } from "./build.js";
import { builderCatalogue } from "./builder.service.js";
import { inputFacts, readerFacts } from "./chat-answers.js";
import { loadState, saveState } from "./canvas.service.js";
import { unreadInputs } from "./inputs.js";
import { addedIdsOf, applyEdit, cascadeWithin, chooseEdit, decide, editable, editClassOf, editShapeOf, findByKey, keyOf, PATCH_CASCADE_DEPTH, placeWords, touchedStepsOf, type ActionKey, type EditDecision } from "./chat-edit.js";

/** S2 patch-first (2026-10-08): a patch pinned to the revision + structure it was planned on. A stale pin falls back to whole rebuild, never a mis-applied edit. */
export interface PatchPin { draftRevision: number; structureHash: string; }
/** S2 patch-first additions (2026-10-08): the steps a patch owns (touched + bounded downstream + added) — everything else must be byte-identical. Added inputs are owned the same way. Structural: id sets only. */
export interface PatchScope { touched: string[]; cascade: string[]; addedSteps: string[]; addedInputs: string[]; }

/** S2 patch-first (2026-10-08): the structure stamp of a state at patch time — compared against the stored revision's hash on apply. */
export function patchStampOf(state: EFlow): string {
  return createHash("sha256").update(JSON.stringify(state.steps)).digest("hex").slice(0, 16);
}

/** S2 patch-first additions (2026-10-08): the scope a decided action owns — touched steps plus downstream within the cap, plus added steps/inputs. Structural: graph edges and id sets only. */
export function patchScopeOf(state: EFlow, d: EditDecision): PatchScope | null {
  if (d.status !== "apply") return null;
  const ops = [...(d.action.op ? [d.action.op] : []), ...(d.action.ops ?? [])];
  const touched = touchedStepsOf(state, ops);
  const cascade = cascadeWithin(state, touched, PATCH_CASCADE_DEPTH);
  const added = addedIdsOf(ops);
  const stepIds = new Set(state.steps.map((s) => s.id));
  const inputIds = new Set(state.inputs.map((i) => i.id));
  const addedInputs = ops.filter((op) => op.op === "declare_input").map((op) => op.id).filter((id) => !inputIds.has(id));
  const addedSteps = added.filter((id) => !stepIds.has(id) && !addedInputs.includes(id));
  return { touched, cascade, addedSteps, addedInputs };
}

/** S2 patch-first additions (2026-10-08): the lost check scoped to a patch — touched + cascade + added steps may move, added inputs may appear. Anything else added/removed/moved escalates to whole rebuild. Structural: id sets and JSON equality only. */
export function patchLostCheck(before: EFlow, after: EFlow, scope: PatchScope): string | null {
  const beforeIds = new Set(before.steps.map((s) => s.id));
  const afterIds = new Set(after.steps.map((s) => s.id));
  for (const id of beforeIds) if (!afterIds.has(id)) {
    if (!scope.touched.includes(id) && !scope.cascade.includes(id)) return `step ${id} was removed`;
  }
  for (const id of afterIds) if (!beforeIds.has(id)) {
    if (!scope.touched.includes(id) && !scope.cascade.includes(id) && !scope.addedSteps.includes(id)) return `step ${id} was added`;
  }
  const beforeInputs = new Set(before.inputs.map((i) => i.id));
  const afterInputs = new Set(after.inputs.map((i) => i.id));
  for (const id of afterInputs) if (!beforeInputs.has(id) && !scope.addedInputs.includes(id)) return `input ${id} was added`;
  for (const id of beforeInputs) if (!afterInputs.has(id)) return `input ${id} was removed`;
  const owned = new Set([...scope.touched, ...scope.cascade, ...scope.addedSteps]);
  const wasThere = new Map(before.steps.map((s) => [s.id, JSON.stringify(s)]));
  const isThere = new Map(after.steps.map((s) => [s.id, JSON.stringify(s)]));
  const moved: string[] = [];
  for (const [id, json] of wasThere) {
    if (owned.has(id)) continue;
    if (!isThere.has(id)) moved.push(`${id} (removed)`);
    else if (isThere.get(id) !== json) moved.push(id);
  }
  for (const id of isThere.keys()) {
    if (!owned.has(id) && !wasThere.has(id)) moved.push(`${id} (added)`);
  }
  return moved.length ? `this edit changed steps it was not about — ${moved.join(", ")}` : null;
}

/** S2 patch-first additions (2026-10-08): carry a decided patch out against a pin. Additions ride the same pin: the new step's holes stay open (saved incomplete) and the caller finishes them. Pin mismatch or out-of-scope movement falls back to whole rebuild (`none_fit` to the caller). Structural: id sets and the cascade cap only. */
export async function carryOutPinned(workspaceId: string, flowId: string, state: EFlow, cat: CatalogueSnapshot, message: string, d: EditDecision, author: RevisionAuthor, pin: PatchPin): Promise<EditReply> {
  const flow = await flowRepo.get(workspaceId, flowId);
  const head = flow?.draftRevision ?? 0;
  if (head !== pin.draftRevision) return { ...NOT_ONE_STEP, partial: true } as EditReply;
  if (d.status !== "apply") return carryOut(workspaceId, flowId, state, cat, message, d, author);
  const scope = patchScopeOf(state, d);
  if (!scope) return carryOut(workspaceId, flowId, state, cat, message, d, author);
  const kind = editClassOf(d.action);
  let r = applyEdit(state, cat, d.action, d.value);
  let used = d.value;
  if (!r.ok && d.meant) { const m = applyEdit(state, cat, d.action, d.meant); if (m.ok) { r = m; used = `${d.meant}”, for “${d.value}`; } }
  if (!r.ok && d.action.slot && d.value?.trim()) return { ...NOT_ONE_STEP, partial: true } as EditReply;
  if (!r.ok && d.action.slot) return carryOut(workspaceId, flowId, state, cat, message, { status: "ask_value", action: d.action, why: `“${d.value}” does not fit: ${r.error}` }, author);
  if (!r.ok) return { status: "insufficient_catalogue", lines: [`That change could not be made, so nothing was changed: ${r.error}`] };
  if (kind === "add") {
    const fresh = r.flow.inputs.filter((i) => !state.inputs.some((s) => s.id === i.id)).map((i) => i.id);
    if (fresh.some((id) => !scope.addedInputs.includes(id))) return { ...NOT_ONE_STEP, partial: true } as EditReply;
  } else if (unreadInputs(r.flow, cat).some((id) => !unreadInputs(state, cat).includes(id))) return { ...NOT_ONE_STEP, partial: true } as EditReply;
  const moved = patchLostCheck(state, r.flow, scope);
  if (moved) return { ...NOT_ONE_STEP, partial: true } as EditReply;
  if (errorsOf(checkState(r.flow, cat)).length) return { ...NOT_ONE_STEP, partial: true } as EditReply;
  // Delta-check: an edit that saves without changing what was asked for is a
  // silent no-op — refuse it, never file "applied". The requested columns ride
  // typed on the decision (`editShapeOf`); each must project in the saved flow
  // or the edit did nothing. Structural: projection membership, never meaning.
  const wantCols = editShapeOf(d) ?? [];
  if (wantCols.length) {
    const cols = new Set(r.flow.steps.flatMap((s) => {
      const sql = ("sql" in s && typeof s.sql === "string" ? s.sql : "") ?? "";
      return [...sql.matchAll(/AS\s+"([^"]+)"/gi)].map((m) => m[1]!.toLowerCase());
    }));
    const missing = wantCols.map((c) => c.toLowerCase()).filter((c) => ![...cols].some((h) => h.includes(c) || c.includes(h)));
    if (missing.length) return { status: "insufficient_catalogue", lines: [`That change did not add ${missing.map((m) => `\`${m}\``).join(", ")} to the automation, so nothing was changed. Say which part should carry ${missing.length === 1 ? "it" : "them"}, or open it on the canvas.`] };
  }
  const saved = await saveState(workspaceId, flowId, r.flow, author, "chat");
  const lines = [`Changed: ${described(d.action, used)}`];
  const idle = unreadInputs(r.flow, cat).filter((id) => !unreadInputs(state, cat).includes(id));
  if (idle.length) lines.push(`Note: ${idle.map((id) => `\`${id}\``).join(", ")} ${idle.length === 1 ? "is" : "are"} asked for on every run, and no step reads ${idle.length === 1 ? "it" : "them"} yet.`);
  if (saved.status === "incomplete") lines.push(`It is not finished yet: ${saved.holes} thing${saved.holes === 1 ? "" : "s"} still to decide. Open it on the canvas to finish it.`);
  return { status: "applied", lines, ...(saved.status === "complete" ? { revision: saved.revision } : {}) };
}
export interface PendingEdit {
  kind: "confirm" | "which_step" | "ask_value";
  /** The message the edit was asked in — the value check reads it. */
  message: string;
  key: ActionKey;
  value?: string;
  candidates?: ActionKey[];
}
export interface EditQuestion { id: string; question: string; options?: Array<{ label: string; value: string }>; allow_custom: boolean }

/** What an edit turn files. Every status is one the chat panel already renders. */
export type EditReply =
  | { status: "applied"; lines: string[]; revision?: number }
  | { status: "needs_input"; text: string; question: EditQuestion; pending: PendingEdit }
  | {
      status: "answered"; lines: string[];
      /** Clickable prompts under the answer; sent as the person's next message. */
      suggestions?: Array<{ label: string; value: string }>;
      /** A capabilities answer's structure (D-341): the overview, and the full inventory to fold away. */
      card?: { intro: string; groups: Array<{ title: string; items: string[] }>; inventory: string[]; /** The fold's label; "See everything I can use" when absent. */ more?: string };
    }
  | { status: "insufficient_catalogue"; lines: string[] };

/** The run inputs no step reads — one definition, in `inputs.ts` (the builder's completeness check reads it too). */
export { unreadInputs } from "./inputs.js";

export const CONFIRM = "confirm", CANCEL = "cancel";
const Q = { confirm: "edit_confirm", step: "edit_step", value: "edit_value" } as const;

/** The words of a reply to one question: a chip sends its value, a typed answer may arrive as `<id>: <words>`. */
export function replyTo(reply: string, questionId: string): string {
  const m = reply.trim().match(/^\s*([A-Za-z0-9_]+)\s*:\s*([\s\S]+)$/);
  return m && m[1] === questionId ? m[2]!.trim() : reply.trim();
}

const CONFIRM_LABEL = "Yes, do it", CANCEL_LABEL = "No, leave it";
const NOT_ONE_STEP = { status: "insufficient_catalogue" as const, lines: ["That needs more than one change to the automation, so it is planned again as a whole."] };
const described = (a: CanvasAction, value?: string) => `${a.label} — at ${placeWords(a.where)}${value ? ` (“${value}”)` : ""}`;
const LEGACY = (why: string) => ({ status: "insufficient_catalogue" as const, lines: [`This automation cannot be changed from chat: ${why}`] });

export async function carryOut(workspaceId: string, flowId: string, state: EFlow, cat: CatalogueSnapshot, message: string, d: EditDecision, author: RevisionAuthor): Promise<EditReply> {
  switch (d.status) {
    case "none_fit": {
      // No listed change does it — and the commonest reason is a component that cannot take what was asked (a reader that takes a
      // month, asked for a date range). Said from the components' own declarations, so the person sees the bound, not just "no".
      const { items } = await builderCatalogue(workspaceId, { flowId });
      const takes = readerFacts(state, items), asks = inputFacts(state, items);
      return { status: "insufficient_catalogue", lines: ["I could not match that to a change this automation offers, so nothing was changed.",
        ...(takes.length ? ["What it reads can only be asked for in the ways its readers take:", ...takes.map((l) => `• ${l}`)] : []),
        ...(asks.length ? ["Each run asks for:", ...asks.map((l) => `• ${l}`)] : []),
        ...(takes.length ? ["To ask for something a reader does not take, the workspace needs a reader that takes it."] : []),
        "Open it on the canvas to see every change it allows."] };
    }
    case "which_step":
      return {
        status: "needs_input",
        text: `“${d.action.label}” can be done at more than one step, and your message does not say which.`,
        question: { id: Q.step, question: "Which step do you mean?", options: d.candidates.map((c) => ({ label: placeWords(c.where), value: "stepId" in c.where ? c.where.stepId : placeWords(c.where) })), allow_custom: false },
        pending: { kind: "which_step", message, key: keyOf(d.action), ...(d.value ? { value: d.value } : {}), candidates: d.candidates.map(keyOf) },
      };
    case "ask_value":
      return {
        status: "needs_input",
        text: d.why ? `To ${d.action.label} at ${placeWords(d.action.where)} I need a value — ${d.why}.` : `To ${d.action.label} at ${placeWords(d.action.where)} I need a value.`,
        question: { id: Q.value, question: `What should ${d.action.slot!.what} be?`, allow_custom: true },
        pending: { kind: "ask_value", message, key: keyOf(d.action) },
      };
    case "confirm":
      return {
        status: "needs_input",
        text: `This removes something from the automation: ${described(d.action, d.value)}.`,
        question: { id: Q.confirm, question: "Do it?", options: [{ label: CONFIRM_LABEL, value: CONFIRM }, { label: CANCEL_LABEL, value: CANCEL }], allow_custom: false },
        pending: { kind: "confirm", message, key: keyOf(d.action), ...(d.value ? { value: d.value } : {}) },
      };
    case "apply": {
      let r = applyEdit(state, cat, d.action, d.value);
      let used = d.value;
      if (!r.ok && d.meant) { const m = applyEdit(state, cat, d.action, d.meant); if (m.ok) { r = m; used = `${d.meant}”, for “${d.value}`; } }
      // A typed value `apply` refuses is a question, never a dead end (P3): the person is asked for it, with the reason.
      // builder-behaviour P4 (R8): words the person DID give that the slot cannot take ("2 days ago" for a date) are words the plan
      // understands (a value relative to the run date, an input each run) — the change is planned again whole, never a literal asked for.
      if (!r.ok && d.action.slot && d.value?.trim()) return { ...NOT_ONE_STEP, partial: true } as EditReply;
      if (!r.ok && d.action.slot) return carryOut(workspaceId, flowId, state, cat, message, { status: "ask_value", action: d.action, why: `“${d.value}” does not fit: ${r.error}` }, author);
      if (!r.ok) return { status: "insufficient_catalogue", lines: [`That change could not be made, so nothing was changed: ${r.error}`] };
      // P1-D5 (builder-inputs): a one-step change that leaves a run input nothing reads did not do what was asked — it added the input
      // beside the value it meant to replace ("let me choose the dates each run" declared `dates` and kept the fixed ones). Not saved:
      // the caller re-plans the whole automation with the change (`builderRebuild`), which places the input where it is read.
      if (unreadInputs(r.flow, cat).some((id) => !unreadInputs(state, cat).includes(id))) return { ...NOT_ONE_STEP, partial: true } as EditReply;
      const saved = await saveState(workspaceId, flowId, r.flow, author, "chat");
      const lines = [`Changed: ${described(d.action, used)}`];
      // An input nothing reads is asked for on every run and used by nothing — said, so a change that added one beside the input
      // it meant to change never reads as done (2026-10-01: "start input should be date" added `input` and left the month).
      const idle = unreadInputs(r.flow, cat).filter((id) => !unreadInputs(state, cat).includes(id));
      if (idle.length) lines.push(`Note: ${idle.map((id) => `\`${id}\``).join(", ")} ${idle.length === 1 ? "is" : "are"} asked for on every run, and no step reads ${idle.length === 1 ? "it" : "them"} yet.`);
      if (saved.status === "incomplete") lines.push(`It is not finished yet: ${saved.holes} thing${saved.holes === 1 ? "" : "s"} still to decide. Open it on the canvas to finish it.`);
      return { status: "applied", lines, ...(saved.status === "complete" ? { revision: saved.revision } : {}) };
    }
  }
}
/** A `change` message: choose one listed action, then decide, ask or apply. `calls` counts the model calls made. */
export async function editTurn(workspaceId: string, flowId: string, message: string, author: RevisionAuthor, chooser: Chooser): Promise<EditReply & { calls: number; decision?: EditDecision["status"] }> {
  const { cat } = await builderCatalogue(workspaceId, { flowId });
  const loaded = await loadState(workspaceId, flowId, cat);
  if ("legacy" in loaded) return { ...LEGACY(loaded.legacy), calls: 0 };
  const chosen = await chooseEdit(message, loaded.state, cat, chooser);
  const d: EditDecision = chosen.pick ? decide(message, chosen.pick, chosen.acts, { stepWords: chosen.stepWords, value: chosen.value, ...(chosen.valueMeant ? { valueMeant: chosen.valueMeant } : {}), ...(chosen.shapeColumns.length ? { shapeColumns: chosen.shapeColumns } : {}) }) : { status: "none_fit" };
  // `decision`: what was decided, for the caller — `none_fit` is a change no listed one-step change makes (chat re-plans it).
  const out = await carryOut(workspaceId, flowId, loaded.state, cat, message, d, author);
  // A change one step could not make whole is `none_fit` to the caller, which re-plans it (P1-D5).
  return { ...out, calls: chosen.calls, decision: (out as { partial?: true }).partial ? "none_fit" : d.status };
}

/**
 * A reply as the option it chooses: a typed reply that IS an option's label chooses that option (builder-behaviour P4, E03: "Yes, do
 * it" typed was not "confirm", and the removal was not made). Any other reply is returned as it is.
 */
export function choiceOf(pending: PendingEdit, said: string): string {
  const low = said.trim().toLowerCase();
  if (pending.kind === "confirm") return low === CONFIRM_LABEL.toLowerCase() ? CONFIRM : low === CANCEL_LABEL.toLowerCase() ? CANCEL : said;
  if (pending.kind === "which_step") { const c = pending.candidates?.find((x) => "stepId" in x.where && placeWords(x.where).toLowerCase() === low); return c && "stepId" in c.where ? c.where.stepId : said; }
  return said;
}

/**
 * The reply to an edit's question, or `null` when the reply is not an answer to it (a new message, routed afresh). No model call:
 * the question's options are the answer.
 */
export async function resumeEdit(workspaceId: string, flowId: string, pending: PendingEdit, reply: string, author: RevisionAuthor): Promise<EditReply | null> {
  const qid = pending.kind === "confirm" ? Q.confirm : pending.kind === "which_step" ? Q.step : Q.value;
  const r = choiceOf(pending, replyTo(reply, qid));
  if (pending.kind === "confirm" && r === CANCEL) return { status: "answered", lines: ["Nothing was changed."] };
  if (pending.kind === "confirm" && r !== CONFIRM) return null;
  const chosenStep = pending.kind === "which_step" ? pending.candidates?.find((c) => "stepId" in c.where && c.where.stepId === r) : undefined;
  if (pending.kind === "which_step" && !chosenStep) return null;
  if (pending.kind === "ask_value" && !r) return null;

  const { cat } = await builderCatalogue(workspaceId, { flowId });
  const loaded = await loadState(workspaceId, flowId, cat);
  if ("legacy" in loaded) return LEGACY(loaded.legacy);
  const acts = editable(loaded.state, cat);
  const a = findByKey(acts, chosenStep ?? pending.key);
  if (!a) return { status: "insufficient_catalogue", lines: ["The automation changed since I asked, and that change is no longer one it offers — nothing was done."] };
  const d: EditDecision =
    pending.kind === "confirm" ? { status: "apply", action: a, ...(pending.value ? { value: pending.value } : {}) }
    // The person's own reply IS their words for the value; `apply` still judges whether it fits.
    : pending.kind === "ask_value" ? { status: "apply", action: a, value: r }
    : decide(pending.message, a, acts, { stepNamed: true, ...(pending.value ? { value: pending.value } : {}) });
  return carryOut(workspaceId, flowId, loaded.state, cat, pending.message, d, author);
}

/** The pending edit a `needs_input` turn carries, or null. */
export function pendingOf(findingsJson: unknown): PendingEdit | { kind: "drafted"; key: string; subject?: string; body?: string } | null {
  const raw = Array.isArray(findingsJson) ? findingsJson[0] : null;
  if (typeof raw !== "string") return null;
  try {
    // The question payload carries the typed pending beside the questions (complete-save asks ride the turn, never the store).
    const parsed = JSON.parse(raw) as { pending?: PendingEdit; questions?: Array<{ pending?: { kind: unknown; key: unknown; subject?: unknown; body?: unknown } }> };
    const qp = parsed.questions?.find((qq) => qq && typeof qq === "object" && (qq as { pending?: unknown }).pending)?.pending as { kind: unknown; key: unknown; subject?: unknown; body?: unknown } | undefined;
    if (qp && qp.kind === "drafted" && typeof qp.key === "string") return { kind: "drafted", key: qp.key, ...(typeof qp.subject === "string" ? { subject: qp.subject } : {}), ...(typeof qp.body === "string" ? { body: qp.body } : {}) };
    const p = parsed.pending;
    return p && typeof p === "object" && typeof p.kind === "string" && p.key ? p : null;
  } catch { return null; }
}
