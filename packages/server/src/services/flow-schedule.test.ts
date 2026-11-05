/**
 * The two rules behind `FlowSummary.schedule`.
 *
 * The field had SIX readers in `packages/client` and no producer at all, so
 * every screen said "Not scheduled" and the Scheduled tab matched nothing. What
 * is asserted here is not that the field exists — a route test would say that —
 * but the one decision inside it somebody will get wrong: WHICH revision
 * answers.
 */
import { describe, expect, it } from "vitest";
import { cronOfModel, firingRevisionOf } from "./flow-schedule.js";

describe("firingRevisionOf", () => {
  it("⚠ the ARMED revision when one is armed, not the draft on top of it", () => {
    expect(firingRevisionOf({ armedRevision: 2, draftRevision: 7 })).toBe(2);
  });

  it("the draft when nothing is armed — what publishing would deploy", () => {
    expect(firingRevisionOf({ armedRevision: null, draftRevision: 3 })).toBe(3);
  });

  it("null when there is no revision at all", () => {
    expect(firingRevisionOf({ armedRevision: null, draftRevision: 0 })).toBeNull();
  });

  it("CONTROL: revision 1 is a revision, not a falsy absence", () => {
    expect(firingRevisionOf({ armedRevision: null, draftRevision: 1 })).toBe(1);
    expect(firingRevisionOf({ armedRevision: 1, draftRevision: 9 })).toBe(1);
  });
});

describe("cronOfModel", () => {
  it("reads the cron a model declares", () => {
    expect(cronOfModel({ schedule: { cron: "30 7 * * *" } })).toBe("30 7 * * *");
  });

  it("trims, because a stored cron with whitespace is the same schedule", () => {
    expect(cronOfModel({ schedule: { cron: "  0 9 * * 1 " } })).toBe("0 9 * * 1");
  });

  it("⚠ a blank cron is null, so the wire has ONE spelling for 'no schedule'", () => {
    expect(cronOfModel({ schedule: { cron: "   " } })).toBeNull();
    expect(cronOfModel({ schedule: {} })).toBeNull();
    expect(cronOfModel({})).toBeNull();
    expect(cronOfModel(null)).toBeNull();
    expect(cronOfModel(undefined)).toBeNull();
  });

  it("refuses a non-string cron rather than rendering it", () => {
    expect(cronOfModel({ schedule: { cron: 7 } })).toBeNull();
  });
});
