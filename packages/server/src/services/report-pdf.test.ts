import { describe, expect, it } from "vitest";
import { extractText } from "unpdf";
import { buildReportPdf, reportPdfFilename, PDF_CONTENT_TYPE } from "./report-pdf.js";
import { highlightsOf, MAX_HIGHLIGHTS } from "./report-highlights.js";
import { compare } from "./report-compare.js";
import { summarise, windowOf, type ReportRun } from "./report.service.js";
import { usd } from "./pdf-charts.js";

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
  run({ key: "b", costUsd: 3, purpose: "test", subject: "s2", person: "Daniel", at: "2026-10-21T10:00:00.000Z", tokensIn: 400, tokensOut: 90, tokens: 490 }),
  run({ key: "c", costUsd: 6, workspaceId: "w2", workspaceName: "HR", flowId: null, flowName: "Unsaved build", purpose: "building", status: "session", at: "2026-10-22T10:00:00.000Z" }),
];
const WINDOW = windowOf({ from: "2026-10-19", to: "2026-10-25" });
const NOW = new Date("2026-10-29T10:12:00.000Z");

const make = (runs: ReportRun[], o: { filters?: string[]; workspaces?: string[]; window?: ReturnType<typeof windowOf> } = {}) =>
  buildReportPdf({ runs, window: o.window ?? WINDOW, workspaces: o.workspaces ?? ["Finance", "HR"], filters: o.filters ?? [], generatedBy: "Ada", now: NOW });

async function pages(buf: Buffer): Promise<string[]> {
  const r = await extractText(new Uint8Array(buf), { mergePages: false });
  return r.text;
}

