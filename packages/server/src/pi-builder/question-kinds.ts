/**
 * How a question is answered (2026-10-13). Forge chooses a KIND from this closed set and fills in its content; the
 * card for each kind is a component we wrote and test. Forge never describes the UI itself — an invented component
 * would be markup from a model in the browser, and an answer whose shape nobody defined.
 *
 * Two rules, both here and nowhere else:
 *   - A question is normalised before anyone sees it. An unknown kind, or a `multi` with nothing to tick, falls back
 *     to what the question was before kinds existed (one of `choices`, or typed text) — never a blank card.
 *   - An answer is checked against its question before it is used. A `multi` answer must name listed options, a
 *     `number` must be a number inside its bounds, a date must be a date. A bad answer is refused with the reason.
 *
 * Wire format, unchanged for every existing question: an answer is a string. A `multi` answer is the chosen options
 * one per line (as a `"files"` pick already is), and `MULTI_NONE` when none is chosen. Forge reads `answers.json`,
 * where a `multi` answer is written as a list (`toStored`).
 *
 * Pure.
 */
import type { PiQuestion, QuestionKind } from "./types.js";

export const QUESTION_KINDS: readonly QuestionKind[] = ["choice", "multi", "number", "date", "period", "text"];

/** The answer to a `multi` question when nothing is ticked. Plain words: it is what the chat shows. */
export const MULTI_NONE = "None of these";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The question as the card will render it. Fields a kind does not use are dropped; nothing is invented. */
export function normaliseQuestion(raw: PiQuestion): PiQuestion {
  const q: PiQuestion = { ...raw };
  const choices = Array.isArray(q.choices) ? q.choices.filter((c) => typeof c === "string" && c.trim()) : undefined;
  if (choices) q.choices = choices;
  else delete q.choices;

  let kind = typeof q.kind === "string" && (QUESTION_KINDS as readonly string[]).includes(q.kind) ? q.kind : undefined;
  // A file question is its own card; a kind beside it would be a second answer to "how is this answered".
  if (q.pick) kind = undefined;
  // Nothing to tick, or one of a list with no list: what the question was before kinds.
  if ((kind === "multi" || kind === "choice") && !choices?.length) kind = undefined;
  if (kind) q.kind = kind;
  else delete q.kind;

  if (q.kind === "number") {
    if (!isNum(q.min)) delete q.min;
    if (!isNum(q.max)) delete q.max;
    if (isNum(q.min) && isNum(q.max) && q.min > q.max) {
      delete q.min;
      delete q.max;
    }
    if (typeof q.unit !== "string" || !q.unit.trim()) delete q.unit;
  } else {
    delete q.min;
    delete q.max;
    delete q.unit;
  }
  return q;
}

export function normaliseQuestions(questions: unknown): PiQuestion[] {
  return (Array.isArray(questions) ? questions : [])
    .filter((q): q is PiQuestion => !!q && typeof q === "object")
    .map(normaliseQuestion);
}

/** The options a `multi` answer names, in the question's order; `MULTI_NONE` is the empty list. */
export function multiChoices(answer: string): string[] {
  const lines = answer
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === MULTI_NONE ? [] : lines;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD = /^(\d{4})-(\d{2})$/;

function realDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** Whether `answer` answers `q`, and why not. Questions without a kind accept any non-empty text, as before. */
export function checkAnswer(q: PiQuestion, answer: string): { ok: true } | { ok: false; reason: string } {
  const a = answer.trim();
  if (!a) return { ok: false, reason: `"${q.prompt}" has no answer.` };
  switch (q.kind) {
    case "multi": {
      const listed = new Set(q.choices ?? []);
      const unknown = multiChoices(a).filter((c) => !listed.has(c));
      return unknown.length
        ? { ok: false, reason: `"${q.prompt}": ${unknown.map((u) => `"${u}"`).join(", ")} is not one of the options.` }
        : { ok: true };
    }
    case "number": {
      const n = Number(a.replace(/,/g, ""));
      if (!Number.isFinite(n)) return { ok: false, reason: `"${q.prompt}" needs a number.` };
      if (isNum(q.min) && n < q.min) return { ok: false, reason: `"${q.prompt}" must be at least ${q.min}.` };
      if (isNum(q.max) && n > q.max) return { ok: false, reason: `"${q.prompt}" must be at most ${q.max}.` };
      return { ok: true };
    }
    case "date":
      return realDate(a) ? { ok: true } : { ok: false, reason: `"${q.prompt}" needs a date as YYYY-MM-DD.` };
    case "period": {
      const m = PERIOD.exec(a);
      return m && +m[2]! >= 1 && +m[2]! <= 12 ? { ok: true } : { ok: false, reason: `"${q.prompt}" needs a month as YYYY-MM.` };
    }
    default:
      // `choice` keeps "Something else": a typed answer to a choice question is how it has always worked.
      return { ok: true };
  }
}

/** What Forge reads in answers.json: a `multi` answer as the list of options, a `number` as a number. */
export function toStored(q: PiQuestion | undefined, answer: string): unknown {
  if (q?.kind === "multi") return multiChoices(answer);
  if (q?.kind === "number") return Number(answer.trim().replace(/,/g, ""));
  return answer;
}
