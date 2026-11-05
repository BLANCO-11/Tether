import { describe, expect, it } from "vitest";
import { cronMatches, parseCron } from "./cron.js";

const at = (iso: string) => new Date(iso);

describe("cron for Forge schedules", () => {
  it("matches minutes, hours, steps and ranges", () => {
    expect(cronMatches("* * * * *", at("2026-10-12T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-10-12T09:00:30Z"))).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-10-12T09:01:00Z"))).toBe(false);
    expect(cronMatches("*/15 * * * *", at("2026-10-12T10:45:00Z"))).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-10-12T10:44:00Z"))).toBe(false);
    expect(cronMatches("0 9-17/4 * * *", at("2026-10-12T13:00:00Z"))).toBe(true);
    expect(cronMatches("0 9-17/4 * * *", at("2026-10-12T15:00:00Z"))).toBe(false);
  });

  it("weekdays: 2026-10-12 is a Monday; 7 is Sunday too", () => {
    expect(cronMatches("0 9 * * 1-5", at("2026-10-12T09:00:00Z"))).toBe(true);
    expect(cronMatches("0 9 * * 1-5", at("2026-10-11T09:00:00Z"))).toBe(false);
    expect(cronMatches("0 9 * * 7", at("2026-10-11T09:00:00Z"))).toBe(true);
  });

  it("with both day fields restricted, either one matches (cron's rule)", () => {
    expect(cronMatches("0 0 1 * 1", at("2026-10-12T00:00:00Z"))).toBe(true); // a Monday, not the 1st
    expect(cronMatches("0 0 1 * 1", at("2026-10-01T00:00:00Z"))).toBe(true); // the 1st, a Thursday
    expect(cronMatches("0 0 1 * 1", at("2026-10-02T00:00:00Z"))).toBe(false);
  });

  it("in the schedule's own timezone", () => {
    // 09:00 in London in October (BST, UTC+1) is 08:00 UTC.
    expect(cronMatches("0 9 * * *", at("2026-10-12T08:00:00Z"), "Europe/London")).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-10-12T09:00:00Z"), "Europe/London")).toBe(false);
  });

  it("refuses a malformed cron by naming the field", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCron("0 25 * * *")).toThrow(/hour/);
    expect(() => parseCron("x 9 * * *")).toThrow(/minute/);
  });
});
