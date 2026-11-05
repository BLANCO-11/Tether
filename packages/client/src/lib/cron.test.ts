// src/lib/cron.test.ts — the shape check mirrors the compiler, and the
// description refuses to guess.
import { describe, expect, it } from "vitest";
import {
  buildCron,
  CRON_FREQUENCIES,
  DEFAULT_CRON_CHOICE,
  describeCron,
  looksLikeCron,
  type CronChoice,
  type CronFrequency,
} from "./cron";

describe("looksLikeCron", () => {
  it("accepts 5 and 6 field expressions, as the compiler does", () => {
    expect(looksLikeCron("0 9 * * 1")).toBe(true);
    expect(looksLikeCron("0 0 9 * * 1")).toBe(true);
  });

  it("rejects the wrong number of fields and non-cron characters", () => {
    expect(looksLikeCron("0 9 * *")).toBe(false);
    expect(looksLikeCron("0 9 * * 1 2 3")).toBe(false);
    expect(looksLikeCron("every monday")).toBe(false);
    expect(looksLikeCron("@daily")).toBe(false); // Kestra takes cron, not macros
  });
});

describe("describeCron", () => {
  it("describes the shapes this product's own presets produce", () => {
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("30 6 * * 1")).toBe("Every Monday at 06:30");
    expect(describeCron("0 8 1 * *")).toBe("On day 1 of every month at 08:00");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
  });

  it("says what `every N days` in cron ACTUALLY means", () => {
    // ⚠ `*/3` in day-of-month restarts on the 1st of each month — it is not a
    // rolling three-day cycle. "Every 3 days" is exactly the phrase a person
    // types expecting the other behaviour, so the caveat is in the sentence
    // rather than left for them to discover on the 31st.
    expect(describeCron("0 7 */3 * *")).toBe(
      "Every 3 days at 07:00 — counting from the 1st of each month",
    );
  });

  it("returns null rather than guessing at anything else", () => {
    // ⚠ The half that matters. A wrong plain-English description of when
    // something fires is the sentence somebody quotes back after the batch went
    // out at the wrong hour. Kestra owns cron; this only recognises.
    expect(describeCron("0 9 L * *")).toBeNull();
    expect(describeCron("0 9 * * 1#2")).toBeNull();
    expect(describeCron("0 9 1-15 * 1,3")).toBeNull();
    expect(describeCron("0 0 9 * * 1")).toBeNull(); // 6-field: valid, not described
  });

  it("returns null for out-of-range values rather than printing them", () => {
    expect(describeCron("0 99 * * *")).toBeNull();
    expect(describeCron("70 9 * * *")).toBeNull();
  });
});

// ── buildCron: the picker's output set is describeCron's input set ──────────

describe("buildCron", () => {
  /**
   * Every choice the picker can express. Not a sample — the full cross product
   * of the controls, so the property below is checked over the picker's whole
   * reachable output rather than over the five examples somebody thought of.
   */
  function everyChoice(): CronChoice[] {
    const out: CronChoice[] = [];
    for (const frequency of CRON_FREQUENCIES) {
      for (const hour of [0, 7, 15, 23]) {
        for (const minute of [0, 30, 59]) {
          for (const weekday of [0, 2, 6]) {
            for (const dayOfMonth of [1, 15, 31]) {
              for (const interval of [1, 3, 6, 12]) {
                out.push({ frequency, hour, minute, weekday, dayOfMonth, interval });
              }
            }
          }
        }
      }
    }
    return out;
  }

  it("enumerates a non-empty set of choices", () => {
    // ⚠ The control for the property below. A property asserted over an empty
    // list passes for ever and reads exactly like one that holds (I-38), and
    // this is the cheapest possible way for that to happen — one typo in a
    // loop bound.
    expect(everyChoice().length).toBeGreaterThan(500);
  });

  it("⚠ PROPERTY: every schedule the picker can build reads back in plain English", () => {
    /**
     * ⚠ **THIS IS THE RULE THAT LETS `buildCron` EXIST.** A picker able to emit
     * an expression `describeCron` cannot read would render "a custom schedule"
     * for a schedule the person had just assembled by clicking — the screen
     * contradicting itself about the thing it was just told.
     *
     * It fails on exactly one edit: adding a `CronFrequency` without adding the
     * matching branch to `describeCron`. That is the edit this test exists for.
     */
    const undescribed = everyChoice()
      .map((c) => ({ choice: c, cron: buildCron(c) }))
      .filter((x) => describeCron(x.cron) === null);
    expect(undescribed).toEqual([]);
  });

  it("⚠ PROPERTY: everything it builds passes the shape check the compiler mirrors", () => {
    // `looksLikeCron` mirrors `assertCron`, so a string failing here would be
    // refused by the server after a round trip — a refusal caused by our own
    // controls rather than by anything the person did.
    const bad = everyChoice().map(buildCron).filter((c) => !looksLikeCron(c));
    expect(bad).toEqual([]);
  });

  it("covers each frequency with the shape describeCron names", () => {
    const at = (frequency: CronFrequency, over: Partial<CronChoice> = {}) =>
      buildCron({ ...DEFAULT_CRON_CHOICE, frequency, ...over });

    expect(at("daily", { hour: 9, minute: 30 })).toBe("30 9 * * *");
    expect(at("weekly", { hour: 15, minute: 0, weekday: 2 })).toBe("0 15 * * 2");
    expect(at("monthly", { hour: 7, minute: 0, dayOfMonth: 1 })).toBe("0 7 1 * *");
    expect(at("hourly", { minute: 0, interval: 6 })).toBe("0 */6 * * *");
    expect(at("everyNDays", { hour: 7, minute: 0, interval: 3 })).toBe("0 7 */3 * *");

    expect(describeCron(at("weekly", { hour: 15, minute: 0, weekday: 2 }))).toBe(
      "Every Tuesday at 15:00",
    );
  });

  it("⚠ pins the minute on `hourly`, never the hour", () => {
    // The same characters the other way round (`0 */6` → `*/6 0`) fires 60
    // times in one hour and then not again that day. Invisible until morning.
    expect(at2("hourly", 6)).toBe("0 */6 * * *");
    function at2(frequency: CronFrequency, interval: number) {
      return buildCron({ ...DEFAULT_CRON_CHOICE, frequency, interval, minute: 0 });
    }
  });

  it("clamps out-of-range control values instead of emitting invalid cron", () => {
    // ⚠ Total, never null: there is no combination of controls that produces a
    // string the server would refuse, so the picker needs no error state.
    const wild = buildCron({
      frequency: "weekly",
      hour: 99,
      minute: -4,
      weekday: 12,
      dayOfMonth: 0,
      interval: 0,
    });
    expect(looksLikeCron(wild)).toBe(true);
    expect(describeCron(wild)).not.toBeNull();
  });
});
