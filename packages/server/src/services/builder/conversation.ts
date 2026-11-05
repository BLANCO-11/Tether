/**
 * The builder as a CONVERSATION (compiled-builder, the chat seam): a goal starts it, each reply answers the ONE pending question, and
 * the flow's working copy (D-319) holds the conversation between turns — the goal's first spec, every answer given, and which question
 * is pending. Chat calls these two functions and nothing else of the builder.
 *
 * A reply replays the build from the stored spec with the answers given so far (`run`'s answerer returns them by hole): the spec is
 * re-checked by code, never re-read by a model, so a later turn cannot re-decide what an earlier one settled. The only model calls a
 * replay can make are the ones an answer itself needs (the unclear words' one re-understanding, a one-slot delivery call).
 *
 * D-294 holds across turns: a question is asked once (its answer is stored, so a replay never asks it again), and an answer that does
 * not fit leaves a stated incomplete, not a re-ask.
 */
import { describeFlow } from "./chat-answers.js";
import { KEEP_AS_IS, CONFIRMS } from "./reply-intents.js";
import { emptyFlow, slugify, type EFlow } from "@foundry/flow-edit";
import { flowRepo } from "../../repositories/flow.repo.js";
import { flowService, type IncompleteView } from "../flow.service.js";
import type { RevisionAuthor } from "../revision-author.js";
import { MAX_CLARIFY_ROUNDS, type BuildQuestion, type Chooser } from "./build.js";
import { LEFT_AS_BUILT, builderCatalogue, currentLines, editStart, existingOf, knownValues, modelChooser, readWriter, recheck, run, save, settledWords, understand, withDrafts, wordsAnchor, type Understood } from "./builder.service.js";
import { EDIT_NOT_ADDITIVE, norm, settledMatch, type GoalSpec } from "./goal-spec.js";
import { S, parseStrict } from "./strict-schema.js";
import { addressed, withReader } from "./plan.js";
import { interpretReplies, type GroupQuestion } from "./reply-intents.js";
import { flowLocalReaders, type LocalReader } from "./local-readers.js";
import { intentIrEnabled, irFromSpec, pinAll, pinSpecByIr } from "./intent-ir.js";
import type { KnownValue } from "./solver.js";
import type { WiringExisting } from "./wiring.js";

export interface BuilderTurn {
  /** `asks`: one question is pending — `question`. The others are terminal for this goal. */
  status: "asks" | "complete" | "incomplete" | "cannot" | "unchanged";
  flowId: string | null;
  /** Written by code from the spec — what the builder understood, for the person to check. */
  readback: string[];
  question?: { holeId: string; ask: string; options?: string[]; onlyOptions?: boolean; pending?: { kind: "drafted"; key: string; subject?: string; body?: string } };
  revision?: number;
  /** What the goal asks for that the flow does not do, each stated. */
  unmet: string[];
  /** Model calls this turn made — counted where they are made, never estimated. */
  calls: number;
  /** What this turn did, in one line, when it is not a build — a discarded build says so. Code-written. */
  said?: string;
  /** Offers, never built: what the person may add if they want it. Code-written. */
  suggestions: string[];
  /** The flow as it stands after this turn, in one or two sentences (`describeFlow`) — what chat leads with. */
  summary?: string;
}

/** What the working copy carries between turns. */
/** `local`: reads written for this goal (`local-readers.ts`) — every turn's catalogue includes them until they are on saved steps. */
/** `corrected`: the goal was re-understood with the person's answers (once) — the spec stored IS that understanding, never redone. */
/** `unsettled`: what the last build left unmet — what a reply to `CLARIFY` is about. */
/** `answers`: append-only across the whole build (contract C1) — keyed by stable question id, never wiped by a round. */
/** `clarifyRounds`: how many clarification rounds this build has entered — the bound (C7) is counted here, persisted with the build. */
/** `deferred`: questions the person put aside (“leave” and friends) — closed for this build, never re-asked (contract C6). */
/** `choices`: saved readers that fit a source equally (`Understood.choices`) — each a one-click question, asked once (`READER`). */
/** `askedParts`: the parts already asked about (`partQuestion`'s key) — append-only; a part still unmet after its answer is STATED, never re-asked. */
/** `built`: the actions the last build placed (tool refs) — an answer that would lose one is not applied (P4-I5). */
/** `pendingGroup`: the whole GROUP of open questions asked as one turn (2026-10-05) — `pending` stays the first of them, and one
 * reply is read against every question in it (`reply-intents.ts`), never one question per turn. */
export interface Conversation { goal: string; texts: string[]; spec: GoalSpec; answers: Record<string, string>; pending: string | null; pendingGroup?: string[]; current?: string[]; known?: KnownValue[]; existing?: WiringExisting; local?: LocalReader[]; corrected?: boolean; replans?: number; unsettled?: string[]; wasUnsettled?: string[]; clarifyRounds?: number; deferred?: string[]; acceptedGaps?: string[]; choices?: Understood["choices"]; askedParts?: string[]; built?: string[]; settled?: string[];
  /** Question id → what it settles (`BuildQuestion.about`); `carried`: decisions by anchor from the automation's last build. */
  abouts?: Record<string, string>; carried?: Record<string, string>;
  /** Strategy B: Intent IR snapshot (pinned decisions) when BUILDER_INTENT_IR is on. */
  intentIr?: import("./intent-ir.js").IntentIR;
}

/**
 * P3: whole-message accept — dispatched on the router's typed `accept` kind,
 * never a regex. Accepting closes ALL open gaps as accepted-with-gaps;
 * "leave / skip / ignore" (KEEP_AS_IS) still defers only the pending question.
 */

/**
 * The question a build that is NOT FINISHED keeps open (2026-10-01): "annual leave refers to a leave type", sent after "Built — not
 * finished … “annual leave” is unclear", was routed as small talk — the conversation had closed, because the goal is re-understood
 * only once per round. That bound is against the MODEL looping on itself; a person's new message is new information, so each one
 * may re-understand the goal again. The build stays a conversation until it is finished or the person moves on.
 */
export const CLARIFY = "clarify:unsettled";

/**
 * P4 (2026-10-02): a question about what is unsettled names ONE part — never a list under "Not settled yet". Only two kinds of gap
 * are the person's to settle, and they are recognised from what the solver states (a whitelist: anything else is the data's limit or
 * the builder's own, and is stated, never asked — P4-I2):
 *  - a part of the goal nothing built does ("the goal also says “X”") — they can say what it should do;
 *  - words whose meaning was not settled ("“X” is unclear") — they can say what they mean.
 * `key` is the part's identity (its words, normalised): one part is asked about once in a build (P4-I1).
 */
export function partQuestion(item: string): { key: string; quote: string; ask: string } | null {
  const said = /^the goal also says “(.+)”, and nothing built here does it$/.exec(item);
  if (said) return { key: `part:said:${norm(said[1]!)}`, quote: said[1]!, ask: `You said “${said[1]}”, and nothing in the automation does that yet. What should it do for it?` };
  const unclear = /^“(.+)” is unclear — what it refers to was not settled$/.exec(item);
  if (unclear) return { key: `part:unclear:${norm(unclear[1]!)}`, quote: unclear[1]!, ask: `What do you mean by “${unclear[1]}”?` };
  // P1 (RC-6): the recipient the DATA cannot address — the one finding here the person CAN settle (give an address), so it
  // asks, once: the key is the goal's own words for them, never the step id (a rebuild's fresh ids must not re-ask), so
  // `askedParts` converges. The builder's own failures and a policy REFUSAL stay statements (the refusal is its port's question).
  const noAddr = /^the goal says who receives `([^`]+)` \(“(.+?)”\), but no row here carries an address for them$/.exec(item);
  if (noAddr) return { key: `part:address:${norm(noAddr[2]!)}`, quote: noAddr[2]!, ask: `There is no address for “${noAddr[2]}” in the data this automation reads — give an email address to send to instead.` };
  return null;
}
const PART = "part:";

/** A choice among readers that fit equally: its identity is the SET of readers, so a re-understanding that offers it again reuses the answer. */
const READER = "reader:";
const readerKey = (c: { ref: string; also: string[] }) => `${READER}${[c.ref, ...c.also].sort().join("|")}`;
const readerLabel = (ref: string, items: { items: Array<{ ref: string; about: string }> }) => {
  const about = items.items.find((i) => i.ref === ref)?.about.replace(/\s+/g, " ").trim();
  const name = ref.slice(ref.indexOf(".") + 1).replace(/_/g, " ");
  return about ? `${name} (${about.length > 90 ? `${about.slice(0, 87)}…` : about})` : name;
};
/** The question for one reader choice, quoting the words it reads for. */
const readerAsk = (conv: Conversation, c?: { ref: string }) => {
  const quote = conv.spec.sources.find((x) => x.ref === c?.ref)?.quote;
  return `${quote ? `For “${quote}”, more` : "More"} than one saved reader gives the rows you need. Which one should the automation read?`;
};
/** The reader a reply picks: by its ref, its label, or its label's words without the trailing note (P4-D3's rule). */
const pickReader = (text: string, refs: string[], items: { items: Array<{ ref: string; about: string }> }): string | undefined => {
  const words = (l: string) => l.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  const t = text.trim();
  return refs.find((r) => r === t || readerLabel(r, items) === t) ?? refs.find((r) => words(readerLabel(r, items)) === words(t) || words(r.slice(r.indexOf(".") + 1).replace(/_/g, " ")) === words(t));
};
/** The conversation with every ANSWERED reader choice applied to its spec (`withReader`): the stored spec always reads the chosen one. */
const withChoices = (conv: Conversation): Conversation => {
  let spec = conv.spec;
  for (const c of conv.choices ?? []) {
    const to = conv.answers[readerKey(c)];
    if (to && to !== c.ref && spec.sources.some((x) => x.ref === c.ref)) spec = withReader(spec, c.ref, to);
  }
  return spec === conv.spec ? conv : { ...conv, spec };
};

/**
 * At the round bound (contract C7) the questions STOP and this is the turn: the open items are stated above it in the same findings,
 * the draft stands as the proposed default, and the person's choice is answered by code — accept keeps it, discard drops it.
 */
export const CLARIFY_BOUND_OFFER =
  "I have asked as much as I can about what is not settled — the draft stands as built with the gaps above. Reply “accept” to keep it as it is (I will not ask again), or “discard” to drop the change.";

/**
 * A stated gap a DEFERRED question owns (contract C6) — deferring closes the question, so its gap is never re-listed as if open:
 * an `unclear:` id carries the person's own words (matched under the one normalisation), an `h_…` port id names its `step.port`.
 * Gaps whose owner cannot be named from the id alone (a spec/cond question) stay listed — the BOUND (C7) caps those, never a loop.
 */
const deferredGap = (item: string, deferred: readonly string[], holes: EFlow["holes"]): boolean => deferred.some((d) => {
  if (d.startsWith("unclear:")) {
    const quote = d.slice("unclear:".length, d.lastIndexOf(":"));
    return !!quote && norm(item).includes(`"${quote}"`);
  }
  const h = holes.find((x) => x.id === d);
  return !!h && h.site.at === "port" && item.includes(`\`${h.site.stepId}.${h.site.port}\``);
});

