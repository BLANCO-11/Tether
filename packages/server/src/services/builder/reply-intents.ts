/**
 * ONE structured call for a GROUP of open questions (2026-10-05): the person's reply is READ with the goal, the questions and the
 * prior answers in view, and comes back as typed intents — never matched by a regex where meaning is the whole point.
 *
 * Why this exists: answers used to be intercepted by code BEFORE the model saw them (`KEEP_AS_IS` in `normalise-value.ts`), so
 * "leave it" to "I cannot give manager from this data" could only ever mean defer (a gap kept, "Built — not finished") — while the
 * same words said the other way ("leave manager out of the flow") completed the build. The conversation's understanding is the
 * MODEL's job; the CODE's job is the shape (below) and the build (`checkSpec`). So:
 *
 *   - `interpretReplies` — one `reply_intents` call per reply, prompt carries goal + questions + prior answers + the reply.
 *   - `validateReplies` — the code validator: every qid is one of the questions actually asked, never duplicated, each intent
 *     carries what it needs (an `answer` has a value; `onlyOptions` questions only take one of their options; `drop` only on a
 *     question about the GOAL's words and only for `unclear:` ids — the "I cannot give X" shape), and `new_instruction` stands
 *     alone (a whole reply that is a new message, not an answer to any one question).
 *   - Any failure — gateway refusal, malformed JSON, a qid that was never asked — returns `null` and the caller falls back to
 *     today's deterministic rules. The conversation can never dead-end on the new path; the fallback IS today's behavior.
 *
 * Intents route to machinery that already exists: `answer`/`drop` become the question's answer (`drop` carries a plain phrase the
 * re-understanding applies — the exact shape that worked when a person typed it), `confirm` is the "yes" the assumptions question
 * takes, `defer` is contract C6, `new_instruction` continues the build as any new message does.
 */
import { S, parseStrict, type Schema } from "./strict-schema.js";
import type { Chooser } from "./build.js";

export type ReplyIntent = "answer" | "confirm" | "defer" | "drop" | "new_instruction";

/** One open question as the reply handler needs it — the ask text the person saw, verbatim from the stored trace. */
export interface GroupQuestion { holeId: string; ask: string; options?: string[]; onlyOptions?: boolean }

