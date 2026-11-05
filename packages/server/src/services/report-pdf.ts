/**
 * The cost report as a PDF (2026-10-29): the same figures as the screen and the workbook, laid out as A4 pages for a
 * person who wants the picture before the data, and who wants to know whether it is better or worse than last time.
 *
 *   Page 1  the summary       header · key figures with their change · highlights · cost by kind ·
 *                             cost per day against the previous period · the leaders
 *   Page 2  where it went     daily cost by workspace · top workflows · cost per person · tokens per day
 *   Page 3  the numbers       a table for each of workspaces, workflows and people, with change and a total · notes
 *
 * Everything is placed at an absolute position rather than flowed, so a page is the same page whatever the data, and a
 * chart can never push the next one off the sheet. Charts take the room the rest leaves, so a page ends near its
 * bottom whatever the amount of data. Built from `summarise()` — the one place the numbers are computed — over runs the
 * drill filters have already narrowed, so a filtered report shows only what it filtered to and says so in its header.
 * The previous period is the same runs for the days before, under the same filters and the same permissions.
 */
import PDFDocument from "pdfkit";
import {
  COLORS,
  INK,
  MUTED,
  PANEL,
  GRID,
  AXIS,
  axisCount,
  axisMoney,
  count,
  dayLabel,
  drawChange,
  drawColumns,
  drawDoughnut,
  drawLines,
  drawRanked,
  fit,
  percent,
  periodText,
  safe,
  stampText,
  usd,
  type ColumnSeries,
  type RankedRow,
} from "./pdf-charts.js";
import { KEYS, changeOf, compare, costByKey, type Change } from "./report-compare.js";
import { markedHighlightsOf, partsOf } from "./report-highlights.js";
import { reportFilename } from "./report-workbook.js";
import { summarise, type ReportGroup, type ReportRun, type ReportWindow } from "./report.service.js";

export const PDF_CONTENT_TYPE = "application/pdf";

const PAGE = { w: 595.28, h: 841.89 };
const M = 40;
const W = PAGE.w - M * 2;
/** Where content stops, above the footer. */
const BOTTOM = 792;

const KIND: Record<string, string> = { live: "Live runs", test: "Test runs", building: "Build sessions" };
/** Kinds have their own colours, apart from the workspaces', so a legend never has to say which meaning a blue has. */
const KIND_COLORS: Record<string, string> = { live: "#0E9F9A", test: "#F2A900", building: "#6366F1" };
const PEOPLE_COLOR = COLORS[5];

/** `cost-report_finance_2026-10-01_to_2026-10-28.pdf` — the workbook's name with the format swapped. */
export function reportPdfFilename(workspaces: readonly string[], window: ReportWindow): string {
  return reportFilename(workspaces, window).replace(/\.xlsx$/, ".pdf");
}

export interface ReportPdfInput {
  runs: readonly ReportRun[];
  /** The runs of the period of the same length just before, under the same filters. Omitted means no comparison. */
  previous?: readonly ReportRun[];
  window: ReportWindow;
  workspaces: readonly string[];
  /** Plain-words description of any drill filters applied, e.g. `Workflow: Invoice chase`. */
  filters: readonly string[];
  generatedBy: string;
  /** When the report was made. Injectable so a test can pin the page and a reader can see when it was true. */
  now?: Date;
}

interface Row {
  key: string | null;
  label: string;
  workspace: string;
  runs: number;
  costUsd: number;
  share: number;
  color: string;
  change: Change;
  other?: boolean;
}

const TOP_N = 10;

