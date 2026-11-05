/**
 * The Dashboard sheet of the cost report (2026-10-28): a header, key figures, six charts, and under them the numbers
 * every chart is drawn from. The charts read those cells, so the number beside a bar is always the number the bar is.
 *
 * Built from `summarise()`'s output, which is also what the screen shows, and from the runs already filtered by the
 * drill — so a filtered report charts only what it filtered to, and the sheet states the filter in its header.
 */
import { CHART_COLORS, type ChartSpec, type Range } from "./report-charts.js";
import type { ReportGroup, ReportRun, ReportSummary } from "./report.service.js";

export type Cell = string | number;

export const DASHBOARD = "Dashboard";

/** Most rows a ranked chart draws. The rest are summed into one "Other" row, so the chart stays readable and the total stays true. */
export const TOP_N = 10;

const COST_FORMAT = "0.00##";
const TOKEN_FORMAT = "#,##0";
const SHARE_FORMAT = "0.0%";

/** Column widths (characters). Column A holds names; the chart grid below is sized from these. */
export const DASHBOARD_WIDTHS = [30, 14, 14, 14, 14];

const CHART_W = 600;
const CHART_H = 300;
/** Rows (of 20px) one chart band takes, with a gap. */
const BAND_ROWS = 16;
/** Chart 2 of each band starts at column F: columns A–E are 215 + 4 × 103 = 627px wide, and a chart is 600px. */
const RIGHT_COL = DASHBOARD_WIDTHS.length;

const CHARTS_TOP = 10; // 0-based row: row 11
const TABLES_TOP = CHARTS_TOP + BAND_ROWS * 3 + 1;

const KIND: Record<string, string> = { live: "Live", test: "Test", building: "Build session" };

export interface FormatRange {
  col: number;
  first: number;
  last: number;
  z: string;
}

export interface Dashboard {
  rows: Cell[][];
  formats: FormatRange[];
  charts: ChartSpec[];
}

const cost = (n: number) => Math.round(n * 1e6) / 1e6;

interface Row {
  name: string;
  runs: number;
  costUsd: number;
  share: number;
  workspace?: string;
  /** The row that sums everything past the top `TOP_N`: an aggregate, not an item, so a chart can draw it differently. */
  other?: boolean;
}

/** The first `TOP_N` groups, and one row that sums the rest. */
export function topRows(groups: readonly ReportGroup[], label: (g: ReportGroup) => string, withWorkspace = false): Row[] {
  const rows: Row[] = groups.slice(0, TOP_N).map((g) => ({
    name: label(g),
    runs: g.runs,
    costUsd: g.costUsd,
    share: g.share,
    ...(withWorkspace ? { workspace: g.workspaceName ?? "" } : {}),
  }));
  const rest = groups.slice(TOP_N);
  if (rest.length) {
    rows.push({
      name: `Other (${rest.length} more)`,
      runs: rest.reduce((a, g) => a + g.runs, 0),
      costUsd: rest.reduce((a, g) => a + g.costUsd, 0),
      share: rest.reduce((a, g) => a + g.share, 0),
      other: true,
      ...(withWorkspace ? { workspace: "" } : {}),
    });
  }
  return rows;
}

/** A chart cannot be given an empty range, so a table with nothing in it says so in one zero row. */
const NOTHING = "(no usage in this period)";

