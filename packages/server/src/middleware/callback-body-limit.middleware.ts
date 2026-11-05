import type { Request, Response, NextFunction } from "express";

/**
 * The step-callback body bound — step-payload-bounds, plan Decisions 1 and 2.
 *
 * ── The failure this exists for ──────────────────────────────────────────────
 *
 * Execution `05aca859-…`: a tool returned 7.19 MiB, the next step (an
 * `llm_complete`) inlined the whole payload into its own request body, and
 * `POST /api/steps/tool` answered
 *
 *     {"error":"request_error","message":"request entity too large"}
 *
 * from `express.json({ limit: "2mb" })`. That is everything a person got. No
 * request id to grep, no size, no limit, no execution, no remedy — and two hops
 * upstream of ops-api's *"input is 7,539,026 characters; the limit is 32,000.
 * Summarise or filter upstream — this step is a text transformer, not a bulk
 * reader"*, which is the actual diagnosis.
 *
 * ── Why a middleware and not a mapping in the error handler ──────────────────
 *
 * body-parser's 413 arrives with the size, the limit and the route already
 * DISCARDED — by then there is nothing left to name. `Content-Length` is
 * readable before any of that, so the refusal can carry both numbers and the
 * execution, which is the whole point of the feature.
 *
 * ── Content-Length only, and what that deliberately does not cover ──────────
 *
 * This reads the declared length and nothing else. A chunked request sends no
 * `Content-Length`, so it passes straight through to `express.json({ limit })`
 * mounted directly behind — which still refuses it, with body-parser's own
 * poorer message. That is an accepted floor, not an oversight: the alternative
 * is counting bytes as they stream, which means buffering to decide whether to
 * buffer. Kestra's `http.Request` sends `Content-Length` (measured on the
 * incident's own taskrun), so the path that produced this bug is covered, and
 * the parser behind is the backstop for the path that is not.
 *
 * ⚠ **It must never read `req.body`.** There is no body yet — this is mounted
 * ABOVE the parser, which is the only position from which the refusal can happen
 * before 8 MB is allocated. A test asserts the absence.
 */
export function callbackBodyLimit(limitBytes: number) {
  return function callbackBodyLimitHandler(req: Request, res: Response, next: NextFunction) {
    const declared = req.header("content-length");

    // Absent (chunked, or a GET) → the parser behind is the backstop.
    if (declared === undefined) return next();

    const actualBytes = Number(declared);
    // ⚠ `Number("")` is 0 and `Number("abc")` is NaN. Neither is a length we can
    // refuse on, and inventing one would refuse a request whose size we do not
    // know — failing closed on a header a caller controls, over a limit that is
    // only a transport bound. Pass it to the parser, which will not be fooled.
    if (!Number.isFinite(actualBytes)) return next();

    if (actualBytes <= limitBytes) return next();

    /**
     * `flowExecutionId` comes from `req.stepAuth` when the step-token middleware
     * has already resolved it, and is OMITTED otherwise.
     *
     * ⚠ Never read from the body — the body is the thing we are refusing to
     * parse, and a caller-supplied execution id on a refusal path would be an
     * unauthenticated claim rendered as fact. `/api/executions/*` has mixed
     * per-route auth, so there is legitimately no execution to name there; the
     * message says "a step callback" rather than "this run" in that case, which
     * is a smaller claim and a true one.
     */
    const flowExecutionId = req.stepAuth?.flowExecutionId;

    // ⚠ ONE line, and NO part of the body in it. At this size the body is both
    // tenant data and unreadable in a log.
    console.error(
      `[413] [${req.id}] callback body ${actualBytes} > ${limitBytes} ` +
        `on ${req.method} ${req.originalUrl}` +
        (flowExecutionId ? ` execution=${flowExecutionId}` : ""),
    );

    const body = {
      /**
       * ⚠ **Never `request_error`.** That name is already produced by
       * body-parser's own 413, by every `ZodError`, and by every 4xx a service
       * throws — four unrelated causes behind one string is a name no caller can
       * switch on. Stable; do not rephrase it.
       */
      error: "callback_payload_too_large",
      message:
          `${flowExecutionId ? "This step sent" : "A step callback sent"} ${megabytes(actualBytes)} to the server; ` +
        `a step can send at most ${megabytes(limitBytes)} at once. It is carrying whole data (all the rows) rather than ` +
        `what the next part needs — send a summary or only the rows that matter.`,
      requestId: req.id,
      // Both numbers, so acting on this needs no sentence parsing.
      actualBytes,
      limitBytes,
      ...(flowExecutionId ? { flowExecutionId } : {}),
    };

    /**
     * ⚠ Answer only once the upload has been READ (and thrown away). Answering first and closing the connection while
     * the step is still sending makes the sender's write fail — Python's urllib reports `Broken pipe` and the refusal
     * above, the only useful thing in this whole exchange, is never seen (2026-10-12, a 103k-row email). Discarding
     * costs bandwidth, never memory. Past `DRAIN_FACTOR`× the limit the connection is cut after all.
     */
    let seen = 0;
    let answered = false;
    const answer = () => {
      if (answered) return;
      answered = true;
      res.status(413).json(body);
    };
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > limitBytes * DRAIN_FACTOR) req.destroy();
    });
    req.on("end", answer);
    req.on("error", () => {});
    req.on("close", () => {
      if (!answered && !req.destroyed) answer();
    });
    req.resume();
  };
}

/** How far past the limit an upload is still read so its sender can get the refusal. */
const DRAIN_FACTOR = 40;

function megabytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
