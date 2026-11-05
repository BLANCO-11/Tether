/**
 * The cost report as one Excel workbook (2026-10-26): the raw numbers. An "About" sheet says what the file covers, then
 * one sheet each for workspaces, workflows, people and every run. Built from the same `ReportRun` rows the screen
 * reads, so the file and the page cannot disagree. Costs are numbers (not text) so a recipient can sum them; the unit
 * is in the header.
 *
 * (2026-10-29: a Dashboard sheet of native Excel charts used to come first. The pictures moved to the PDF report and the
 * workbook is the data. `buildDashboardWorkbook` below still builds that version, and is not called by the product:
 * it is the switch to turn the Excel charts back on.)
 */
import ExcelJS from "exceljs";
import { utils, write } from "xlsx";
import { addCharts } from "./report-charts.js";
import { buildDashboard, DASHBOARD, DASHBOARD_WIDTHS } from "./report-dashboard.js";
import { AXIS, COLORS, stampText, periodText } from "./pdf-charts.js";
import { KEYS, changeOf, compare, costByKey, type Change } from "./report-compare.js";
import { highlightsOf } from "./report-highlights.js";
import { summarise, type ReportGroup, type ReportRun, type ReportWindow } from "./report.service.js";

type Cell = string | number;

const cost = (n: number) => Math.round(n * 1e6) / 1e6;

function sheet(rows: Cell[][], widths: number[]) {
  const ws = utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  return ws;
}

function groupRows(groups: readonly ReportGroup[], first: string, extra?: { head: string; of: (g: ReportGroup) => Cell }) {
  const head: Cell[] = [first, ...(extra ? [extra.head] : []), "Workflows", "People", "Runs", "Tokens", "Cost (USD)", "Share of cost"];
  return [
    head,
    ...groups.map((g) => [
      g.name,
      ...(extra ? [extra.of(g)] : []),
      g.workflows,
      g.people,
      g.runs,
      g.tokens,
      cost(g.costUsd),
      Math.round(g.share * 10_000) / 10_000,
    ]),
  ];
}

const KIND: Record<string, string> = { live: "Live", test: "Test", building: "Build session" };

export interface WorkbookInput {
  runs: readonly ReportRun[];
  window: ReportWindow;
  workspaces: readonly string[];
  /** Plain-words description of any drill filters applied, e.g. `Workflow: Invoice chase`. */
  filters: readonly string[];
  generatedBy: string;
  /** The same runs for the period before, to say whether cost is better or worse. Without it there is no comparison. */
  previous?: readonly ReportRun[];
  now?: Date;
}

// ── the workbook the product sends (ExcelJS: styled, with number formats) ─────────────────────────────────────────

const HEAD_FILL = "FF1F2937";
const BAND_FILL = "FFF5F7FA";
const GREY = "FF6B7280";
const FMT_USD = '"$"#,##0.0000';
const FMT_USD2 = '"$"#,##0.00';
const FMT_PCT = "0.0%";
const FMT_INT = "#,##0";
const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;
const OUTCOME: Record<string, string> = { succeeded: "Completed", failed: "Failed", session: "Build session", running: "Running", cancelled: "Cancelled" };

function changeText(c: Change): string {
  if (c.kind === "none") return "—";
  if (c.kind === "new") return "New";
  if (c.kind === "flat") return "No change";
  const pct = c.pct >= 0.1 ? Math.round(c.pct * 100) : +(c.pct * 100).toFixed(1);
  return `${c.kind === "up" ? "+" : "−"}${pct}%`;
}

interface Col {
  header: string;
  width: number;
  fmt?: string;
  align?: "left" | "right" | "center";
}