export function buildReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const now = input.now ?? new Date();
  const s = summarise(input.runs, input.window);
  const cmp = compare(input.runs, input.previous, input.window, now);
  const period = periodText(input.window.fromDay, input.window.toDay);
  const manyWorkspaces = new Set(input.runs.map((r) => r.workspaceId)).size > 1;

  // One colour per workspace, the same in every chart and table. Beyond five, the rest share one grey.
  const wsColor = new Map(s.lenses.workspaces.slice(0, 5).map((g, i) => [g.id ?? "", COLORS[i]]));
  const colorOfWorkspace = (id: string | undefined) => wsColor.get(id ?? "") ?? AXIS;

  const doc = new PDFDocument({
    size: "A4",
    margin: M,
    bufferPages: true,
    info: {
      Title: `Cost report, ${period}`,
      Author: safe(input.generatedBy),
      Subject: `Cost report for ${safe(input.workspaces.join(", "))}`,
      Creator: "Foundry",
      CreationDate: now,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const text = (t: string, x: number, y: number, o: { size?: number; bold?: boolean; color?: string; width?: number; align?: "left" | "center" | "right" } = {}) =>
    doc
      .font(o.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(o.size ?? 9)
      .fillColor(o.color ?? INK)
      .text(safe(t), x, y, { width: o.width, align: o.align ?? "left", lineBreak: false });

  // ── ranking rows: the leaders, with their change against the previous period ──
  const ranked = (
    groups: readonly ReportGroup[],
    label: (g: ReportGroup) => string,
    color: (g: ReportGroup) => string,
    key: (r: ReportRun) => string,
    limit: number,
    withOther: boolean,
  ): Row[] => {
    const now_ = costByKey(cmp.currentRuns, key);
    const before = costByKey(cmp.previousRuns, key);
    const rowOf = (g: ReportGroup): Row => ({
      key: g.id,
      label: label(g),
      workspace: g.workspaceName ?? "",
      runs: g.runs,
      costUsd: g.costUsd,
      share: g.share,
      color: color(g),
      change: changeOf(now_.get(g.id ?? "") ?? 0, before.get(g.id ?? "") ?? 0, cmp.hasPrevious),
    });
    const rows = groups.slice(0, limit).map(rowOf);
    const rest = groups.slice(limit);
    if (withOther && rest.length) {
      const sum = (f: (g: ReportGroup) => number) => rest.reduce((a, g) => a + f(g), 0);
      rows.push({
        key: null,
        label: `Other (${rest.length} more)`,
        workspace: "",
        runs: sum((g) => g.runs),
        costUsd: sum((g) => g.costUsd),
        share: sum((g) => g.share),
        color: AXIS,
        other: true,
        change: changeOf(sum((g) => now_.get(g.id ?? "") ?? 0), sum((g) => before.get(g.id ?? "") ?? 0), cmp.hasPrevious),
      });
    }
    return rows;
  };
  const workflowLabel = (g: ReportGroup) => (manyWorkspaces && g.workspaceName ? `${g.name} (${g.workspaceName})` : g.name);
  const rowsOf = {
    workspaces: (limit: number, other: boolean) => ranked(s.lenses.workspaces, (g) => g.name, (g) => colorOfWorkspace(g.id ?? undefined), KEYS.workspace, limit, other),
    workflows: (limit: number, other: boolean, plain = false) =>
      ranked(s.lenses.workflows, plain ? (g) => g.name : workflowLabel, (g) => colorOfWorkspace(g.workspaceId), KEYS.workflow, limit, other),
    people: (limit: number, other: boolean) => ranked(s.lenses.people, (g) => g.name, () => PEOPLE_COLOR, KEYS.person, limit, other),
  };
  const asBars = (rows: Row[]): RankedRow[] => rows.map((r) => ({ label: r.label, value: r.costUsd, note: percent(r.share), other: r.other, color: r.color }));

  // ── Page 1 ────────────────────────────────────────────────────────────────
  text("Cost report", M, 40, { size: 22, bold: true });
  text(`Generated ${stampText(now)}`, M, 48, { size: 8.5, color: MUTED, width: W, align: "right" });

  // The header: four facts side by side, labels in small capitals, values in bold; then the workspaces as coloured
  // chips in the colour each one has in every chart below, so the header doubles as the legend.
  const label = (t: string, x: number, yy: number) =>
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor(MUTED).text(safe(t.toUpperCase()), x, yy, { lineBreak: false, characterSpacing: 0.8 });
  const facts: Array<{ k: string; v: string; w: number; muted?: boolean }> = [
    { k: "Period", v: period, w: 165 },
    {
      k: "Compared with",
      v: cmp.hasPrevious ? periodText(cmp.previousWindow.fromDay, cmp.previousWindow.toDay) : "no earlier usage to compare with",
      w: 165,
      muted: !cmp.hasPrevious,
    },
    { k: "Filters", v: input.filters.length ? input.filters.join("; ") : "None", w: 95, muted: !input.filters.length },
    { k: "Prepared by", v: input.generatedBy, w: W - 425 },
  ];
  let fx = M;
  for (const f of facts) {
    label(f.k, fx, 76);
    const bold = !f.muted;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    text(fit(doc, f.v, f.w - 8), fx, 87, { size: 9, bold, color: f.muted ? MUTED : INK });
    fx += f.w;
  }

  label(input.workspaces.length === 1 ? "Workspace" : `Workspaces (${input.workspaces.length})`, M, 108);
  const wsIdByName = new Map(s.lenses.workspaces.map((g) => [g.name, g.id ?? ""]));
  const chipH = 15;
  let cx = M;
  let cy = 119;
  for (const name of input.workspaces) {
    const id = wsIdByName.get(name);
    const used = id !== undefined;
    const fill = used ? colorOfWorkspace(id) : PANEL;
    doc.font("Helvetica-Bold").fontSize(8);
    const t = fit(doc, name, 160);
    const cw = doc.widthOfString(t) + 16;
    if (cx + cw > M + W) {
      cx = M;
      cy += chipH + 5;
    }
    doc.roundedRect(cx, cy, cw, chipH, chipH / 2).fill(fill);
    if (!used) doc.roundedRect(cx, cy, cw, chipH, chipH / 2).lineWidth(0.6).stroke(GRID);
    text(t, cx + 8, cy + 4, { size: 8, bold: true, color: used ? "#FFFFFF" : MUTED });
    cx += cw + 6;
  }
  const headerEnd = cy + chipH;
  doc.moveTo(M, headerEnd + 8).lineTo(M + W, headerEnd + 8).lineWidth(0.6).stroke(GRID);
  /** Everything below the header moves down by as much as the chips wrapped onto extra lines. */
  const dy = Math.max(0, headerEnd + 18 - 146);

  const perRun = (t: { costUsd: number; runs: number }) => (t.runs ? t.costUsd / t.runs : 0);
  const tiles: Array<{ label: string; value: string; change: Change; tone: "cost" | "neutral" }> = [
    { label: "Total cost", value: usd(s.tiles.costUsd), change: changeOf(cmp.current.costUsd, cmp.previous.costUsd, cmp.hasPrevious), tone: "cost" },
    { label: "Runs", value: count(s.tiles.runs), change: changeOf(cmp.current.runs, cmp.previous.runs, cmp.hasPrevious), tone: "neutral" },
    { label: "Cost per run", value: usd(perRun(s.tiles)), change: changeOf(perRun(cmp.current), perRun(cmp.previous), cmp.hasPrevious && cmp.previous.runs > 0), tone: "cost" },
    { label: "Tokens", value: axisCount(s.tiles.tokens), change: changeOf(cmp.current.tokens, cmp.previous.tokens, cmp.hasPrevious), tone: "neutral" },
    { label: "People", value: count(s.tiles.people), change: changeOf(cmp.current.people, cmp.previous.people, cmp.hasPrevious), tone: "neutral" },
  ];
  const tw = (W - 8 * (tiles.length - 1)) / tiles.length;
  tiles.forEach((t, i) => {
    const x = M + i * (tw + 8);
    doc.roundedRect(x, 146 + dy, tw, 58, 4).fill(PANEL);
    label(t.label, x + 10, 156 + dy);
    text(t.value, x + 10, 169 + dy, { size: 15, bold: true, width: tw - 14 });
    if (t.change.kind === "none") text("no earlier data", x + 10, 190 + dy, { size: 7.5, color: MUTED });
    else drawChange(doc, 0, 190 + dy, t.change, t.tone, { size: 7.5, suffix: "vs before", left: x + 10 });
  });

  const sectionY = 222 + dy;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text("HIGHLIGHTS", M, sectionY, { lineBreak: false, characterSpacing: 1 });
  let y = sectionY + 18;
  for (const line of markedHighlightsOf(s, cmp)) {
    doc.circle(M + 4, y + 4, 2.2).fill(COLORS[0]);
    const parts = partsOf(line);
    parts.forEach((p, i) => {
      doc
        .font(p.style === "plain" ? "Helvetica" : "Helvetica-Bold")
        .fontSize(9)
        .fillColor(p.style === "workspace" ? colorOfWorkspace(wsIdByName.get(p.text)) : INK);
      const o = { width: 240, lineGap: 1.5, continued: i < parts.length - 1 };
      if (i === 0) doc.text(safe(p.text), M + 14, y, o);
      else doc.text(safe(p.text), o);
    });
    y = doc.y + 5;
  }
  const donutH = 150;
  drawDoughnut(
    doc,
    { x: M + 275, y: sectionY, w: W - 275, h: donutH },
    "Cost by kind (USD)",
    s.byPurpose.map((p) => ({ label: KIND[p.purpose], value: p.costUsd, color: KIND_COLORS[p.purpose] })),
    usd,
    { maxRadius: 48 },
  );

  const topSide = manyWorkspaces
    ? { title: "Top workspaces (USD)", rows: rowsOf.workspaces(5, false) }
    : { title: "Top people (USD)", rows: rowsOf.people(5, false) };
  const topFlows = { title: "Top workflows (USD)", rows: rowsOf.workflows(5, false) };
  const bottomRows = Math.max(topSide.rows.length, topFlows.rows.length, 1);
  const rowH = 22;
  const bottomH = 24 + bottomRows * rowH;

  const chartY = Math.max(y, sectionY + donutH) + 14;
  const chartH = Math.min(Math.max(BOTTOM - bottomH - 22 - chartY, 150), 250);
  const labels = s.byDay.map((d) => dayLabel(d.day));
  const hasLine = cmp.hasPrevious;
  drawLines(
    doc,
    { x: M, y: chartY, w: W, h: chartH },
    "Cost per day",
    labels,
    [
      { name: `${dayLabel(input.window.fromDay)} – ${dayLabel(input.window.toDay)}`, values: cmp.currentDaily, color: COLORS[0] },
      ...(hasLine
        ? [{ name: `${dayLabel(cmp.previousWindow.fromDay)} – ${dayLabel(cmp.previousWindow.toDay)}`, values: cmp.previousDaily, color: "#94A3B8", dashed: true }]
        : []),
    ],
    axisMoney,
    { note: hasLine ? undefined : "No earlier usage to compare with", peak: (v) => `Peak ${usd(v)}` },
  );

  const colW = (W - 15) / 2;
  const bottomY = chartY + chartH + 22;
  const small = { labelW: 112, valueW: 74, rowH };
  drawRanked(doc, { x: M, y: bottomY, w: colW, h: bottomH }, topSide.title, asBars(topSide.rows), COLORS[0], usd, small);
  drawRanked(doc, { x: M + colW + 15, y: bottomY, w: colW, h: bottomH }, topFlows.title, asBars(topFlows.rows), COLORS[0], usd, small);

  // ── Page 2 ────────────────────────────────────────────────────────────────
  doc.addPage();
  const dayOf = new Map(s.byDay.map((d, i) => [d.day, i]));
  let stack: ColumnSeries[];
  let stackTitle: string;
  if (manyWorkspaces) {
    stackTitle = "Cost per day by workspace (USD)";
    const top = s.lenses.workspaces.slice(0, 5);
    const slot = new Map<string, number>(top.map((g, i) => [g.id ?? "", i]));
    stack = top.map((g, i) => ({ name: g.name, values: s.byDay.map(() => 0), color: COLORS[i] }));
    const otherSeries: ColumnSeries = { name: "Other", values: s.byDay.map(() => 0), color: AXIS };
    for (const r of input.runs) {
      const d = dayOf.get(r.at.slice(0, 10));
      if (d === undefined) continue;
      const si = slot.get(r.workspaceId);
      (si === undefined ? otherSeries : stack[si]).values[d] += r.costUsd;
    }
    if (s.lenses.workspaces.length > 5) stack.push(otherSeries);
  } else {
    stackTitle = "Cost per day by kind (USD)";
    stack = (["live", "test", "building"] as const).map((k) => ({ name: KIND[k], values: s.byDay.map((d) => d[k]), color: KIND_COLORS[k] }));
  }
  drawColumns(doc, { x: M, y: 52, w: W, h: 215 }, stackTitle, labels, stack, axisMoney);

  const listsY = 291;
  const wide = { labelW: 112, valueW: 74, rowH: 20 };
  const usedL = drawRanked(doc, { x: M, y: listsY, w: colW, h: 260 }, "Top workflows by cost (USD)", asBars(rowsOf.workflows(TOP_N, true)), COLORS[0], usd, wide);
  const usedR = drawRanked(doc, { x: M + colW + 15, y: listsY, w: colW, h: 260 }, "Cost per person (USD)", asBars(rowsOf.people(TOP_N, true)), PEOPLE_COLOR, usd, wide);

  const tokensY = listsY + Math.max(usedL, usedR) + 26;
  const tokensIn = s.byDay.map((d) => input.runs.filter((r) => r.at.slice(0, 10) === d.day).reduce((a, r) => a + r.tokensIn, 0));
  const tokensOut = s.byDay.map((d) => input.runs.filter((r) => r.at.slice(0, 10) === d.day).reduce((a, r) => a + r.tokensOut, 0));
  drawColumns(
    doc,
    { x: M, y: tokensY, w: W, h: Math.min(Math.max(BOTTOM - tokensY, 130), 230) },
    "Tokens in and out per day",
    labels,
    [
      { name: "Tokens in", values: tokensIn, color: COLORS[0] },
      { name: "Tokens out", values: tokensOut, color: COLORS[1] },
    ],
    axisCount,
  );

  // ── Page 3 ────────────────────────────────────────────────────────────────
  doc.addPage();
  let ty = 52;
  const totalChange = changeOf(cmp.current.costUsd, cmp.previous.costUsd, cmp.hasPrevious);

  type Col = { head: string; w: number; align: "left" | "right" };
  const table = (title: string, cols: Col[], rows: Row[], cells: (r: Row) => string[], totalCells: string[], dots: boolean) => {
    const need = 20 + 14 + (rows.length + 1) * 15 + 14;
    if (ty + need > BOTTOM) {
      doc.addPage();
      ty = 52;
    }
    text(title, M, ty, { size: 11, bold: true });
    ty += 20;
    const xAt = (i: number) => M + cols.slice(0, i).reduce((a, k) => a + k.w, 0);
    const put = (c: Col, i: number, t: string, yy: number, o: { bold?: boolean; color?: string; pad?: number } = {}) => {
      const pad = o.pad ?? 0;
      doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
      text(fit(doc, t, c.w - 8 - pad), xAt(i) + pad, yy, { size: 8.5, bold: o.bold, color: o.color, width: c.w - 8 - pad, align: c.align });
    };
    cols.forEach((c, i) => put(c, i, c.head, ty, { bold: true, color: MUTED }));
    ty += 14;
    doc.lineWidth(0.5).moveTo(M, ty - 3).lineTo(M + W, ty - 3).strokeColor(AXIS).stroke();
    const changeRight = M + W - 8;
    if (!rows.length) {
      text("No usage in this period", M, ty + 2, { size: 8.5, color: MUTED });
      ty += 18;
    }
    rows.forEach((r, k) => {
      if (k % 2 === 1) doc.rect(M, ty - 3.5, W, 15).fill(PANEL);
      cells(r).forEach((t, i) => {
        const dot = dots && i === 0 && !r.other;
        if (dot) doc.circle(M + 4, ty + 3.5, 3).fill(r.color);
        put(cols[i], i, t, ty, { pad: dot ? 12 : 0, color: r.other ? MUTED : INK });
      });
      drawChange(doc, changeRight, ty, r.change, "cost", { size: 8.5 });
      ty += 15;
    });
    doc.lineWidth(0.5).moveTo(M, ty - 3.5).lineTo(M + W, ty - 3.5).strokeColor(AXIS).stroke();
    totalCells.forEach((t, i) => put(cols[i], i, t, ty + 1, { bold: true }));
    drawChange(doc, changeRight, ty + 1, totalChange, "cost", { size: 8.5 });
    ty += 28;
  };

  const money = (r: Row) => usd(r.costUsd);
  table(
    manyWorkspaces ? "Workspaces" : "Workspace",
    [
      { head: "Workspace", w: 215, align: "left" },
      { head: "Runs", w: 60, align: "right" },
      { head: "Cost (USD)", w: 90, align: "right" },
      { head: "Share", w: 60, align: "right" },
      { head: "Change", w: 90, align: "right" },
    ],
    rowsOf.workspaces(TOP_N, true),
    (r) => [r.label, count(r.runs), money(r), percent(r.share)],
    ["Total", count(s.tiles.runs), usd(s.tiles.costUsd), "100%"],
    true,
  );
  table(
    "Top workflows",
    [
      { head: "Workflow", w: 165, align: "left" },
      { head: "Workspace", w: 105, align: "left" },
      { head: "Runs", w: 45, align: "right" },
      { head: "Cost (USD)", w: 80, align: "right" },
      { head: "Share", w: 50, align: "right" },
      { head: "Change", w: 70, align: "right" },
    ],
    // The table has its own Workspace column, so its names are plain; the charts' carry the workspace instead.
    rowsOf.workflows(TOP_N, true, true),
    (r) => [r.label, r.workspace, count(r.runs), money(r), percent(r.share)],
    ["Total", "", count(s.tiles.runs), usd(s.tiles.costUsd), "100%"],
    false,
  );
  table(
    "People",
    [
      { head: "Person", w: 215, align: "left" },
      { head: "Runs", w: 60, align: "right" },
      { head: "Cost (USD)", w: 90, align: "right" },
      { head: "Share", w: 60, align: "right" },
      { head: "Change", w: 90, align: "right" },
    ],
    rowsOf.people(TOP_N, true),
    (r) => [r.label, count(r.runs), money(r), percent(r.share)],
    ["Total", count(s.tiles.runs), usd(s.tiles.costUsd), "100%"],
    false,
  );

  const notes = [
    "Cost is model (LLM) spend only, priced at the rate in effect when each call happened.",
    cmp.hasPrevious
      ? `Change compares with the previous ${cmp.usedDays} day${cmp.usedDays === 1 ? "" : "s"} (${dayLabel(cmp.previousWindow.fromDay)} to ${dayLabel(cmp.previousWindow.toDay)}), day by day.${cmp.partialDay ? ` Today, ${dayLabel(cmp.partialDay)}, is not over yet and is left out of it.` : ""}`
      : "There was no usage in the period before this one, so nothing is compared.",
    `Days are UTC days. This is a snapshot taken ${stampText(now)}; it does not update.`,
    "Highlights are calculated from the figures in this report. No AI model wrote them.",
    "Lists show the ten largest items and add the rest together as “Other”, so every total stays complete.",
  ];
  if (ty + 18 + notes.length * 24 > BOTTOM) {
    doc.addPage();
    ty = 52;
  }
  text("Notes", M, ty, { size: 11, bold: true });
  ty += 18;
  for (const note of notes) {
    text("•", M + 2, ty, { size: 8.5, color: MUTED });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(safe(note), M + 14, ty, { width: W - 14, lineGap: 1 });
    ty = doc.y + 4;
  }

  // ── Running header (pages 2 on) and footer (all) ──────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits inside the bottom margin; pdfkit starts a new page for text written there unless that margin is zero.
    doc.page.margins.bottom = 0;
    if (i > 0) text(`Cost report  ·  ${period}`, M, 24, { size: 8, color: MUTED });
    doc.lineWidth(0.5).moveTo(M, 806).lineTo(M + W, 806).strokeColor(GRID).stroke();
    text("Foundry cost report", M, 814, { size: 8, color: MUTED });
    text(`Page ${i + 1} of ${range.count}`, M, 814, { size: 8, color: MUTED, width: W, align: "right" });
  }

  doc.end();
  return done;
}
