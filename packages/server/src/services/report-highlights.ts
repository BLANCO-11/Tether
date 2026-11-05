/**
 * The "highlights" of the PDF cost report (2026-10-29): a few plain sentences about where the money went.
 *
 * COMPUTED, never generated. Every sentence is a fixed template filled from the report's own figures, so a highlight
 * can only say what the numbers say, and one with nothing to say is left out rather than padded. No model writes
 * them, for the reason the repo keeps for suggestions generally (D-73): a model asked to describe a number will
 * sometimes describe a different one, and in a cost report that is the one line somebody quotes.
 */
import { dayLabel, percent, usd } from "./pdf-charts.js";
import { changeOf, type Comparison } from "./report-compare.js";
import type { ReportGroup, ReportSummary } from "./report.service.js";

export const MAX_HIGHLIGHTS = 5;

/**
 * Emphasis marks for the PDF. A highlight is built once, with its key figures wrapped in BOLD and workspace names in
 * WORKSPACE, so the PDF can render them bold (and a workspace in its own colour) while `highlightsOf` returns the very
 * same sentence as plain text. Control characters, so no name or number can ever be mistaken for one.
 */
export const BOLD = "\u0001";
export const WORKSPACE = "\u0002";
const MARKS = new RegExp(`[${BOLD}${WORKSPACE}]`, "g");
const b = (t: string) => `${BOLD}${t.replace(MARKS, "")}${BOLD}`;
const ws = (t: string) => `${WORKSPACE}${t.replace(MARKS, "")}${WORKSPACE}`;

/** A marked highlight split into runs of text: plain, bold, or a workspace name (bold, in that workspace's colour). */
export type HighlightPart = { text: string; style: "plain" | "bold" | "workspace" };
export function partsOf(marked: string): HighlightPart[] {
  const out: HighlightPart[] = [];
  for (const piece of marked.split(new RegExp(`(${BOLD}[^${BOLD}]*${BOLD}|${WORKSPACE}[^${WORKSPACE}]*${WORKSPACE})`))) {
    if (!piece) continue;
    if (piece.startsWith(BOLD)) out.push({ text: piece.slice(1, -1), style: "bold" });
    else if (piece.startsWith(WORKSPACE)) out.push({ text: piece.slice(1, -1), style: "workspace" });
    else out.push({ text: piece, style: "plain" });
  }
  return out.filter((p) => p.text);
}

const KIND: Record<string, string> = { live: "Live runs", test: "Test runs", building: "Build sessions" };

/** The group with the highest cost per run, among groups with at least two runs (one run is an anecdote, not a rate). */
function costliestPerRun(groups: readonly ReportGroup[]): { group: ReportGroup; perRun: number } | null {
  let best: { group: ReportGroup; perRun: number } | null = null;
  for (const g of groups) {
    if (g.runs < 2) continue;
    const perRun = g.costUsd / g.runs;
    if (!best || perRun > best.perRun) best = { group: g, perRun };
  }
  return best;
}

/** "Cost is up 12% on the previous 28 days: $266.78 against $238.10." Only when there is an earlier period to say it about. */
function againstBefore(cmp: Comparison): string | null {
  if (!cmp.hasPrevious) return null;
  const c = changeOf(cmp.current.costUsd, cmp.previous.costUsd);
  const span = `${cmp.usedDays} day${cmp.usedDays === 1 ? "" : "s"}`;
  const figures = `${b(usd(cmp.current.costUsd))} against ${usd(cmp.previous.costUsd)}`;
  const only = cmp.partialDay ? ` Today, ${dayLabel(cmp.partialDay)}, is not over yet and is left out.` : "";
  if (c.kind === "new") return `There was no cost in the previous ${span}; this period has ${b(usd(cmp.current.costUsd))}.${only}`;
  if (c.kind === "flat") return `Cost is ${b("unchanged")} on the previous ${span}: ${figures}.${only}`;
  const pct = c.pct >= 0.1 ? Math.round(c.pct * 100) : +(c.pct * 100).toFixed(1);
  return `Cost is ${b(`${c.kind === "up" ? "up" : "down"} ${pct}%`)} on the previous ${span}: ${figures}.${only}`;
}

/** The highlights as plain sentences, for anything that is not the PDF. */
export function highlightsOf(s: ReportSummary, cmp?: Comparison): string[] {
  return markedHighlightsOf(s, cmp).map((h) => h.replace(MARKS, ""));
}

/** The same highlights with their key figures marked for emphasis (see `partsOf`). */
export function markedHighlightsOf(s: ReportSummary, cmp?: Comparison): string[] {
  const total = s.tiles.costUsd;
  if (!(total > 0)) return s.tiles.runs ? ["The runs in this period have no recorded cost."] : ["There is no usage in this period."];

  const out: string[] = [];
  const before = cmp ? againstBefore(cmp) : null;
  if (before) out.push(before);
  const { workspaces, workflows } = s.lenses;

  if (workspaces.length >= 2) {
    const w = workspaces[0];
    out.push(`${ws(w.name)} spent the most: ${b(usd(w.costUsd))}, ${b(percent(w.share))} of the total.`);
  }

  const failed = s.byOutcome.find((o) => o.outcome === "failed");
  if (failed && failed.runs > 0) {
    out.push(`${b(`${failed.runs} run${failed.runs === 1 ? "" : "s"} failed`)}, costing ${b(usd(failed.costUsd))}.`);
  }

  if (workflows.length >= 2) {
    const w = workflows[0];
    out.push(`${b(w.name)}${w.workspaceName && workspaces.length >= 2 ? ` (${ws(w.workspaceName)})` : ""} was the costliest workflow: ${b(usd(w.costUsd))}, ${b(percent(w.share))} of the total.`);
  }

  if (s.byDay.length >= 2) {
    const peak = s.byDay.reduce((a, d) => (d.costUsd > a.costUsd ? d : a), s.byDay[0]);
    if (peak.costUsd > 0) out.push(`The busiest day was ${b(dayLabel(peak.day))}, at ${b(usd(peak.costUsd))}.`);
  }

  const rate = costliestPerRun(workflows);
  if (rate && workflows.length >= 2) {
    out.push(`${b(rate.group.name)} had the highest cost per run: ${b(usd(rate.perRun))} over ${rate.group.runs} runs.`);
  }

  const kinds = s.byPurpose.filter((p) => p.costUsd > 0);
  if (kinds.length >= 2) {
    out.push(`By kind: ${kinds.map((p) => `${KIND[p.purpose].toLowerCase()} ${b(percent(p.costUsd / total))}`).join(", ")}.`);
  }

  if (!out.length) out.push(`All of the ${b(usd(total))} came from one workspace, one workflow and one kind of run.`);
  return out.slice(0, MAX_HIGHLIGHTS);
}
