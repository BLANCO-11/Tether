import { describe, expect, it } from "vitest";
import { read, utils } from "xlsx";
import { buildDashboardWorkbook as buildReportWorkbook } from "./report-workbook.js";
import { chartXml, colLetter, rangeRef, xmlEscape } from "./report-charts.js";
import { DASHBOARD, TOP_N, topRows } from "./report-dashboard.js";
import { readZip, writeZip } from "./zip-lite.js";
import { summarise, windowOf, type ReportGroup, type ReportRun } from "./report.service.js";

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
const build = (runs: ReportRun[], filters: string[] = [], workspaces = ["Finance", "HR"]) =>
  buildReportWorkbook({ runs, window: WINDOW, workspaces, filters, generatedBy: "Ada" });

/** A tag-balance check: enough to catch the mistake that makes Excel say "we found a problem with some content". */
function wellFormed(xml: string): string | null {
  const stack: string[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "");
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return `unbalanced </${name}>`;
  }
  if (stack.length) return `unclosed <${stack.at(-1)}>`;
  // Every `<` and `&` outside a tag must be accounted for.
  if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(body)) return "bare ampersand";
  return null;
}

/** Reads `Dashboard!$C$60:$C$70` back out of the parsed sheet, the way Excel would. */
function cellsOf(wb: ReturnType<typeof read>, f: string): Array<string | number | undefined> {
  const m = /^Dashboard!\$([A-Z]+)\$(\d+)(?::\$([A-Z]+)\$(\d+))?$/.exec(f);
  if (!m) throw new Error(`unexpected reference ${f}`);
  const out: Array<string | number | undefined> = [];
  for (let r = Number(m[2]); r <= Number(m[4] ?? m[2]); r++) out.push(wb.Sheets[DASHBOARD][`${m[1]}${r}`]?.v);
  return out;
}

describe("the zip helper", () => {
  it("round-trips every part of a real workbook byte for byte", () => {
    const parts = readZip(build(RUNS));
    const again = readZip(writeZip(parts));
    expect([...again.keys()]).toEqual([...parts.keys()]);
    for (const [name, data] of parts) expect(again.get(name)?.equals(data), name).toBe(true);
  });

  it("refuses a buffer that is not a zip, rather than reading nonsense", () => {
    expect(() => readZip(Buffer.from("not a zip file at all, just text"))).toThrow(/not a zip/);
  });
});