/** An unclear question's WORDS as its identity: normalised, leading article dropped — the shape a re-derivation paraphrases into. */
const unclearWords = (holeId: string): string =>
  holeId.startsWith("unclear:") ? norm(holeId.slice("unclear:".length, holeId.lastIndexOf(":"))).replace(/^(the|a|an) /, "") : "";

/** One unknown re-quoted: the words equal, or one contains the other ("the relevant body message" / "relevant body message"). */
const sameWords = (a: string, b: string): boolean => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

/**
 * The reply this conversation already holds for a question — its exact id, else its WORDS when exactly ONE stored unclear answer
 * overlaps them. The model re-quotes across re-derivations (it dropped "the" between rounds in the field replay), and an id that
 * misses by one article would hand an answered question back to the person as new — the identity is the unknown, not the phrasing.
 * Ambiguity never guesses: two fitting answers means no match, and the question is asked plainly.
 */
const answerFor = (holeId: string, conv: Conversation, about?: string): string | undefined => {
  const exact = conv.answers[holeId];
  if (exact !== undefined) return exact;
  // MEM (2026-10-06): question ids are re-derived on every re-plan — by position, by step id, by re-normalised quote — so the same
  // question comes back under a new id. Its ANCHOR (`about`, computed by code from what it is about) does not move: the latest answer
  // to any question with the same anchor answers it, else a decision carried from the automation's last build.
  if (about) {
    let last: string | undefined;
    for (const k of Object.keys(conv.answers)) if (conv.abouts?.[k] === about) last = conv.answers[k];
    if (last !== undefined) return last;
    if (conv.carried?.[about] !== undefined) return conv.carried[about];
  }
  const words = unclearWords(holeId);
  if (!words) return undefined;
  const hits = Object.entries(conv.answers).filter(([k]) => k.startsWith("unclear:") && sameWords(unclearWords(k), words));
  return hits.length === 1 ? hits[0]![1] : undefined;
};

/** A question the person deferred — its exact id, else its words (any fit closes it: a defer is the person's intent, never a guess). */
const deferredFor = (holeId: string, deferred: readonly string[]): boolean =>
  deferred.includes(holeId) || (!!unclearWords(holeId) && deferred.some((k) => k.startsWith("unclear:") && sameWords(unclearWords(k), unclearWords(holeId))));
/** P3: a question whose words the person accepted-with-gaps — its unclear words or about-anchor matches an accepted anchor. */
const acceptedFor = (holeId: string, about: string | undefined, accepted: readonly string[]): boolean => {
  if (accepted.includes(holeId)) return true;
  const w = unclearWords(holeId);
  if (w && accepted.some((a) => a === `words:${w}` || sameWords(a.replace(/^words:/, ""), w))) return true;
  if (about && accepted.includes(about)) return true;
  return false;
};

const convOf = (build: unknown): Conversation | null => ((build as { goalSpec?: { conversation?: Conversation } } | undefined)?.goalSpec?.conversation ?? null);
/**
 * S6: the clarifyish fast path, WITHOUT reading the reply — what code decides before the
 * model sees it. A put-aside defers only the pending (C6); anything else is new words
 * for the goal (`continue`). Accept is dispatched on the router's typed `accept`
 * kind at the turn level, never here — this function no longer reads accept
 * phrasings. The caller tries the model read first and falls back here on a null read.
 */
export function clarifyFastPath(pending: string, text: string): "accept" | "defer" | "continue" {
  const t = text.trim();
  if (pending !== CLARIFY && !pending.startsWith(PART)) return "continue";
  if (KEEP_AS_IS.test(t)) return "defer";
  return "continue";
}
/**
 * Whether an edit's new actions repeat one the automation already takes: the same component, sending to the same recipient — the
 * recipient's own words, or "me" as the signed-in person, equal to an address that step already sends to. A second email to someone
 * ELSE, or a different component, is an addition; an action with no recipient is never judged a repeat.
 */
export function repeatsAnAction(spec: GoalSpec, start: EFlow, requester?: string, addressed: (ref: string) => boolean = () => false): boolean {
  const literals = (ref: string) => start.steps.flatMap((x) => (x.kind === "tool" && "ref" in x && x.ref === ref ? x.inputs.flatMap((b) => (b.source?.from === "literal" ? [String(b.source.value).trim().toLowerCase()] : [])) : []));
  return spec.sinks.some((sink) => {
    const there = literals(sink.ref);
    if (!there.length) return false;
    const to = spec.values.filter((v) => v.role === "recipient" && v.fills?.startsWith(`${sink.ref}.`));
    // Unsaid, on a component that sends to an address: the build gives it the address this step already sends to (Z5) — the same.
    if (!to.length) return addressed(sink.ref);
    return to.some((v) => {
      const who = v.from === "requester" ? requester : v.quote;
      return !!who?.trim() && there.includes(who.trim().toLowerCase());
    });
  });
}

/** A goal (or, on a flow that already has steps, an edit) — the first turn. */
/** The chooser, counting its calls. */
const counted = (chooser: Chooser) => { const c = { n: 0, f: ((...a: Parameters<Chooser>) => { c.n++; return chooser(...a); }) as Chooser }; return c; };

