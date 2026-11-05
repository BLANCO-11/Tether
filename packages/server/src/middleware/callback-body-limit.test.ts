/**
 * `callbackBodyLimit` — step-payload-bounds T05.
 *
 * ⚠ These are UNIT tests of the handler. What they cannot see is the MOUNT
 * ORDER, which is half the feature: a correct refusal mounted below
 * `express.json` never runs, and every assertion here would still pass. That is
 * `routes/steps-body-limit.test.ts`'s job, through `createApp()`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { callbackBodyLimit } from "./callback-body-limit.middleware.js";

const LIMIT = 5_242_880;

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

/** A request carrying only what this middleware is allowed to read. */
function req(opts: { length?: string; executionId?: string; body?: unknown } = {}) {
  return {
    id: "req-test",
    method: "POST",
    originalUrl: "/api/steps/tool",
    header: (n: string) => (n.toLowerCase() === "content-length" ? opts.length : undefined),
    // The refusal is sent once the upload has been read; this stand-in has nothing left to read.
    on(ev: string, cb: () => void) {
      if (ev === "end") cb();
      return this;
    },
    resume() {},
    ...(opts.executionId
      ? { stepAuth: { workspaceId: "ws-1", flowExecutionId: opts.executionId } }
      : {}),
    ...(opts.body === undefined ? {} : { body: opts.body }),
  } as never;
}

afterEach(() => vi.restoreAllMocks());

describe("within the limit, it does nothing at all", () => {
  it("a small body calls next() and writes no response", () => {
    const next = vi.fn();
    const { r, out } = res();
    callbackBodyLimit(LIMIT)(req({ length: "768" }), r as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(out.code).toBeUndefined();
    expect(out.body).toBeUndefined();
  });

  /**
   * ⚠ The boundary is `>`, not `>=`. A body of exactly the limit is admitted —
   * the same rule Legal's notice deadline teaches: an off-by-one at a boundary
   * refuses the last request that was still correct.
   */
  it("a body of EXACTLY the limit is admitted", () => {
    const next = vi.fn();
    callbackBodyLimit(LIMIT)(req({ length: String(LIMIT) }), res().r as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("over the limit, it refuses with everything a person needs", () => {
  it("413, the stable error name, both byte counts and the request id", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const next = vi.fn();
    const { r, out } = res();
    callbackBodyLimit(LIMIT)(req({ length: "8401233" }), r as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(out.code).toBe(413);
    expect(out.body).toMatchObject({
      error: "callback_payload_too_large",
      actualBytes: 8_401_233,
      limitBytes: LIMIT,
      requestId: "req-test",
    });
  });

  it("names the execution when the step token resolved one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    callbackBodyLimit(LIMIT)(
      req({ length: "8401233", executionId: "05aca859-91df-4472-be95-edcd7e0d967b" }),
      r as never,
      vi.fn(),
    );
    expect(out.body).toMatchObject({ flowExecutionId: "05aca859-91df-4472-be95-edcd7e0d967b" });
    expect(out.body as Record<string, unknown>).toHaveProperty("message");
    expect((out.body as { message: string }).message).toContain("This step sent");
  });

  /**
   * ⚠ OMITTED, not null and not invented. `/api/executions/*` has mixed
   * per-route auth so there is genuinely no execution to name, and the sentence
   * makes the smaller claim instead.
   */
  it("omits flowExecutionId entirely when there is no step auth", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    callbackBodyLimit(LIMIT)(req({ length: "8401233" }), r as never, vi.fn());
    expect(out.body).not.toHaveProperty("flowExecutionId");
    expect((out.body as { message: string }).message).toContain("A step callback sent");
  });

  it("the message carries both sizes and what to do instead", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, out } = res();
    callbackBodyLimit(LIMIT)(req({ length: "8401233" }), r as never, vi.fn());
    const m = (out.body as { message: string }).message;
    expect(m).toContain("8.0 MB");
    expect(m).toContain("5.0 MB");
    expect(m).toContain("summary");
  });

  it("logs exactly one line, with the numbers and the execution and NO body", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    callbackBodyLimit(LIMIT)(
      req({ length: "8401233", executionId: "exec-1", body: { secret: "should never be logged" } }),
      res().r as never,
      vi.fn(),
    );
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain("[413] [req-test] callback body 8401233 > 5242880");
    expect(line).toContain("execution=exec-1");
    expect(line).not.toContain("should never be logged");
  });

  it("omits the execution clause from the log when there is none", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    callbackBodyLimit(LIMIT)(req({ length: "8401233" }), res().r as never, vi.fn());
    expect(String(spy.mock.calls[0]?.[0])).not.toContain("execution=");
  });
});

