/**
 * Retention IS the replay window — GAPS §6.3.
 *
 * The gap was never that the number was wrong. It was that one number carries
 * two meanings and nothing said so at the point where somebody relies on the
 * second one. These assertions are therefore about the SENTENCE and about the
 * arithmetic that puts it beside a specific run, not about the value 30.
 *
 * ⚠ The one thing that must never be true here: a second source for the number.
 * Every case below reads it back from `retentionDays()` rather than writing
 * `30`, so a deployment that sets `KESTRA_RETENTION_DAYS=7` does not fail this
 * file — which is exactly what a hard-coded expectation would do, and the
 * "fix" for that is a second default.
 */
import { describe, it, expect } from "vitest";
import { replayWindow, retentionCoupling, retentionDays } from "./retention.js";
import { config } from "../config/index.js";

const DAY = 86_400_000;
const daysAgo = (n: number, from = Date.now()) => new Date(from - n * DAY);

describe("one number, one source", () => {
  it("reads config.kestra.retentionDays and nothing else", () => {
    expect(retentionDays()).toBe(config.kestra.retentionDays);
    expect(replayWindow(new Date()).days).toBe(config.kestra.retentionDays);
  });

  /**
   * The 410 refusal quotes this string, and `kestra:phase6` asserts the run-time
   * message matches /retained for N days/. If that phrase ever leaves this
   * function the harness fails — which is the point of pinning it here, where
   * the failure is one second rather than a container rebuild.
   */
  it("the coupling sentence names the window and both of its meanings", () => {
    const s = retentionCoupling();
    expect(s).toContain(`retained for ${retentionDays()} days`);
    expect(s).toMatch(/IS the replay window/);
    expect(s).toMatch(/shortening retention shortens/i);
  });

  it("the sentence tracks a changed window rather than promising 30 for ever", () => {
    expect(retentionCoupling(7)).toContain("retained for 7 days");
    expect(retentionCoupling(7)).not.toContain("30");
  });
});

describe("how much window this run has left", () => {
  it("a run from today has nearly the whole window", () => {
    const w = replayWindow(new Date());
    expect(w.daysRemaining).toBe(retentionDays());
    expect(w.expiringSoon).toBe(false);
    expect(w.expiresAt).not.toBeNull();
  });

  /**
   * The case the gap is actually about: nothing warned anybody until the 410,
   * which arrives after the run is already gone.
   */
  it("a run near the edge is flagged BEFORE it falls out of the window", () => {
    const w = replayWindow(daysAgo(retentionDays() - 2));
    expect(w.daysRemaining).toBe(2);
    expect(w.expiringSoon).toBe(true);
  });

  it("a run already past the window reads 0 and is NOT “expiring soon”", () => {
    const w = replayWindow(daysAgo(retentionDays() + 5));
    expect(w.daysRemaining).toBe(0);
    // It has expired. Warning about the future tense of something that already
    // happened is how people stop reading the warning.
    expect(w.expiringSoon).toBe(false);
  });

  /**
   * ⚠ The threshold is a FRACTION of the window, not a fixed week. A fixed week
   * against a 4-day retention warns nobody in time; against a 365-day retention
   * it warns from day 358. Both are the warning silently losing track of the
   * thing it warns about.
   */
  it("the warning threshold scales with the window", () => {
    const now = Date.now();
    /**
     * ⚠ The cast is deliberate, and the alternative is worse. `replayWindow`
     * refuses a `days` parameter on purpose — its docblock says so — because a
     * caller able to pass its own window IS the second source of the number
     * this whole module exists to prevent. So the only honest way to test a
     * different window is to move the one source and put it back, which is what
     * a deployment setting `KESTRA_RETENTION_DAYS` actually does.
     *
     * `config` is readonly to TypeScript and a plain mutable object at run time.
     * Narrowed to the one key so the cast cannot quietly grant more than that,
     * and restored in a `finally` so a failing expectation cannot leak a 4-day
     * window into the rest of the file.
     */
    const key = config.kestra as { retentionDays: number };
    const at = (days: number, age: number) => {
      const before = key.retentionDays;
      key.retentionDays = days;
      try {
        return replayWindow(daysAgo(age, now), new Date(now));
      } finally {
        key.retentionDays = before;
      }
    };
    // 4-day window: one day left is soon. A fixed 7-day threshold would have
    // been true on day 0 and therefore said nothing.
    expect(at(4, 3).expiringSoon).toBe(true);
    expect(at(4, 0).expiringSoon).toBe(false);
    // 365-day window: 8 days left is soon, 100 is not.
    expect(at(365, 357).expiringSoon).toBe(true);
    expect(at(365, 265).expiringSoon).toBe(false);
  });

  it("a run with no start time reports the window and refuses to invent a countdown", () => {
    const w = replayWindow(null);
    expect(w.days).toBe(retentionDays());
    expect(w.daysRemaining).toBeNull();
    expect(w.expiresAt).toBeNull();
    expect(w.note).toBe(retentionCoupling());
  });

  it("an unparseable timestamp is the same answer, not a NaN countdown", () => {
    expect(replayWindow("not a date").daysRemaining).toBeNull();
  });

  /**
   * Measured from the START, because `PurgeExecutions.endDate` compares against
   * the execution's start date. Using `endedAt` would over-promise on precisely
   * the long runs most likely to be replayed.
   */
  it("expiry is start + window, to the millisecond", () => {
    const started = new Date("2026-06-01T00:00:00.000Z");
    const w = replayWindow(started, new Date("2026-06-02T00:00:00.000Z"));
    expect(w.expiresAt).toBe(
      new Date(started.getTime() + retentionDays() * DAY).toISOString(),
    );
  });
});
