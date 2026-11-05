/**
 * What went wrong, in words a person acts on (2026-10-11). A Forge turn fails in a handful of ways — the AI service
 * refuses, is busy, is down, cannot be reached, the conversation outgrew it, the turn ran too long, or Forge itself
 * stopped — and each was shown as raw text ("403 terminated") or not at all (the chat sat on "drafting"). ONE mapping,
 * used for the live retry line and for the failure card; the raw error is kept as `detail`, never dropped.
 *
 * `retryable` says whether pressing Try again can help. A sign-in problem cannot — an administrator has to act.
 */
import type { PiTurnError } from "./types.js";

type Rule = { test: RegExp; title: string; said: string; retryable: boolean };

/** Most specific first: "429" before a generic 4xx, a sign-in failure before a refusal. */
const RULES: Rule[] = [
  {
    test: /\b429\b|rate.?limit|too many requests|quota/i,
    title: "The AI service is busy",
    said: "It turned the request away because too many were coming in. Waiting a minute and trying again usually works.",
    retryable: true,
  },
  {
    test: /\b401\b|unauthori[sz]ed|invalid.{0,20}(api.?)?key|authentication|no api key/i,
    title: "Foundry could not sign in to the AI service",
    said: "The AI service did not accept Foundry's credentials. Trying again won't help. An administrator needs to check the AI service settings.",
    retryable: false,
  },
  {
    test: /\b413\b|entity too large|payload too large|request too large/i,
    title: "That was too large to send to the AI service",
    said: "The request, usually because of a large image, was over the AI service's size limit. Images are now shrunk before they are sent, so trying again should work; if it does not, attach a smaller image.",
    retryable: true,
  },
  {
    test: /context.{0,20}(length|window)|too long|maximum.{0,20}tokens|token limit|prompt is too large/i,
    title: "This conversation has grown too long",
    said: "The AI service cannot take a conversation this long. Everything built so far is kept. Start a fresh chat for this workflow to carry on.",
    retryable: false,
  },
  {
    test: /\b403\b|terminated|forbidden|content.?(filter|policy)|blocked/i,
    title: "The AI service cut the request off",
    said: "It stopped answering partway through. This is usually temporary on the service's side, and trying again usually works.",
    retryable: true,
  },
  {
    test: /\b(500|502|503|504|529)\b|overloaded|unavailable|bad gateway|internal server error|server error/i,
    title: "The AI service is having problems",
    said: "It returned an error on its side. This is usually temporary. Try again in a minute.",
    retryable: true,
  },
  {
    test: /time[d ]?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|network|socket hang up/i,
    title: "Foundry could not reach the AI service",
    said: "The connection to the AI service failed. Trying again normally works; if it keeps happening, the service may be down.",
    retryable: true,
  },
];

/** A model-call error in plain words. Unknown errors still get a sentence, and keep their raw text as detail. */
export function explainModelError(raw: string | null | undefined): PiTurnError {
  const detail = String(raw ?? "").trim();
  const rule = RULES.find((r) => r.test.test(detail));
  return rule
    ? { title: rule.title, said: rule.said, retryable: rule.retryable, ...(detail ? { detail } : {}) }
    : {
        title: "The AI service returned an error",
        said: "Forge's request to the AI service failed. Trying again often works.",
        retryable: true,
        ...(detail ? { detail } : {}),
      };
}

/** How a turn that did not finish normally is explained — the failure card's content. */
export function turnFailure(
  ended: "failed" | "timeout" | "exited" | "refused",
  opts: { modelError?: string | null; minutes: number; exitCode?: number | null; stderr?: string; reason?: string },
): PiTurnError {
  if (ended === "refused") {
    return {
      title: "Forge could not take this message",
      said: opts.reason ?? "The message was refused before Forge read it. Try again in a moment.",
      retryable: true,
    };
  }
  if (ended === "failed") {
    const e = explainModelError(opts.modelError);
    return { ...e, said: `${e.said} It was already retried automatically.` };
  }
  if (ended === "timeout") {
    return {
      title: `This took longer than ${opts.minutes} minutes, so it was stopped`,
      said: "What Forge wrote so far is kept. Try again, or ask for the change in smaller parts.",
      retryable: true,
    };
  }
  const detail = [opts.exitCode != null ? `exit ${opts.exitCode}` : "", (opts.stderr ?? "").slice(-500)].filter(Boolean).join(": ");
  return {
    title: "Forge stopped unexpectedly",
    said: "What it wrote so far is kept. Trying again starts it fresh, with the conversation remembered.",
    retryable: true,
    ...(detail ? { detail } : {}),
  };
}