export async function builderStart(workspaceId: string, goal: string, author: RevisionAuthor, flowId: string | null = null, model: Chooser = modelChooser, opts: { rebuild?: boolean; removed?: string[]; local?: LocalReader[]; pinFrom?: GoalSpec } = {}): Promise<BuilderTurn> {
  const c = counted(model), chooser = c.f;
  // T13: a rebuild seeds written reads from the flow (and any caller-supplied locals) so Intent IR can pin them — clearing the
  // incomplete after complete used to leave the catalogue without the reader the prior revision already had.
  const seeded = opts.local?.length ? opts.local : flowId && opts.rebuild ? await flowLocalReaders(workspaceId, flowId) : [];
  // The first turn may WRITE a read (the catalogue offers "a new read of <datasource>"); later turns only use what was written.
  const { items, cat } = await builderCatalogue(workspaceId, { flowId, local: seeded, newReads: true });
  const { start } = flowId ? await editStart(workspaceId, flowId, cat) : { start: null };
  // `rebuild`: the goal is the WHOLE automation as it should be — planned from nothing and saved as the next revision of this flow,
  // so it is not an edit (no current steps to keep), and only the values the person gave before carry over.
  const current = start && !opts.rebuild ? currentLines(start, cat) : undefined;
  // Z5: what the person already gave, on the automation's steps — reusable in this change, never asked again. In a rebuild those
  // steps are the previous revision's, not this build's (its new steps may reuse their ids), so each value is marked as from before.
  const known = start ? knownValues(start).map((k) => (opts.rebuild ? { ...k, stepId: `before:${k.stepId}` } : k)) : [];
  // Z6: what the change can reach — the automation's own lists, prepared text and condition paths.
  const existing = start && !opts.rebuild ? existingOf(start, cat) : undefined;
  // P7: what the automation's last revision implemented is settled for this change (edit or rebuild) — never asked again.
  const prevGoalSpec = start && flowId ? await (async () => { const f = await flowRepo.get(workspaceId, flowId); const rev = f && f.draftRevision > 0 ? await flowRepo.getRevision(f.id, f.draftRevision) : undefined; return rev?.goalSpec; })() : undefined;
  const settled = settledWords(prevGoalSpec);
  const settledSpec = (prevGoalSpec as { spec?: GoalSpec } | null | undefined)?.spec ?? opts.pinFrom;
  const u0 = await understand(goal, items, chooser, undefined, current, known, existing, readWriter(workspaceId), settled);
  // T13 / Phase 1: a rebuild is a correction against the head revision's settled structure — pin untouched sources/sinks etc.
  const pinSpec = opts.rebuild && intentIrEnabled() && settledSpec ? pinSpecByIr(settledSpec, u0.checked.spec, goal).spec : u0.checked.spec;
  const mergedLocal = [...seeded, ...(u0.local ?? []).filter((l) => !seeded.some((s) => s.ref === l.ref))];
  const u: Understood = JSON.stringify(pinSpec) !== JSON.stringify(u0.checked.spec)
    ? { ...recheck({ goal: u0.goal, texts: u0.texts, spec: pinSpec, corrected: true, ...(u0.known ? { known: u0.known } : {}), ...(u0.existing ? { existing: u0.existing } : {}) }, items), ...(mergedLocal.length ? { local: mergedLocal } : {}), calls: u0.calls, ...(u0.choices?.length ? { choices: u0.choices } : {}) }
    : { ...u0, ...(mergedLocal.length && !u0.local?.length ? { local: mergedLocal } : {}) };
  // An "addition" that is the SAME action the automation already takes, to the same recipient, is a change to that step (issue 1,
  // 2026-10-03: "attach the list as a CSV to the email" added a second email carrying the attachment). It is not additive, so it is
  // refused as such — and chat re-plans it whole (`builderRebuild`), which changes the one step instead of adding another.
  const requester = /@/.test(author.createdBy) ? author.createdBy : undefined;
  if (start && !opts.rebuild && repeatsAnAction(u.checked.spec, start, requester, (ref) => addressed(items, ref))) {
    return { status: "cannot", flowId, readback: [], unmet: [`Missing: ${EDIT_NOT_ADDITIVE}`], suggestions: [], calls: c.n };
  }
  // builder-behaviour P7 (E01): a change planned again WHOLE keeps every action the automation has, unless the change's own words
  // name it — a restatement that left one out ("only the ones opened more than 2 days ago" lost the chat post) is not applied, and the
  // person is told what it would have removed. Removing what they named ("stop emailing me") goes ahead.
  if (start && opts.rebuild && opts.removed) {
    const lost = lostActions(start, u.checked.spec, settledSpec, opts.removed);
    if (lost.length) return { status: "cannot", flowId, readback: [], unmet: lost.map((q) => `That change would also remove “${q}”, which it does not mention — nothing was changed. Say the change again, or say that this goes too.`), suggestions: [], calls: c.n };
  }
  const carried = (prevGoalSpec as { decisions?: Record<string, string> } | null | undefined)?.decisions;
  const conv: Conversation = { goal: u.goal, texts: u.texts, spec: u.checked.spec, answers: {}, ...(carried && Object.keys(carried).length ? { carried } : {}), pending: null, ...(current ? { current } : {}), ...(known.length ? { known } : {}), ...(existing ? { existing } : {}), ...(mergedLocal.length ? { local: mergedLocal } : {}), ...(u.choices?.length ? { choices: u.choices } : {}) };
  if (intentIrEnabled()) conv.intentIr = pinAll(irFromSpec(u.goal, u.checked.spec));
  const t = await step(workspaceId, conv, author, flowId, chooser);
  return { ...t, calls: c.n };
}

/**
 * The open group's questions as the reply reader needs them, read from the stored trace; `null` when any id is not there — a
 * CLARIFY/PART/reader pending or an edit-held one, which are not trace questions and keep their own reply paths.
 */
function groupQuestionsOf(build: { goalSpec: unknown; trace: unknown } | undefined, ids: string[]): GroupQuestion[] | null {
  const trace = build?.trace;
  if (!trace || typeof trace !== "object" || !("questions" in trace)) return null;
  const list: unknown = trace.questions;
  if (!Array.isArray(list)) return null;
  const found = new Map<string, GroupQuestion>();
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null || !("holeId" in raw) || !("ask" in raw)) continue;
    const holeId: unknown = raw.holeId, ask: unknown = raw.ask;
    if (typeof holeId !== "string" || typeof ask !== "string") continue;
    const q: GroupQuestion = { holeId, ask };
    if ("options" in raw && Array.isArray(raw.options)) {
      const opts = raw.options.filter((x: unknown): x is string => typeof x === "string");
      if (opts.length) q.options = opts;
    }
    if ("onlyOptions" in raw && raw.onlyOptions === true) q.onlyOptions = true;
    found.set(holeId, q);
  }
  const out: GroupQuestion[] = [];
  for (const id of ids) { const q = found.get(id); if (!q) return null; out.push(q); }
  return out;
}

/**
 * A defer (contract C6): the question closes FOR THIS BUILD — an `unclear`/`assumed` one lets the round continue with the other
 * answers, anything else keeps the draft as it stands and states its gaps on the way out (P7). No model call decides this branch.
 */
async function deferTurn(workspaceId: string, flowId: string, view: IncompleteView, conv: Conversation, deferred: string[], author: RevisionAuthor, chooser: Chooser): Promise<Omit<BuilderTurn, "calls">> {
  const next: Conversation = { ...conv, pending: null, pendingGroup: undefined, deferred };
  if (conv.pending && /^(unclear|assumed):/.test(conv.pending)) return step(workspaceId, next, author, flowId, chooser);
  const stored = view.build;
  if (!stored) return { status: "incomplete", flowId, readback: [], unmet: conv.unsettled ?? [], suggestions: [] };
  const gs = stored.goalSpec && typeof stored.goalSpec === "object" ? stored.goalSpec : {};
  await flowService.saveIncomplete(workspaceId, flowId, view.model, { ...stored, goalSpec: { ...gs, conversation: next } });
  // P7: what the build still leaves undone is stated on the way out — "leave it" settles a question, never the build's gaps.
  const trace = stored.trace;
  const left = trace && typeof trace === "object" && "unmet" in trace && Array.isArray(trace.unmet) ? trace.unmet.filter((x: unknown): x is string => typeof x === "string") : [];
  return { status: "incomplete", flowId, readback: [], unmet: [...new Set([...(conv.unsettled ?? []), ...left])], suggestions: [] };
}
/**
 * P3: accept-with-gaps — close ALL currently-open gaps as accepted-with-gaps (words-anchors, pinned like settled).
 * Open = the pending group ids + unsettled part words. Later re-plans matching an accepted anchor stay closed;
 * NEW words still ask. `cannot` outcomes never reach here (no gaps to accept, only refusal).
 */
export function acceptGaps(conv: Conversation): { accepted: string[]; stillOpen: string[] } {
  const open: string[] = [...(conv.pendingGroup?.length ? conv.pendingGroup : conv.pending ? [conv.pending] : []), ...(conv.unsettled ?? [])];
  const accepted: string[] = [];
  for (const id of open) {
    const anchor = id.startsWith("unclear:") ? `words:${unclearWords(id)}` : id.startsWith("part:") ? `words:${norm(id.slice(id.lastIndexOf(":") + 1)).replace(/^(the|a|an) /, "")}` : id;
    if (anchor && !accepted.includes(anchor)) accepted.push(anchor);
  }
  return { accepted, stillOpen: [] };
}