/** A titled, banded table with a bold header, frozen header row, filters and an optional total row outside the filter. */
function table(wb: ExcelJS.Workbook, name: string, subtitle: string, cols: Col[], rows: Array<Array<ExcelJS.CellValue>>, o: { total?: Array<ExcelJS.CellValue>; tab: string; style?: (r: number, c: number, cell: ExcelJS.Cell) => void }) {
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: o.tab } }, views: [{ state: "frozen", ySplit: 3, showGridLines: false }] });
  ws.columns = cols.map((c) => ({ width: c.width }));
  ws.getCell("A1").value = name;
  ws.getCell("A1").font = { bold: true, size: 14, color: { argb: HEAD_FILL } };
  ws.getCell("A2").value = subtitle;
  ws.getCell("A2").font = { size: 9, color: { argb: GREY } };
  const head = ws.getRow(3);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    cell.alignment = { vertical: "middle", horizontal: c.align ?? "left", wrapText: true };
  });
  head.height = 22;
  rows.forEach((values, ri) => {
    const row = ws.getRow(4 + ri);
    values.forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = v;
      if (cols[ci].fmt) cell.numFmt = cols[ci].fmt!;
      cell.alignment = { horizontal: cols[ci].align ?? "left" };
      if (ri % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND_FILL } };
      o.style?.(ri, ci, cell);
    });
  });
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + rows.length, column: cols.length } };
  if (o.total) {
    const row = ws.getRow(4 + rows.length);
    o.total.forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = v;
      if (cols[ci].fmt) cell.numFmt = cols[ci].fmt!;
      cell.font = { bold: true };
      cell.alignment = { horizontal: cols[ci].align ?? "left" };
      cell.border = { top: { style: "medium", color: { argb: HEAD_FILL } } };
    });
  }
  return ws;
}

