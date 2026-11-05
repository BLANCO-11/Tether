/**
 * Auth-failure logging/throttling (V3, FR-007 — research.md Decision 5).
 *
 * This is the ONLY rate-limit-shaped state this feature adds. Concurrency
 * ceilings on flow generation and execution starts (FR-006) already exist
 * — `flow-chat.service.ts`, `flow-generation-job.service.ts`,
 * `tenant-budget.service.ts` — and are not duplicated here.
 *
 * Per-process in-memory only (Decision 1): a restart clearing the throttle
 * is an accepted tradeoff, not a gap — the server runs as one process today.
 */
export interface AuthFailureRule {
  windowMs: number;
  max: number;
}

interface WindowCounter {
  count: number;
  windowStart: number;
}

/**
 * The window arithmetic, once.
 *
 * `authFailureThrottle` below is a naming wrapper over this — it counts
 * failures, and the only difference is which events a caller chooses to count.
 * Two copies of "has this key exceeded N in the last W ms" would drift in the
 * direction where one of them stops expiring windows, which reads as a caller
 * being throttled for ever with nothing to point at.
 */
export function fixedWindowLimiter(rule: AuthFailureRule) {
  const state = new Map<string, WindowCounter>();

  function current(key: string): WindowCounter {
    const existing = state.get(key);
    const now = Date.now();
    if (!existing || now - existing.windowStart > rule.windowMs) {
      const fresh = { count: 0, windowStart: now };
      state.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  return {
    /** Count one event against `key`. */
    record(key: string) {
      current(key).count += 1;
    },
    /** Has `key` reached the ceiling inside the current window? */
    isLimited(key: string): boolean {
      return current(key).count >= rule.max;
    },
    /**
     * Count this event and answer whether it should be refused. One call, so a
     * caller cannot check-then-forget-to-record (which silently disables the
     * limit) or record twice (which halves the ceiling).
     */
    hit(key: string): boolean {
      current(key).count += 1;
      return current(key).count > rule.max;
    },
  };
}

export function authFailureThrottle(rule: AuthFailureRule) {
  const window = fixedWindowLimiter(rule);
  return {
    recordFailure(ip: string) {
      window.record(ip);
    },
    isThrottled(ip: string): boolean {
      return window.isLimited(ip);
    },
  };
}