/** The person's reply to the pending question (or to the whole GROUP of them — read at once, `reply-intents.ts`). */
export async function builderAnswer(workspaceId: string, flowId: string, text: string, author: RevisionAuthor, model: Chooser = modelChooser, opts: { kind?: string } = {}): Promise<BuilderTurn> {
  const c = counted(model), chooser = c.f;
  const view = await flowService.getIncomplete(workspaceId, flowId);
  const conv = convOf(view?.build);
  if (opts.kind === "discard") return { ...(await discardBuild(workspaceId, flowId)), calls: c.n };
  if (!conv?.pending) throw Object.assign(new Error("this automation has no question waiting for an answer"), { statusCode: 409 });
  if (view!.stale) throw Object.assign(new Error("a revision was written after this conversation's last turn; start again from the current draft"), { statusCode: 409 });
  // A reader choice: the reply picks one (or "leave it" keeps the one chosen) and the stored spec is renamed to it — no model call,
  // nothing else touched (an answer edits only its part, P4-I5). A reply that names none of them is not guessed: asked again plainly.
  if (conv.pending.startsWith(READER)) {
    const ch = (conv.choices ?? []).find((x) => readerKey(x) === conv.pending);
    const refs = ch ? [ch.ref, ...ch.also] : [];
    const { items } = await builderCatalogue(workspaceId, { flowId });
    const picked = KEEP_AS_IS.test(text.trim()) ? refs[0] : pickReader(text, refs, items);
    // RCH (2026-10-06): a reply that names none of the options is what the person MEANS by the rows, not a wrong answer — it was asked
    // back unboundedly ("That is not one of the options", ten times) and nothing they said was kept. The choice closes for this build
    // (the plan's own reader stands) and the goal is re-planned with the reply as the meaning of the words the readers were offered for.
    if (!picked && ch && text.trim()) {
      const quote = conv.spec.sources.find((x) => x.ref === ch.ref)?.quote;
      const t = await continueBuild(workspaceId, flowId, { ...conv, pending: null, deferred: [...new Set([...(conv.deferred ?? []), conv.pending])] }, text, author, chooser, [`“${quote ?? "the rows it reads"}” means: ${text.trim()}`]);
      return { ...t, calls: c.n };
    }
    if (!picked) {
      // The same choice, shown again with what went wrong — nothing is rebuilt and nothing is stored.
      return { status: "asks", flowId, readback: [], said: "That is not one of the options — pick one of them, or say “leave it” to keep the first.", question: { holeId: conv.pending, ask: readerAsk(conv, ch), options: refs.map((r) => readerLabel(r, items)), onlyOptions: true }, unmet: conv.unsettled ?? [], suggestions: [], calls: c.n };
    }
    const t = await step(workspaceId, withChoices({ ...conv, answers: { ...conv.answers, [conv.pending]: picked }, pending: null }), author, flowId, chooser);
    return { ...t, calls: c.n };
  }
  // (typed `discard` is handled at entry, above — destruction is never the model's to read).
  // S4 drafted defaults (2026-10-08): a confirm over goal-drafted wording — "yes" keeps the drafts and
  // replays; anything else falls back to the open ask with the drafts unbound. No model call.
  if (conv.pending.startsWith("drafted:")) {
    if (CONFIRMS.test(text.trim())) {
      const t = await step(workspaceId, { ...conv, answers: { ...conv.answers, [conv.pending]: "yes" }, pending: null, pendingGroup: undefined }, author, flowId, chooser);
      return { ...t, calls: c.n };
    }
    // Reject: the drafts are declined — defer the confirm and replay so the ports ask openly.
    const t = await step(workspaceId, { ...conv, answers: { ...conv.answers, [conv.pending]: text.trim() }, pending: null, pendingGroup: undefined }, author, flowId, chooser);
    return { ...t, calls: c.n };
  }
  // S6: model-first on clarifyish pendings — the group read runs BEFORE the fast
  // path; the fast path (`clarifyFastPath`) is the fallback on a null/empty read.
  // (typed `discard` is handled at entry, above — destruction is never the model's to read.)
  // Non-clarifyish pendings skip this block: the general group-read below handles them.
  const clarifyish = conv.pending === CLARIFY || conv.pending.startsWith(PART);
  if (clarifyish) {
    const ids = conv.pendingGroup?.length ? conv.pendingGroup : [conv.pending];
    const questions = groupQuestionsOf(view?.build, ids);
    const routed = questions ? await interpretReplies({ goal: conv.goal, answers: conv.answers, questions, reply: text.trim() }, chooser) : null;
    if (routed?.newInstruction) {
      const t = await continueBuild(workspaceId, flowId, conv, text, author, chooser);
      return { ...t, calls: c.n };
    }
    if (routed && (Object.keys(routed.answers).length || routed.deferred.length)) {
      const deferred = [...new Set([...(conv.deferred ?? []), ...routed.deferred])];
      const answeredIds = new Set([...Object.keys(routed.answers), ...routed.deferred]);
      const still = ids.filter((id) => !answeredIds.has(id));
      const next: Conversation = { ...conv, answers: { ...conv.answers, ...routed.answers }, deferred, pending: still[0] ?? null, ...(still.length > 1 ? { pendingGroup: still } : { pendingGroup: undefined }) };
      if (Object.keys(routed.answers).length || still.length || routed.deferred.some((id) => /^(unclear|assumed):/.test(id))) {
        const t = await step(workspaceId, next, author, flowId, chooser);
        return { ...t, calls: c.n };
      }
      return { ...(await deferTurn(workspaceId, flowId, view!, next, deferred, author, chooser)), calls: c.n };
    }
    // Null/empty read — today's deterministic rules, unchanged, reached second instead of first.
    const fast = clarifyFastPath(conv.pending, text);
    if (fast === "accept") {
      const { accepted } = acceptGaps(conv);
      const next: Conversation = { ...conv, pending: null, pendingGroup: undefined, acceptedGaps: [...new Set([...(conv.acceptedGaps ?? []), ...accepted])] };
      const irMod = await import("./intent-ir.js");
      if (irMod.intentIrEnabled()) {
        const base = conv.intentIr ?? irMod.irFromSpec(conv.goal, conv.spec, { pinAll: true, acceptedGaps: conv.acceptedGaps });
        next.intentIr = irMod.acceptGaps(base, accepted);
        next.spec = irMod.specFromIr(next.intentIr);
      }
      return { ...(await deferTurn(workspaceId, flowId, view!, next, [...new Set([...(next.deferred ?? []), conv.pending])], author, chooser)), calls: c.n };
    }
    if (fast === "defer") return { ...(await deferTurn(workspaceId, flowId, view!, conv, [...new Set([...(conv.deferred ?? []), conv.pending])], author, chooser)), calls: c.n };
    const t = await continueBuild(workspaceId, flowId, conv, text, author, chooser);
    return { ...t, calls: c.n };
  }
  // Non-clarifyish pending: ONE structured read of the reply against the WHOLE open group.
  const ids = conv.pendingGroup?.length ? conv.pendingGroup : [conv.pending];
  const questions = groupQuestionsOf(view?.build, ids);
  const routed = questions ? await interpretReplies({ goal: conv.goal, answers: conv.answers, questions, reply: text.trim() }, chooser) : null;
  if (routed?.newInstruction) {
    // The reply is a NEW message, not an answer: the build continues with it, like any other addition.
    const t = await continueBuild(workspaceId, flowId, conv, text, author, chooser);
    return { ...t, calls: c.n };
  }
  if (routed) {
    const deferred = [...new Set([...(conv.deferred ?? []), ...routed.deferred])];
    const answeredIds = new Set([...Object.keys(routed.answers), ...routed.deferred]);
    const still = ids.filter((id) => !answeredIds.has(id));
    const next: Conversation = { ...conv, answers: { ...conv.answers, ...routed.answers }, deferred, pending: still[0] ?? null, ...(still.length > 1 ? { pendingGroup: still } : { pendingGroup: undefined }) };
    // Replay when anything was answered, anything is still open, or an unknown was deferred (the round goes on — the same split
    // the single-question paths made). Only a defer of value questions with nothing left open ends here: the draft stands, gaps stated.
    if (Object.keys(routed.answers).length || still.length || routed.deferred.some((id) => /^(unclear|assumed):/.test(id))) {
      const t = await step(workspaceId, next, author, flowId, chooser);
      return { ...t, calls: c.n };
    }
    return { ...(await deferTurn(workspaceId, flowId, view!, next, deferred, author, chooser)), calls: c.n };
  }
  // S3 validate-then-capture (2026-10-08) fallback — before capturing as typed: the reply is validated
  // against the pending hole's own type (`literalFits` via `replyFitsHole`). A miss is re-routed as a new
  // intent with the question left open (the build continues with it); a fit captures exactly as today.
  // Fallback — today's rules, unchanged: the defer closes the pending question; anything else is the answer as typed.
  if (KEEP_AS_IS.test(text.trim())) return { ...(await deferTurn(workspaceId, flowId, view!, conv, [...new Set([...(conv.deferred ?? []), conv.pending])], author, chooser)), calls: c.n };
  {
    const { holeForPending: holeFor, replyFitsHole: fits } = await import("./chat-route.js");
    const { builderCatalogue: catalogueOf } = await import("./builder.service.js");
    const { cat } = await catalogueOf(workspaceId, { flowId });
    const model = view?.model as { holes?: Array<{ id: string }> } | undefined;
    const hole = model?.holes ? holeFor({ holes: model.holes as never }, conv.pending) : null;
    const miss = hole && (hole.ty === null || hole.ty === undefined ? null : fits(text.trim(), hole, cat));
    if (miss) {
      const t = await continueBuild(workspaceId, flowId, conv, text, author, chooser);
      return { ...t, calls: c.n };
    }
  }
  const t = await step(workspaceId, { ...conv, answers: { ...conv.answers, [conv.pending]: text.trim() } }, author, flowId, chooser);
  return { ...t, calls: c.n };
}

/** Shown first when a rebuild actually ran — previous answers / incomplete context are gone. */
export const REPLAN_DONE =
  "Replanned the workflow from that change. Earlier answers and in-progress context for this build are cleared.";
/**
 * The person's new words, on a build that is not finished: the goal is understood AGAIN with them — about what is unsettled when
 * something is, else as an addition ("convert the output into a csv and send me over email") — a read written if they need one, and
 * a fresh round of questions from that understanding. One re-understanding per message the person sends: never a model loop.
 *
 * ⚠ The replan GATE is DELETED (2026-10-10, the person's call): a change to an unfinished build used to be HELD — "that needs a
 * full rebuild, reply go ahead or turn on Enable replan" — and its "go ahead" looped when nothing was waiting. It is applied now.
 * The gate was added for the 2026-10-07 needs_input → part-question cycle; each re-understanding is still one per message sent
 * and its questions are still asked once per part (`askedParts`), which is what bounds that cycle.
 */
