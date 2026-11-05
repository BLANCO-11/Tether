/**
 * Charts for the PDF cost report (2026-10-29), drawn directly with pdfkit as vector shapes: columns, stacked columns,
 * ranked bars and a doughnut. No images, so text stays selectable and every chart is sharp at any zoom.
 *
 * Two halves on purpose. The GEOMETRY (how tall a bar is, where the ticks fall, the angle of a slice) is plain
 * arithmetic over numbers and is what the tests check. The DRAWING takes that geometry and puts it on the page.
 * A chart is only ever as right as its geometry, so the geometry can be asserted without rendering anything.
 */

type Doc = PDFKit.PDFDocument;

export const INK = "#1F2937";
export const MUTED = "#6B7280";
export const GRID = "#E5E7EB";
export const AXIS = "#9CA3AF";
export const PANEL = "#F3F5F9";
/** Same palette as the Excel dashboard, so the two reports look related. */
export const COLORS = ["#2F6FEB", "#E8890C", "#1F9D6B", "#8B5CF6", "#D6456B", "#64748B"];

// ── formatting ───────────────────────────────────────────────────────────────

/** `$412.80`, `$1,234.56`, `$0.0123` (cost per call is often cents or less), `$0.00`. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (abs >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** An axis label: no trailing zeros, thousands as `k`. */
export function axisMoney(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1000) return `$${+(n / 1000).toFixed(1)}k`;
  return `$${+n.toFixed(4)}`;
}

export function axisCount(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(+n.toFixed(2));
}

export function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** A share as a whole percent; a real but tiny share says `<1%` rather than a misleading `0%`. */
export function percent(fraction: number): string {
  if (!(fraction > 0)) return "0%";
  const p = fraction * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `2026-10-14` → `14 Oct 2026`. The year is always shown: a report is kept and forwarded long after the day it was made. */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : iso;
}

/** `2026-10-01`, `2026-10-28` → `1 Oct 2026 to 28 Oct 2026 (UTC)`. */
export function periodText(fromDay: string, toDay: string): string {
  return `${dayLabel(fromDay)} to ${dayLabel(toDay)} (UTC)`;
}

/** A moment as `29 Oct 2026, 10:12 UTC`. */
export function stampText(d: Date): string {
  const iso = d.toISOString();
  return `${dayLabel(iso.slice(0, 10))}, ${iso.slice(11, 16)} UTC`;
}

/**
 * pdfkit's built-in fonts cover Latin text only. A character outside that range would print as a wrong glyph, so it is
 * replaced with `?` — visibly absent, never silently wrong. Bundling a wider font is a separate decision.
 */
export function safe(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[^ -~ -ÿ–—‘’“”•…€]/g, "?");
}

// ── geometry (pure) ──────────────────────────────────────────────────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bar extends Box {
  value: number;
  index: number;
}

/**
 * A value axis that ends on a round number, so the top gridline is a figure a person can read. `max` of nothing is a
 * unit axis, never a division by zero.
 */
export function niceScale(max: number, ticks = 5): { max: number; step: number } {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, step: 1 / ticks };
  // The smallest round step (1, 2, 2.5 or 5 times a power of ten) that covers the data in at most `ticks` steps.
  const exp = Math.floor(Math.log10(max / ticks));
  for (const e of [exp, exp + 1]) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** e;
      if (max / step <= ticks + 1e-9) return { max: step * Math.ceil(max / step - 1e-9), step };
    }
  }
  const step = 10 ** (exp + 2);
  return { max: step * Math.ceil(max / step - 1e-9), step };
}

/** One bar per value, each in its own slot of the plot, height proportional to the value. */
export function columnBars(values: readonly number[], plot: Box, max: number, fill = 0.7): Bar[] {
  const slot = plot.w / Math.max(values.length, 1);
  const bw = Math.min(slot * fill, 34);
  return values.map((value, index) => {
    const h = max > 0 ? (Math.max(value, 0) / max) * plot.h : 0;
    return { index, value, x: plot.x + slot * index + (slot - bw) / 2, y: plot.y + plot.h - h, w: bw, h };
  });
}