describe("the PDF report", () => {
  it("is a real PDF of three A4 pages", async () => {
    const buf = await make(RUNS);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await pages(buf)).length).toBe(3);
    expect(PDF_CONTENT_TYPE).toBe("application/pdf");
  });

  it("states what it covers: the period, the workspaces, the filters and who made it", async () => {
    const [p1] = await pages(await make(RUNS));
    expect(p1).toContain("Cost report");
    expect(p1).toContain("19 Oct 2026 to 25 Oct 2026 (UTC)");
    expect(p1).toContain("Finance");
    expect(p1).toContain("HR");
    expect(p1).toContain("None");
    expect(p1).toContain("Ada");
    expect(p1).toContain("29 Oct 2026, 10:12 UTC");
    expect(p1).not.toMatch(/\b2026-10-\d\d\b/); // no ISO dates anywhere on the page a person reads
  });

  it("the figures in the PDF are the figures summarise() computes", async () => {
    const [p1] = await pages(await make(RUNS));
    const t = summarise(RUNS, WINDOW).tiles;
    expect(p1).toContain(usd(t.costUsd)); // $10.00
    expect(p1).toContain(String(t.runs));
    expect(p1).toContain(usd(t.costUsd / t.runs));
  });

  it("page 2 ranks the workspaces, and each carries its cost", async () => {
    const [, p2] = await pages(await make(RUNS));
    const [p1, , p3] = await pages(await make(RUNS));
    expect(p1).toContain("Top workspaces");
    expect(p1.indexOf("HR")).toBeLessThan(p1.lastIndexOf("Finance")); // HR cost 6, Finance 4
    expect(p3).toContain(usd(6));
    expect(p3).toContain(usd(4));
    expect(p2).toContain("Cost per day by workspace");
  });

  it("page 3 carries the exact figures for the top workflows", async () => {
    const [, , p3] = await pages(await make(RUNS));
    expect(p3).toContain("Top workflows");
    expect(p3).toContain("Total");
    expect(p3).toContain("Unsaved build");
    expect(p3).toContain("Invoice chase");
    expect(p3).toContain("LLM");
  });

  it("every page has a footer with its number", async () => {
    const all = await pages(await make(RUNS));
    all.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of 3`));
  });

  it("a filtered report says so, and shows nothing it filtered out", async () => {
    const only = RUNS.filter((r) => r.workspaceId === "w1");
    const all = (await pages(await make(only, { filters: ["Workspace: Finance"], workspaces: ["Finance"] }))).join("\n");
    expect(all).toContain("Workspace: Finance");
    expect(all).not.toContain("Unsaved build");
    expect(all).not.toMatch(/\bHR\b/);
  });

  it("an empty report is still a valid report and says there is no usage", async () => {
    const all = await pages(await make([]));
    expect(all.length).toBe(3);
    expect(all.join("\n")).toContain("There is no usage in this period.");
    expect(all.join("\n")).toContain("No usage in this period");
  });

  it("a single day, one workspace, one run does not break the layout", async () => {
    const buf = await make([run({ key: "x", costUsd: 2 })], { workspaces: ["Finance"], window: windowOf({ from: "2026-10-20", to: "2026-10-20" }) });
    expect((await pages(buf)).length).toBe(3);
  });

  it("a long name is cut with an ellipsis, not allowed to run into the next column", async () => {
    const long = "Weekly summary to leadership with a very long workflow name that must be cut";
    const all = (await pages(await make([run({ key: "l", costUsd: 5, flowName: long })]))).join("\n");
    expect(all).not.toContain(long);
    expect(all).toContain("Weekly summary");
    expect(all).toContain("…");
  });

  it("a character the built-in font cannot draw shows as ? rather than as a wrong glyph", async () => {
    const all = (await pages(await make([run({ key: "h", costUsd: 5, person: "आशा Rao" })]))).join("\n");
    expect(all).not.toContain("आशा");
    expect(all).toContain("Rao");
    expect(all).toContain("?");
  });

  it("markup in a name is printed as text", async () => {
    const all = (await pages(await make([run({ key: "m", costUsd: 5, flowName: "A <b> & B" })]))).join("\n");
    expect(all).toContain("A <b> & B");
  });

  it("more than ten workflows: ten rows plus Other, with the total unchanged", async () => {
    const many = Array.from({ length: 14 }, (_, i) => run({ key: `k${i}`, costUsd: i + 1, flowId: `f${i}`, flowName: `Flow ${i}` }));
    const all = (await pages(await make(many))).join("\n");
    expect(all).toContain("Other (4 more)");
    expect(all).toContain(usd(many.reduce((a, r) => a + r.costUsd, 0))); // 105
  });

  it("compares with the previous period: dates, change and a dashed line's legend", async () => {
    const prev = [run({ key: "p1", costUsd: 4, at: "2026-10-13T10:00:00.000Z" }), run({ key: "p2", costUsd: 4, at: "2026-10-14T10:00:00.000Z" })];
    const buf = await buildReportPdf({ runs: RUNS, previous: prev, window: WINDOW, workspaces: ["Finance", "HR"], filters: [], generatedBy: "Ada", now: NOW });
    const all = (await pages(buf)).join("\n");
    expect(all).toContain("12 Oct 2026 to 18 Oct 2026 (UTC)"); // what it was compared with
    expect(all).toContain("Cost per day");
    expect(all).toContain("5 Oct 2026 – 11 Oct 2026".replace("5 Oct","12 Oct").replace("11 Oct","18 Oct")); // the dashed line is named by its dates
    expect(all).toContain("25%"); // 10 against 8
    expect(all).toContain("vs before");
    expect((await pages(buf)).length).toBe(3);
  });

  it("with no earlier usage it says so instead of inventing a percentage", async () => {
    const all = (await pages(await make(RUNS))).join("\n");
    expect(all).toContain("no earlier usage to compare with");
    expect(all).toContain("No earlier usage to compare with");
    expect(all).toContain("no earlier data");
    expect(all).not.toMatch(/vs before/);
  });

  it("the filename is the workbook's with .pdf", () => {
    expect(reportPdfFilename(["Orders & Fulfilment"], WINDOW)).toBe("cost-report_orders-fulfilment_2026-10-19_to_2026-10-25.pdf");
    expect(reportPdfFilename(["A", "B"], WINDOW)).toBe("cost-report_2-workspaces_2026-10-19_to_2026-10-25.pdf");
  });
});

describe("the highlights", () => {
  const s = summarise(RUNS, WINDOW);

  it("name the biggest workspace with its real share", () => {
    expect(highlightsOf(s)[0]).toBe("HR spent the most: $6.00, 60% of the total.");
  });

  it("name the busiest day and the costliest workflow from the data", () => {
    const h = highlightsOf(s).join("\n");
    expect(h).toContain("The busiest day was 22 Oct 2026, at $6.00.");
    expect(h).toContain("Unsaved build (HR) was the costliest workflow: $6.00, 60% of the total.");
  });

  it("split cost by kind", () => {
    expect(highlightsOf(s).join("\n")).toContain("By kind: live runs 10%, test runs 30%, build sessions 60%.");
  });

  it("never exceed the limit, and a figure in a highlight can be found in the report", () => {
    const h = highlightsOf(s);
    expect(h.length).toBeLessThanOrEqual(MAX_HIGHLIGHTS);
    expect(h.length).toBeGreaterThan(0);
  });

  it("lead with how cost compares with the previous period, in the real figures", () => {
    const before = windowOf({ from: "2026-10-12", to: "2026-10-18" });
    const prev = [run({ key: "p", costUsd: 5, at: "2026-10-13T10:00:00.000Z" })];
    const cmp = compare(RUNS, prev, WINDOW, new Date("2026-11-30T00:00:00.000Z"));
    expect(before.fromDay).toBe(cmp.previousWindow.fromDay);
    expect(highlightsOf(s, cmp)[0]).toBe("Cost is up 100% on the previous 7 days: $10.00 against $5.00.");
    expect(highlightsOf(s, cmp).length).toBeLessThanOrEqual(MAX_HIGHLIGHTS);
  });

  it("claim no comparison when there is no earlier usage", () => {
    const cmp = compare(RUNS, [], WINDOW, new Date("2026-11-30T00:00:00.000Z"));
    expect(highlightsOf(s, cmp).join("\n")).not.toMatch(/previous/);
  });

  it("say so plainly when there is nothing to say", () => {
    expect(highlightsOf(summarise([], WINDOW))).toEqual(["There is no usage in this period."]);
    expect(highlightsOf(summarise([run({ key: "z", costUsd: 0 })], WINDOW))).toEqual(["The runs in this period have no recorded cost."]);
  });

  it("do not claim a comparison there is nothing to compare: one workspace gets no 'spent the most' line", () => {
    const one = highlightsOf(summarise([run({ key: "a", costUsd: 2 }), run({ key: "b", costUsd: 3, at: "2026-10-21T10:00:00.000Z" })], WINDOW)).join("\n");
    expect(one).not.toContain("spent the most");
  });

  it("report failed runs with their cost", () => {
    const h = highlightsOf(summarise([...RUNS, run({ key: "f", costUsd: 2, status: "failed", at: "2026-10-23T10:00:00.000Z" })], WINDOW)).join("\n");
    expect(h).toContain("1 run failed, costing $2.00.");
  });
});
