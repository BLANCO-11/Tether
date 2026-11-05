import { describe, it, expect, vi, beforeEach } from "vitest";
import { config } from "../config/index.js";
import { requireApiKey, resetAuthFailureThrottleForTests } from "./auth.middleware.js";

/**
 * FR-007 (research.md Decision 5) — the one genuinely open part of
 * FR-005/FR-007. `requireApiKey`'s failure branch used to be a bare 401 with
 * no logging and no throttle; a caller could brute-force the key at any rate.
 */
function ctx(ip: string, headerValue?: string) {
  const req = {
    ip,
    path: "/api/workspaces",
    header(name: string) {
      return name.toLowerCase() === "x-api-key" ? headerValue : undefined;
    },
  } as unknown as import("express").Request;
  let statusCode = 0;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  } as unknown as import("express").Response;
  let called = false;
  const next = (() => {
    called = true;
  }) as import("express").NextFunction;
  return {
    req,
    res,
    next,
    get status() {
      return statusCode;
    },
    get body() {
      return payload as { error?: string };
    },
    get headers() {
      return headers;
    },
    get called() {
      return called;
    },
  };
}

describe("requireApiKey — auth-failure logging and throttling", () => {
  beforeEach(() => {
    resetAuthFailureThrottleForTests();
  });

  it("a single bad key is a plain 401, not yet throttled", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = ctx("10.0.0.1", "wrong-key");
    requireApiKey(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.called).toBe(false);
    // Logged with enough context to investigate — IP and path — never the
    // presented (wrong) key value.
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("10.0.0.1"),
      expect.objectContaining({ path: "/api/workspaces" }),
    );
    const logged = JSON.stringify(spy.mock.calls[0]);
    expect(logged).not.toContain("wrong-key");
    spy.mockRestore();
  });

  it("throttles after repeated failures from the SAME ip, with Retry-After", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ip = "10.0.0.2";
    let last = ctx(ip, "wrong-key");
    for (let i = 0; i < 20; i++) {
      last = ctx(ip, "wrong-key");
      requireApiKey(last.req, last.res, last.next);
    }
    expect(last.status).toBe(429);
    expect(last.body.error).toBe("rate_limited");
    expect(last.headers["Retry-After"]).toBeTruthy();
    spy.mockRestore();
  });

  it("a different ip is never throttled by another ip's failures", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 20; i++) {
      const c = ctx("10.0.0.3", "wrong-key");
      requireApiKey(c.req, c.res, c.next);
    }
    const c = ctx("10.0.0.4", "wrong-key");
    requireApiKey(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    spy.mockRestore();
  });

  it("a correct key still passes through, unaffected", () => {
    const c = ctx("10.0.0.5", config.parentApiKey);
    requireApiKey(c.req, c.res, c.next);
    expect(c.called).toBe(true);
    expect(c.status).toBe(0);
  });

  /**
   * ── The comparison itself ──────────────────────────────────────────────────
   *
   * `!==` on strings short-circuits at the first differing byte, so the time it
   * takes leaks the length of the shared prefix. Against a long-lived shared
   * secret that is a usable oracle: guess a byte, keep the guess that took
   * longer, repeat. The throttle above makes it slow, not impossible, and does
   * nothing about an attacker with addresses to spare.
   *
   * ⚠ Timing cannot be asserted reliably in a unit test — a wall-clock
   * measurement here would be flaky on a shared runner and would pass for the
   * wrong reasons. What IS assertable is the behaviour that must survive the
   * change to `timingSafeEqual`, which throws on unequal lengths rather than
   * returning false. So these pin the shapes that would crash or wrongly pass:
   * a long prefix match, a key that is a prefix of the real one, and one that
   * extends it.
   */
  describe("the key comparison handles every length relationship", () => {
    const real = config.parentApiKey;

    it("refuses a key sharing all but the last byte", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const nearMiss = real.slice(0, -1) + (real.endsWith("x") ? "y" : "x");
      const c = ctx("10.0.1.1", nearMiss);
      requireApiKey(c.req, c.res, c.next);
      expect(c.called).toBe(false);
      expect(c.status).toBe(401);
      spy.mockRestore();
    });

    /** `timingSafeEqual` THROWS on unequal lengths; the length check must come first. */
    it("refuses a shorter key without throwing", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const c = ctx("10.0.1.2", real.slice(0, 2));
      expect(() => requireApiKey(c.req, c.res, c.next)).not.toThrow();
      expect(c.status).toBe(401);
      spy.mockRestore();
    });

    it("refuses a longer key that starts with the real one, without throwing", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const c = ctx("10.0.1.3", real + "extra");
      expect(() => requireApiKey(c.req, c.res, c.next)).not.toThrow();
      expect(c.status).toBe(401);
      spy.mockRestore();
    });

    /**
     * ⚠ Multi-byte input. `Buffer.byteLength` and `String.length` disagree for
     * anything outside ASCII, so a length check written against the string would
     * hand `timingSafeEqual` two different-sized buffers and throw a 500 —
     * turning a wrong credential into a server error an attacker can trigger.
     */
    it("refuses a multi-byte key without throwing", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const c = ctx("10.0.1.4", "é".repeat(real.length));
      expect(() => requireApiKey(c.req, c.res, c.next)).not.toThrow();
      expect(c.status).toBe(401);
      spy.mockRestore();
    });
  });
});
