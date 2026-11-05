// The cost report's wire types and the small pure helpers its page uses (2026-10-26). The server decides who may open
// the report and what is in it; nothing here re-derives either.

export type ReportPurpose = "building" | "test" | "live";
export type ReportOutcome = "succeeded" | "failed" | "stopped";

export interface ReportGroup {
  /** What a drill filter takes: a workspace id, a workflow id (or "none"), or an identity subject. */
  id: string | null;
  name: string;
  /** Workflow lens only. */
  workspaceName?: string;
  workspaceId?: string;
  costUsd: number;
  tokens: number;
  runs: number;
  workflows: number;
  people: number;
  workspaces: number;
  share: number;
}

export interface ReportSummary {
  window: { fromDay: string; toDay: string };
  tiles: { costUsd: number; tokens: number; runs: number; workspaces: number; workflows: number; people: number };
  /** Every day in the period, with its cost split by what spent it. */
  byDay: Array<{ day: string; costUsd: number; live: number; test: number; building: number }>;
  byPurpose: Array<{ purpose: ReportPurpose; costUsd: number; runs: number }>;
  /** Cost of the runs that have an outcome; building sessions and runs still going have none (`withoutOutcome`). */
  byOutcome: Array<{ outcome: ReportOutcome; costUsd: number; runs: number }>;
  withoutOutcome: number;
  lenses: { workspaces: ReportGroup[]; workflows: ReportGroup[]; people: ReportGroup[] };
  /** Every workspace the caller may report on, with its cost in the period, for the picker. */
  workspaces: Array<{ id: string; name: string; costUsd: number }>;
  selected: string[];
}

export interface ReportRun {
  key: string;
  workspaceId: string;
  workspaceName: string;
  flowId: string | null;
  flowName: string;
  subject: string | null;
  person: string;
  purpose: ReportPurpose;
  status: string;
  at: string;
  tokens: number;
  costUsd: number;
}

export type RunSort = "at" | "cost" | "tokens" | "workflow" | "workspace" | "person" | "status";

/** What the person has asked for: a period, the workspaces picked, and the drill made so far. */
export interface ReportQuery {
  days?: number;
  from?: string;
  to?: string;
  workspaces?: string[];
  flowId?: string;
  subject?: string;
}

export const NO_FLOW = "none";

/** The query string both the page and the file use, so the numbers and the download are for the same selection. */
export function queryString(q: ReportQuery, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  if (q.from && q.to) {
    p.set("from", q.from);
    p.set("to", q.to);
  } else p.set("days", String(q.days ?? 30));
  if (q.workspaces?.length) p.set("workspaces", q.workspaces.join(","));
  if (q.flowId) p.set("flowId", q.flowId);
  if (q.subject) p.set("subject", q.subject);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
}

export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export const KIND_WORD: Record<ReportPurpose, string> = { live: "Live", test: "Test", building: "Build session" };

/** One drill step: the id the server filters on, and the name the trail shows. */
export interface DrillStep {
  id: string;
  name: string;
}
export interface Drill {
  workspace: DrillStep | null;
  flow: DrillStep | null;
  person: DrillStep | null;
}
export const NO_DRILL: Drill = { workspace: null, flow: null, person: null };
export type Lens = "workspaces" | "workflows" | "people" | "runs";

/**
 * Where a click on a row goes. A workspace opens its workflows, a workflow opens its runs, a person opens the
 * workflows they used. Pure so the rule is checked without rendering.
 */
export function drillInto(lens: Exclude<Lens, "runs">, g: ReportGroup, d: Drill): { drill: Drill; lens: Lens } {
  const here = { id: g.id ?? NO_FLOW, name: g.name };
  if (lens === "workspaces") return { drill: { ...d, workspace: here }, lens: "workflows" };
  if (lens === "workflows") {
    const workspace = g.workspaceId ? { id: g.workspaceId, name: g.workspaceName ?? "" } : d.workspace;
    return { drill: { ...d, workspace, flow: here }, lens: "runs" };
  }
  return { drill: { ...d, person: here }, lens: "workflows" };
}