/** Series stacked bottom-up: the second sits on the first. Returns one bar list per series. */
export function stackedBars(series: ReadonlyArray<readonly number[]>, plot: Box, max: number, fill = 0.7): Bar[][] {
  const n = series[0]?.length ?? 0;
  const slot = plot.w / Math.max(n, 1);
  const bw = Math.min(slot * fill, 34);
  const below = new Array<number>(n).fill(0);
  return series.map((values) =>
    values.map((value, index) => {
      const h = max > 0 ? (Math.max(value, 0) / max) * plot.h : 0;
      const bar = { index, value, x: plot.x + slot * index + (slot - bw) / 2, y: plot.y + plot.h - below[index] - h, w: bw, h };
      below[index] += h;
      return bar;
    }),
  );
}

/** Horizontal bars, one per row, the largest taking the whole width of the area. */
export function rankedBars(values: readonly number[], area: Box, rowH: number, barH: number): Bar[] {
  const max = Math.max(0, ...values);
  return values.map((value, index) => ({
    index,
    value,
    x: area.x,
    y: area.y + index * rowH + (rowH - barH) / 2,
    w: max > 0 ? (Math.max(value, 0) / max) * area.w : 0,
    h: barH,
  }));
}

export interface LinePoint {
  index: number;
  value: number;
  x: number;
  y: number;
}

/**
 * Where each point of a line falls. Points spread evenly from one inset edge to the other (a single point sits in the
 * middle). A `null` is a day with nothing to say, such as today before it has finished: it gets no point, so the line
 * stops there instead of dropping to zero.
 */
export function linePoints(values: ReadonlyArray<number | null>, plot: Box, max: number, inset = 8): LinePoint[] {
  const n = values.length;
  const out: LinePoint[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) return;
    const x = n <= 1 ? plot.x + plot.w / 2 : plot.x + inset + ((plot.w - inset * 2) * index) / (n - 1);
    const h = max > 0 ? (Math.max(value, 0) / max) * plot.h : 0;
    out.push({ index, value, x, y: plot.y + plot.h - h });
  });
  return out;
}

export interface Arc {
  index: number;
  value: number;
  fraction: number;
  /** Radians, 0 = three o'clock; slices start at twelve o'clock and run clockwise. */
  start: number;
  end: number;
}

/** The slices of a doughnut. A zero value gets no slice; the fractions of the rest sum to 1. */
export function doughnutArcs(values: readonly number[]): Arc[] {
  const total = values.reduce((a, v) => a + Math.max(v, 0), 0);
  if (!(total > 0)) return [];
  let at = -Math.PI / 2;
  const out: Arc[] = [];
  values.forEach((value, index) => {
    if (!(value > 0)) return;
    const fraction = value / total;
    out.push({ index, value, fraction, start: at, end: at + fraction * Math.PI * 2 });
    at += fraction * Math.PI * 2;
  });
  return out;
}

/** An annular sector as an SVG path, which pdfkit draws directly. Not for a full circle (see `drawDoughnut`). */
export function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`;
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${p(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, end)} L ${p(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, start)} Z`;
}

/**
 * Where to put each axis label so none overlaps another and none leaves the chart. Labels are centred under their bar and
 * nudged inside `[min, max]`; one that would still touch the label before it is left out rather than printed on top of it.
 */
export function placeLabels(centers: readonly number[], widths: readonly number[], min: number, max: number, gap = 6): Array<{ index: number; x: number }> {
  const out: Array<{ index: number; x: number }> = [];
  let edge = -Infinity;
  centers.forEach((c, index) => {
    const w = widths[index] ?? 0;
    const x = Math.min(Math.max(c - w / 2, min), Math.max(max - w, min));
    if (x < edge + gap) return;
    out.push({ index, x });
    edge = x + w;
  });
  return out;
}

