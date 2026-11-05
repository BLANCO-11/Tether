import { describe, expect, it } from "vitest";
import { read, utils } from "xlsx";
import {
  NO_FLOW,
  applyDrill,
  outcomeOf,
  pageOfRuns,
  reportService,
  summarise,
  windowOf,
  type ReportRun,
} from "./report.service.js";
import { buildReportWorkbook, reportFilename } from "./report-workbook.js";

const run = (o: Partial<ReportRun> & Pick<ReportRun, "key" | "costUsd">): ReportRun => ({
  workspaceId: "w1",
  workspaceName: "Finance",
  flowId: "f1",
  flowName: "Invoice chase",
  subject: "s1",
  person: "Priya",
  purpose: "live",
  status: "succeeded",
  at: "2026-10-20T10:00:00.000Z",
  tokensIn: 100,
  tokensOut: 50,
  tokens: 150,
  ...o,
});

const RUNS: ReportRun[] = [
  run({ key: "a", costUsd: 1 }),
  run({ key: "b", costUsd: 3, purpose: "test", subject: "s2", person: "Daniel", at: "2026-10-21T10:00:00.000Z" }),
  run({ key: "c", costUsd: 6, workspaceId: "w2", workspaceName: "HR", flowId: null, flowName: "Unsaved build", purpose: "building", status: "session", at: "2026-10-22T10:00:00.000Z" }),
];
const WINDOW = windowOf({ from: "2026-10-19", to: "2026-10-25" });

