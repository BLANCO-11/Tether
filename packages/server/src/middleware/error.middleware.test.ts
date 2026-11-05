import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "./error.middleware.js";
import { ZodError } from "zod";

/**
 * What a status code MEANS, at the wire.
 *
 * ⚠ The regression this file exists for: the handler honoured `statusCode` only
 * in the 4xx range, so every deliberate 5xx a service threw arrived as a 500.
 * The message survived and the status did not — the wrong half to lose. `502`
 * means an upstream refused, `503` means it was unreachable, and `500` means
 * this process has a bug; only the last one is ours to fix, and a client (or a
 * pager) switching on the number was told the wrong thing every time.
 *
 * It surfaced as a 500 on `POST …/test-run` for a flow whose required input was
 * not supplied — a caller mistake reported as a server crash.
 */

function res() {
  const out: { code?: number; body?: unknown } = {};
  const r = {
    status(c: number) {
      out.code = c;
      return r;
    },
    json(b: unknown) {
      out.body = b;
      return r;
    },
  };
  return { r, out };
}

const err = (message: string, statusCode?: number) =>
  Object.assign(new Error(message), statusCode === undefined ? {} : { statusCode });

describe("errorHandler honours what the thrower said", () => {
  it("a 4xx keeps its code", () => {
    const { r, out } = res();
    errorHandler(err("flow not found", 404), {} as never, r as never, (() => {}) as never);
    expect(out.code).toBe(404);
    expect(out.body).toMatchObject({ message: "flow not found" });
  });

  /** The regression. A 502 used to arrive as a 500. */
  it("a 502 is NOT flattened to 500", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    errorHandler(err("Kestra refused the run: …", 502), {} as never, r as never, (() => {}) as never);
    expect(out.code).toBe(502);
    expect(out.body).toMatchObject({ error: "upstream_error" });
    spy.mockRestore();
  });

  /** CLAUDE.md: *"Kestra unreachable → 503"*. That was untrue at the wire. */
  it("a 503 survives, so 'unreachable' does not read as 'crashed'", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    errorHandler(err("Kestra is unreachable", 503), {} as never, r as never, (() => {}) as never);
    expect(out.code).toBe(503);
    spy.mockRestore();
  });

  it("an error with no statusCode is still a 500 — an unclaimed failure is ours", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    errorHandler(err("cannot read property of undefined"), {} as never, r as never, (() => {}) as never);
    expect(out.code).toBe(500);
    expect(out.body).toMatchObject({ error: "internal_error" });
    spy.mockRestore();
  });

  it("a ZodError is a 400 with its issues, whatever else is true", () => {
    const { r, out } = res();
    const z = new ZodError([{ code: "custom", path: ["model"], message: "bad" }]);
    errorHandler(z, {} as never, r as never, (() => {}) as never);
    expect(out.code).toBe(400);
    expect(out.body).toMatchObject({ error: "validation_error" });
  });

  /**
   * FR-004 / research.md §5 — the upstream_error branch used to embed a raw
   * upstream body verbatim (`flow.service.ts:240`'s
   * `Kestra rejected the compiled flow: ${JSON.stringify(e.body ?? e.message)}`
   * is exactly this shape). After this feature, only an opaque code + the
   * request id cross the wire; the real message is still logged server-side.
   */
  it("a 5xx no longer echoes the thrown message — only an opaque code + requestId", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    const req = { id: "req-abc-123" };
    errorHandler(
      err("Kestra rejected the compiled flow: {\"secret\":\"leaked-token\"}", 502),
      req as never,
      r as never,
      (() => {}) as never,
    );
    expect(out.code).toBe(502);
    expect(out.body).toMatchObject({ error: "upstream_error", requestId: "req-abc-123" });
    expect(out.body).not.toHaveProperty("message");
    expect(JSON.stringify(out.body)).not.toContain("leaked-token");
    // The real detail must still be diagnosable server-side, tagged with the same id.
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("req-abc-123"),
      expect.stringContaining("leaked-token"),
    );
    spy.mockRestore();
  });

  it("an unclaimed (no statusCode) 5xx also no longer echoes the thrown message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    const req = { id: "req-def-456" };
    errorHandler(
      err("connect ECONNREFUSED 10.0.0.5:5432"),
      req as never,
      r as never,
      (() => {}) as never,
    );
    expect(out.code).toBe(500);
    expect(out.body).toMatchObject({ error: "internal_error", requestId: "req-def-456" });
    expect(out.body).not.toHaveProperty("message");
    expect(JSON.stringify(out.body)).not.toContain("10.0.0.5");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("req-def-456"),
      expect.anything(),
    );
    spy.mockRestore();
  });

  /**
   * ⚠ **THE SUBJECT CHANGED; THE PROPERTY DID NOT.** This asserted the same
   * thing about the agent runtime's own error type, whose branch fired first —
   * being more specific —
   * and echoed `message`, `status` and `body` verbatim, undoing the redaction
   * the generic 5xx branch performs a few lines below it. That branch and its
   * error type are gone with the runtime they belonged to, and the redaction is
   * now the generic branch's alone. Deleting the test with the branch would have
   * been the quiet option: an upstream carrying a credential and an internal
   * hostname is exactly the payload this rule exists for, whoever raised it.
   */
  it("an explicit 5xx does not echo the upstream body, message or status", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    const req = { id: "req-ghi-789" };
    const up = Object.assign(
      new Error("upstream refused: http://internal-runtime.svc:6800 rejected tth_live_leaked"),
      { statusCode: 502 },
    );
    errorHandler(up, req as never, r as never, (() => {}) as never);
    expect(out.code).toBe(502);
    expect(out.body).toMatchObject({ error: "upstream_error", requestId: "req-ghi-789" });
    expect(out.body).not.toHaveProperty("message");
    expect(out.body).not.toHaveProperty("body");
    expect(out.body).not.toHaveProperty("status");
    const wire = JSON.stringify(out.body);
    expect(wire).not.toContain("tth_live_leaked");
    expect(wire).not.toContain("internal-runtime");
    // Still diagnosable server-side, against the same request id.
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("req-ghi-789"),
      expect.stringContaining("internal-runtime"),
    );
    spy.mockRestore();
  });

  /**
   * ── A malformed uuid is a 400, not a 500 ───────────────────────────────────
   *
   * `GET /api/workspaces/not-a-uuid/flows` reaches Postgres, which raises
   * `22P02`. That arrived as an unclaimed 500 — and once the 5xx branches stopped
   * echoing `message`, the answer became a bare `internal_error`: a caller's typo
   * reported as a server fault with nothing to act on.
   */
  describe("a value Postgres cannot read as an identifier", () => {
    it("is a 400 that says what kind of thing was wrong", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { r, out } = res();
      const pgErr = Object.assign(
        new Error('invalid input syntax for type uuid: "not-a-uuid"'),
        { code: "22P02" },
      );
      errorHandler(pgErr, { id: "req-uuid-1" } as never, r as never, (() => {}) as never);
      expect(out.code).toBe(400);
      expect(out.body).toMatchObject({ error: "request_error", requestId: "req-uuid-1" });
      spy.mockRestore();
    });

    /**
     * ⚠ `err.message` names the relation and column it failed against, which is
     * internal shape — so the wire gets a fixed sentence and the log gets the
     * detail, exactly as the 5xx branches do.
     */
    it("does not echo Postgres's own message", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { r, out } = res();
      const pgErr = Object.assign(
        new Error('invalid input syntax for type uuid: "abc" at "flow_revisions.flow_id"'),
        { code: "22P02" },
      );
      errorHandler(pgErr, { id: "req-uuid-2" } as never, r as never, (() => {}) as never);
      const wire = JSON.stringify(out.body);
      expect(wire).not.toContain("flow_revisions");
      expect(wire).not.toContain("invalid input syntax");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("req-uuid-2"),
        expect.stringContaining("flow_revisions"),
      );
      spy.mockRestore();
    });

    /**
     * ⚠ The shape Drizzle actually throws (0.44+): the SQLSTATE is on `cause`. Every case above hands over a raw
     * driver error, and they all stayed green while this one would have been a 500.
     */
    it("is still a 400 when Drizzle wraps the driver's error", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { r, out } = res();
      const raw = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: "22P02" });
      const wrapped = new Error("Failed query: select ... where id = $1\nparams: not-a-uuid", { cause: raw });
      errorHandler(wrapped, { id: "req-uuid-w" } as never, r as never, (() => {}) as never);
      expect(out.code).toBe(400);
      expect(out.body).toMatchObject({ error: "request_error", requestId: "req-uuid-w" });
      spy.mockRestore();
    });

    /**
     * ⚠ THE CONTROL. Only `22P02` is a caller mistake. Every other Postgres
     * failure — a dropped connection, a constraint violation, a missing relation
     * — is this deployment's problem and must stay a 500, or a real incident
     * starts reading as "somebody typed the wrong id".
     */
    it("CONTROL — another Postgres error code is still a 500", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { r, out } = res();
      const pgErr = Object.assign(new Error('relation "flows" does not exist'), {
        code: "42P01",
      });
      errorHandler(pgErr, { id: "req-uuid-3" } as never, r as never, (() => {}) as never);
      expect(out.code).toBe(500);
      expect(out.body).toMatchObject({ error: "internal_error" });
      spy.mockRestore();
    });
  });

  /**
   * `findings` is structured and written to be acted on (`FlowValidationError`).
   * Flattening it into `message` at the last hop is the least visible place to
   * lose it.
   */
  it("findings travel on a 4xx", () => {
    const { r, out } = res();
    const e = Object.assign(new Error("refused"), {
      statusCode: 400,
      findings: [{ rule: "unknown_ref", stepId: "fetch" }],
    });
    errorHandler(e, {} as never, r as never, (() => {}) as never);
    expect(out.body).toMatchObject({ findings: [{ rule: "unknown_ref" }] });
  });
});

