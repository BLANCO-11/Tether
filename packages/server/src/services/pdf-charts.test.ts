import { describe, expect, it } from "vitest";
import {
  arcPath,
  axisCount,
  axisMoney,
  columnBars,
  dayLabel,
  doughnutArcs,
  changeWords,
  labelStride,
  linePoints,
  periodText,
  stampText,
  placeLabels,
  niceScale,
  percent,
  rankedBars,
  safe,
  stackedBars,
  usd,
  type Box,
} from "./pdf-charts.js";

const PLOT: Box = { x: 100, y: 50, w: 400, h: 200 };

describe("the value axis", () => {
  it("ends on a round number at or above the largest value", () => {
    for (const max of [0.37, 3.2, 10, 58.1, 412.8, 999, 1234.5, 90_000]) {
      const s = niceScale(max);
      expect(s.max, String(max)).toBeGreaterThanOrEqual(max);
      expect(s.max, String(max)).toBeLessThan(max * 1.7);
      expect(s.max / s.step, String(max)).toBeLessThanOrEqual(5 + 1e-9); // at most five steps, so the labels never crowd
      // The top is a whole number of steps.
      expect(Math.abs(s.max / s.step - Math.round(s.max / s.step))).toBeLessThan(1e-9);
    }
  });

  it("known cases", () => {
    expect(niceScale(10)).toEqual({ max: 10, step: 2 });
    expect(niceScale(412.8)).toEqual({ max: 500, step: 100 });
    expect(niceScale(58.1)).toEqual({ max: 60, step: 20 });
    expect(niceScale(3.2)).toEqual({ max: 4, step: 1 });
    expect(niceScale(0.37)).toEqual({ max: 0.4, step: 0.1 });
  });

  it("nothing to draw is a unit axis, never a division by zero", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const s = niceScale(bad);
      expect(Number.isFinite(s.max) && s.max > 0 && s.step > 0).toBe(true);
    }
  });
});

describe("columns", () => {
  it("a bar's height is its value's share of the axis, and the tallest reaches the top", () => {
    const { max } = niceScale(8);
    const bars = columnBars([2, 8, 0, 4], PLOT, max);
    expect(bars[1].h).toBeCloseTo((8 / max) * PLOT.h, 6);
    expect(bars[0].h).toBeCloseTo(bars[1].h / 4, 6);
    expect(bars[2].h).toBe(0);
    for (const b of bars) expect(b.y + b.h).toBeCloseTo(PLOT.y + PLOT.h, 6); // all stand on the baseline
  });

  it("every bar sits inside its own slot, inside the plot, in order", () => {
    const bars = columnBars([1, 1, 1, 1, 1], PLOT, 1);
    bars.forEach((b, i) => {
      expect(b.x).toBeGreaterThanOrEqual(PLOT.x + (PLOT.w / 5) * i);
      expect(b.x + b.w).toBeLessThanOrEqual(PLOT.x + (PLOT.w / 5) * (i + 1) + 1e-9);
    });
  });

  it("a negative value is not drawn downward", () => {
    expect(columnBars([-3, 3], PLOT, 3)[0].h).toBe(0);
  });

  it("no values is no bars", () => {
    expect(columnBars([], PLOT, 1)).toEqual([]);
  });
});

describe("stacked columns", () => {
  it("the second series sits exactly on top of the first, and together they are the total", () => {
    const [a, b] = stackedBars([[2, 6], [3, 1]], PLOT, 10);
    expect(a[0].h).toBeCloseTo(40, 6);
    expect(b[0].h).toBeCloseTo(60, 6);
    expect(b[0].y + b[0].h).toBeCloseTo(a[0].y, 6); // touches
    expect(a[0].h + b[0].h).toBeCloseTo(((2 + 3) / 10) * PLOT.h, 6);
    expect(a[1].h + b[1].h).toBeCloseTo(((6 + 1) / 10) * PLOT.h, 6);
  });
});

describe("ranked bars", () => {
  const AREA: Box = { x: 200, y: 80, w: 250, h: 90 };

  it("the largest takes the whole width, the rest are proportional, in the order given", () => {
    const bars = rankedBars([10, 5, 2.5, 0], AREA, 18, 11);
    expect(bars[0].w).toBe(250);
    expect(bars[1].w).toBeCloseTo(125, 6);
    expect(bars[2].w).toBeCloseTo(62.5, 6);
    expect(bars[3].w).toBe(0);
    expect(bars.map((b) => b.y)).toEqual([...bars.map((b) => b.y)].sort((x, y) => x - y)); // top to bottom
    expect(bars[1].y - bars[0].y).toBe(18);
  });

  it("all zeros draw nothing rather than a full-width bar", () => {
    expect(rankedBars([0, 0], AREA, 18, 11).every((b) => b.w === 0)).toBe(true);
  });
});

