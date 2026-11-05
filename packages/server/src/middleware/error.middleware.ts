import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { pgErrorCode } from "../db/pg-error.js";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    // ⚠ `requestId` here too, and it is a deliberate half-step BEYOND T01's
    // literal wording (which named only the generic 4xx branch below).
    // step-payload-bounds P0's stated purpose is *"every 4xx in the product
    // becomes greppable"*, and this is the most COMMON 4xx of all — every schema
    // rejection on every route lands here. Leaving it out would have satisfied
    // the task and missed the goal. `issues` is unchanged.
    return res.status(400).json({ error: "validation_error", issues: err.issues, requestId: req.id });
  }
  const statusCode = (err as { statusCode?: number })?.statusCode;
  const message = err instanceof Error ? err.message : "Unknown error";

  // ── A malformed identifier is the CALLER's mistake, not a crash ─────────────
  //
  // Postgres `22P02` (invalid_text_representation) is what a route gets when a
  // path parameter cannot be read as the column's type — overwhelmingly a
  // malformed uuid, e.g. `GET /api/workspaces/not-a-uuid/flows`. It arrived here
  // as an unclaimed 500, and since the 5xx branches stopped echoing `message`
  // that answer became `internal_error` with nothing to act on: a typo reported
  // as a server fault.
  //
  // ⚠ This is deliberately HERE and not a `validate({ params })` retrofit across
  // the 152 `req.params` reads in `src/routes`. Those params are uuids handed to
  // parameterized queries, so there is no injection to close; the only real
  // defect was the status code, and one branch fixes it for every route at once.
  // A 17-file mechanical retrofit would risk a 400 on a screen that works today
  // for a class of bug that does not exist. `@foundry/shared`'s `validate` says
  // the same thing about scope in its own docblock.
  //
  // ⚠ The value is NOT echoed. It is the caller's own input so it discloses
  // nothing about this process, but `err.message` also carries the column and
  // relation it failed against, which is internal shape.
  //
  // ⚠ Read through `pgErrorCode`: from drizzle-orm 0.44 the SQLSTATE is on `err.cause`, not `err`.
  if (pgErrorCode(err) === "22P02") {
    console.error(`[error 400] [${req.id}] invalid identifier`, message);
    return res.status(400).json({
      error: "request_error",
      message: "a path or query value is not a valid identifier for this resource",
      requestId: req.id,
    });
  }

  // ── An explicit 5xx is a DIAGNOSIS, not a crash ────────────────────────────
  //
  // ⚠ This branch used to be `>= 400 && < 500`, so every deliberate 5xx a
  // service threw arrived at the client as a 500. The message survived and the
  // status did not, which is the wrong half to lose: `502` means an upstream we
  // depend on refused, `503` means it was unreachable, and `500` means this
  // process has a bug. Three different incidents, one of them ours.
  //
  // Concretely, it made `flowService.testRun`'s "Kestra refused the run" a 500,
  // and CLAUDE.md's *"Kestra unreachable → 503"* untrue at the wire. Logged
  // either way, because a 5xx is worth a line in the log whoever's fault it is.
  //
  // FR-004 — `message` here can be an upstream body echoed verbatim
  // (`flow.service.ts`'s `Kestra rejected the compiled flow: ${JSON.stringify(...)}`
  // is exactly this shape), so it never crosses the wire; only the status and
  // the request id do. The real message is still logged, tagged with req.id.
  if (statusCode && statusCode >= 500) {
    console.error(`[error ${statusCode}] [${req.id}]`, message);
    // ⚠ `expose` is OPT-IN and is NOT an echo of `err.message`. FR-004's rule is that a
    // message we did not write — an upstream body, a driver error, a connection string —
    // must never cross the wire, and that rule is unchanged: nothing here reads
    // `err.message`. An `expose` object exists only because the thrower constructed it
    // deliberately, field by field, as the thing a caller should see. The RBAC guard's
    // wiring 500 is the case that needs it: "you mounted this guard where it cannot
    // decide" is useless as a bare `upstream_error`, and it is our own sentence about
    // our own routing table, not anybody's upstream.
    const exposed = responseBodyOf(err);
    if (exposed) {
      return res.status(statusCode).json({ ...exposed, requestId: req.id });
    }
    return res.status(statusCode).json({ error: "upstream_error", requestId: req.id });
  }

  if (statusCode && statusCode >= 400 && statusCode < 500) {
    // `findings` travels when the thrower attached it — today that is
    // `FlowValidationError`, whose whole point is that the finding is
    // structured and LLM-consumable (phase-5.md: a bare "invalid tool" wastes a
    // redraft cycle). Flattening it to `message` here would undo that at the
    // last hop, which is the least visible place to lose it.
    const findings = (err as { findings?: unknown })?.findings;
    // Phase 2: the checker's structured diagnostics, same rule as `findings`.
    const diagnostics = (err as { diagnostics?: unknown })?.diagnostics;
    // Sharing boundaries phase 4: what a workflow still needs before it can run — each with who fixes it.
    const needs = (err as { needs?: unknown })?.needs;
    // ⚠ `requestId` travels on this branch too — step-payload-bounds D2. It was
    // the one branch without it, so the most common failure a caller can cause
    // was the one they could not correlate to a server log line: the measured
    // 413 on execution `05aca859-…` arrived as four words with nothing to grep.
    // `message` and `findings` are UNCHANGED — a 4xx message is our own
    // sentence, not an echoed upstream body, and `FlowValidationError`'s
    // structured finding is what stops a bare "invalid tool" wasting a redraft
    // cycle.
    // ⚠ Same opt-in rule as the 5xx branch above, and the same precedent as `findings`:
    // a thrower that built a structured envelope gets to keep its shape at the last hop.
    // This is what carries contracts/api.md §E — `{error, reason, message, permission}` —
    // so a client can tell "you are not signed in" from "you need a grant" from "somebody
    // wired the guard wrongly" without parsing prose.
    const exposed = responseBodyOf(err);
    if (exposed) {
      return res.status(statusCode).json({ ...exposed, requestId: req.id });
    }
    return res
      .status(statusCode)
      .json({ error: "request_error", message, requestId: req.id, ...(findings ? { findings } : {}), ...(diagnostics ? { diagnostics } : {}), ...(needs ? { needs } : {}) });
  }
  // Same rule as the branch above: an unclaimed failure's message can be a raw
  // driver/fetch error (hostnames, connection strings) with no scrubbing layer
  // of its own — never echoed, only logged against req.id.
  console.error(`[error] [${req.id}]`, err);
  res.status(500).json({ error: "internal_error", requestId: req.id });
}


