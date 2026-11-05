/**
 * The cost report as one Excel workbook (2026-10-26): a Summary sheet, then one sheet each for workspaces, workflows,
 * people and every run. Built from the same `ReportRun` rows the screen reads, so the file and the page cannot
 * disagree. Costs are numbers (not text) so a recipient can sum them; the unit is in the header.
 */
import { utils, write } from "xlsx";
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

export function buildReportWorkbook(input: {
  runs: readonly ReportRun[];
  window: ReportWindow;
  workspaces: readonly string[];
  /** Plain-words description of any drill filters applied, e.g. `Workflow: Invoice chase`. */
  filters: readonly string[];
  generatedBy: string;
}): Buffer {
  const s = summarise(input.runs, input.window);
  const wb = utils.book_new();

  utils.book_append_sheet(
    wb,
    sheet(
      [
        ["Cost report"],
        [],
        ["Period", `${input.window.fromDay} to ${input.window.toDay}`],
        ["Workspaces", input.workspaces.join(", ")],
        ...(input.filters.length ? [["Filters", input.filters.join("; ")]] : []),
        ["Prepared by", input.generatedBy],
        [],
        ["Total cost (USD)", cost(s.tiles.costUsd)],
        ["Tokens", s.tiles.tokens],
        ["Runs", s.tiles.runs],
        ["Workspaces with usage", s.tiles.workspaces],
        ["Workflows with usage", s.tiles.workflows],
        ["People", s.tiles.people],
        [],
        ["Cost by kind", "Cost (USD)", "Runs"],
        ...s.byPurpose.map((p) => [KIND[p.purpose], cost(p.costUsd), p.runs]),
        [],
        ["Cost is model (LLM) spend only, priced at the rate in effect when each call happened."],
      ],
      [26, 48, 12],
    ),
    "Summary",
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

  return write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
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