async function continueBuild(workspaceId: string, flowId: string, conv: Conversation, text: string, author: RevisionAuthor, chooser: Chooser, defs0?: string[], opts: { shapeOnly?: boolean } = {}): Promise<Omit<BuilderTurn, "calls">> {
  let defs = defs0;
  // MEM5 (2026-10-06): an answer to a PART question ("What do you mean by “X”?", "You said “X” … what should it do for it?") is what
  // those words MEAN — kept as their meaning beside the goal, never restated into it as a new sentence the person is then asked about.
  if (!defs && /^part:(said|unclear):/.test(conv.pending ?? "")) {
    const pq = partQuestion(conv.unsettled?.[0] ?? "");
    if (pq) defs = [`“${pq.quote}” means: ${text.trim()}`];
  }
  const clarifying = !!conv.unsettled?.length;
  // The gate fires only when a question is actually open (pending): without one there is nothing the reply clarifies,
  // so it is not a refusal of an answer — it falls through to the rebuild offer path via dispatch.
  const answerable = !!conv.pending;
  // Middle gear: column/output reshape on a written read — revise projection, never a whole-goal replan. Typed: the turn level routes `shape` and passes it via opts; never mined from the message here.
  const shapeOnly = !clarifying && !defs && !!opts.shapeOnly && (conv.local?.length ?? 0) > 0;
  if (shapeOnly) console.info("[builder] continueBuild why=shape_only");
  else console.info("[builder] continueBuild why=%s clarifying=%s", answerable ? "answer" : "change", clarifying);
  // A CLARIFICATION used to strip written reads from the catalogue (`rewriteReads` + `local=[]`) so the proposer rewrote them
  // from every word said (2026-10-01). Under Intent IR (Phase 1 / T13) that is collateral: settled readers must stay unless the
  // answer touches them — clearing locals before `pinSpecByIr` made "accumulated" drop `banded_absences` and invent a table.
  // Flag off: keep the old rewrite path so pre-IR behaviour is unchanged.
  const rewrite = clarifying && !conv.current && !intentIrEnabled();
  const prior = conv.local ?? [];
  const local = rewrite ? [] : prior;
  const part = conv.pending?.startsWith(PART) ? partQuestion(conv.unsettled?.[0] ?? "") : null;
  const said = defs ? defs.join("; ") : part ? `About “${part.quote}”: ${text.trim()}` : clarifying ? `About what is not settled yet (${conv.unsettled!.join("; ")}): ${text.trim()}` : `The person adds: ${text.trim()}`;
  // the reply is APPLIED to the goal — one call restates the whole goal as it now stands (what the reply
  // replaces is left out, what it adds is in) — and that goal is planned on its own. Appending the reply kept every clause of the
  // original, so "instead of managers, make it department" left "a list of managers" to build for ever.
  // (Restated in `understand`, for EVERY reply that re-plans — this path and the answers `run` hands to `correct`.)
  const restated: string | null = null;
  const goal = restated ?? (clarifying || defs ? conv.goal : `${conv.goal}\n${text.trim()}`);
  const texts = restated ? [restated] : clarifying || defs ? conv.texts : [goal, ...conv.texts.slice(1)];
  const { items } = await builderCatalogue(workspaceId, { flowId, local, newReads: true, rewriteReads: rewrite });
  const previous: Understood = { ...recheck({ goal, texts, spec: conv.spec, ...(conv.known ? { known: conv.known } : {}), ...(conv.existing ? { existing: conv.existing } : {}) }, items), ...(conv.current ? { current: conv.current } : {}), ...(prior.length ? { local: prior } : {}) };
  const again = await understand(goal, items, chooser, { previous, text: said, ...(defs ? { defs } : {}), ...(restated ? { words: [] } : clarifying ? { words: [text.trim()] } : { words: [] }) }, undefined, undefined, undefined, readWriter(workspaceId));
  // Answers are APPEND-ONLY across the whole build (contract C1): a re-understanding carries every answer given so far, and a
  // clarifying reply is itself stored under the CLARIFY key — a round can add state, never wipe it. `clarifyRounds` counts the
  // rounds entered (contract C7's bound is counted here, persisted with the build; restarts cannot lose it — contract C9).
  const fresh: Conversation = { goal: again.goal, texts: again.texts, spec: again.checked.spec, answers: { ...conv.answers, ...(clarifying ? { [CLARIFY]: text.trim() } : {}), ...(conv.pending?.startsWith(PART) ? { [conv.pending]: text.trim() } : {}) }, ...(conv.abouts ? { abouts: conv.abouts } : {}), ...(conv.carried ? { carried: conv.carried } : {}), pending: null, clarifyRounds: (conv.clarifyRounds ?? 0) + (clarifying ? 1 : 0), ...(conv.deferred?.length ? { deferred: conv.deferred } : {}), ...(conv.current ? { current: conv.current } : {}), ...(conv.known ? { known: conv.known } : {}), ...(conv.existing ? { existing: conv.existing } : {}), ...(again.local?.length ? { local: again.local } : {}), ...(clarifying ? { wasUnsettled: conv.unsettled } : {}), ...(again.choices?.length ? { choices: again.choices } : {}), ...(conv.askedParts?.length ? { askedParts: conv.askedParts } : {}), ...(conv.built ? { built: conv.built } : {}) };
  // A reader the person already chose stays chosen through the re-understanding (asked once, P4-I1).
  // The build as it was is the FALLBACK: an answer that would lose an action already placed is not applied (P4-I5).
  return step(workspaceId, withChoices(fresh), author, flowId, chooser, { continuation: true, ...(clarifying ? { fallback: { ...conv, pending: null } } : {}) });
}

/** "revert", "undo", "cancel", "discard" — dispatched on the router's typed `discard` kind at the turn level, never a regex. The unfinished build is dropped; the automation is its last saved version again. */
export async function discardBuild(workspaceId: string, flowId: string): Promise<Omit<BuilderTurn, "calls">> {
  await flowService.clearIncomplete(workspaceId, flowId);
  const saved = (await flowRepo.get(workspaceId, flowId))?.draftRevision ?? 0;
  return { status: "unchanged", flowId, readback: [], said: saved > 0 ? "The unfinished change is discarded — the automation is back to its last saved version." : "The unfinished build is discarded — nothing was saved.", unmet: [], suggestions: [] };
}

/**
 * A message that builds or changes, on a flow whose build is NOT FINISHED and asks nothing (2026-10-01: "convert the output into a csv
 * and send me over email" was refused twice — "answer its open questions first", with none open). It continues that build; `null`
 * when the flow has no unfinished build to continue (the caller starts or edits as before).
 */
export async function builderContinue(workspaceId: string, flowId: string, text: string, author: RevisionAuthor, model: Chooser = modelChooser, opts: { kind?: string; shapeOnly?: boolean } = {}): Promise<BuilderTurn | null> {
  const view = await flowService.getIncomplete(workspaceId, flowId);
  const conv = convOf(view?.build);
  if (!conv || view!.stale) return null;
  const c = counted(model);
  if (opts.kind === "discard") return { ...(await discardBuild(workspaceId, flowId)), calls: 0 };
  const t = await continueBuild(workspaceId, flowId, conv, text, author, c.f, undefined, { ...(opts.shapeOnly ? { shapeOnly: true } : {}) });
  return { ...t, calls: c.n };
}

/**
 * A change to what the automation already HAS, that neither the one-step editor nor the additive plan can make (2026-10-03): "post it
 * to a chat channel instead", "list the leave applications instead", "attach the list as a CSV to the email", "change the subject".
 * The editor offers only listed one-step changes and answered "nothing fits"; the plan adds and refuses a change to an existing step.
 * Both were right about their own reach, and the person was left with no way to make the change.
 *
 * So the goal is RESTATED with the change applied (one small call: the person's words, the change folded in, nothing added) and the
 * whole automation is planned again from it, as the next revision of THIS flow (`builderStart`'s `rebuild`): same flow, same history,
 * the usual "what changed" diff, and the values the person gave before carried over, never asked again.
 *
 * Measured before it was built (2026-10-03, HR + Customer Support, 3 runs each): swapping the action or the reader, attaching the
 * rows, changing the subject went from 0 of 36 correct to 33 of 36 — the same flow every time, nothing re-asked, every draft run SUCCESS.
 *
 * S2 patch-first (2026-10-08): before the whole rebuild, a single-step fix is tried as a patch via `carryOut`
 * with a draftRevision + structure stamp pin; cascade walks downstream within the cap, shape change escalates
 * to rebuild, and the lost check diffs touched steps only.
 */