/** The raw-data workbook the product sends: a Summary first, then one sheet each for workspaces, workflows, people, days and runs. */
export async function buildReportWorkbook(input: WorkbookInput): Promise<Buffer> {
  const now = input.now ?? new Date();
  const s = summarise(input.runs, input.window);
  const cmp = compare(input.runs, input.previous, input.window, now);
  const period = periodText(input.window.fromDay, input.window.toDay);
  const filtersText = input.filters.length ? input.filters.join("; ") : "None";
  const sub = `${period} · Filters: ${filtersText}`;
  const manyWorkspaces = new Set(input.runs.map((r) => r.workspaceId)).size > 1;

  // One colour per workspace, as in the PDF: the five costliest, the rest grey.
  const wsColor = new Map(s.lenses.workspaces.slice(0, 5).map((g, i) => [g.id ?? "", COLORS[i]]));
  const colorOf = (id: string | null | undefined) => argb(wsColor.get(id ?? "") ?? AXIS);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Foundry";
  wb.created = now;

  // ── Summary ──
  const ws = wb.addWorksheet("Summary", { properties: { tabColor: { argb: HEAD_FILL } }, views: [{ showGridLines: false }] });
  ws.columns = [{ width: 30 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 14 }];
  let r = 1;
  const section = (title: string) => {
    r += 1;
    const c = ws.getCell(r, 1);
    c.value = title;
    c.font = { bold: true, size: 10, color: { argb: HEAD_FILL } };
    ws.getRow(r).eachCell(() => undefined);
    for (let i = 1; i <= 5; i++) ws.getCell(r, i).border = { bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
    r += 1;
  };
  ws.getCell(r, 1).value = "COST REPORT";
  ws.getCell(r, 1).font = { bold: true, size: 20, color: { argb: HEAD_FILL } };
  ws.getRow(r).height = 30;
  r += 1;
  ws.getCell(r, 1).value = `${period}  ·  Prepared by ${input.generatedBy}  ·  Generated ${stampText(now)}`;
  ws.getCell(r, 1).font = { size: 9, color: { argb: GREY } };
  r += 1;
  ws.getCell(r, 1).value = `Compared with: ${cmp.hasPrevious ? periodText(cmp.previousWindow.fromDay, cmp.previousWindow.toDay) : "no earlier usage to compare with"}  ·  Filters: ${filtersText}`;
  ws.getCell(r, 1).font = { size: 9, color: { argb: GREY } };

  section("KEY FIGURES");
  ["Measure", "This period", "Previous", "Change"].forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    c.alignment = { horizontal: i ? "right" : "left" };
  });
  r += 1;
  const perRun = (t: { costUsd: number; runs: number }) => (t.runs ? t.costUsd / t.runs : 0);
  const failed = s.byOutcome.find((o) => o.outcome === "failed");
  const figures: Array<{ label: string; now: number; before: number; fmt: string; bold?: boolean; noCompare?: boolean }> = [
    { label: "Total cost (USD)", now: s.tiles.costUsd, before: cmp.previous.costUsd, fmt: FMT_USD2, bold: true },
    { label: "Runs", now: s.tiles.runs, before: cmp.previous.runs, fmt: FMT_INT },
    { label: "Failed runs", now: failed?.runs ?? 0, before: 0, fmt: FMT_INT, noCompare: true },
    { label: "Cost per run (USD)", now: perRun(s.tiles), before: perRun(cmp.previous), fmt: FMT_USD },
    { label: "Tokens", now: s.tiles.tokens, before: cmp.previous.tokens, fmt: FMT_INT },
    { label: "People", now: s.tiles.people, before: cmp.previous.people, fmt: FMT_INT },
  ];
  for (const f of figures) {
    const shown = cmp.hasPrevious && !f.noCompare;
    ws.getCell(r, 1).value = f.label;
    ws.getCell(r, 2).value = f.now;
    ws.getCell(r, 2).numFmt = f.fmt;
    ws.getCell(r, 2).font = { bold: true };
    if (shown) {
      ws.getCell(r, 3).value = f.before;
      ws.getCell(r, 3).numFmt = f.fmt;
    } else ws.getCell(r, 3).value = "—";
    ws.getCell(r, 4).value = shown ? changeText(changeOf(f.now, f.before, true)) : "—";
    for (let i = 2; i <= 4; i++) ws.getCell(r, i).alignment = { horizontal: "right" };
    if (f.bold) ws.getCell(r, 1).font = { bold: true };
    r += 1;
  }

  section("HIGHLIGHTS");
  for (const line of highlightsOf(s, cmp)) {
    ws.mergeCells(r, 1, r, 5);
    const c = ws.getCell(r, 1);
    c.value = `•  ${line}`;
    c.alignment = { wrapText: true, vertical: "top" };
    ws.getRow(r).height = line.length > 80 ? 28 : 16;
    r += 1;
  }

  section(manyWorkspaces || input.workspaces.length > 1 ? `WORKSPACES (${input.workspaces.length})` : "WORKSPACE");
  ["Workspace", "Cost (USD)", "Share of cost", "Runs"].forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    c.alignment = { horizontal: i ? "right" : "left" };
  });
  r += 1;
  const used = new Map(s.lenses.workspaces.map((g) => [g.name, g]));
  for (const name of input.workspaces) {
    const g = used.get(name);
    const c = ws.getCell(r, 1);
    c.value = name;
    c.font = { bold: true, color: { argb: g ? "FFFFFFFF" : GREY } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: g ? colorOf(g.id) : "FFF3F5F9" } };
    c.alignment = { indent: 1 };
    ws.getCell(r, 2).value = g ? cost(g.costUsd) : 0;
    ws.getCell(r, 2).numFmt = FMT_USD;
    ws.getCell(r, 3).value = g ? Math.round(g.share * 10_000) / 10_000 : 0;
    ws.getCell(r, 3).numFmt = FMT_PCT;
    ws.getCell(r, 4).value = g ? g.runs : 0;
    ws.getCell(r, 4).numFmt = FMT_INT;
    for (let i = 2; i <= 4; i++) ws.getCell(r, i).alignment = { horizontal: "right" };
    r += 1;
  }

  section("IN THIS FILE");
  for (const [name, what] of [["Workspaces", "cost by workspace"], ["Workflows", "cost by workflow"], ["People", "cost by person"], ["Days", "cost for each day, against the previous period"], ["Runs", "every run, one per row"]]) {
    const c = ws.getCell(r, 1);
    c.value = { text: name, hyperlink: `#'${name}'!A1` };
    c.font = { color: { argb: "FF2F6FEB" }, underline: true };
    ws.getCell(r, 2).value = what;
    ws.getCell(r, 2).font = { color: { argb: GREY } };
    r += 1;
  }

  section("NOTES");
  const notes = [
    "Cost is model (LLM) spend only, priced at the rate in effect when each call happened. Days are UTC days.",
    "Comparisons use complete days only: a day that is not over yet is left out of both periods.",
    "Share of cost is each row's part of the total shown for its sheet.",
  ];
  for (const n of notes) {
    ws.mergeCells(r, 1, r, 5);
    ws.getCell(r, 1).value = n;
    ws.getCell(r, 1).font = { size: 9, color: { argb: GREY } };
    ws.getCell(r, 1).alignment = { wrapText: true, vertical: "top" };
    ws.getRow(r).height = 26;
    r += 1;
  }

  // ── Workspaces / Workflows / People ──
  const groupSheet = (
    name: string,
    groups: readonly ReportGroup[],
    first: string,
    key: (r: ReportRun) => string,
    tab: string,
    extra?: { head: string; of: (g: ReportGroup) => string },
    nameColor?: (g: ReportGroup) => string | null,
  ) => {
    const now_ = costByKey(cmp.currentRuns, key);
    const before = costByKey(cmp.previousRuns, key);
    const cols: Col[] = [
      { header: first, width: extra ? 34 : 30 },
      ...(extra ? [{ header: extra.head, width: 24 }] : []),
      { header: "Workflows", width: 11, fmt: FMT_INT, align: "right" },
      { header: "People", width: 9, fmt: FMT_INT, align: "right" },
      { header: "Runs", width: 8, fmt: FMT_INT, align: "right" },
      { header: "Tokens", width: 12, fmt: FMT_INT, align: "right" },
      { header: "Cost (USD)", width: 13, fmt: FMT_USD, align: "right" },
      { header: "Cost per run (USD)", width: 14, fmt: FMT_USD, align: "right" },
      { header: "Share of cost", width: 12, fmt: FMT_PCT, align: "right" },
      { header: "Change vs previous", width: 14, align: "right" },
    ];
    const rows = groups.map((g) => [
      g.name,
      ...(extra ? [extra.of(g)] : []),
      g.workflows,
      g.people,
      g.runs,
      g.tokens,
      cost(g.costUsd),
      g.runs ? cost(g.costUsd / g.runs) : 0,
      Math.round(g.share * 10_000) / 10_000,
      changeText(changeOf(now_.get(g.id ?? "") ?? 0, before.get(g.id ?? "") ?? 0, cmp.hasPrevious)),
    ]);
    const sum = (f: (g: ReportGroup) => number) => groups.reduce((a, g) => a + f(g), 0);
    const totalRuns = sum((g) => g.runs);
    const totalCost = sum((g) => g.costUsd);
    const total: Array<ExcelJS.CellValue> = [
      "Total",
      ...(extra ? [""] : []),
      "",
      "",
      totalRuns,
      sum((g) => g.tokens),
      cost(totalCost),
      totalRuns ? cost(totalCost / totalRuns) : 0,
      groups.length ? 1 : 0,
      "",
    ];
    table(wb, name, sub, cols, rows, {
      total,
      tab,
      style: (ri, ci, cell) => {
        const g = groups[ri];
        const c = nameColor?.(g);
        if (ci === 0 && c) cell.font = { bold: true, color: { argb: c } };
      },
    });
  };
  groupSheet("Workspaces", s.lenses.workspaces, "Workspace", KEYS.workspace, "FF2F6FEB", undefined, (g) => colorOf(g.id));
  groupSheet("Workflows", s.lenses.workflows, "Workflow", KEYS.workflow, "FFE8890C", { head: "Workspace", of: (g) => g.workspaceName ?? "" });
  groupSheet("People", s.lenses.people, "Person", KEYS.person, "FF1F9D6B");

  // ── Days: the data behind the PDF's cost-per-day chart ──
  const DAYMS = 86_400_000;
  const runsPerDay = new Map<string, number>();
  for (const x of input.runs) runsPerDay.set(x.at.slice(0, 10), (runsPerDay.get(x.at.slice(0, 10)) ?? 0) + 1);
  const dayCols: Col[] = [
    { header: "Date (UTC)", width: 14, fmt: "d mmm yyyy" },
    { header: "Runs", width: 8, fmt: FMT_INT, align: "right" },
    { header: "Cost (USD)", width: 13, fmt: FMT_USD, align: "right" },
    { header: "Same day, previous period", width: 20, fmt: "d mmm yyyy" },
    { header: "Previous cost (USD)", width: 16, fmt: FMT_USD, align: "right" },
  ];
  const dayRows = s.byDay.map((d, i) => {
    const prev = cmp.previousDaily[i];
    return [
      new Date(`${d.day}T00:00:00Z`),
      runsPerDay.get(d.day) ?? 0,
      cost(d.costUsd),
      cmp.hasPrevious ? new Date(input.window.since.getTime() - (cmp.days - i) * DAYMS) : "",
      cmp.hasPrevious && prev != null ? cost(prev) : "",
    ];
  });
  table(wb, "Days", sub, dayCols, dayRows, {
    tab: "FF8B5CF6",
    total: ["Total", dayRows.reduce((a, d) => a + (d[1] as number), 0), cost(s.byDay.reduce((a, d) => a + d.costUsd, 0)), "", ""],
  });

  // ── Runs ──
  const runCols: Col[] = [
    { header: "Date (UTC)", width: 19, fmt: "yyyy-mm-dd hh:mm" },
    { header: "Run", width: 38 },
    { header: "Workspace", width: 24 },
    { header: "Workflow", width: 32 },
    { header: "Person", width: 28 },
    { header: "Type", width: 14 },
    { header: "Outcome", width: 14 },
    { header: "Tokens in", width: 11, fmt: FMT_INT, align: "right" },
    { header: "Tokens out", width: 11, fmt: FMT_INT, align: "right" },
    { header: "Cost (USD)", width: 13, fmt: FMT_USD, align: "right" },
  ];
  const runRows = input.runs.map((x) => [
    new Date(x.at),
    x.key,
    x.workspaceName,
    x.flowName,
    x.person,
    KIND[x.purpose] ?? x.purpose,
    OUTCOME[x.status] ?? x.status,
    x.tokensIn,
    x.tokensOut,
    cost(x.costUsd),
  ]);
  table(wb, "Runs", sub, runCols, runRows, {
    tab: "FF64748B",
    total: ["Total", "", "", "", "", "", "", input.runs.reduce((a, x) => a + x.tokensIn, 0), input.runs.reduce((a, x) => a + x.tokensOut, 0), cost(input.runs.reduce((a, x) => a + x.costUsd, 0))],
    style: (ri, ci, cell) => {
      if (ci === 6 && input.runs[ri].status === "failed") cell.font = { bold: true, color: { argb: "FFDC2626" } };
    },
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The earlier version, with a Dashboard sheet of native Excel charts first. Not used by the product; the way back. */
export function buildDashboardWorkbook(input: WorkbookInput): Buffer {
  return build(input, true);
}

function build(input: WorkbookInput, withDashboard: boolean): Buffer {
  const s = summarise(input.runs, input.window);
  const wb = utils.book_new();

  const dash = withDashboard ? buildDashboard({ summary: s, runs: input.runs, workspaces: input.workspaces, filters: input.filters, generatedBy: input.generatedBy }) : null;
  if (dash) {
    const dws = sheet(dash.rows, DASHBOARD_WIDTHS);
    for (const f of dash.formats) {
      for (let r = f.first; r <= f.last; r++) {
        const c = dws[utils.encode_cell({ r, c: f.col })];
        if (c && c.t === "n") c.z = f.z;
      }
    }
    utils.book_append_sheet(wb, dws, DASHBOARD);
  }

  if (!dash) utils.book_append_sheet(
    wb,
    sheet(
      [
        ["Cost report"],
        ["Period", periodText(input.window.fromDay, input.window.toDay)],
        ["Workspaces", input.workspaces.join(", ")],
        ["Filters", input.filters.length ? input.filters.join("; ") : "none"],
        ["Prepared by", input.generatedBy],
        ["Generated", stampText(new Date())],
        [],
        ["Cost is model (LLM) spend only, priced at the rate in effect when each call happened. Days are UTC days."],
        ["The Runs sheet lists every run; the other sheets add them up by workspace, workflow and person."],
      ],
      [16, 70],
    ),
    "About",
  );

  utils.book_append_sheet(wb, sheet(groupRows(s.lenses.workspaces, "Workspace"), [28, 11, 9, 8, 12, 12, 14]), "Workspaces");
  utils.book_append_sheet(
    wb,
    sheet(groupRows(s.lenses.workflows, "Workflow", { head: "Workspace", of: (g) => g.workspaceName ?? "" }), [34, 24, 11, 9, 8, 12, 12, 14]),
    "Workflows",
  );
  utils.book_append_sheet(wb, sheet(groupRows(s.lenses.people, "Person"), [30, 11, 9, 8, 12, 12, 14]), "People");

  utils.book_append_sheet(
    wb,
    sheet(
      [
        ["Date (UTC)", "Run", "Workspace", "Workflow", "Person", "Kind", "Outcome", "Tokens", "Cost (USD)"],
        ...input.runs.map((r) => [
          r.at.slice(0, 19).replace("T", " "),
          r.key.slice(0, 8),
          r.workspaceName,
          r.flowName,
          r.person,
          KIND[r.purpose],
          r.status,
          r.tokens,
          cost(r.costUsd),
        ]),
      ],
      [20, 10, 24, 32, 28, 14, 12, 10, 12],
    ),
    "Runs",
  );

  const plain = write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return dash ? addCharts(plain, DASHBOARD, dash.charts) : plain;
}

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A filename that is safe in a header and readable in an inbox: `cost-report_finance_2026-10-01_to_2026-10-26.xlsx`. */
export function reportFilename(workspaces: readonly string[], window: ReportWindow): string {
  const scope = workspaces.length === 1 ? workspaces[0] : `${workspaces.length}-workspaces`;
  return `cost-report_${scope}_${window.fromDay}_to_${window.toDay}.xlsx`
    .toLowerCase()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-");
}
