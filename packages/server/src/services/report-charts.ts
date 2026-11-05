/**
 * Native Excel charts for the cost report (2026-10-28).
 *
 * SheetJS community writes cells and sheets but no charts, so the finished `.xlsx` (a zip of XML parts) is opened, the
 * chart parts are added and it is written back: one `chartN.xml` per chart, a `drawing1.xml` placing them on the
 * sheet, and the links between them. Every chart reads CELL RANGES on the sheet, so it stays live if somebody edits a
 * number; the values are also cached in the chart so a viewer that does not recalculate (preview panes, some web
 * viewers) still draws it.
 *
 * Deliberately plain: clustered/stacked columns, bars and a doughnut, no 3-D, no combo axes, no extension elements —
 * the shapes Excel desktop and Excel for the web both draw without argument.
 */
import { readZip, writeZip } from "./zip-lite.js";

export type ChartKind = "column" | "bar" | "stacked" | "doughnut";

/** Cells in one column of the chart sheet: 0-based column, first and last row (inclusive). */
export interface Range {
  col: number;
  first: number;
  last: number;
}

export interface ChartSeries {
  /** The header cell holding the series name. */
  name: { col: number; row: number; text: string };
  vals: Range;
  values: number[];
  /** Number format of the value axis / labels. */
  format?: string;
  color?: string;
}

export interface ChartSpec {
  kind: ChartKind;
  title: string;
  cats: Range;
  categories: string[];
  series: ChartSeries[];
  /** Where the top-left corner sits (0-based column and row) and how big it is, in pixels. */
  at: { col: number; row: number; widthPx: number; heightPx: number };
}

const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const REL_DRAWING = `${NS_R}/drawing`;
const REL_CHART = `${NS_R}/chart`;
const EMU_PER_PX = 9525;

/** A palette that reads on white and keeps its order when a series is dropped. */
export const CHART_COLORS = ["#2F6FEB", "#E8890C", "#1F9D6B", "#8B5CF6", "#D6456B", "#64748B"];