export async function builderRebuild(workspaceId: string, flowId: string, change: string, author: RevisionAuthor, model: Chooser = modelChooser): Promise<BuilderTurn> {
  const c = counted(model);
  const flow = await flowRepo.get(workspaceId, flowId);
  const head = flow?.draftRevision ?? 0;
  // The person's own words for the automation: the goal of the newest revision the builder wrote. A revision written since (the
  // editor, the canvas) changed it without words, so what it does NOW is stated beside the goal, by code.
  let goal: string | undefined;
  let at = head;
  for (; at > 0 && head - at < 50; at--) {
    const g = ((await flowRepo.getRevision(flowId, at))?.goalSpec as { goal?: string } | null | undefined)?.goal;
    if (g?.trim()) { goal = g.trim(); break; }
  }
  let now: string | undefined;
  // P7 (E01): the automation's ACTIONS, each by the person's words for it (the head revision's spec) — what the restatement may say
  // it removes, from this closed list.
  const { items: its, cat: cat0 } = await builderCatalogue(workspaceId, { flowId });
  const { start: s0 } = await editStart(workspaceId, flowId, cat0);
  if ((!goal || at !== head) && s0) now = describeFlow(s0, its, cat0);
  const headRev = head > 0 ? await flowRepo.getRevision(flowId, head) : undefined;
  const headSpec = (headRev?.goalSpec as { spec?: GoalSpec } | null | undefined)?.spec;
  const acts = s0 ? actionsOf(s0, headSpec) : [];
  // S2 patch-first (2026-10-08): a single-step fix patches in place via `carryOut` with a draftRevision +
  // structure-stamp pin; untouched steps stay byte-identical by the scoped lost check. Anything the patch
  // cannot carry (no listed action fits, pin stale, shape change, out-of-scope movement) falls through to
  // the whole rebuild below — the existing lost-actions guard applies there, unchanged.
  if (s0) {
    const { builderCatalogue: catalogueOf } = await import("./builder.service.js");
    const { loadState } = await import("./canvas.service.js");
    const { chooseEdit, decide: decideEdit } = await import("./chat-edit.js");
    const { carryOutPinned, patchStampOf } = await import("./chat-edit.service.js");
    const { cat } = await catalogueOf(workspaceId, { flowId });
    const loaded = await loadState(workspaceId, flowId, cat);
    if (!("legacy" in loaded)) {
      const pin = { draftRevision: head, structureHash: patchStampOf(loaded.state) };
      const chosen = await chooseEdit(change, loaded.state, cat, c.f);
      if (chosen.pick) {
        const d = decideEdit(change, chosen.pick, chosen.acts, { stepWords: chosen.stepWords, value: chosen.value, ...(chosen.valueMeant ? { valueMeant: chosen.valueMeant } : {}), ...(chosen.shapeColumns.length ? { shapeColumns: chosen.shapeColumns } : {}) });
        if (d.status === "apply") {
          const out = await carryOutPinned(workspaceId, flowId, loaded.state, cat, change, d, author, pin);
          const decision = (out as { partial?: true }).partial ? "none_fit" : d.status;
          if (out.status === "applied" && decision === "apply") {
            const lines = "lines" in out ? out.lines : [];
            return { status: "complete", flowId, readback: lines, unmet: [], suggestions: [], ...(out.revision !== undefined ? { revision: out.revision } : {}), calls: chosen.calls + c.n };
          }
        }
      }
    }
  }
  // T13: seed written readers + pin against the head revision's spec so a post-complete meaning change cannot drop them.
  const locals = await flowLocalReaders(workspaceId, flowId);
  // Root cause (post-complete edits): `restateGoal` + cold `builderStart` planned from nothing, dropped how the head
  // revision already covered the goal, then asked part-questions about clauses the written read already implemented.
  // Pin against the head revision's spec whenever we have it — locals help but must not be required (measured 2026-10-07:
  // empty locals took edit:restate and wiped a revision that already carried sqlSpec readers).
  // Shape-only still skips makePlan inside `understand` for latency; everything else re-plans as a correction with pin.
  if (goal && headSpec) {
    console.info("[builder] rebuild why=opt_in pin=headSpec locals=%d", locals.length);
    const { items } = await builderCatalogue(workspaceId, { flowId, local: locals, newReads: true });
    const known = s0 ? knownValues(s0).map((k) => ({ ...k, stepId: `before:${k.stepId}` })) : [];
    const settled = settledWords(headRev?.goalSpec);
    const previous: Understood = {
      ...recheck({ goal, texts: [goal], spec: headSpec, ...(known.length ? { known } : {}) }, items),
      ...(locals.length ? { local: locals } : {}),
      ...(settled.length ? { settled } : {}),
    };
    const again = await understand(goal, items, c.f, { previous, text: change, words: [change] }, undefined, known, undefined, readWriter(workspaceId), settled);
    const carried = (headRev?.goalSpec as { decisions?: Record<string, string> } | null | undefined)?.decisions;
    const conv: Conversation = {
      goal: again.goal, texts: again.texts, spec: again.checked.spec, answers: {},
      ...(carried && Object.keys(carried).length ? { carried } : {}),
      pending: null, corrected: true,
      ...(known.length ? { known } : {}),
      ...(again.local?.length ? { local: again.local } : locals.length ? { local: locals } : {}),
      ...(again.choices?.length ? { choices: again.choices } : {}),
    };
    if (intentIrEnabled()) conv.intentIr = pinAll(irFromSpec(again.goal, again.checked.spec));
    // Same guard as builderStart rebuild: a restatement that would drop an unnamed action is refused, not applied.
    if (s0 && acts.length) {
      const lost = lostActions(s0, again.checked.spec, headSpec, []);
      if (lost.length) {
        return { status: "cannot", flowId, readback: again.readback, unmet: lost.map((q) => `That change would also remove “${q}”, which it does not mention — nothing was changed. Say the change again, or say that this goes too.`), suggestions: [], calls: again.calls + c.n };
      }
    }
    const t = await step(workspaceId, conv, author, flowId, c.f);
    return { ...t, calls: again.calls + c.n };
  }
  console.info("[builder] rebuild why=opt_in pin=none (edit:restate fallback)");
  const r = await restateGoal(goal, now, change, c.f, acts);
  const removed = r.removes.flatMap((k) => acts.filter((a) => a.key === k).map((a) => a.ref));
  const t = await builderStart(workspaceId, r.goal, author, flowId, model, {
    rebuild: true,
    ...(acts.length ? { removed } : {}),
    ...(locals.length ? { local: locals } : {}),
    ...(headSpec ? { pinFrom: headSpec } : {}),
  });
  return { ...t, calls: t.calls + c.n };
}

/** The automation's goal as it should be after `change` — one strict call, in the person's words; a removed part is simply left out. */
export async function restateGoal(goal: string | undefined, now: string | undefined, change: string, chooser: Chooser, acts: Array<{ key: string; words: string }> = []): Promise<{ goal: string; removes: string[] }> {
  const schema = S.obj({ goal: S.str("the whole automation, restated with the change applied"),
    // P7 (E01): which of the automation's actions the change REMOVES — from its closed list; nothing else may be left out.
    ...(acts.length ? { removes: S.arr(S.oneOf(acts.map((a) => a.key)), acts.length, "the actions below the CHANGE removes or replaces — none when it only adds or changes something else") } : {}) });
  const prompt = [
    "An automation exists; the person now asks for the CHANGE below. Write the goal of the automation AS IT SHOULD BE after the change —",
    "one or two sentences, in the person's own words, keeping everything the change does not touch and replacing what it changes.",
    "What the change removes is LEFT OUT — never written as something it does not do (\"without emailing\", \"no longer posts\").",
    "Add nothing neither of them says.",
    "",
    ...(goal ? [`GOAL (the person's words when it was built): ${goal}`] : []),
    ...(now ? [`WHAT IT DOES NOW: ${now}`] : []),
    ...(acts.length ? ["ITS ACTIONS (the restated goal keeps every one the change does not remove or replace):", ...acts.map((a) => `- ${a.key}: ${a.words}`)] : []),
    `CHANGE: ${change}`,
  ].join("\n");
  const r = parseStrict<{ goal: string; removes?: string[] }>(schema, await chooser(prompt, { name: "edit_restate", schema }, "edit:restate"), "edit:restate");
  return { goal: r.goal.trim(), removes: r.removes ?? [] };
}

/** P7 (E01): the automation's actions, keyed, by the person's words for each (its quote in `spec`, else its component). */
export function actionsOf(start: EFlow, spec: GoalSpec | undefined): Array<{ key: string; ref: string; words: string }> {
  const quotes = [...(spec?.sinks ?? [])];
  return start.steps.filter((x) => x.kind === "tool").map((x, i) => {
    const ref = (x as { ref: string }).ref;
    const qi = quotes.findIndex((q) => q.ref === ref);
    const words = qi >= 0 ? quotes.splice(qi, 1)[0]!.quote : ref;
    return { key: `A${i + 1}`, ref, words };
  });
}

/** A flow that only reads is complete — delivery is OFFERED, never added (2026-09-27: "get me a list" became an email). */
const DELIVERY_OFFER = "It keeps the result in the automation and sends nothing. If you want it delivered, say where — to you, to people in the data, or to a channel.";

/** A conditional action with no schedule — it only acts when started. */
const WATCH_OFFER = "It acts only when it is started. If it should keep watching for this, say how often it should check.";