describe("the doughnut", () => {
  it("slices sum to a full turn, start at twelve o'clock and are contiguous", () => {
    const arcs = doughnutArcs([1, 3, 6]);
    expect(arcs[0].start).toBeCloseTo(-Math.PI / 2, 9);
    expect(arcs.at(-1)!.end).toBeCloseTo(-Math.PI / 2 + Math.PI * 2, 9);
    arcs.slice(1).forEach((a, i) => expect(a.start).toBeCloseTo(arcs[i].end, 9));
    expect(arcs.reduce((x, a) => x + a.fraction, 0)).toBeCloseTo(1, 9);
    expect(arcs[2].fraction).toBeCloseTo(0.6, 9);
  });

  it("a zero value gets no slice but keeps its index", () => {
    const arcs = doughnutArcs([5, 0, 5]);
    expect(arcs.map((a) => a.index)).toEqual([0, 2]);
  });

  it("nothing to show is no slices", () => {
    expect(doughnutArcs([0, 0])).toEqual([]);
    expect(doughnutArcs([])).toEqual([]);
  });

  it("a slice over half a turn takes the long way round", () => {
    expect(arcPath(0, 0, 10, 5, -Math.PI / 2, Math.PI)).toContain("A 10 10 0 1 1");
    expect(arcPath(0, 0, 10, 5, 0, 1)).toContain("A 10 10 0 0 1");
  });
});

describe("labels and formats", () => {
  it("skips axis labels so they cannot collide", () => {
    expect(labelStride(70)).toBe(1);
    expect(labelStride(10)).toBe(7);
    expect(labelStride(0)).toBeGreaterThan(1);
  });

  it("axis labels never overlap each other and never leave the chart", () => {
    // 28 days, every third labelled, the last bar close to the right edge: the case that put "28 Oct" on top of "25 Oct".
    const centers = Array.from({ length: 10 }, (_, k) => 150 + k * 3 * 26.7);
    const widths = centers.map(() => 28);
    const placed = placeLabels(centers, widths, 40, 555);
    placed.forEach((p, k) => {
      expect(p.x).toBeGreaterThanOrEqual(40);
      expect(p.x + 28).toBeLessThanOrEqual(555 + 1e-9);
      if (k) expect(p.x).toBeGreaterThanOrEqual(placed[k - 1].x + 28);
    });
    expect(placed.length).toBeLessThan(centers.length + 1);
    expect(placed[0].index).toBe(0);
  });

  it("CONTROL: labels that already fit are all kept, and one past the edge is nudged in, not dropped", () => {
    expect(placeLabels([100, 200, 300], [28, 28, 28], 0, 500).length).toBe(3);
    const [only] = placeLabels([498], [28], 0, 500);
    expect(only.x).toBe(472);
  });

  it("money", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(412.8)).toBe("$412.80");
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(0.5)).toBe("$0.50");
    expect(usd(0.0004)).toBe("$0.0004");
    expect(axisMoney(0)).toBe("$0");
    expect(axisMoney(2500)).toBe("$2.5k");
    expect(axisMoney(0.25)).toBe("$0.25");
    expect(axisCount(1500)).toBe("1.5k");
  });

  it("a share is a whole percent, and a real but tiny one is not shown as zero", () => {
    expect(percent(0.623)).toBe("62%");
    expect(percent(0.004)).toBe("<1%");
    expect(percent(0)).toBe("0%");
    expect(percent(1)).toBe("100%");
  });

  it("dates read as people say them", () => {
    expect(dayLabel("2026-10-14")).toBe("14 Oct 2026");
    expect(dayLabel("2026-01-05")).toBe("5 Jan 2026");
    expect(periodText("2026-10-01", "2026-10-28")).toBe("1 Oct 2026 to 28 Oct 2026 (UTC)");
    expect(stampText(new Date("2026-10-29T10:12:00.000Z"))).toBe("29 Oct 2026, 10:12 UTC");
    expect(dayLabel("not a date")).toBe("not a date");
  });

  it("text the built-in font cannot draw becomes ?, and control characters become spaces", () => {
    expect(safe("Asha Rao")).toBe("Asha Rao");
    expect(safe("José – “ok” €5")).toBe("José – “ok” €5");
    expect(safe("आशा")).toBe("???");
    expect(safe("a\u0000b\nc")).toBe("a b c");
  });
});

describe("lines", () => {
  it("spread evenly from edge to edge, each at its value's height on the axis", () => {
    const pts = linePoints([0, 5, 10], PLOT, 10, 0);
    expect(pts.map((p) => p.x)).toEqual([100, 300, 500]);
    expect(pts[0].y).toBe(250); // zero stands on the baseline
    expect(pts[2].y).toBe(50); // the maximum reaches the top
    expect(pts[1].y).toBeCloseTo(150, 6);
  });

  it("a null is a day not drawn: the point is absent and the others keep their places", () => {
    const pts = linePoints([1, 2, null, null], PLOT, 2, 0);
    expect(pts.map((p) => p.index)).toEqual([0, 1]);
    expect(pts[1].x).toBeCloseTo(100 + 400 / 3, 6);
  });

  it("one point sits in the middle, and nothing is no points", () => {
    expect(linePoints([4], PLOT, 4)[0].x).toBe(300);
    expect(linePoints([], PLOT, 1)).toEqual([]);
    expect(linePoints([0, 0], PLOT, 0).every((p) => p.y === 250)).toBe(true);
  });

  it("a negative value is not drawn below the baseline", () => {
    expect(linePoints([-5], PLOT, 10)[0].y).toBe(250);
  });
});

describe("how a change reads", () => {
  it("in words, with a dash where there is nothing to compare with", () => {
    expect(changeWords({ kind: "up", pct: 0.123 })).toBe("12%");
    expect(changeWords({ kind: "down", pct: 0.5 })).toBe("50%");
    expect(changeWords({ kind: "up", pct: 0.034 })).toBe("3.4%");
    expect(changeWords({ kind: "new", pct: 0 })).toBe("new");
    expect(changeWords({ kind: "flat", pct: 0 })).toBe("no change");
    expect(changeWords({ kind: "none", pct: 0 })).toBe("–");
  });
});