export function xmlEscape(s: string): string {
  return (
    s
      // Characters XML 1.0 cannot carry at all: a workflow name with one would make Excel repair the whole file.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

export function colLetter(col: number): string {
  let n = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** `Dashboard!$A$60:$A$70`. A sheet name with anything but letters, digits or an underscore is quoted. */
export function rangeRef(sheet: string, r: Range): string {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  const c = colLetter(r.col);
  return `${name}!$${c}$${r.first + 1}:$${c}$${r.last + 1}`;
}

function cellRef(sheet: string, col: number, row: number): string {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  return `${name}!$${colLetter(col)}$${row + 1}`;
}

const rgb = (hex: string) => hex.replace("#", "").toUpperCase();
const fill = (hex: string) => `<a:solidFill><a:srgbClr val="${rgb(hex)}"/></a:solidFill>`;

function strRef(f: string, values: string[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`).join("");
  return `<c:strRef><c:f>${xmlEscape(f)}</c:f><c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache></c:strRef>`;
}

function numRef(f: string, values: number[], format: string): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number.isFinite(v) ? v : 0}</c:v></c:pt>`).join("");
  return (
    `<c:numRef><c:f>${xmlEscape(f)}</c:f><c:numCache><c:formatCode>${xmlEscape(format)}</c:formatCode>` +
    `<c:ptCount val="${values.length}"/>${pts}</c:numCache></c:numRef>`
  );
}

function title(text: string): string {
  return (
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="1300" b="1"/><a:t>${xmlEscape(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
  );
}

function seriesXml(spec: ChartSpec, s: ChartSeries, i: number, sheet: string): string {
  const color = s.color ?? CHART_COLORS[i % CHART_COLORS.length];
  const format = s.format ?? "General";
  const tx = `<c:tx>${strRef(cellRef(sheet, s.name.col, s.name.row), [s.name.text])}</c:tx>`;
  const cat = `<c:cat>${strRef(rangeRef(sheet, spec.cats), spec.categories)}</c:cat>`;
  const val = `<c:val>${numRef(rangeRef(sheet, s.vals), s.values, format)}</c:val>`;

  if (spec.kind === "doughnut") {
    const points = spec.categories
      .map(
        (_, k) =>
          `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/><c:spPr>${fill(CHART_COLORS[k % CHART_COLORS.length])}</c:spPr></c:dPt>`,
      )
      .join("");
    const labels =
      `<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/></c:spPr>` +
      `<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/>` +
      `<c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>`;
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${points}${labels}${cat}${val}</c:ser>`;
  }
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}<c:spPr>${fill(color)}</c:spPr>` +
    `<c:invertIfNegative val="0"/>${cat}${val}</c:ser>`
  );
}

function axes(spec: ChartSpec): string {
  const horizontal = spec.kind === "bar";
  const valueFormat = spec.series[0]?.format ?? "General";
  // A ranked bar lists its largest first, so the category axis runs top-down and the value axis is put back at the foot.
  const catOrient = horizontal ? "maxMin" : "minMax";
  const catPos = horizontal ? "l" : "b";
  const valPos = horizontal ? "b" : "l";
  const valCrosses = horizontal ? "max" : "autoZero";
  return (
    `<c:catAx><c:axId val="111111"/><c:scaling><c:orientation val="${catOrient}"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${catPos}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/>` +
    `<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222"/><c:crosses val="autoZero"/>` +
    `<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${valPos}"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>` +
    `<c:numFmt formatCode="${xmlEscape(valueFormat)}" sourceLinked="0"/><c:majorTickMark val="none"/>` +
    `<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111"/><c:crosses val="${valCrosses}"/>` +
    `<c:crossBetween val="between"/></c:valAx>`
  );
}

export function chartXml(spec: ChartSpec, sheet: string): string {
  const sers = spec.series.map((s, i) => seriesXml(spec, s, i, sheet)).join("");
  let plot: string;
  if (spec.kind === "doughnut") {
    plot = `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;
  } else {
    const stacked = spec.kind === "stacked";
    plot =
      `<c:barChart><c:barDir val="${spec.kind === "bar" ? "bar" : "col"}"/>` +
      `<c:grouping val="${stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${sers}` +
      `<c:gapWidth val="${spec.kind === "bar" ? 40 : 60}"/>${stacked ? '<c:overlap val="100"/>' : ""}` +
      `<c:axId val="111111"/><c:axId val="222222"/></c:barChart>${axes(spec)}`;
  }
  // One series needs no legend; a doughnut and a stack need it to be read at all.
  const legend =
    spec.kind === "doughnut" || spec.series.length > 1
      ? `<c:legend><c:legendPos val="${spec.kind === "doughnut" ? "r" : "b"}"/><c:overlay val="0"/></c:legend>`
      : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/>` +
    `<c:chart>${title(spec.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>` +
    `${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
  );
}

function drawingXml(specs: readonly ChartSpec[]): string {
  const frames = specs
    .map((s, i) => {
      const n = i + 1;
      return (
        `<xdr:oneCellAnchor><xdr:from><xdr:col>${s.at.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${s.at.row}</xdr:row>` +
        `<xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${s.at.widthPx * EMU_PER_PX}" cy="${s.at.heightPx * EMU_PER_PX}"/>` +
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n + 1}" name="Chart ${n}" descr="${xmlEscape(s.title)}"/>` +
        `<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="rId${n}"/></a:graphicData></a:graphic>` +
        `</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`
      );
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${frames}</xdr:wsDr>`;
}

function relsXml(rels: ReadonlyArray<{ id: string; type: string; target: string }>): string {
  const items = rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlEscape(r.target)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
}

/** Where a sheet's XML lives inside the zip, found from the workbook's own index rather than assumed to be `sheet1.xml`. */
function sheetPartOf(parts: Map<string, Buffer>, sheetName: string): string {
  const wb = parts.get("xl/workbook.xml")?.toString("utf8");
  const rels = parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!wb || !rels) throw new Error("workbook has no sheet index");
  const tag = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]).find((t) => new RegExp(`\\bname="${xmlEscape(sheetName)}"`).test(t));
  const rid = tag && /\br:id="([^"]+)"/.exec(tag)?.[1];
  if (!rid) throw new Error(`workbook has no sheet named ${sheetName}`);
  const relTag = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${rid}"`));
  const target = relTag && /\bTarget="([^"]+)"/.exec(relTag)?.[1];
  if (!target) throw new Error(`sheet ${sheetName} has no part`);
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

/**
 * Adds `specs` as native charts on `sheetName` of a finished workbook and returns the new bytes. A workbook with no
 * charts to add is returned untouched.
 */
export function addCharts(xlsx: Buffer, sheetName: string, specs: readonly ChartSpec[]): Buffer {
  if (specs.length === 0) return xlsx;
  const parts = readZip(xlsx);
  const sheetPart = sheetPartOf(parts, sheetName);
  const sheetXml = parts.get(sheetPart)?.toString("utf8");
  if (!sheetXml) throw new Error(`sheet part ${sheetPart} is missing`);

  specs.forEach((s, i) => parts.set(`xl/charts/chart${i + 1}.xml`, Buffer.from(chartXml(s, sheetName), "utf8")));
  parts.set("xl/drawings/drawing1.xml", Buffer.from(drawingXml(specs), "utf8"));
  parts.set(
    "xl/drawings/_rels/drawing1.xml.rels",
    Buffer.from(relsXml(specs.map((_, i) => ({ id: `rId${i + 1}`, type: REL_CHART, target: `../charts/chart${i + 1}.xml` }))), "utf8"),
  );

  // The sheet points at its drawing: a relationship, and one <drawing> element. `drawing` comes after the page setup and
  // before anything else that may follow it, so it goes at the very end unless one of those later elements is present.
  const dir = sheetPart.slice(0, sheetPart.lastIndexOf("/"));
  const file = sheetPart.slice(sheetPart.lastIndexOf("/") + 1);
  const relsPart = `${dir}/_rels/${file}.rels`;
  const existing = parts.get(relsPart)?.toString("utf8");
  let id = "rId1";
  if (existing) {
    const used = new Set([...existing.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
    for (let n = 1; used.has(id); n++) id = `rId${n + 1}`;
    const link = `<Relationship Id="${id}" Type="${REL_DRAWING}" Target="../drawings/drawing1.xml"/>`;
    parts.set(relsPart, Buffer.from(existing.replace("</Relationships>", `${link}</Relationships>`), "utf8"));
  } else {
    parts.set(relsPart, Buffer.from(relsXml([{ id, type: REL_DRAWING, target: "../drawings/drawing1.xml" }]), "utf8"));
  }
  const drawing = `<drawing xmlns:r="${NS_R}" r:id="${id}"/>`;
  const later = /<(legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(sheetXml);
  const patched = later
    ? `${sheetXml.slice(0, later.index)}${drawing}${sheetXml.slice(later.index)}`
    : sheetXml.replace("</worksheet>", `${drawing}</worksheet>`);
  if (patched === sheetXml) throw new Error("could not place the drawing on the sheet");
  parts.set(sheetPart, Buffer.from(patched, "utf8"));

  const types = parts.get("[Content_Types].xml")?.toString("utf8");
  if (!types) throw new Error("workbook has no content types");
  const overrides =
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` +
    specs
      .map(
        (_, i) =>
          `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
      )
      .join("");
  parts.set("[Content_Types].xml", Buffer.from(types.replace("</Types>", `${overrides}</Types>`), "utf8"));

  return writeZip(parts);
}
