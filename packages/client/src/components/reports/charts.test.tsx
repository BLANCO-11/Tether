// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DailyCostChart } from "./DailyCostChart";
import { RankedBars } from "./RankedBars";
import type { ReportGroup } from "@/lib/reports";

const group = (i: number, costUsd: number, extra: Partial<ReportGroup> = {}): ReportGroup => ({
  id: `g${i}`, name: `Group ${i}`, costUsd, tokens: 1, runs: 1, workflows: 1, people: 1, workspaces: 1, share: costUsd / 100, ...extra,
});

describe("DailyCostChart", () => {
  afterEach(cleanup);
  const byDay = [
    { day: "2026-10-24", costUsd: 0, live: 0, test: 0, building: 0 },
    { day: "2026-10-25", costUsd: 4, live: 1, test: 1, building: 2 },
    { day: "2026-10-26", costUsd: 6, live: 5, test: 0, building: 1 },
  ];
  const byPurpose = [
    { purpose: "live" as const, costUsd: 6, runs: 3 },
    { purpose: "test" as const, costUsd: 1, runs: 1 },
    { purpose: "building" as const, costUsd: 3, runs: 2 },
  ];

  it("draws a bar segment per kind that spent something, and none for a quiet day", () => {
    const { container } = render(<DailyCostChart byDay={byDay} byPurpose={byPurpose} />);
    const days = container.querySelectorAll("svg g[aria-label]");
    expect(days.length).toBe(3);
    expect(days[0]!.querySelectorAll("rect[fill^='var(--']").length).toBe(0); // quiet day: no coloured segment
    expect(days[1]!.querySelectorAll("rect[fill^='var(--']").length).toBe(3); // live + test + building
    expect(days[2]!.querySelectorAll("rect[fill^='var(--']").length).toBe(2); // no test spend that day
  });

  it("segment heights are to scale: the same cost is the same height, double is double", () => {
    const { container } = render(<DailyCostChart byDay={[
      { day: "2026-10-25", costUsd: 2, live: 2, test: 0, building: 0 },
      { day: "2026-10-26", costUsd: 4, live: 4, test: 0, building: 0 },
    ]} byPurpose={byPurpose} />);
    const heights = [...container.querySelectorAll("svg g[aria-label] rect[fill='var(--ok)']")].map((r) => Number(r.getAttribute("height")));
    expect(heights[1]! / heights[0]!).toBeCloseTo(2, 5);
  });

  it("says the exact figures for a day on hover, and on keyboard focus, and drops them afterwards", () => {
    const { container } = render(<DailyCostChart byDay={byDay} byPurpose={byPurpose} />);
    const day = container.querySelectorAll("svg g[aria-label]")[1]!;
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.mouseEnter(day);
    const tip = screen.getByRole("status");
    expect(tip.textContent).toContain("25 Oct");
    expect(tip.textContent).toContain("$4.00 total");
    expect(tip.textContent).toContain("Live");
    fireEvent.mouseLeave(day);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.focus(day);
    expect(screen.getByRole("status").textContent).toContain("$4.00 total");
    fireEvent.blur(day);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("each day has a text equivalent, so the chart is not the only way to read it", () => {
    const { container } = render(<DailyCostChart byDay={byDay} byPurpose={byPurpose} />);
    expect(container.querySelectorAll("svg g[aria-label]")[2]!.getAttribute("aria-label")).toBe("26 Oct: $6.00. Live $5.00, testing $0.000, building $1.00.");
  });

  it("the legend carries the period's total and share for each kind", () => {
    render(<DailyCostChart byDay={byDay} byPurpose={byPurpose} />);
    expect(screen.getByText(/Live runs \$6\.00 · 60%/)).toBeTruthy();
    expect(screen.getByText(/Testing \$1\.00 · 10%/)).toBeTruthy();
    expect(screen.getByText(/Building \$3\.00 · 30%/)).toBeTruthy();
  });

  it("labels the axis in round figures above the biggest day, and a period with no spend still draws", () => {
    const { container } = render(<DailyCostChart byDay={byDay} byPurpose={byPurpose} />);
    const labels = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(["$0.000", "$2.50", "$5.00", "$7.50", "$10.00", "24 Oct", "26 Oct"]));
    cleanup();
    const quiet = render(<DailyCostChart byDay={[{ day: "2026-10-26", costUsd: 0, live: 0, test: 0, building: 0 }]} byPurpose={[]} />);
    expect(quiet.container.querySelector("svg")).toBeTruthy();
  });
});

describe("RankedBars", () => {
  afterEach(cleanup);

  it("lists the biggest first and opens the group that was clicked", () => {
    const onOpen = vi.fn();
    render(<RankedBars groups={[group(1, 10), group(2, 30), group(3, 20)]} noun="workspace" colourOf={() => "red"} onOpen={onOpen} />);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Open workspace Group 2", "Open workspace Group 3", "Open workspace Group 1"]);
    fireEvent.click(screen.getByRole("button", { name: "Open workspace Group 3" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "g3" }));
  });

  it("bar lengths are relative to the biggest bar", () => {
    const { container } = render(<RankedBars groups={[group(1, 50), group(2, 25)]} noun="workspace" colourOf={() => "red"} onOpen={() => undefined} />);
    const widths = [...container.querySelectorAll("span.block.h-full")].map((e) => (e as HTMLElement).style.width);
    expect(widths).toEqual(["100%", "50%"]);
  });

  it("shows the top eight and rolls the rest into one 'Other' row that cannot be opened", () => {
    const many = Array.from({ length: 11 }, (_, i) => group(i, 100 - i));
    render(<RankedBars groups={many} noun="workflow" colourOf={() => "red"} onOpen={() => undefined} />);
    expect(screen.getAllByRole("button").length).toBe(8);
    const other = screen.getByText("Other (3)");
    expect(other.closest("button")).toBeNull();
    // the three smallest of 100..90 are 92, 91 and 90, so "Other" totals $273
    expect(other.closest("li")!.textContent).toContain("$273");
  });

  it("each bar takes the colour the caller chose for it", () => {
    const { container } = render(<RankedBars groups={[group(1, 10, { name: "A" }), group(2, 5, { name: "B" })]} noun="workspace" colourOf={(g) => (g.name === "A" ? "var(--first)" : "var(--second)")} onOpen={() => undefined} />);
    const fills = [...container.querySelectorAll("span.block.h-full")].map((e) => (e as HTMLElement).style.background);
    expect(fills).toEqual(["var(--first)", "var(--second)"]);
  });

  it("an empty selection says so instead of drawing nothing", () => {
    render(<RankedBars groups={[]} noun="workspace" colourOf={() => "red"} onOpen={() => undefined} />);
    expect(screen.getByText(/No usage in this period/)).toBeTruthy();
  });
});
