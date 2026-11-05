/**
 * The cost report's comparison with the previous period (2026-10-29): "better or worse than before".
 *
 * The previous period is the same number of days directly before this one. Days are lined up by position (day 1 against
 * day 1), so each point compares like with like.
 *
 * A period that includes today is compared on COMPLETE days only. Today is part of a day, so setting it beside a whole
 * earlier day would show a drop that never happened; it is left out of both sides and the report says so.
 *
 * Nothing is invented: with no earlier usage there is no comparison (`hasPrevious: false`), and a figure that grew from
 * zero is "new", not an infinite percentage.
 */
import { NO_FLOW, isoDay, type ReportRun, type ReportWindow } from "./report.service.js";

const DAY = 86_400_000;

/** The window of the same length that ends the day before `w` starts. */
export function previousWindow(w: ReportWindow): ReportWindow {
  const length = w.until.getTime() - w.since.getTime();
  const since = new Date(w.since.getTime() - length);
  return { since, until: w.since, fromDay: isoDay(since), toDay: isoDay(new Date(w.since.getTime() - DAY)) };
}

export interface Change {
  kind: "none" | "new" | "flat" | "up" | "down";
  /** A fraction (0.12 is 12%); 0 unless `up` or `down`. */
  pct: number;
}

/** Change from `before` to `now`. Under half a percent is "no change": a figure that moved in the fifth decimal has not moved. */
export function changeOf(now: number, before: number, hasPrevious = true): Change {
  if (!hasPrevious) return { kind: "none", pct: 0 };
  if (!(before > 0)) return now > 0 ? { kind: "new", pct: 0 } : { kind: "flat", pct: 0 };
  const pct = (now - before) / before;
  if (Math.abs(pct) < 0.005) return { kind: "flat", pct: 0 };
  return { kind: pct > 0 ? "up" : "down", pct: Math.abs(pct) };
}

export interface Totals {
  costUsd: number;
  runs: number;
  tokens: number;
  people: number;
}

export interface Comparison {
  /** False when the earlier period has no usage at all: there is nothing to compare with. */
  hasPrevious: boolean;
  previousWindow: ReportWindow;
  /** Days in the period, and how many of them are compared (all, or all but today). */
  days: number;
  usedDays: number;
  /** The day left out because it is not over yet, or null. */
  partialDay: string | null;
  /** Runs on the compared days, this period and the one before. */
  currentRuns: ReportRun[];
  previousRuns: ReportRun[];
  current: Totals;
  previous: Totals;
  /** One entry per day of the period; null where the day is not compared. */
  currentDaily: Array<number | null>;
  previousDaily: Array<number | null>;
}

const dayIndex = (r: ReportRun, since: Date) => Math.floor((Date.parse(r.at) - since.getTime()) / DAY);

function totals(runs: readonly ReportRun[]): Totals {
  return {
    costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
    runs: runs.length,
    tokens: runs.reduce((a, r) => a + r.tokens, 0),
    people: new Set(runs.map((r) => r.subject ?? r.person)).size,
  };
}

export function compare(
  runs: readonly ReportRun[],
  previous: readonly ReportRun[] | undefined,
  window: ReportWindow,
  now: Date = new Date(),
): Comparison {
  const prevWindow = previousWindow(window);
  const days = Math.round((window.until.getTime() - window.since.getTime()) / DAY);

  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayIndex = Math.floor((todayStart - window.since.getTime()) / DAY);
  // Today is in the period. Leave it out, unless it is the only day there is.
  const partial = todayIndex >= 0 && todayIndex < days && todayIndex > 0;
  const usedDays = partial ? todayIndex : days;

  const currentRuns = runs.filter((r) => dayIndex(r, window.since) < usedDays);
  const previousRuns = (previous ?? []).filter((r) => dayIndex(r, prevWindow.since) < usedDays);

  const daily = (list: readonly ReportRun[], since: Date): Array<number | null> => {
    const out: Array<number | null> = Array.from({ length: days }, (_, i) => (i < usedDays ? 0 : null));
    for (const r of list) {
      const i = dayIndex(r, since);
      if (i >= 0 && i < usedDays) out[i] = (out[i] ?? 0) + r.costUsd;
    }
    return out;
  };

  return {
    hasPrevious: (previous?.length ?? 0) > 0,
    previousWindow: prevWindow,
    days,
    usedDays,
    partialDay: partial ? isoDay(new Date(todayStart)) : null,
    currentRuns,
    previousRuns,
    current: totals(currentRuns),
    previous: totals(previousRuns),
    currentDaily: daily(currentRuns, window.since),
    previousDaily: daily(previousRuns, prevWindow.since),
  };
}

/** Cost per group key, for a "change" column: look up a row's earlier cost by the same key the row was grouped by. */
export function costByKey(runs: readonly ReportRun[], keyOf: (r: ReportRun) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of runs) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + r.costUsd);
  return m;
}

/** The keys a report's three lenses group by, the same ones `summarise` uses, so a lookup always finds its row. */
export const KEYS = {
  workspace: (r: ReportRun) => r.workspaceId,
  workflow: (r: ReportRun) => r.flowId ?? NO_FLOW,
  person: (r: ReportRun) => r.subject ?? `name:${r.person}`,
};