/** The drill as the query the server filters on. A drilled workspace narrows the picker's choice, never widens it. */
export function drillQuery(base: ReportQuery, d: Drill): ReportQuery {
  return {
    ...base,
    ...(d.workspace ? { workspaces: [d.workspace.id] } : {}),
    ...(d.flow ? { flowId: d.flow.id } : {}),
    ...(d.person ? { subject: d.person.id } : {}),
  };
}

/** Download names the browser may mangle; the server's `Content-Disposition` is preferred, this is the fallback. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  const m = disposition?.match(/filename="?([^";]+)"?/i);
  return m?.[1] ?? fallback;
}

const ADDRESS = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
/** The addresses typed into the email box, split on commas, semicolons and whitespace. */
export function parseRecipients(text: string): string[] {
  return [...new Set(text.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}
/** What is wrong with the typed addresses, in words, or null. The server checks the domain; this only catches typos. */
export function recipientProblem(list: readonly string[]): string | null {
  if (!list.length) return "Add at least one email address.";
  const bad = list.filter((a) => !ADDRESS.test(a));
  return bad.length ? `Check ${bad.length === 1 ? "this address" : "these addresses"}: ${bad.join(", ")}` : null;
}

// ── chart helpers (2026-10-28) ────────────────────────────────────────────────

/**
 * One colour per workspace, handed out by the workspace's place in the list the server returned (name order), so a
 * workspace keeps its colour whatever else is selected.
 *
 * ⚠ These are the theme's own categorical tokens (`--k-*`, defined for BOTH themes in globals.css), because no colour
 * literal may live outside that file (`ui-honesty-check.sh` #14). They were made for step kinds; here they are only a
 * set of distinguishable hues, and the order avoids the three that already mean live, test and building on the chart
 * (`--ok`, `--warn`, `--accent`).
 */
const WORKSPACE_PALETTE = ["var(--k-datasource)", "var(--k-tool)", "var(--k-code)", "var(--k-approval)", "var(--k-loop)", "var(--k-http)", "var(--k-transform)"];
export const workspaceColour = (index: number) => WORKSPACE_PALETTE[((index % WORKSPACE_PALETTE.length) + WORKSPACE_PALETTE.length) % WORKSPACE_PALETTE.length]!;

/** The top of a chart's axis: the next round number above the data, so gridlines land on figures a person can read. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** `2026-10-27` → `27 Oct`, in UTC so the label is the day the server bucketed. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export interface RankedRow {
  key: string;
  name: string;
  costUsd: number;
  share: number;
  /** Absent on the rolled-up "Other" row, which cannot be opened. */
  group: ReportGroup | null;
  note?: string;
}

/** The biggest `top` groups, and everything after them rolled into one "Other" row that is not clickable. */
export function topRows(groups: readonly ReportGroup[], top = 8): RankedRow[] {
  const sorted = [...groups].sort((a, b) => b.costUsd - a.costUsd);
  const rows: RankedRow[] = sorted.slice(0, top).map((g) => ({ key: g.id ?? g.name, name: g.name, costUsd: g.costUsd, share: g.share, group: g, note: g.workspaceName }));
  const rest = sorted.slice(top);
  if (rest.length) {
    rows.push({ key: "__other", name: `Other (${rest.length})`, costUsd: rest.reduce((a, g) => a + g.costUsd, 0), share: rest.reduce((a, g) => a + g.share, 0), group: null });
  }
  return rows;
}

/** Where this calendar month is heading (`GET /reports/forecast`). Shown on the screen only; no file carries it. */
export interface MonthForecast {
  month: string;
  daysInMonth: number;
  today: number;
  soFar: number;
  /** False when too few complete days have passed to average; the figures below are then null. */
  enough: boolean;
  completeDays: number;
  basisDays: number;
  avgDaily: number | null;
  projected: number | null;
  low: number | null;
  high: number | null;
  series: Array<{ day: number; actual: number | null; projected: number | null }>;
}
