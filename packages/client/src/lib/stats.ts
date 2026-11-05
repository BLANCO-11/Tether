// src/lib/stats.ts — pure aggregation and formatting over runs, for the dashboard
// and history. No React, no storage: functions take rows (plus `now` where time
// matters) and return numbers/labels, so everything here is testable in isolation.
// Runs without machine fields (from an older backend) are simply left out of math
// that needs them — they still count toward totals.
import type { Run } from "@/lib/types";

const DAY = 86_400_000;

/** Runs that started within the last `days` days (needs startedAt). */
export function runsInLastDays(runs: Run[], days: number, now: number): Run[] {
  const cutoff = now - days * DAY;
  return runs.filter((r) => r.startedAt && Date.parse(r.startedAt) >= cutoff);
}

/**
 * Runs that have actually finished — the only ones a success rate may divide by.
 *
 * A run still in flight has not succeeded and has not failed. Counting it in the
 * denominator makes the rate sag while work is happening and recover when it
 * finishes, which reads as an incident; counting it as a FAILURE (what this file
 * did before `outcome` gained "running") states something false. Phase 4's
 * `agent` steps run for minutes, so at any moment several runs are live.
 */
export function settled(runs: Run[]): Run[] {
  return runs.filter((r) => r.outcome !== "running");
}

/** How many of these runs are still going. */
export function runningCount(runs: Run[]): number {
  return runs.filter((r) => r.outcome === "running").length;
}

/** Share of SETTLED runs that finished, 0..1. Nothing settled counts as 1 (nothing failed). */
export function successRate(runs: Run[]): number {
  const done = settled(runs);
  if (done.length === 0) return 1;
  return done.filter((r) => r.outcome === "done").length / done.length;
}

/** Average duration in ms across runs that carry one; 0 when none do. */
export function avgDurationMs(runs: Run[]): number {
  const timed = runs.filter((r) => typeof r.durationMs === "number");
  if (timed.length === 0) return 0;
  return timed.reduce((sum, r) => sum + (r.durationMs as number), 0) / timed.length;
}

/** `total` counts every run that day; `failed` counts only ones that actually stopped. */
export type DayPoint = { label: string; total: number; failed: number; running: number };

/** Per-day totals for the last `days` days, oldest first — the trend chart's data. */
export function seriesByDay(runs: Run[], days: number, now: number): DayPoint[] {
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayStart = startOfDay(now - i * DAY);
    const dayRuns = runs.filter((r) => {
      if (!r.startedAt) return false;
      const t = Date.parse(r.startedAt);
      return t >= dayStart && t < dayStart + DAY;
    });
    out.push({
      label: new Date(dayStart).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
      total: dayRuns.length,
      failed: dayRuns.filter((r) => r.outcome === "stopped").length,
      running: runningCount(dayRuns),
    });
  }
  return out;
}

export type AutomationStats = {
  name: string;
  runs: number;
  succeeded: number;
  /** Still in flight — excluded from `rate`, which is over settled runs only. */
  running: number;
  rate: number; // 0..1
  avgMs: number;
  lastStartedAt?: string; // ISO of the most recent run
};

/** Per-automation rollup, most-run first. */
export function perAutomation(runs: Run[]): AutomationStats[] {
  const byName = new Map<string, Run[]>();
  for (const r of runs) {
    const list = byName.get(r.automation) ?? [];
    list.push(r);
    byName.set(r.automation, list);
  }
  return [...byName.entries()]
    .map(([name, list]) => ({
      name,
      runs: list.length,
      succeeded: list.filter((r) => r.outcome === "done").length,
      running: runningCount(list),
      rate: successRate(list),
      avgMs: avgDurationMs(list),
      lastStartedAt: list
        .map((r) => r.startedAt)
        .filter((t): t is string => !!t)
        .sort()
        .pop(),
    }))
    .sort((a, b) => b.runs - a.runs);
}

/** "41 sec", "3 min", "1 hr 12 min" — durations in plain words. */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} sec`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 >= 30 ? `${min + 1} min` : `${min} min`;
  const hr = Math.floor(min / 60);
  return `${hr} hr ${min % 60} min`;
}

/** "09:12 today", "Yesterday 16:41", "Mon 30 Jun" — timestamps in plain words. */
export function fmtWhen(iso: string, now: number): string {
  const t = Date.parse(iso);
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (t >= startOfDay(now)) return `${time} today`;
  if (t >= startOfDay(now) - DAY) return `Yesterday ${time}`;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Midnight (local) of the day containing `t`. */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