/** A whole answer that only CONFIRMS — "yes", "that's right". Never a value: it confirms an assumption, and fills no other port. */
export const CONFIRMS = /^(yes|yep|yeah|y|correct|right|exactly|ok|okay|sure|confirmed|that'?s (right|correct|it|what i mean))[.! ]*$/i;
/**
 * A whole answer that keeps the build AS IT IS — the defer that closes the pending question for this build (contract C6): bare words
 * count ("leave", "skip", "fine", "accept"), not only "leave it". Deliberately does NOT include "yes"/"ok"/"sure" — those are
 * `CONFIRMS`: they confirm an assumption as asked, and are never a defer.
 */
export const KEEP_AS_IS = /^(leave|keep|skip|ignore|accept|fine|done|stop|no more|as it is|that'?s fine|it'?s fine)( it| this| that| as it is| it as it is)?[.! ]*$/i;

/** What a validated reply maps to: answers by qid, defers by qid, or the whole reply being a new message. */
export interface RoutedReplies { answers: Record<string, string>; deferred: string[]; newInstruction: boolean }

export const REPLY_INTENTS = "reply_intents";

/** The strict schema the reply comes back in — exact `maxItems`, so the model cannot answer questions that were not asked. */
export function replyIntentsSchema(maxQuestions: number): Schema {
  return S.obj({
    replies: S.arr(S.obj({
      qid: S.str("the qid of ONE question below, exactly as written"),
      intent: S.oneOf(["answer", "confirm", "defer", "drop", "new_instruction"], "what the reply means for that question"),
      value: S.nullable(S.str("the reply's words for an answer/drop; null for confirm/defer/new_instruction")),
    }), maxQuestions, "one entry per question the reply addresses; omit the rest"),
  });
}

/** The prompt: full conversational context, a closed intent vocabulary, and the one judgment that fixes the field case. */
export function replyPrompt(ctx: { goal: string; answers: Record<string, string>; questions: GroupQuestion[]; reply: string }): string {
  const given = Object.entries(ctx.answers).slice(-10).map(([qid, v]) => `${qid} — ${v}`);
  return [
    "A person is building an automation in a chat. Read ONE reply they sent to a group of questions and map it to typed intents.",
    "",
    "GOAL (the person's own words):",
    ctx.goal,
    ...(given.length ? ["", "ANSWERS ALREADY GIVEN:", ...given] : []),
    "", "QUESTIONS (one entry per question their reply addresses; omit the rest; never invent a qid):",
    ...ctx.questions.flatMap((q) => [
      `- qid: ${q.holeId}`,
      `  asked: ${q.ask.replace(/\n+/g, " ")}`,
      ...(q.options?.length ? [`  options: ${q.options.join(" | ")}`] : []),
      ...(q.onlyOptions ? ["  (only these options are valid answers)"] : []),
    ]),
    "", "THE PERSON'S REPLY:", ctx.reply,
    "", 'Return {"replies":[{"qid":"…","intent":"…","value":null}]} — one entry per question the reply addresses:',
    '- "answer": the reply gives this question its value or its meaning (value = the person\'s own words for it).',
    '- "confirm": the reply confirms an offered reading as asked ("yes"). value: null.',
    '- "defer": the reply puts the question aside, keeping the build as it is ("leave it", "skip", "fine"). value: null.',
    '- "drop": the reply means this part is not needed at all — it leaves the goal (value = a short plain phrase saying what to remove, e.g. "leave manager out of the flow"). Only for a question asking what GOAL words mean.',
    '- "new_instruction": the reply is a NEW message rather than an answer to any question — the only entry when used.',
    "",
    "Judge from the whole context, not the reply alone: “leave it” to “I cannot give X from this data” usually means DROP X;",
    "to an offered choice it means DEFER; a bare value answers the question it was asked to.",
  ].join("\n");
}

/**
 * The code validator over one structured reply — per-entry (S5): a bad entry is DROPPED
 * and the valid ones stand; `null` (never a throw) only when NOTHING valid remains, so the
 * caller falls back to the deterministic rules. Cross-field and cross-question rules only;
 * the JSON shape is `parseStrict`'s. A lone `new_instruction` still stands alone; mixed
 * with routed entries it is dropped like any other unroutable entry.
 */
export function validateReplies(parsed: unknown, questions: GroupQuestion[]): RoutedReplies | null {
  const replies = (parsed as { replies?: unknown } | null)?.replies;
  if (!Array.isArray(replies) || !replies.length) return null;
  const byId = new Map(questions.map((q) => [q.holeId, q]));
  const answers: Record<string, string> = {};
  const deferred: string[] = [];
  const seen = new Set<string>();
  for (const r of replies) {
    if (!r || typeof r !== "object") continue;
    const { qid, intent, value } = r as { qid?: unknown; intent?: unknown; value?: unknown };
    if (typeof qid !== "string") continue;
    const q = byId.get(qid);
    if (!q || seen.has(qid)) continue;
    if (intent === "new_instruction") {
      if (replies.length === 1) return { answers: {}, deferred: [], newInstruction: true };
      continue;
    }
    if (intent === "confirm" || intent === "defer") {
      if (value !== null && value !== undefined) continue; // the prompt's contract: these carry no value
      seen.add(qid);
      if (intent === "confirm") answers[qid] = "yes"; else deferred.push(qid);
      continue;
    }
    if (intent !== "answer" && intent !== "drop") continue;
    const v = typeof value === "string" ? value.trim() : "";
    if (!v) continue;
    // `drop` only means anything on the GOAL's own words ("I cannot give X …") — elsewhere it is a misread, dropped.
    if (intent === "drop" && !qid.startsWith("unclear:")) continue;
    if (q.onlyOptions && !(q.options ?? []).includes(v)) continue;
    seen.add(qid);
    answers[qid] = v;
  }
  if (!Object.keys(answers).length && !deferred.length) return null;
  return { answers, deferred, newInstruction: false };
}

/**
 * One `reply_intents` call over the whole group; `null` on ANY failure (gateway refusal, malformed JSON, validator rejection) —
 * the caller then answers with today's rules. Never throws: a failed read is a fallback, not a dead end.
 */
export async function interpretReplies(
  ctx: { goal: string; answers: Record<string, string>; questions: GroupQuestion[]; reply: string },
  chooser: Chooser,
): Promise<RoutedReplies | null> {
  const schema = replyIntentsSchema(ctx.questions.length);
  try {
    const raw = await chooser(replyPrompt(ctx), { name: REPLY_INTENTS, schema }, "chat:reply_intents");
    return validateReplies(parseStrict<unknown>(schema, raw, "chat:reply_intents"), ctx.questions);
  } catch {
    return null;
  }
}
