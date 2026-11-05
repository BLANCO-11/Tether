import { describe, expect, it } from "vitest";
import { countsOf, healthOf, windowOf, type HealthRun, type RunOutcome } from "./runs-health.js";

const DAY = 24 * 3600_000;
const dayStart = new Date("2026-10-23T00:00:00.000Z");
const now = new Date("2026-10-23T13:30:00.000Z");

const run = (outcome: RunOutcome, startedAt: Date, over: Partial<HealthRun> = {}): HealthRun => ({
  label: "Invoice chase",
  startedAt,
  endedAt: outcome === "running" ? null : new Date(startedAt.getTime() + 30_000),
  outcome,
  ...over,
});
const daysAgo = (d: number, h = 9) => new Date(dayStart.getTime() - d * DAY + h * 3600_000);

describe("the periods", () => {
  it("7 days is today and the six days before it, and the previous period is the 7 days before that", () => {
    const w = windowOf("7d", dayStart, now);
    expect(w.start.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(w.prevStart.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(w.prevEnd).toEqual(w.start);
    expect(w.buckets).toHaveLength(7);
    expect(w.buckets[6]!.start).toEqual(dayStart);
  });

  it("30 days has 30 daily buckets", () => {
    expect(windowOf("30d", dayStart, now).buckets).toHaveLength(30);
  });

  it("today is compared with yesterday UP TO THIS TIME, in hourly buckets", () => {
    const w = windowOf("today", dayStart, now);
    expect(w.prevStart.toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(w.prevEnd.toISOString()).toBe("2026-10-22T13:30:00.000Z");
    expect(w.bucket).toBe("hour");
    expect(w.buckets).toHaveLength(14);
  });
});

describe("the counts", () => {
  it("counts a partly-done run as settled, and as neither a success nor a failure", () => {
    const c = countsOf([run("done", now), run("partial", now), run("stopped", now), run("running", now)]);
    expect(c).toEqual({ runs: 4, settled: 3, succeeded: 1, failed: 1, partial: 1 });
  });
});

describe("the figures for one period", () => {
  const runs: HealthRun[] = [
    run("done", daysAgo(0)),
    run("done", daysAgo(1)),
    run("stopped", daysAgo(2), { label: "Expense check" }),
    run("stopped", daysAgo(3), { label: "Expense check" }),
    run("stopped", daysAgo(4)),
    run("partial", daysAgo(5)),
    // the previous 7 days
    run("done", daysAgo(8)),
    run("stopped", daysAgo(10)),
    // before both periods, but still going: counts only as running now
    run("running", daysAgo(20)),
    run("running", new Date(now.getTime() - 64_000)),
  ];
  const h = healthOf("7d", runs, dayStart, now);

  it("counts the period and the previous period separately", () => {
    expect(h.current).toEqual({ runs: 7, settled: 6, succeeded: 2, failed: 3, partial: 1 });
    expect(h.previous).toEqual({ runs: 2, settled: 2, succeeded: 1, failed: 1, partial: 0 });
  });

  it("names how many automations the failures came from", () => {
    expect(h.failedAutomations).toBe(2);
  });

  it("spreads the period over its buckets, oldest first, and the buckets add up to the figure", () => {
    expect(h.series.map((b) => b.runs)).toEqual([0, 1, 1, 1, 1, 1, 2]);
    expect(h.series.reduce((n, b) => n + b.runs, 0)).toBe(h.current.runs);
  });

  it("running now includes a run that started before the period, and says how long the longest has run", () => {
    expect(h.runningNow).toBe(2);
    expect(h.longestRunningMs).toBe(now.getTime() - daysAgo(20).getTime());
  });

  it("the median is over settled runs only", () => {
    expect(h.medianMs).toBe(30_000);
  });

  it("with no runs, nothing is invented", () => {
    const empty = healthOf("today", [], dayStart, now);
    expect(empty.current.runs).toBe(0);
    expect(empty.longestRunningMs).toBeNull();
    expect(empty.medianMs).toBeNull();
  });
});