async function step(workspaceId: string, conv: Conversation, author: RevisionAuthor, flowId: string | null, chooser: Chooser, opts: { continuation?: boolean; fallback?: Conversation } = {}): Promise<Omit<BuilderTurn, "calls">> {
  // An answer may re-understand the goal (once) — and what it says may need a read written for it (2026-10-01: "by deductions I mean
  // the LOP days"), so the catalogue offers a new read here too, and the run carries the writer.
  // T13 / Intent IR: keep offering newReads after a settled round — `!corrected` hid the writer and, with MEM3, dropped the
  // settled reader so the next answer re-planned without it.
  const { items, cat } = await builderCatalogue(workspaceId, { flowId, local: conv.local ?? [], newReads: intentIrEnabled() || !conv.corrected });
  const existing = flowId ? await flowRepo.get(workspaceId, flowId) : null;
  // The draft an edit started from: the flow's last REVISION (the working copy is this conversation's own state, never its start).
  const start: EFlow = (conv.current && existing ? (await editStart(workspaceId, existing.id, cat, { resuming: true })).start : null) ?? emptyFlow(slugify(conv.goal).slice(0, 40) || "automation");
  const u0: Understood = { ...recheck({ goal: conv.goal, texts: conv.texts, spec: conv.spec, ...(conv.corrected ? { corrected: true } : {}), ...(conv.known ? { known: conv.known } : {}), ...(conv.existing ? { existing: conv.existing } : {}), ...(conv.settled?.length ? { settled: conv.settled } : {}) }, items), ...(conv.current ? { current: conv.current } : {}), ...(conv.local?.length ? { local: conv.local } : {}), ...(conv.replans ? { replans: conv.replans } : {}), ...(conv.settled?.length ? { settled: conv.settled } : {}) };
  // Z9: "me" is the signed-in person — their verified address, only when a person (not a harness) made the turn.
  const requester = /@/.test(author.createdBy) ? author.createdBy : undefined;
  const answeredHoles = Object.keys(conv.answers);
  const u = { ...withDrafts(u0, cat, start), ...(requester ? { requester } : {}), ...(answeredHoles.length ? { answered: answeredHoles, answerTexts: conv.answers } : {}) };
  const asked: BuildQuestion[] = [];
  const r = await run(u, items, cat, chooser, async (qs) => { asked.push(...qs); return qs.map((q) => answerFor(q.holeId, conv, q.about) ?? (deferredFor(q.holeId, conv.deferred ?? []) || (q.about && (conv.deferred ?? []).some((d) => conv.abouts?.[d] === q.about) || acceptedFor(q.holeId, q.about, conv.acceptedGaps ?? [])) ? LEFT_AS_BUILT : null)); }, start, conv.corrected ? undefined : readWriter(workspaceId), { wholeRound: true });
  // Every question this run asked is recorded with its anchor, so a later re-derivation under a new id finds its answer.
  conv = { ...conv, abouts: { ...(conv.abouts ?? {}), ...Object.fromEntries(asked.filter((q) => q.about).map((q) => [q.holeId, q.about!])) } };
  // A re-understanding is KEPT once its round is settled (every question of it answered): later turns replay the stored spec, never
  // the model call again — nor a read written again, differently. A round with a question still open is not settled; it is asked.
  const und = r.understood;
  const roundOne = r.trace.questions.filter((q) => q.round === 1 && /^(unclear|delivery):/.test(q.holeId));
  const settled: Partial<Conversation> = und && roundOne.every((q) => q.filled) ? { goal: und.goal, spec: und.checked.spec, texts: und.texts, corrected: true, ...(und.replans ? { replans: und.replans } : {}), ...(und.local?.length ? { local: und.local } : {}) } : {};
  // A read that re-understanding wrote is not in this turn's catalogue: the turn is replayed ONCE from what was stored (corrected —
  // no model call, nothing written), with the read beside the others.
  // A read REVISED in place keeps its ref and changes its form, so "new" is judged by the form too — a ref match alone would build
  // the rest of the turn against the read as it was.
  if (settled.local?.some((l) => !(conv.local ?? []).some((x) => x.ref === l.ref && JSON.stringify(x.spec) === JSON.stringify(l.spec)))) return step(workspaceId, { ...conv, ...settled }, author, flowId, chooser);
  // P4-I5: an answer about one part may not cost another. Every action the build had placed must still be placed — a re-understanding
  // that lost one (the field case: the otherwise-arm's email) is not applied; the build is replayed as it was, and the person is told.
  const toolRefs = (f: EFlow) => f.steps.flatMap((x) => (x.kind === "tool" && "ref" in x && x.ref ? [x.ref] : []));
  if (opts.fallback) {
    const now = toolRefs(r.flow);
    const lost = (opts.fallback.built ?? []).filter((ref, i, all) => now.filter((x) => x === ref).length < all.filter((x) => x === ref).length);
    if (r.status === "cannot" || r.status === "unchanged" || lost.length) {
      // P4-I5 surgical (2026-10-06): the answer stays applied to everything that survived — only the LOST part is
      // re-asked, in the person's words for it, instead of discarding the whole answer. The build replays as it was,
      // with the lost words as the unsettled part, so the next question names exactly what needs settling.
      const lostWords = [...new Set(lost.flatMap((ref) => opts.fallback!.spec.sinks.filter((s) => s.ref === ref).map((s) => s.quote)))];
      const back: Conversation = lost.length && lostWords.length
        ? { ...opts.fallback, pending: null, unsettled: lostWords, wasUnsettled: opts.fallback.unsettled }
        : opts.fallback;
      const t = await step(workspaceId, back, author, flowId, chooser);
      return { ...t, said: lostWords.length ? `I kept your answer, but “${lostWords.join("; ")}” is not built any more — what should happen for it?` : "I could not use that answer without undoing what was already built, so the automation is as it was." };
    }
  }
  const built = toolRefs(r.flow);
  const readback = (r.understood ?? u).readback;
  const unmet = r.trace.unmet ?? [];
  const acts = r.flow.steps.some((x) => x.kind === "tool");
  const suggestions = [
    ...(acts ? [] : [DELIVERY_OFFER]),
    // An action that depends on what the data shows, with no schedule, acts only when someone starts it (E5.13, D10) — offered, never set.
    ...(acts && !r.flow.schedule && r.flow.steps.some((x) => x.kind === "transform" || x.kind === "branch") ? [WATCH_OFFER] : []),
  ];
  if (r.status === "cannot" || r.status === "unchanged") {
    // Nothing is written — and a question this conversation left pending is closed, so the next message is a new goal, not its answer.
    // A CONTINUATION that cannot be built writes nothing at all: the build stays as it was before the message (2026-10-01: the failed
    // continuation was stored, and every later message — "revert the change" too — met the same refusal).
    if (!opts.continuation && existing && convOf((await flowService.getIncomplete(workspaceId, existing.id))?.build)?.pending) {
      const view = (await flowService.getIncomplete(workspaceId, existing.id))!;
      await flowService.saveIncomplete(workspaceId, existing.id, view.model, { ...(view.build as { goalSpec: object; trace: unknown }), goalSpec: { ...((view.build as { goalSpec: object }).goalSpec), conversation: { ...conv, pending: null } } });
    }
    return { status: r.status, flowId: existing?.id ?? null, readback, unmet, suggestions: [] };
  }
  // EVERY question this replay asked that has no answer yet is pending — asked as ONE group (2026-10-05), each numbered, and one
  // reply is read against all of them (`reply-intents.ts`). A question with its own CHIPS (options) keeps a turn to itself: the
  // panel binds options to the question, so the group is the leading run of option-free questions and `open` is always its first.
  // A DEFERRED question is closed for the build (contract C6): answered-or-deferred decides, by STATE — the model cannot re-open
  // what the person put aside, whatever it returns. The bound (C7) suppresses every question, direct ones included.
  const deferredList = conv.deferred ?? [];
  const bound = (conv.clarifyRounds ?? 0) >= MAX_CLARIFY_ROUNDS;
  // An answer is found by what it SETTLES (`about`), not only by the question's id, which a re-plan re-derives. One question is asked
  // once per turn: a round replayed inside the run raises the same id again, and the group showed it twice (2026-10-06).
  const opens = asked.filter((q, i) => asked.findIndex((x) => x.holeId === q.holeId) === i && answerFor(q.holeId, conv, q.about) === undefined && !deferredFor(q.holeId, deferredList) && !(q.about && deferredList.some((d) => conv.abouts?.[d] === q.about)) && !acceptedFor(q.holeId, q.about, conv.acceptedGaps ?? []));
  const open = opens[0];
  // A choice among readers that fit equally is asked FIRST, once (P4): it decides what the whole flow reads. A build that is
  // otherwise complete is held as the working copy until it is answered — no revision is written over a reader not yet chosen.
  const choice = (conv.choices ?? []).find((c) => conv.answers[readerKey(c)] === undefined && !deferredList.includes(readerKey(c)) && conv.spec.sources.some((x) => x.ref === c.ref));
  // The decisions this build holds, by anchor (latest answer wins; carried ones not answered again stay): a completed build keeps
  // them, so an edit or rebuild of it does not ask again what the person already settled.
  const decisions: Record<string, string> = { ...(conv.carried ?? {}) };
  for (const k of Object.keys(conv.answers)) { const a = conv.abouts?.[k]; if (a) decisions[a] = conv.answers[k]!; }
  const saved = await save(workspaceId, { ...(r.understood ?? u), ...(Object.keys(decisions).length ? { decisions } : {}) }, r, author, undefined, existing ?? undefined, choice ? readerKey(choice) : undefined);
  const summary = describeFlow(r.flow, items, cat);
  if (choice) {
    const key = readerKey(choice);
    const view = await flowService.getIncomplete(workspaceId, saved.flowId);
    await flowService.saveIncomplete(workspaceId, saved.flowId, view!.model, { ...(view!.build as { goalSpec: object; trace: unknown }), goalSpec: { ...((view!.build as { goalSpec: object }).goalSpec), conversation: { ...conv, ...settled, pending: key, built } } });
    return { status: "asks", flowId: saved.flowId, readback, question: { holeId: key, ask: readerAsk(conv, choice), options: [choice.ref, ...choice.also].map((ref) => readerLabel(ref, items)), onlyOptions: true }, unmet, suggestions, summary };
  }
  // S4 drafted defaults (2026-10-08): goal-drafted wording bound at `drafted` provenance is confirmed as
  // ONE question ("use this?") instead of one open question per port. Reject falls back to the open ask.
  if (!bound) {
    const { draftedConfirmOf, draftedConfirmAsk } = await import("./build.js");
    const draft = draftedConfirmOf(r.flow, cat);
    if (draft) {
      const key = `drafted:${draft.stepId}:wording`;
      if (conv.answers[key] === undefined && !deferredList.includes(key)) {
        const ask = draftedConfirmAsk(draft);
        const next: Conversation = { ...conv, ...settled, pending: key, pendingGroup: undefined, built };
        const pending = { kind: "drafted" as const, key, ...(draft.subject !== undefined ? { subject: draft.subject } : {}), ...(draft.body !== undefined ? { body: draft.body } : {}) };
        const view = await flowService.getIncomplete(workspaceId, saved.flowId);
        // A complete save writes a revision and keeps no working copy: there
        // is no incomplete to hold the question — the draft confirm rides
        // the turn payload (typed pending), never the store. Structural: presence check.
        if (!view) return { status: "asks", flowId: saved.flowId, readback, question: { holeId: key, ask, pending }, unmet, suggestions, summary, ...(saved.revision !== undefined ? { revision: saved.revision } : {}) };
        await flowService.saveIncomplete(workspaceId, saved.flowId, view.model, { ...(view.build as { goalSpec: object; trace: unknown }), goalSpec: { ...((view.build as { goalSpec: object }).goalSpec), conversation: next } });
        return { status: "asks", flowId: saved.flowId, readback, question: { holeId: key, ask }, unmet, suggestions, summary };
      }
    }
  }
  if (open && r.status === "incomplete" && !bound) {
    // The group is the LEADING run of option-free open questions; a question with chips stops it (options bind to one question).
    const group: BuildQuestion[] = [];
    for (const q of opens) { if (q.options?.length || q.onlyOptions) break; group.push(q); }
    const askedQs = group.length > 1 ? group : [open];
    const ask = askedQs.length > 1 ? askedQs.map((q, i) => `${i + 1}. ${q.ask}`).join("\n") : open.ask;
    const next: Conversation = { ...conv, ...settled, pending: open.holeId, ...(askedQs.length > 1 ? { pendingGroup: askedQs.map((q) => q.holeId) } : { pendingGroup: undefined }), built };
    const view = await flowService.getIncomplete(workspaceId, saved.flowId);
    await flowService.saveIncomplete(workspaceId, saved.flowId, view!.model, { ...(view!.build as { goalSpec: object; trace: unknown }), goalSpec: { ...((view!.build as { goalSpec: object }).goalSpec), conversation: next } });
    return { status: "asks", flowId: saved.flowId, readback, question: { holeId: open.holeId, ask, ...(askedQs.length === 1 && open.options ? { options: open.options } : {}), ...(askedQs.length === 1 && open.onlyOptions ? { onlyOptions: true } : {}) }, unmet, suggestions, summary };
  }
  if (r.status === "complete") {
    if (existing?.incompleteModel) await flowService.clearIncomplete(workspaceId, saved.flowId);
    return { status: "complete", flowId: saved.flowId, readback, ...(saved.revision !== undefined ? { revision: saved.revision } : {}), unmet, suggestions, summary };
  }
  // Nothing left to ask by the rounds, and still not finished: the working copy is kept, and the conversation stays OPEN on what is
  // unsettled — the person's reply re-understands the goal with it (`CLARIFY`). With nothing named unmet there is nothing to ask.
  // Three gates decide that openness, all by code (contracts C6/C7): gaps a DEFERRED question owns are closed and never re-listed;
  // CLARIFY itself may be deferred; and at the BOUND no question is asked — the terminal offer replaces it, with `pending` kept
  // only so a reply (accept / discard / one last try) still lands in `builderAnswer` instead of the router.
  const view = await flowService.getIncomplete(workspaceId, saved.flowId);
  // P3: gaps the person accepted-with-gaps are stated, never re-asked — CLARIFY pends only when something un-accepted remains.
  const acceptedGaps = conv.acceptedGaps ?? [];
  const gapOpen = (u: string): boolean => { const pq = partQuestion(u); return !pq || (!acceptedGaps.includes(pq.key) && !acceptedGaps.some((a) => sameWords(a.replace(/^words:/, ""), norm(pq.quote).replace(/^(the|a|an) /, "")))); };
  const wantsClarify = unmet.length > 0 && !deferredList.includes(CLARIFY) && unmet.some(gapOpen);
  // Only what the PERSON can settle is asked (2026-10-02, P4-I2): what the builder itself failed to place — a condition it left with
  // nothing on it, a part it could not place — is stated in the readback, never put to them as "Not settled yet" (they cannot fix the
  // builder, and whatever they answered was folded into the goal and re-understood, losing what was already right).
  const ours = new Set(r.trace.internal ?? []);
  const askable = wantsClarify ? unmet.filter((u) => !ours.has(u) && !deferredGap(u, deferredList, r.flow.holes)) : [];
  // ONE part per question (P4): the first gap the person can settle that has not been asked about in this build. A part asked about
  // once and still unmet is stated with the rest — never asked again (P4-I1), so the conversation always converges.
  const askedParts = conv.askedParts ?? [];
  // Words already asked about as an unclear-words question (`unclear:` holes) are asked: their part is never asked again as new.
  const askedWords = (q: { key: string; quote: string }) => q.key.startsWith(`${PART}unclear:`) && [...Object.keys(conv.answers), ...deferredList].some((k) => k.startsWith("unclear:") && sameWords(unclearWords(k), norm(q.quote).replace(/^(the|a|an) /, "")));
  const acceptedWords = (q: { key: string; quote: string }) => (conv.acceptedGaps ?? []).some((a) => sameWords(a.replace(/^words:/, ""), norm(q.quote).replace(/^(the|a|an) /, "")));
  // S6 delta-only choke point (2026-10-08): a part question anchored to settled words is rejected IN CODE — the same
  // `settledMatch` exact-norm membership the unclear rounds hold to. A correction touching a settled word re-opens exactly
  // that word upstream (its replan unclear flag survives), so this gate never blocks a genuine correction.
  const settledAnchored = (quote: string) => settledMatch(quote, conv.settled ?? []);
  const part = wantsClarify && !bound ? askable.map((item) => ({ item, q: partQuestion(item) })).find((x) => x.q && !settledAnchored(x.q.quote) && !askedParts.includes(x.q.key) && !deferredList.includes(x.q.key) && !(conv.acceptedGaps ?? []).includes(x.q.key) && !askedWords(x.q) && !acceptedWords(x.q)) : undefined;
  // A part question's anchor is the person's words it names.
  if (part) conv = { ...conv, abouts: { ...(conv.abouts ?? {}), [part.q!.key]: wordsAnchor(part.q!.quote) } };
  const pending = part ? part.q!.key : wantsClarify && bound ? CLARIFY : null;
  const unsettled = part ? [part.item] : wantsClarify && bound ? unmet : [];
  if (view) await flowService.saveIncomplete(workspaceId, saved.flowId, view.model, { ...(view.build as { goalSpec: object; trace: unknown }), goalSpec: { ...((view.build as { goalSpec: object }).goalSpec), conversation: { ...conv, ...settled, pending, unsettled, built, ...(part ? { askedParts: [...askedParts, part.q!.key] } : {}) } } });
  if (part) return { status: "asks", flowId: saved.flowId, readback, question: { holeId: part.q!.key, ask: part.q!.ask }, unmet, suggestions, summary };
  if (pending) return { status: "incomplete", flowId: saved.flowId, readback, unmet, suggestions: [...suggestions, CLARIFY_BOUND_OFFER], summary };
  return { status: "incomplete", flowId: saved.flowId, readback, unmet, suggestions, summary };
}