describe("the report window", () => {
  const now = new Date("2026-10-26T15:30:00.000Z");

  it("`days` counts today, so 7 days is today and the six before it", () => {
    const w = windowOf({ days: 7 }, now);
    expect(w.fromDay).toBe("2026-10-20");
    expect(w.toDay).toBe("2026-10-26");
    expect(w.until.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });

  it("an explicit range is inclusive at both ends", () => {
    const w = windowOf({ from: "2026-10-01", to: "2026-10-03" });
    expect(w.since.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("who a request may cover", () => {
  const allowed = [
    { id: "w1", name: "Finance" },
    { id: "w2", name: "HR" },
  ];

  it("asking for nothing means everything the caller may see", () => {
    const r = reportService.resolve(allowed, []);
    expect(r).toEqual({ ok: true, workspaces: allowed });
  });

  it("a workspace outside the caller's set is a refusal, not a silent drop", () => {
    expect(reportService.resolve(allowed, ["w1", "w3"])).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("a caller who may see nothing is refused whatever they ask for", () => {
    expect(reportService.resolve([], [])).toEqual({ ok: false, reason: "none_allowed" });
    expect(reportService.resolve([], ["w1"])).toEqual({ ok: false, reason: "none_allowed" });
  });

  it("CONTROL: a permitted workspace passes — without it, 'refuse everything' satisfies every case above", () => {
    expect(reportService.resolve(allowed, ["w2"])).toEqual({ ok: true, workspaces: [allowed[1]] });
  });
});

describe("the drill", () => {
  it("narrows by workspace, workflow and person, and never adds a row", () => {
    expect(applyDrill(RUNS, { workspaceIds: ["w1"] }).map((r) => r.key)).toEqual(["a", "b"]);
    expect(applyDrill(RUNS, { flowId: "f1", subject: "s2" }).map((r) => r.key)).toEqual(["b"]);
    expect(applyDrill(RUNS, {}).length).toBe(3);
  });

  it("`none` selects building sessions that never became a workflow", () => {
    expect(applyDrill(RUNS, { flowId: NO_FLOW }).map((r) => r.key)).toEqual(["c"]);
  });
});

describe("summarise", () => {
  const s = summarise(RUNS, WINDOW);

  it("totals add up and counts are distinct", () => {
    expect(s.tiles).toMatchObject({ costUsd: 10, runs: 3, workspaces: 2, workflows: 2, people: 2, tokens: 450 });
  });

  it("every day in the window appears, quiet days as zero", () => {
    expect(s.byDay.map((d) => d.day)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(s.byDay.find((d) => d.day === "2026-10-21")?.costUsd).toBe(3);
    expect(s.byDay.find((d) => d.day === "2026-10-23")?.costUsd).toBe(0);
  });

  it("each day carries its split by kind, and the split adds up to the day", () => {
    const d21 = s.byDay.find((d) => d.day === "2026-10-21")!;
    expect(d21).toMatchObject({ costUsd: 3, test: 3, live: 0, building: 0 });
    const d22 = s.byDay.find((d) => d.day === "2026-10-22")!;
    expect(d22).toMatchObject({ costUsd: 6, building: 6, live: 0, test: 0 });
    for (const d of s.byDay) expect(d.live + d.test + d.building).toBeCloseTo(d.costUsd, 9);
  });

  it("cost by outcome counts only runs that HAVE one: a building session or a run still going is neither success nor failure", () => {
    expect(s.byOutcome).toEqual([
      { outcome: "succeeded", costUsd: 4, runs: 2 },
      { outcome: "failed", costUsd: 0, runs: 0 },
      { outcome: "stopped", costUsd: 0, runs: 0 },
    ]);
    expect(s.withoutOutcome).toBe(1); // the building session
  });

  it("maps statuses onto the three outcomes, and refuses to guess for the rest", () => {
    expect(outcomeOf("succeeded")).toBe("succeeded");
    expect(outcomeOf("failed")).toBe("failed");
    expect(outcomeOf("partial")).toBe("failed");
    for (const st of ["rejected", "expired", "cancelled"]) expect(outcomeOf(st)).toBe("stopped");
    for (const st of ["running", "waiting", "session", "anything-new"]) expect(outcomeOf(st)).toBeNull();
  });

  it("splits cost by kind, and building sessions are counted", () => {
    expect(Object.fromEntries(s.byPurpose.map((p) => [p.purpose, p.costUsd]))).toEqual({ live: 1, test: 3, building: 6 });
  });

  it("ranks each lens by cost and the shares sum to one", () => {
    expect(s.lenses.workspaces.map((g) => g.name)).toEqual(["HR", "Finance"]);
    expect(s.lenses.workspaces.reduce((a, g) => a + g.share, 0)).toBeCloseTo(1, 9);
    const unsaved = s.lenses.workflows.find((g) => g.id === NO_FLOW);
    expect(unsaved?.name).toBe("Unsaved build");
    expect(unsaved?.workspaceName).toBe("HR");
  });

  it("an empty selection is zeros and empty lenses, not an error", () => {
    const e = summarise([], WINDOW);
    expect(e.tiles.costUsd).toBe(0);
    expect(e.lenses.people).toEqual([]);
    expect(e.byDay.length).toBe(7);
  });
});

describe("pagination", () => {
  it("the page is a slice of the whole sorted set, and the total is the whole set", () => {
    const many = Array.from({ length: 120 }, (_, i) => run({ key: `r${i}`, costUsd: i, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
    const p1 = pageOfRuns(many, { sort: "cost", dir: "desc", offset: 0, limit: 50 });
    const p3 = pageOfRuns(many, { sort: "cost", dir: "desc", offset: 100, limit: 50 });
    expect(p1.total).toBe(120);
    expect(p1.rows.length).toBe(50);
    expect(p1.rows[0].costUsd).toBe(119);
    expect(p3.rows.length).toBe(20);
    expect(p3.rows.at(-1)?.costUsd).toBe(0);
  });
});

describe("the workbook", () => {
  const buf = buildReportWorkbook({ runs: RUNS, window: WINDOW, workspaces: ["Finance", "HR"], filters: [], generatedBy: "Ada" });
  const wb = read(buf, { type: "buffer" });

  it("has one sheet each for the summary, workspaces, workflows, people and runs", () => {
    expect(wb.SheetNames).toEqual(["Summary", "Workspaces", "Workflows", "People", "Runs"]);
  });

  it("the Runs sheet carries EVERY run, and costs are numbers a recipient can sum", () => {
    const rows = utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Runs);
    expect(rows.length).toBe(RUNS.length);
    expect(rows.reduce((a, r) => a + Number(r["Cost (USD)"]), 0)).toBeCloseTo(10, 6);
  });

  it("the Summary sheet states the total", () => {
    const flat = utils.sheet_to_json<unknown[]>(wb.Sheets.Summary, { header: 1 }).flat();
    expect(flat).toContain("Total cost (USD)");
    expect(flat).toContain(10);
  });

  it("the filename is safe and says what it covers", () => {
    expect(reportFilename(["Orders & Fulfilment"], WINDOW)).toBe("cost-report_orders-fulfilment_2026-10-19_to_2026-10-25.xlsx");
    expect(reportFilename(["A", "B"], WINDOW)).toBe("cost-report_2-workspaces_2026-10-19_to_2026-10-25.xlsx");
  });
});