describe("the dashboard workbook", () => {
  const buf = build(RUNS);
  const parts = readZip(buf);
  const wb = read(buf, { type: "buffer" });

  it("still opens as a workbook, with the Dashboard first and the data sheets after it", () => {
    expect(wb.SheetNames).toEqual(["Dashboard", "Workspaces", "Workflows", "People", "Runs"]);
  });

  it("carries six charts, one drawing, and every link between them", () => {
    const names = [...parts.keys()];
    for (let i = 1; i <= 6; i++) expect(names).toContain(`xl/charts/chart${i}.xml`);
    expect(names).not.toContain("xl/charts/chart7.xml");
    expect(names).toContain("xl/drawings/drawing1.xml");
    expect(names).toContain("xl/drawings/_rels/drawing1.xml.rels");
    const types = parts.get("[Content_Types].xml")!.toString();
    expect(types.match(/drawingml\.chart\+xml/g)?.length).toBe(6);
    expect(types).toContain("/xl/drawings/drawing1.xml");
    const rels = parts.get("xl/drawings/_rels/drawing1.xml.rels")!.toString();
    for (let i = 1; i <= 6; i++) expect(rels).toContain(`../charts/chart${i}.xml`);
  });

  it("the sheet points at its drawing exactly once, and that link exists", () => {
    const sheet = parts.get("xl/worksheets/sheet1.xml")!.toString();
    expect(sheet.match(/<drawing\b/g)?.length).toBe(1);
    const id = /<drawing\b[^>]*r:id="([^"]+)"/.exec(sheet)![1];
    const rels = parts.get("xl/worksheets/_rels/sheet1.xml.rels")!.toString();
    expect(rels).toMatch(new RegExp(`Id="${id}"[^>]*drawings/drawing1.xml`));
    // `drawing` must come after the page margins, never before the data.
    expect(sheet.indexOf("<drawing")).toBeGreaterThan(sheet.indexOf("</sheetData>"));
  });

  it("every part that was written is well-formed XML", () => {
    for (const [name, data] of parts) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      expect(wellFormed(data.toString("utf8")), name).toBeNull();
    }
  });

  it("every chart draws the cells beside it: its cached numbers ARE what the sheet holds", () => {
    let checked = 0;
    for (let i = 1; i <= 6; i++) {
      const xml = parts.get(`xl/charts/chart${i}.xml`)!.toString();
      const blocks = [...xml.matchAll(/<c:(?:strRef|numRef)>\s*<c:f>([^<]+)<\/c:f>[\s\S]*?<\/c:(?:strCache|numCache)>/g)];
      expect(blocks.length, `chart ${i} has references`).toBeGreaterThan(0);
      for (const b of blocks) {
        const cached = [...b[0].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((m) => m[1]);
        const live = cellsOf(wb, b[1]);
        expect(cached.length, b[1]).toBe(live.length);
        cached.forEach((v, k) => expect(String(live[k]), `${b[1]}[${k}]`).toBe(v));
        checked += 1;
      }
    }
    // 6 charts: 2 series x (cat+val) for tokens, and (name+cat+val) per series elsewhere.
    expect(checked).toBeGreaterThanOrEqual(6 * 3);
  });

  it("CONTROL: the comparison can fail — a chart pointed one row off reads different cells", () => {
    const xml = parts.get("xl/charts/chart1.xml")!.toString();
    const f = /<c:numRef>\s*<c:f>([^<]+)</.exec(xml)![1];
    const shifted = f.replace(/\$(\d+):\$([A-Z]+)\$(\d+)$/, (_, a, c, b) => `$${Number(a) + 1}:$${c}$${Number(b) + 1}`);
    expect(cellsOf(wb, shifted)).not.toEqual(cellsOf(wb, f));
  });

  it("the six charts sit in a two-by-three grid and do not overlap", () => {
    const drawing = parts.get("xl/drawings/drawing1.xml")!.toString();
    const at = [...drawing.matchAll(/<xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/g)].map((m) => `${m[1]},${m[2]}`);
    expect(new Set(at).size).toBe(6);
    expect(new Set(at.map((a) => a.split(",")[1])).size).toBe(3);
    // Each is 300px tall = 15 default rows, and the bands are 16 rows apart.
    const rows = [...new Set(at.map((a) => Number(a.split(",")[1])))].sort((a, b) => a - b);
    expect(rows[1] - rows[0]).toBeGreaterThan(15);
    expect(rows[2] - rows[1]).toBeGreaterThan(15);
    // The charts end above the first table, so none covers a number.
    const firstTable = utils.sheet_to_json<unknown[]>(wb.Sheets.Dashboard, { header: 1 }).findIndex((r) => r[0] === "Cost and tokens per day");
    expect(rows[2] + 15).toBeLessThan(firstTable);
  });

  it("the numbers are on the sheet beside the charts, and they total to the report", () => {
    const rows = utils.sheet_to_json<unknown[]>(wb.Sheets.Dashboard, { header: 1 });
    const head = rows.findIndex((r) => r[0] === "Cost by workspace");
    const body = rows.slice(head + 2, head + 4);
    expect(body.map((r) => r[0])).toEqual(["HR", "Finance"]);
    expect(body.reduce((a, r) => a + Number(r[2]), 0)).toBeCloseTo(10, 6);
    const days = rows.findIndex((r) => r[0] === "Cost and tokens per day");
    expect(rows.slice(days + 2, days + 9).length).toBe(7); // a quiet day is a row of zeros, not a gap
  });

  it("states the period, the workspaces and that no filter is applied", () => {
    const flat = utils.sheet_to_json<unknown[]>(wb.Sheets.Dashboard, { header: 1 }).slice(0, 6).flat();
    expect(flat).toContain("2026-10-19 to 2026-10-25 (UTC)");
    expect(flat).toContain("Finance, HR");
    expect(flat).toContain("none");
  });
});

describe("a filtered report charts only what it filtered to", () => {
  it("the workflow filter reaches the charts, the numbers and the header together", () => {
    const only = RUNS.filter((r) => r.workspaceId === "w1");
    const buf = build(only, ["Workspace: Finance"], ["Finance"]);
    const wb = read(buf, { type: "buffer" });
    const flat = utils.sheet_to_json<unknown[]>(wb.Sheets.Dashboard, { header: 1 });
    expect(flat.flat()).toContain("Workspace: Finance");
    expect(flat.flat()).not.toContain("HR");
    const xml = readZip(buf).get("xl/charts/chart3.xml")!.toString();
    expect(xml).toContain("Finance");
    expect(xml).not.toContain("HR");
    expect(Number(flat[7][0])).toBeCloseTo(4, 6);
  });
});

