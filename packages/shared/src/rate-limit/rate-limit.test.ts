import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authFailureThrottle, fixedWindowLimiter } from "./index.js";

/**
 * `authFailureThrottle` is a naming wrapper over this, so these tests are the
 * ones that pin the window arithmetic. The suite below still runs against the
 * wrapper deliberately: the wrapper is what `auth.middleware.ts` imports, and a
 * refactor that broke only the wrapper would otherwise pass.
 */
describe("fixedWindowLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * ⚠ `hit` is `>` where `isLimited` is `>=`, and the difference is deliberate:
   * `hit` counts the request it is deciding about, so the Nth request must be
   * allowed and the (N+1)th refused. Getting this wrong gives a ceiling of N-1
   * and presents as "the documented limit is off by one".
   */
  it("hit() allows exactly `max` events, then refuses", () => {
    const limiter = fixedWindowLimiter({ windowMs: 60_000, max: 3 });
    expect(limiter.hit("k")).toBe(false);
    expect(limiter.hit("k")).toBe(false);
    expect(limiter.hit("k")).toBe(false);
    expect(limiter.hit("k")).toBe(true);
  });

  it("hit() counts on its own — a caller cannot check and forget to record", () => {
    const limiter = fixedWindowLimiter({ windowMs: 60_000, max: 1 });
    limiter.hit("k");
    expect(limiter.isLimited("k")).toBe(true);
  });

  it("keys are independent", () => {
    const limiter = fixedWindowLimiter({ windowMs: 60_000, max: 1 });
    limiter.hit("a");
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(false);
  });

  it("the window expires, so a refusal is never permanent", () => {
    const limiter = fixedWindowLimiter({ windowMs: 1_000, max: 1 });
    limiter.hit("k");
    expect(limiter.hit("k")).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(limiter.hit("k")).toBe(false);
  });
});

describe("authFailureThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not throttled until `max` failures land within the window", () => {
    const throttle = authFailureThrottle({ windowMs: 60_000, max: 3 });
    expect(throttle.isThrottled("1.2.3.4")).toBe(false);
    throttle.recordFailure("1.2.3.4");
    expect(throttle.isThrottled("1.2.3.4")).toBe(false);
    throttle.recordFailure("1.2.3.4");
    expect(throttle.isThrottled("1.2.3.4")).toBe(false);
    throttle.recordFailure("1.2.3.4");
    expect(throttle.isThrottled("1.2.3.4")).toBe(true);
  });

  it("keys are independent — one IP's failures never throttle another", () => {
    const throttle = authFailureThrottle({ windowMs: 60_000, max: 1 });
    throttle.recordFailure("1.2.3.4");
    expect(throttle.isThrottled("1.2.3.4")).toBe(true);
    expect(throttle.isThrottled("5.6.7.8")).toBe(false);
  });

  it("resets once the window elapses", () => {
    const throttle = authFailureThrottle({ windowMs: 1_000, max: 1 });
    throttle.recordFailure("1.2.3.4");
    expect(throttle.isThrottled("1.2.3.4")).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(throttle.isThrottled("1.2.3.4")).toBe(false);
  });
});