describe("a length it cannot read is not a length it may refuse on", () => {
  it("no Content-Length at all → next() (the parser behind is the backstop)", () => {
    const next = vi.fn();
    const { out } = res();
    callbackBodyLimit(LIMIT)(req({}), res().r as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(out.code).toBeUndefined();
  });

  it("a non-numeric Content-Length → next()", () => {
    const next = vi.fn();
    callbackBodyLimit(LIMIT)(req({ length: "not-a-number" }), res().r as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("an empty Content-Length → next() (Number('') is 0, which is not a size)", () => {
    const next = vi.fn();
    callbackBodyLimit(LIMIT)(req({ length: "" }), res().r as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

/**
 * ⚠ THE LOAD-BEARING ASSERTION IN THIS FILE.
 *
 * The refusal has to happen before the body is allocated — that is the only
 * reason this middleware exists rather than a mapping in the error handler. A
 * future edit that reaches for `req.body` (to name a step, say) would silently
 * move the middleware's requirement below the parser and reintroduce the 8 MB
 * allocation this is here to prevent. So the property is asserted directly: the
 * handler still refuses correctly when reading `req.body` would THROW.
 */
describe("it never touches req.body", () => {
  it("refuses correctly even when reading req.body throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const trap = {
      id: "req-trap",
      method: "POST",
      originalUrl: "/api/steps/tool",
      header: (n: string) => (n.toLowerCase() === "content-length" ? "9000000" : undefined),
      get body() {
        throw new Error("req.body was read — the middleware is below the parser");
      },
      on(ev: string, cb: () => void) {
        if (ev === "end") cb();
        return this;
      },
      resume() {},
    } as never;
    const { r, out } = res();
    expect(() => callbackBodyLimit(LIMIT)(trap, r as never, vi.fn())).not.toThrow();
    expect(out.code).toBe(413);
  });

  it("and passes a small one through without reading it either", () => {
    const trap = {
      id: "req-trap",
      method: "POST",
      originalUrl: "/api/steps/tool",
      header: (n: string) => (n.toLowerCase() === "content-length" ? "100" : undefined),
      get body() {
        throw new Error("req.body was read");
      },
    } as never;
    const next = vi.fn();
    expect(() => callbackBodyLimit(LIMIT)(trap, res().r as never, next)).not.toThrow();
    expect(next).toHaveBeenCalledOnce();
  });
});

/**
 * The bug this drain exists for (2026-10-12): the refusal was sent and the connection closed while the step was
 * still uploading, so the sender's write failed with `Broken pipe` and the refusal was never read. Over a real socket.
 */
describe("over a real connection, the sender reads the refusal", () => {
  // `Connection: close` is what Python's urllib sends — and what makes Node close the socket once it has answered.
  it("a large upload gets the 413 and its message, not a broken pipe", async () => {
    const express = (await import("express")).default;
    const app = express();
    app.use(callbackBodyLimit(1_000_000));
    app.post("/", (_req, res) => res.status(200).end());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const body = Buffer.alloc(30 * 1024 * 1024, 120);
      // Like Python's urllib: send the WHOLE body, and only then read the answer. A write that fails is the bug.
      const net = await import("node:net");
      const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1");
        let raw = "";
        sock.on("data", (c) => (raw += c));
        sock.on("error", reject);
        sock.write(`POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
        sock.write(body, (err) => {
          if (err) return reject(err);
          sock.on("end", () => {
            const [head, text = ""] = raw.split("\r\n\r\n");
            resolve({ status: Number(head!.split(" ")[1]), text });
          });
        });
      });
      expect(answer.status).toBe(413);
      expect(JSON.parse(answer.text)).toMatchObject({ error: "callback_payload_too_large" });
    } finally {
      server.close();
    }
  });
});