/**
 * Every 4xx names the log line that explains it — step-payload-bounds P0 (D2).
 *
 * ⚠ **The gap this closes was found by a real incident, and the shape of it is
 * the point.** Execution `05aca859-…` died on a 413 whose whole body was
 * `{"error":"request_error","message":"request entity too large"}`. Four words,
 * and — because this branch was the ONE that omitted `requestId`, while the two
 * 5xx branches and the `22P02` 400 all carried it — nothing to grep for in the
 * server log. The most common failure a caller can cause was the least
 * diagnosable one.
 *
 * `message` and `findings` are asserted UNCHANGED alongside the new field: a 4xx
 * message is our own sentence rather than an echoed upstream body (which is why
 * the 5xx branches drop theirs), and losing either while "adding an id" would be
 * the kind of fix that costs more than it buys.
 */
describe("a 4xx carries requestId", () => {
  const reqWith = (id: string) => ({ id }) as never;

  it("the generic 4xx branch — with its message intact", () => {
    const { r, out } = res();
    errorHandler(err("flow not found", 404), reqWith("req-404"), r as never, (() => {}) as never);
    expect(out.code).toBe(404);
    expect(out.body).toMatchObject({
      error: "request_error",
      message: "flow not found",
      requestId: "req-404",
    });
  });

  it("a 4xx carrying findings keeps BOTH the findings and the id", () => {
    const { r, out } = res();
    const e = Object.assign(new Error("refused"), {
      statusCode: 400,
      findings: [{ rule: "unknown_ref", stepId: "fetch" }],
    });
    errorHandler(e, reqWith("req-findings"), r as never, (() => {}) as never);
    expect(out.body).toMatchObject({
      findings: [{ rule: "unknown_ref", stepId: "fetch" }],
      requestId: "req-findings",
    });
  });

  /**
   * ⚠ Beyond T01's literal wording, and deliberately — see the comment on the
   * `ZodError` branch. This is the most common 4xx in the product (every schema
   * rejection on every route), so "every 4xx is greppable" is false without it.
   */
  it("a ZodError 400 too — the most common 4xx of all", () => {
    const { r, out } = res();
    const ze = new ZodError([
      { code: "invalid_type", expected: "string", received: "number", path: ["name"], message: "bad" },
    ] as never);
    errorHandler(ze, reqWith("req-zod"), r as never, (() => {}) as never);
    expect(out.code).toBe(400);
    expect(out.body).toMatchObject({ error: "validation_error", requestId: "req-zod" });
    // The issues are why this branch exists; an id must not displace them.
    expect((out.body as { issues?: unknown[] }).issues).toHaveLength(1);
  });

  it("the 22P02 400 already carried it, and still does", () => {
    const { r, out } = res();
    const e = Object.assign(new Error('invalid input syntax for type uuid: "nope"'), {
      code: "22P02",
    });
    errorHandler(e, reqWith("req-uuid"), r as never, (() => {}) as never);
    expect(out.code).toBe(400);
    expect(out.body).toMatchObject({ requestId: "req-uuid" });
  });

  /**
   * ⚠ CONTROL, and the one assertion that stops this change drifting. The 5xx
   * branches carry the id and NOT the message, because a 5xx message can be an
   * echoed upstream body (`flow.service.ts`'s `Kestra rejected the compiled
   * flow: …`). Adding an id to the 4xx branch must not be read as "echo more
   * everywhere".
   */
  it("CONTROL — a 5xx still carries the id and still refuses to echo the message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    errorHandler(err("Kestra rejected: <internal host>", 502), reqWith("req-502"), r as never, (() => {}) as never);
    expect(out.code).toBe(502);
    expect(out.body).toEqual({ error: "upstream_error", requestId: "req-502" });
    expect(JSON.stringify(out.body)).not.toContain("internal host");
    spy.mockRestore();
  });
});