/**
 * A response body a thrower built deliberately, field by field, as the thing a caller
 * should see.
 *
 * ⚠ **A SYMBOL, AND NOT A PROPERTY CALLED `expose`, BECAUSE THAT NAME IS TAKEN.**
 * `http-errors` — which `body-parser` and much of the Express ecosystem throw — sets
 * `err.expose` to a **boolean**. The first version of this used that name, and a 413
 * from the body parser arrived carrying `expose: true`; `{ ...true }` spreads to `{}`,
 * so the response lost `error: "request_error"` entirely and became a bare
 * `{ requestId }`. Caught by `steps-body-limit.test.ts`'s control, not by reading.
 * A `Symbol.for` key cannot collide with anything an upstream library sets.
 */
export const RESPONSE_BODY = Symbol.for("foundry.error.responseBody");

function responseBodyOf(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const body = (err as Record<symbol, unknown>)[RESPONSE_BODY];
  // Belt and braces: even under the symbol, only an object is ever spread.
  return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
}

/** Attach a deliberate response body to an error. */
export function withResponseBody<E extends Error>(err: E, body: Record<string, unknown>): E {
  Object.defineProperty(err, RESPONSE_BODY, { value: body, enumerable: false });
  return err;
}

// Wrap async route handlers so thrown errors reach the error middleware.
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  fn: T,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    /**
     * ⚠ The promise is RETURNED, not dropped. Express 4 ignores a handler's
     * return value, so this changes nothing at the wire — and it is what lets a
     * test `await` a middleware this wraps. `run-requester.test.ts` does exactly
     * that, and a wrapper that swallowed the promise made a gate untestable the
     * moment it was made crash-safe.
     */
    return fn(req, res, next).catch(next);
  };
}
