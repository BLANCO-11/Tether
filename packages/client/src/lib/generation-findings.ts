// src/lib/generation-findings.ts — the two shapes a generation failure's
// `findings` arrives in, and why only one of them used to render. I-100.
//
// ── ⚠ THE DEFECT ────────────────────────────────────────────────────────────
//
// `GenerationJob["result"].findings` is typed `unknown`, and two different
// server-side errors populate it:
//
//   FlowValidationError  → objects: { rule, stepId, message }   (caps, refs)
//   FlowDraftError       → plain STRINGS                        (the redraft loop)
//
// `/flows/new`'s failure screen read `f.stepId`, `f.rule` and `f.message` off
// every entry. For a string all three are `undefined`, so each finding rendered
// an EMPTY ROW — and the string shape is the one a person actually hits, because
// it is what "could not draft a valid flow in 3 attempts" throws. The findings
// it carries are the useful part: they name the step, the field, and the
// expression that would have been right.
//
// ⚠ The typecheck could not catch it. `findings?: unknown` accepts any access,
// and the client's own type was hand-written. Same family as I-97 — a
// hand-declared shape that says nothing lets a wrong render ship.

export type GenerationFinding = {
  rule?: string;
  stepId?: string;
  /** ⚠ Required here, unlike on the wire. A finding with no text is not a finding. */
  message: string;
};

/**
 * Both shapes, as one list a screen can render.
 *
 * ⚠ Anything it cannot read becomes `JSON.stringify(f)` rather than being
 * dropped. A finding silently discarded is the original defect with a tidier
 * implementation — the screen would again look like there was nothing to say.
 * Empty strings ARE dropped, because a blank row is what this exists to stop.
 */
export function normaliseFindings(raw: unknown): GenerationFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap<GenerationFinding>((f) => {
    if (typeof f === "string") return f.trim() ? [{ message: f }] : [];
    if (f && typeof f === "object") {
      const o = f as { rule?: unknown; stepId?: unknown; message?: unknown };
      const message =
        typeof o.message === "string" && o.message.trim() ? o.message : JSON.stringify(f);
      return [{
        message,
        ...(typeof o.rule === "string" ? { rule: o.rule } : {}),
        ...(typeof o.stepId === "string" ? { stepId: o.stepId } : {}),
      }];
    }
    return [];
  });
}

/**
 * Did the drafter run out of attempts, as opposed to failing some other way?
 *
 * ⚠ **This exists because the explanation it gates was hardcoded and wrong
 * within an hour of shipping** (`issues.md` I-102). A `failed` job covers a
 * drafter that could not hold the shape, a flow id already taken, a cap
 * exceeded, a ref that does not exist — and *"the designer could not produce a
 * valid flow in three attempts"* is true of exactly one of them. Printed over
 * the others it is a confident wrong diagnosis, which is worse than the bare
 * server message it was added to improve on. That is I-95's shape: copy accurate
 * about one path, shown over another.
 *
 * ⚠ Matched on the server's own wording, which is a COUPLING and is stated as
 * one: `draftFlow` throws ``could not draft a valid flow in ${MAX_DRAFT_ATTEMPTS}
 * attempts``. It fails CLOSED — an unrecognised message gets the message alone,
 * with no explanation and no suggestion, which is what the screen did before and
 * is honest.
 */
export function ranOutOfAttempts(message: string | undefined | null): boolean {
  return /could not draft a valid flow in \d+ attempts/.test(message ?? "");
}

/**
 * Did the drafting call never get an answer out of the model gateway, as
 * opposed to the drafter answering badly?
 *
 * ⚠ **This exists because a real gateway outage rendered as no reason at all**
 * (2026-08-18). `google/gemma-4-26B-A4B-it` started returning 502 from the
 * gateway, and the failure screen printed the honest-but-unreadable result: a
 * raw nginx error page, JSON-escaped, truncated mid-word at 300 characters by
 * `inference.service.ts`'s `text.slice(0, 300)` — *"drafting call failed:
 * gateway returned 502: {\"error\":{\"message\":\"litellm.BadGatewayError …
 * <html>…502 Bad Gateway…Received Model Group=google/gemm"*. `ranOutOfAttempts`
 * was correctly false, so BOTH explanatory blocks were suppressed and the blob
 * was the whole screen. It was read as the guardrail rejecting the request — the
 * one thing it was not — which is worse than saying nothing, because it sends
 * the person to rewrite a goal that was never the problem.
 *
 * ⚠ Same fail-closed contract as `ranOutOfAttempts`, and the same COUPLING
 * stated as one: every message in this class comes from `inference.service.ts`,
 * which throws ``gateway returned ${res.status}: …``, `"gateway returned a
 * non-JSON body"` or `"gateway returned no message content"`. Anything else
 * still gets the bare message with no explanation.
 *
 * ⚠ It deliberately does NOT distinguish 5xx from 4xx. Both are statements about
 * the model endpoint and its configuration — down, wrong model name, rejected
 * key — and none is a statement about the goal, which is the only distinction
 * the screen draws. Narrowing it to 5xx would put a 400 for an unknown model
 * back in the no-reason-at-all bucket, which is the defect this closes.
 */
export function gatewayFailed(message: string | undefined | null): boolean {
  return /gateway returned (\d{3}|a non-JSON body|no message content)/.test(message ?? "");
}