/**
 * builder-behaviour P7 (E01): the actions the automation HAS (its call steps) that a whole re-plan no longer has and that the change
 * did not REMOVE (the restatement's own closed list, `removed`, by component) — each by the person's words for it.
 */
export function lostActions(start: EFlow, spec: GoalSpec, prev: GoalSpec | undefined, removed: readonly string[]): string[] {
  const left = spec.sinks.map((x) => x.ref);
  const gone = [...removed];
  const out: string[] = [];
  for (const a of actionsOf(start, prev)) {
    const k = left.indexOf(a.ref);
    if (k >= 0) { left.splice(k, 1); continue; }
    const g = gone.indexOf(a.ref);
    if (g >= 0) { gone.splice(g, 1); continue; }
    out.push(a.words);
  }
  return out;
}

/**
 * S2 patch-first (2026-10-08): the lost-action check scoped to touched steps — only steps the patch owns may move.
 * Untouched steps are byte-identical by construction (the caller asserts it), so the whole-diff false positive on an
 * unmentioned sink (live turn 7) cannot fire. Shape change (added/removed step ids) is NOT a patch: `null` escalates to rebuild.
 */
export function patchLostActions(before: EFlow, after: EFlow, touched: readonly string[], spec: GoalSpec, prev: GoalSpec | undefined, removed: readonly string[]): string[] | null {
  const beforeIds = new Set(before.steps.map((s) => s.id));
  const afterIds = new Set(after.steps.map((s) => s.id));
  for (const id of beforeIds) if (!afterIds.has(id) && !touched.includes(id)) return null;
  for (const id of afterIds) if (!beforeIds.has(id) && !touched.includes(id)) return null;
  const owned = new Set(touched);
  const narrow = { ...before, steps: before.steps.filter((s) => owned.has(s.id)) } as EFlow;
  const left = spec.sinks.map((x) => x.ref);
  const gone = [...removed];
  const out: string[] = [];
  for (const a of actionsOf(narrow, prev)) {
    const k = left.indexOf(a.ref);
    if (k >= 0) { left.splice(k, 1); continue; }
    const g = gone.indexOf(a.ref);
    if (g >= 0) { gone.splice(g, 1); continue; }
    out.push(a.words);
  }
  return out;
}
