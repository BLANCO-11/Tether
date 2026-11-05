import { describe, expect, it } from "vitest";
import { changeOf, compare, costByKey, KEYS, previousWindow } from "./report-compare.js";
import { windowOf, type ReportRun } from "./report.service.js";

const run = (key: string, at: string, costUsd: number, o: Partial<ReportRun> = {}): ReportRun => ({
  key,
  workspaceId: "w1",
  workspaceName: "Finance",
  flowId: "f1",
  flowName: "Invoice chase",
  subject: "s1",
  person: "Priya",
  purpose: "live",
  status: "succeeded",
  at,
  tokensIn: 10,
  tokensOut: 5,
  tokens: 15,
  costUsd,
  ...o,
});

const W = windowOf({ from: "2026-10-08", to: "2026-10-14" }); // seven days
const LATER = new Date("2026-11-30T00:00:00.000Z");

describe("the previous period", () => {
  it("is the same number of days directly before, ending the day before this one starts", () => {
    const p = previousWindow(W);
    expect(p.fromDay).toBe("2026-10-01");
    expect(p.toDay).toBe("2026-10-07");
    expect(p.until.getTime()).toBe(W.since.getTime());
    expect(p.until.getTime() - p.since.getTime()).toBe(W.until.getTime() - W.since.getTime());
  });

  it("a one-day period compares with the day before; a month spanning a short month stays exact", () => {
    expect(previousWindow(windowOf({ from: "2026-03-01", to: "2026-03-01" })).fromDay).toBe("2026-02-28");
    const p = previousWindow(windowOf({ from: "2026-03-01", to: "2026-03-31" }));
    expect([p.fromDay, p.toDay]).toEqual(["2026-01-29", "2026-02-28"]);
  });
});

describe("change", () => {
  it("up, down, with the size as a fraction of before", () => {
    expect(changeOf(12, 10)).toEqual({ kind: "up", pct: 0.2 });
    expect(changeOf(5, 10)).toEqual({ kind: "down", pct: 0.5 });
  });

  it("growing from nothing is new, never an infinite percentage; nothing from nothing is no change", () => {
    expect(changeOf(3, 0)).toEqual({ kind: "new", pct: 0 });
    expect(changeOf(0, 0)).toEqual({ kind: "flat", pct: 0 });
  });

  it("a move under half a percent is no change", () => {
    expect(changeOf(100.2, 100).kind).toBe("flat");
    expect(changeOf(100.6, 100).kind).toBe("up");
  });

  it("with nothing earlier to compare with there is no change at all, whatever the figures", () => {
    expect(changeOf(50, 0, false)).toEqual({ kind: "none", pct: 0 });
    expect(changeOf(50, 10, false).kind).toBe("none");
  });
});

describe("compare()", () => {
  const cur = [run("a", "2026-10-08T10:00:00.000Z", 1), run("b", "2026-10-14T10:00:00.000Z", 3, { subject: "s2", person: "Daniel" })];
  const prev = [run("p", "2026-10-01T10:00:00.000Z", 2), run("q", "2026-10-07T10:00:00.000Z", 2)];

  it("lines the days up by position: day 1 against day 1, day 7 against day 7", () => {
    const c = compare(cur, prev, W, LATER);
    expect(c.currentDaily).toEqual([1, 0, 0, 0, 0, 0, 3]);
    expect(c.previousDaily).toEqual([2, 0, 0, 0, 0, 0, 2]);
    expect(c.current.costUsd).toBe(4);
    expect(c.previous.costUsd).toBe(4);
    expect(c.current.people).toBe(2);
    expect(c.hasPrevious).toBe(true);
    expect(c.partialDay).toBeNull();
  });

  it("no earlier runs means no comparison", () => {
    expect(compare(cur, [], W, LATER).hasPrevious).toBe(false);
    expect(compare(cur, undefined, W, LATER).hasPrevious).toBe(false);
  });

  it("a period that includes today leaves today out of BOTH sides, so a part-day is not read as a drop", () => {
    const now = new Date("2026-10-14T09:00:00.000Z"); // the last day of the period, only just begun
    const c = compare(cur, prev, W, now);
    expect(c.partialDay).toBe("2026-10-14");
    expect(c.usedDays).toBe(6);
    expect(c.current.costUsd).toBe(1); // run "b" is today's and is not counted
    expect(c.previous.costUsd).toBe(2); // and neither is the earlier period's seventh day
    expect(c.currentDaily[6]).toBeNull();
    expect(c.previousDaily[6]).toBeNull();
  });

  it("CONTROL: the same data a day later counts every day", () => {
    const c = compare(cur, prev, W, new Date("2026-10-15T09:00:00.000Z"));
    expect(c.usedDays).toBe(7);
    expect(c.current.costUsd).toBe(4);
  });

  it("when today is the only day there is, it is compared rather than discarded", () => {
    const one = windowOf({ from: "2026-10-14", to: "2026-10-14" });
    const c = compare([run("z", "2026-10-14T01:00:00.000Z", 2)], [run("y", "2026-10-13T01:00:00.000Z", 1)], one, new Date("2026-10-14T09:00:00.000Z"));
    expect(c.usedDays).toBe(1);
    expect(c.current.costUsd).toBe(2);
  });
});

describe("keys", () => {
  it("group the same way the report's lenses do, so a row finds its earlier figure", () => {
    const m = costByKey([run("a", "2026-10-08T10:00:00.000Z", 1), run("b", "2026-10-09T10:00:00.000Z", 2)], KEYS.workflow);
    expect(m.get("f1")).toBe(3);
    expect(costByKey([run("n", "2026-10-08T10:00:00.000Z", 1, { flowId: null })], KEYS.workflow).get("none")).toBe(1);
    expect(costByKey([run("n", "2026-10-08T10:00:00.000Z", 1, { subject: null, person: "Ada" })], KEYS.person).get("name:Ada")).toBe(1);
  });
});