export function buildDashboard(input: {
  summary: ReportSummary;
  runs: readonly ReportRun[];
  workspaces: readonly string[];
  filters: readonly string[];
  generatedBy: string;
}): Dashboard {
  const { summary: s } = input;
  const rows: Cell[][] = [];
  const formats: FormatRange[] = [];
  const charts: ChartSpec[] = [];

  const per = s.tiles.runs ? s.tiles.costUsd / s.tiles.runs : 0;
  rows.push(
    ["Cost report"],
    ["Period", `${s.window.fromDay} to ${s.window.toDay} (UTC)`],
    ["Workspaces", input.workspaces.join(", ")],
    ["Filters", input.filters.length ? input.filters.join("; ") : "none"],
    ["Prepared by", input.generatedBy],
    [],
    ["Total cost (USD)", "Runs", "Cost / run", "Tokens", "People"],
    [cost(s.tiles.costUsd), s.tiles.runs, cost(per), s.tiles.tokens, s.tiles.people],
    ["Cost is model (LLM) spend only, priced at the rate in effect when each call happened."],
  );
  formats.push(
    { col: 0, first: 7, last: 7, z: COST_FORMAT },
    { col: 2, first: 7, last: 7, z: COST_FORMAT },
    { col: 3, first: 7, last: 7, z: TOKEN_FORMAT },
  );
  // Charts sit in the rows after this, over empty cells; the numbers they draw begin below them.
  while (rows.length < TABLES_TOP) rows.push([]);

  /** A titled table: returns where its data rows are, so a chart can point at them. */
  const table = (heading: string, head: Cell[], body: Cell[][], zs: Array<string | null>) => {
    rows.push([heading]);
    const headRow = rows.length;
    rows.push(head);
    const first = rows.length;
    const data = body.length ? body : [[NOTHING, ...head.slice(1).map(() => 0)]];
    rows.push(...data);
    const last = rows.length - 1;
    zs.forEach((z, col) => z && formats.push({ col, first, last, z }));
    rows.push([]);
    return { headRow, first, last, data };
  };
  const range = (col: number, t: { first: number; last: number }): Range => ({ col, first: t.first, last: t.last });
  const text = (v: Cell) => String(v);

  // Where each of the six charts goes: two to a band, left then right.
  const slot = (n: number) => ({
    col: n % 2 === 0 ? 0 : RIGHT_COL,
    row: CHARTS_TOP + Math.floor(n / 2) * BAND_ROWS,
    widthPx: CHART_W,
    heightPx: CHART_H,
  });

  const day = table(
    "Cost and tokens per day",
    ["Day (UTC)", "Cost (USD)", "Tokens in", "Tokens out"],
    s.byDay.map((d) => {
      const rs = input.runs.filter((r) => r.at.slice(0, 10) === d.day);
      return [d.day, cost(d.costUsd), rs.reduce((a, r) => a + r.tokensIn, 0), rs.reduce((a, r) => a + r.tokensOut, 0)];
    }),
    [null, COST_FORMAT, TOKEN_FORMAT, TOKEN_FORMAT],
  );
  const kind = table(
    "Cost by kind",
    ["Kind", "Runs", "Cost (USD)", "Share of cost"],
    s.byPurpose.map((p) => [KIND[p.purpose], p.runs, cost(p.costUsd), s.tiles.costUsd ? p.costUsd / s.tiles.costUsd : 0]),
    [null, null, COST_FORMAT, SHARE_FORMAT],
  );
  const named = (heading: string, label: string, list: Row[], extra?: string) =>
    table(
      heading,
      [label, "Runs", "Cost (USD)", "Share of cost", ...(extra ? [extra] : [])],
      list.map((r) => [r.name, r.runs, cost(r.costUsd), Math.round(r.share * 10_000) / 10_000, ...(extra ? [r.workspace ?? ""] : [])]),
      [null, null, COST_FORMAT, SHARE_FORMAT],
    );
  const workspaces = named("Cost by workspace", "Workspace", topRows(s.lenses.workspaces, (g) => g.name));
  const workflows = named(
    "Top workflows by cost",
    "Workflow",
    topRows(s.lenses.workflows, (g) => g.name, true),
    "Workspace",
  );
  const people = named("Cost per person", "Person", topRows(s.lenses.people, (g) => g.name));

  const dayCats = day.data.map((r) => text(r[0]));
  const costValues = (t: { data: Cell[][] }, col: number) => t.data.map((r) => Number(r[col]));
  const headerOf = (t: { headRow: number }, col: number, name: string) => ({ col, row: t.headRow, text: name });

  charts.push(
    {
      kind: "column",
      title: "Cost per day (USD)",
      cats: range(0, day),
      categories: dayCats,
      series: [{ name: headerOf(day, 1, "Cost (USD)"), vals: range(1, day), values: costValues(day, 1), format: COST_FORMAT, color: CHART_COLORS[0] }],
      at: slot(0),
    },
    {
      kind: "doughnut",
      title: "Cost by kind (USD)",
      cats: range(0, kind),
      categories: kind.data.map((r) => text(r[0])),
      series: [{ name: headerOf(kind, 2, "Cost (USD)"), vals: range(2, kind), values: costValues(kind, 2), format: COST_FORMAT }],
      at: slot(1),
    },
    {
      kind: "bar",
      title: "Cost by workspace (USD)",
      cats: range(0, workspaces),
      categories: workspaces.data.map((r) => text(r[0])),
      series: [{ name: headerOf(workspaces, 2, "Cost (USD)"), vals: range(2, workspaces), values: costValues(workspaces, 2), format: COST_FORMAT, color: CHART_COLORS[0] }],
      at: slot(2),
    },
    {
      kind: "bar",
      title: `Top workflows by cost (USD)`,
      cats: range(0, workflows),
      categories: workflows.data.map((r) => text(r[0])),
      series: [{ name: headerOf(workflows, 2, "Cost (USD)"), vals: range(2, workflows), values: costValues(workflows, 2), format: COST_FORMAT, color: CHART_COLORS[1] }],
      at: slot(3),
    },
    {
      kind: "bar",
      title: "Cost per person (USD)",
      cats: range(0, people),
      categories: people.data.map((r) => text(r[0])),
      series: [{ name: headerOf(people, 2, "Cost (USD)"), vals: range(2, people), values: costValues(people, 2), format: COST_FORMAT, color: CHART_COLORS[2] }],
      at: slot(4),
    },
    {
      kind: "stacked",
      title: "Tokens in and out per day",
      cats: range(0, day),
      categories: dayCats,
      series: [
        { name: headerOf(day, 2, "Tokens in"), vals: range(2, day), values: costValues(day, 2), format: TOKEN_FORMAT, color: CHART_COLORS[0] },
        { name: headerOf(day, 3, "Tokens out"), vals: range(3, day), values: costValues(day, 3), format: TOKEN_FORMAT, color: CHART_COLORS[1] },
      ],
      at: slot(5),
    },
  );

  return { rows, formats, charts };
}