/** Which labels to print so they never collide: every `k`th, where `k` makes room for `minGap` points. */
export function labelStride(slot: number, minGap = 62): number {
  return Math.max(1, Math.ceil(minGap / Math.max(slot, 1)));
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** `text` cut with an ellipsis so it fits `width` at the current font and size. */
export function fit(doc: Doc, text: string, width: number): string {
  const s = safe(text);
  if (doc.widthOfString(s) <= width) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${s.slice(0, mid)}…`) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

function put(doc: Doc, text: string, x: number, y: number, o: { size?: number; bold?: boolean; color?: string; width?: number; align?: "left" | "center" | "right" } = {}) {
  doc
    .font(o.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(o.size ?? 9)
    .fillColor(o.color ?? INK)
    .text(safe(text), x, y, { width: o.width, align: o.align ?? "left", lineBreak: false });
}

function heading(doc: Doc, box: Box, title: string, legend?: Array<{ name: string; color: string }>) {
  put(doc, title, box.x, box.y, { size: 11, bold: true });
  if (!legend) return;
  doc.font("Helvetica").fontSize(8.5);
  let x = box.x + box.w;
  for (const item of [...legend].reverse()) {
    const w = doc.widthOfString(safe(item.name));
    x -= w;
    put(doc, item.name, x, box.y + 1.5, { size: 8.5, color: MUTED });
    x -= 12;
    doc.rect(x, box.y + 2.5, 8, 8).fill(item.color);
    x -= 12;
  }
}

function empty(doc: Doc, box: Box, message = "No usage in this period") {
  doc.rect(box.x, box.y + 22, box.w, box.h - 22).fill(PANEL);
  put(doc, message, box.x, box.y + 22 + (box.h - 22) / 2 - 5, { size: 9.5, color: MUTED, width: box.w, align: "center" });
}

/** The horizontal gridlines and their value labels, shared by the column and line charts. */
function gridlines(doc: Doc, box: Box, plot: Box, max: number, step: number, axis: (n: number) => string) {
  doc.lineWidth(0.5);
  for (let v = 0; v <= max + step / 1000; v += step) {
    const y = plot.y + plot.h - (v / max) * plot.h;
    doc.moveTo(plot.x, y).lineTo(plot.x + plot.w, y).strokeColor(v === 0 ? AXIS : GRID).stroke();
    put(doc, axis(v), box.x, y - 4, { size: 7.5, color: MUTED, width: plot.x - box.x - 6, align: "right" });
  }
}

export interface ColumnSeries {
  name: string;
  values: number[];
  color: string;
}

/** Columns for one series, stacked columns for more, over a shared set of labels. */
export function drawColumns(
  doc: Doc,
  box: Box,
  title: string,
  labels: readonly string[],
  series: readonly ColumnSeries[],
  axis: (n: number) => string,
) {
  heading(doc, box, title, series.length > 1 ? series.map((s) => ({ name: s.name, color: s.color })) : undefined);
  const stackTotals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(s.values[i] ?? 0, 0), 0));
  if (!labels.length || !stackTotals.some((v) => v > 0)) return empty(doc, box);

  const left = 50;
  const plot: Box = { x: box.x + left, y: box.y + 26, w: box.w - left, h: box.h - 26 - 20 };
  const { max, step } = niceScale(Math.max(...stackTotals));

  gridlines(doc, box, plot, max, step, axis);

  const bars = stackedBars(series.map((s) => s.values), plot, max);
  bars.forEach((list, si) => {
    for (const b of list) if (b.h > 0) doc.rect(b.x, b.y, b.w, b.h).fill(series[si].color);
  });

  const slot = plot.w / labels.length;
  const stride = labelStride(slot);
  doc.font("Helvetica").fontSize(7.5);
  const wanted = labels.map((l, i) => ({ l, i })).filter(({ i }) => i % stride === 0);
  const placed = placeLabels(
    wanted.map(({ i }) => plot.x + slot * i + slot / 2),
    wanted.map(({ l }) => doc.widthOfString(safe(l))),
    box.x,
    box.x + box.w,
  );
  for (const p of placed) put(doc, wanted[p.index].l, p.x, plot.y + plot.h + 6, { size: 7.5, color: MUTED });
}

export interface RankedRow {
  label: string;
  value: number;
  /** Shown after the value in muted text, e.g. a share. */
  note?: string;
  /** An aggregate ("Other") rather than an item: drawn in grey so it is not read as the biggest one. */
  other?: boolean;
  /** This row's own colour (a workspace keeps its colour in every chart); otherwise the chart's. */
  color?: string;
}

/** Horizontal bars, largest first, each with its figure at the end so nobody reads a number off a bar's length. */
export function drawRanked(
  doc: Doc,
  box: Box,
  title: string,
  rows: readonly RankedRow[],
  color: string,
  money: (n: number) => string,
  o: { labelW?: number; valueW?: number; rowH?: number } = {},
): number {
  heading(doc, box, title);
  const rowH = o.rowH ?? 18;
  const height = 24 + Math.max(rows.length, 1) * rowH;
  if (!rows.length || !rows.some((r) => r.value > 0)) {
    empty(doc, { ...box, h: Math.min(box.h, 70) });
    return 70;
  }
  const labelW = o.labelW ?? 150;
  const valueW = o.valueW ?? 96;
  const area: Box = { x: box.x + labelW + 8, y: box.y + 24, w: box.w - labelW - 8 - valueW, h: rows.length * rowH };
  const bars = rankedBars(rows.map((r) => r.value), area, rowH, Math.min(11, rowH - 5));

  doc.lineWidth(0.5).moveTo(area.x, area.y).lineTo(area.x, area.y + area.h).strokeColor(AXIS).stroke();
  rows.forEach((r, i) => {
    const b = bars[i];
    doc.font("Helvetica").fontSize(8.5);
    put(doc, fit(doc, r.label, labelW), box.x, b.y + 1.5, { size: 8.5 });
    if (b.w > 0) doc.rect(b.x, b.y, Math.max(b.w, 1), b.h).fill(r.other ? AXIS : (r.color ?? color));
    put(doc, money(r.value), b.x + b.w + 6, b.y + 1.5, { size: 8.5, bold: true });
    if (r.note) {
      doc.font("Helvetica-Bold").fontSize(8.5);
      put(doc, r.note, b.x + b.w + 6 + doc.widthOfString(money(r.value)) + 5, b.y + 1.5, { size: 8, color: MUTED });
    }
  });
  return height;
}

export interface Slice {
  label: string;
  value: number;
  color: string;
}

/** A doughnut with its legend beside it: each kind's amount and share, and the total in the hole. */
export function drawDoughnut(doc: Doc, box: Box, title: string, slices: readonly Slice[], money: (n: number) => string, o: { maxRadius?: number } = {}) {
  heading(doc, box, title);
  const total = slices.reduce((a, s) => a + Math.max(s.value, 0), 0);
  const R = Math.min((box.h - 30) / 2, o.maxRadius ?? 80);
  const r = R * 0.6;
  const cx = box.x + R + 6;
  const cy = box.y + 26 + R;

  if (!(total > 0)) {
    doc.circle(cx, cy, R).fill(PANEL);
    doc.circle(cx, cy, r).fill("#FFFFFF");
    put(doc, "No usage", cx - r, cy - 5, { size: 8.5, color: MUTED, width: r * 2, align: "center" });
  } else {
    const arcs = doughnutArcs(slices.map((s) => s.value));
    if (arcs.length === 1) {
      // One slice is a whole ring, which an arc cannot draw (its start and end are the same point).
      doc.circle(cx, cy, R).fill(slices[arcs[0].index].color);
      doc.circle(cx, cy, r).fill("#FFFFFF");
    } else {
      for (const a of arcs) doc.path(arcPath(cx, cy, R, r, a.start, a.end)).fill(slices[a.index].color);
    }
    put(doc, money(total), cx - r, cy - 8, { size: 9.5, bold: true, width: r * 2, align: "center" });
    put(doc, "total", cx - r, cy + 4, { size: 7.5, color: MUTED, width: r * 2, align: "center" });
  }

  const lx = cx + R + 18;
  const lw = box.x + box.w - lx;
  slices.forEach((s, i) => {
    const y = box.y + 34 + i * 24;
    doc.rect(lx, y + 1, 9, 9).fill(s.color);
    put(doc, s.label, lx + 15, y, { size: 9 });
    put(doc, `${money(s.value)}  ·  ${percent(total > 0 ? Math.max(s.value, 0) / total : 0)}`, lx + 15, y + 11, { size: 8, color: MUTED, width: lw - 15 });
  });
}

export interface LineSeries {
  name: string;
  /** One value per day; `null` is a day not drawn (the line stops). */
  values: Array<number | null>;
  color: string;
  dashed?: boolean;
}

/**
 * Lines over a shared set of day labels, current period solid and any earlier one dashed beneath it. The current line
 * (the first series) has its peak marked. `note` is printed instead of a legend when there is nothing to compare with.
 */
export function drawLines(
  doc: Doc,
  box: Box,
  title: string,
  labels: readonly string[],
  series: readonly LineSeries[],
  axis: (n: number) => string,
  o: { note?: string; peak?: (value: number, label: string) => string } = {},
) {
  put(doc, title, box.x, box.y, { size: 11, bold: true });
  // The legend is a short line in each series' own style, not a square: a dashed line has to read as dashed.
  let lx = box.x + box.w;
  if (o.note) {
    put(doc, o.note, box.x, box.y + 1.5, { size: 8.5, color: MUTED, width: box.w, align: "right" });
  } else {
    doc.font("Helvetica").fontSize(8.5);
    for (const item of [...series].reverse()) {
      lx -= doc.widthOfString(safe(item.name));
      put(doc, item.name, lx, box.y + 1.5, { size: 8.5, color: MUTED });
      lx -= 6;
      doc.lineWidth(1.8).strokeColor(item.color);
      if (item.dashed) doc.dash(3, { space: 2 });
      doc.moveTo(lx - 16, box.y + 6.5).lineTo(lx, box.y + 6.5).stroke();
      doc.undash();
      lx -= 28;
    }
  }

  const top = Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)), 0);
  if (!labels.length || !(top > 0)) return empty(doc, box);

  const left = 50;
  const plot: Box = { x: box.x + left, y: box.y + 34, w: box.w - left, h: box.h - 34 - 20 };
  const { max, step } = niceScale(top);
  gridlines(doc, box, plot, max, step, axis);

  // Earlier period first so the current one is drawn over it.
  const drawn = series.map((s) => ({ s, pts: linePoints(s.values, plot, max) }));
  for (const { s, pts } of [...drawn].reverse()) {
    doc.lineWidth(s.dashed ? 1.4 : 2).strokeColor(s.color).lineJoin("round");
    if (s.dashed) doc.dash(4, { space: 3 });
    let prev: LinePoint | null = null;
    for (const p of pts) {
      // A gap in the days (a null between points) breaks the line; consecutive days join.
      if (prev && p.index === prev.index + 1) doc.moveTo(prev.x, prev.y).lineTo(p.x, p.y).stroke();
      prev = p;
    }
    doc.undash();
  }
  const current = drawn[0]?.pts ?? [];
  if (labels.length <= 31) for (const p of current) doc.circle(p.x, p.y, 1.8).fill(drawn[0].s.color);
  if (current.length === 1) doc.circle(current[0].x, current[0].y, 2.5).fill(drawn[0].s.color);

  if (o.peak && current.length > 1) {
    const best = current.reduce((a, p) => (p.value > a.value ? p : a), current[0]);
    if (best.value > 0) {
      const text = o.peak(best.value, labels[best.index] ?? "");
      doc.font("Helvetica-Bold").fontSize(7.5);
      const w = doc.widthOfString(safe(text));
      const [at] = placeLabels([best.x], [w], box.x, box.x + box.w);
      doc.circle(best.x, best.y, 3).lineWidth(1).strokeColor("#FFFFFF").fillAndStroke(drawn[0].s.color, "#FFFFFF");
      put(doc, text, at.x, best.y - 14, { size: 7.5, bold: true, color: INK });
    }
  }

  const n = labels.length;
  const slot = n > 1 ? (plot.w - 16) / (n - 1) : plot.w;
  const stride = labelStride(slot);
  doc.font("Helvetica").fontSize(7.5);
  const xs = linePoints(labels.map(() => 0), plot, max);
  const wanted = labels.map((l, i) => ({ l, i })).filter(({ i }) => i % stride === 0);
  const placed = placeLabels(
    wanted.map(({ i }) => xs[i].x),
    wanted.map(({ l }) => doc.widthOfString(safe(l))),
    box.x,
    box.x + box.w,
  );
  for (const p of placed) put(doc, wanted[p.index].l, p.x, plot.y + plot.h + 6, { size: 7.5, color: MUTED });
}

// ── change against the previous period ───────────────────────────────────────

export type ChangeTone = "cost" | "neutral";

export interface ChangeLike {
  kind: "none" | "new" | "flat" | "up" | "down";
  pct: number;
}

/** What a change says in words: `12%`, `new`, `no change`, or a dash where there is nothing earlier to compare with. */
export function changeWords(c: ChangeLike): string {
  if (c.kind === "up" || c.kind === "down") return c.pct < 0.1 ? `${(c.pct * 100).toFixed(1)}%` : `${Math.round(c.pct * 100)}%`;
  if (c.kind === "new") return "new";
  if (c.kind === "flat") return "no change";
  return "–";
}

/**
 * A change marker drawn as a shape (the built-in font has no triangle glyph). Spend going up is red and going down is
 * green; for anything else, more is not worse, so the marker is neutral. Right-aligned to `right`.
 */
export function drawChange(doc: Doc, right: number, y: number, c: ChangeLike, tone: ChangeTone, o: { size?: number; suffix?: string; left?: number } = {}) {
  const size = o.size ?? 8.5;
  const words = changeWords(c) + (o.suffix && (c.kind === "up" || c.kind === "down" || c.kind === "new" || c.kind === "flat") ? ` ${o.suffix}` : "");
  doc.font("Helvetica").fontSize(size);
  const w = doc.widthOfString(safe(words));
  const arrow = c.kind === "up" || c.kind === "down" ? 9 : 0;
  if (o.left !== undefined) right = o.left + arrow + w; // left-aligned: the caller gave where it starts
  const color = c.kind === "none" || c.kind === "flat" || tone === "neutral" ? MUTED : c.kind === "down" ? "#15803D" : "#B91C1C";
  put(doc, words, right - w, y, { size, color: c.kind === "up" || c.kind === "down" ? color : MUTED, width: w + 2 });
  if (c.kind === "up" || c.kind === "down") {
    const x = right - w - 9;
    const t = y + 1.5;
    const path = c.kind === "up" ? `M ${x} ${t + 6} L ${x + 3.5} ${t} L ${x + 7} ${t + 6} Z` : `M ${x} ${t} L ${x + 3.5} ${t + 6} L ${x + 7} ${t} Z`;
    doc.path(path).fill(color);
  }
}