describe("thin and empty data still draws", () => {
  it("a report with no runs still has six charts, each over a one-row range that says so", () => {
    const buf = build([]);
    const parts = readZip(buf);
    for (let i = 1; i <= 6; i++) expect(parts.has(`xl/charts/chart${i}.xml`)).toBe(true);
    const wb = read(buf, { type: "buffer" });
    const rows = utils.sheet_to_json<unknown[]>(wb.Sheets.Dashboard, { header: 1 });
    const at = rows.findIndex((r) => r[0] === "Cost by workspace");
    expect(rows[at + 2][0]).toBe("(no usage in this period)");
    expect(rows[at + 2][2]).toBe(0);
    for (const [name, data] of parts) if (/\.(xml|rels)$/.test(name)) expect(wellFormed(data.toString("utf8")), name).toBeNull();
  });

  it("a single day and a single workspace is a valid chart, not an error", () => {
    const buf = buildReportWorkbook({
      runs: [run({ key: "x", costUsd: 2 })],
      window: windowOf({ from: "2026-10-20", to: "2026-10-20" }),
      workspaces: ["Finance"],
      filters: [],
      generatedBy: "Ada",
    });
    expect(readZip(buf).has("xl/charts/chart6.xml")).toBe(true);
  });
});

describe("ranked charts stay readable and stay true", () => {
  const group = (i: number, cost: number): ReportGroup => ({
    id: `g${i}`,
    name: `Workflow ${i}`,
    workspaceName: "Finance",
    costUsd: cost,
    tokens: 0,
    runs: 1,
    workflows: 1,
    people: 1,
    workspaces: 1,
    share: cost / 100,
  });

  it("more than TOP_N groups become TOP_N rows and one Other row that carries the rest, so the total is unchanged", () => {
    const groups = Array.from({ length: 14 }, (_, i) => group(i, 14 - i));
    const rows = topRows(groups, (g) => g.name);
    expect(rows.length).toBe(TOP_N + 1);
    expect(rows.at(-1)?.name).toBe("Other (4 more)");
    expect(rows.reduce((a, r) => a + r.costUsd, 0)).toBe(groups.reduce((a, g) => a + g.costUsd, 0));
  });

  it("CONTROL: exactly TOP_N groups get no Other row", () => {
    const groups = Array.from({ length: TOP_N }, (_, i) => group(i, 1));
    expect(topRows(groups, (g) => g.name).every((r) => !r.name.startsWith("Other"))).toBe(true);
  });

  it("a real report with 14 workflows lists ten and an Other row, and still totals", () => {
    const many = Array.from({ length: 14 }, (_, i) => run({ key: `k${i}`, costUsd: i + 1, flowId: `f${i}`, flowName: `Flow ${i}` }));
    const wb = read(build(many), { type: "buffer" });
    const rows = utils.sheet_to_json<unknown[]>(wb.Sheets.Dashboard, { header: 1 });
    const at = rows.findIndex((r) => r[0] === "Top workflows by cost");
    const body = rows.slice(at + 2, at + 2 + TOP_N + 1);
    expect(body.at(-1)?.[0]).toBe("Other (4 more)");
    expect(body.reduce((a, r) => a + Number(r[2]), 0)).toBeCloseTo(summarise(many, WINDOW).tiles.costUsd, 6);
  });
});

describe("chart XML helpers", () => {
  it("escapes names a person typed, and drops characters XML cannot carry", () => {
    expect(xmlEscape(`A & B <c> "d"`)).toBe("A &amp; B &lt;c&gt; &quot;d&quot;");
    expect(xmlEscape("bad\u0000name\u0008")).toBe("badname");
  });

  it("a workflow named with markup cannot break the chart", () => {
    const bad = run({ key: "z", costUsd: 5, flowName: `Chase <b>&"x"` });
    const parts = readZip(build([bad]));
    for (const [name, data] of parts) if (/\.(xml|rels)$/.test(name)) expect(wellFormed(data.toString("utf8")), name).toBeNull();
    expect(parts.get("xl/charts/chart4.xml")!.toString()).toContain("Chase &lt;b&gt;&amp;&quot;x&quot;");
  });

  it("column letters and ranges match Excel's A1 notation", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(rangeRef("Dashboard", { col: 2, first: 59, last: 61 })).toBe("Dashboard!$C$60:$C$62");
    expect(rangeRef("My Sheet", { col: 0, first: 0, last: 0 })).toBe("'My Sheet'!$A$1:$A$1");
  });

  it("a ranked bar reverses its category axis so the largest is at the top, a column chart does not", () => {
    const base = { title: "t", cats: { col: 0, first: 1, last: 1 }, categories: ["a"], series: [{ name: { col: 1, row: 0, text: "s" }, vals: { col: 1, first: 1, last: 1 }, values: [1] }], at: { col: 0, row: 0, widthPx: 1, heightPx: 1 } };
    expect(chartXml({ ...base, kind: "bar" }, "Dashboard")).toContain('<c:orientation val="maxMin"/>');
    expect(chartXml({ ...base, kind: "column" }, "Dashboard")).not.toContain("maxMin");
  });
});
