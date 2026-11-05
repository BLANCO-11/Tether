/**
 * The ROUTE of a chat message (phase X, D-334): what kind of message it is, decided by one small strict call before anything
 * else runs. The builder's own calls are untouched — this is its own call, so no builder prompt byte moves.
 *
 *   build         a goal, or something to ADD to the automation → the builder (`builderStart`)
 *   change        alter or remove something already in it      → one canvas action (`chat-edit.ts`)
 *   about_flow    a question about this automation as it is     → answered by code (`chat-answers.ts`)
 *   capabilities  a question about what can be built or done here → answered by code
 *   chat          anything else: thanks, a greeting              → a fixed line
 *
 * `change` and `about_flow` are offered only when the automation has steps: with none, there is nothing to change or describe,
 * and the enum does not carry them — the model cannot choose them (the schema's rule, not a check afterwards).
 *
 * ⚠ The prompt names kinds, never nouns (P5), and its examples are domain-free. Nothing here matches words: which kind a
 * sentence is, only a model can say — a keyword list is what phase 0 removed.
 */
import type { CatalogueSnapshot, Hole, Ty } from "@foundry/flow-edit";
import { literalFits } from "@foundry/flow-edit";
import type { Chooser } from "./build.js";
import { S, parseStrict, type Schema } from "./strict-schema.js";

// ⚠ `replan_go_ahead` and the composer's Build/Ask `mode` are DELETED (2026-10-10): the replan gate they served is gone
// (a change to an unfinished build is applied, never held for a "go ahead"), and the router decides build vs ask itself.
export const ROUTE_KINDS = ["build", "change", "shape", "about_flow", "capabilities", "chat", "answer", "accept", "discard"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/**
 * The kinds a message may be, given whether the automation has steps — and, only while a question of the builder's is waiting,
 * `answer` (builder-behaviour P4, R11: a waiting question captured whatever came next — "send the email to X instead" became the
 * answer to "what is 2 days ago?").
 * `shape` is the column-reshape fast path (typed, never a regex): offered only when the automation has steps.
 * `accept` / `discard` are control replies to an unfinished build or a waiting question — never mined by regex.
 */
export const routeKinds = (hasSteps: boolean, asking = false): RouteKind[] =>
  ROUTE_KINDS.filter((k) => {
    if (k === "answer") return asking;
    if (k === "change" || k === "about_flow" || k === "shape") return hasSteps;
    if (k === "accept" || k === "discard") return hasSteps || asking;
    return true;
  });

export const routeSchema = (hasSteps: boolean, asking = false): Schema => S.obj({ kind: S.oneOf(routeKinds(hasSteps, asking)) });

export function routePrompt(message: string, hasSteps: boolean, asked?: string): string {
  const kinds = routeKinds(hasSteps, !!asked);

  const says: Record<RouteKind, string> = {
    build: "`build` — the person describes an automation they want, or something to ADD to this one (a new step, a new action, a schedule it does not have yet). Most messages are this.",
    change: "`change` — the person asks to alter or remove something ALREADY in this automation: a different value, a different source for a field, a different reader, no longer running on a schedule, taking a step or an approval out. Also when they challenge that something already built is wrong or overlapping (a comparison, a filter, SQL, a threshold) — even as a rhetorical question (“don’t you think …?”, “won’t that double-count?”) — they want it fixed, not a summary.",
    shape: "`shape` — the person asks only to change which columns the automation returns (which outputs it shows): adding, removing or renaming output columns. No new step, no new action, no schedule change.",
    about_flow: "`about_flow` — the person asks a NEUTRAL question about this automation as it is: what it does, what a step does, what it reads or sends. Not a challenge to its logic.",
    capabilities: "`capabilities` — the person asks what can be built or done here in general: what you can build, what this workspace can do, what is possible.",
    chat: "`chat` — none of these: a greeting, thanks, or a remark that asks for nothing.",
    answer: "`answer` — the person answers the question the builder just asked (below): a value, a choice, a yes or no, or what they meant. A message that asks for something else instead is not an answer.",
    accept: "`accept` — the person accepts what was built or offered as it is: keep it, it looks good, go ahead with it.",
    discard: "`discard` — the person drops the unfinished change or draft: revert it, undo it, throw it away.",
  };
  return [
    "You sort ONE message a person sent to an automation builder. You do not answer it; you say what kind of message it is.",
    `The automation ${hasSteps ? "already has steps" : "has no steps yet"}.`,
    "Kinds:",
    ...kinds.map((k) => `- ${says[k]}`),
    "A request that both adds and asks is `build`. A question that asks to be built (\"can you make one that …\") is `build`.",
    "⚠ `about_flow` is only “what does it do / what does this step do”. If they argue a value, comparison, query or threshold is wrong or overlapping, that is `change` — never `about_flow` (a summary would ignore the point).",
    ...(asked ? ["", "THE BUILDER JUST ASKED", asked] : []),
    "",
    "MESSAGE",
    message,
  ].join("\n");
}

/** The kind of one message — one strict call. */
export async function routeMessage(message: string, hasSteps: boolean, chooser: Chooser, asked?: string): Promise<RouteKind> {
  const schema = routeSchema(hasSteps, !!asked);
  const raw = await chooser(routePrompt(message, hasSteps, asked), { name: "chat_route", schema }, "chat:route");
  return parseStrict<{ kind: RouteKind }>(schema, raw, "chat:route").kind;
}

/**
 * S3 validate-then-capture (2026-10-08): a reply is captured as the pending hole's answer only when it
 * fits that hole's type (`literalFits` against the port's declared type); a miss is re-routed as a new
 * intent with the question left open. Structural: the hole's own type is the validator, never a word list.
 */
export function replyFitsHole(reply: string, hole: Pick<Hole, "ty"> | null | undefined, cat: CatalogueSnapshot): string | null {
  if (!hole || hole.ty === null || hole.ty === undefined) return null;
  return literalFits(reply.trim(), hole.ty as Ty, cat);
}

/** S3 validate-then-capture (2026-10-08): the hole a pending question id names on a state, or null. Structural: id lookup. */
export function holeForPending(state: { holes: Hole[] }, pending: string): Hole | null {
  return state.holes.find((x) => x.id === pending) ?? null;
}
