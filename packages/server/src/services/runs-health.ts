/**
 * The dashboard's "Runs and health" figures (2026-10-23) — pure, so every rule here is tested without a database.
 *
 * A run has FOUR outcomes here, not three: `partial` (some items failed — e.g. 6 of 8 emails sent) is its own answer.
 * It used to be counted as `done`, so a run that left two people unmailed raised the success rate. Succeeded counts
 * full success only; a partly-done run is settled and is neither a success nor a failure.
 *
 * The periods are whole days in the viewer's time zone (`dayStart` is the start of their today): "7 days" is today
 * and the six days before it, so the sparkline's buckets and the figure count exactly the same runs. The previous
 * period is the same length just before it — for "today", yesterday up to this time of day, so a morning is not
 * compared with a whole day.
 */

export type RunOutcome = "done" | "partial" | "stopped" | "running";
export type HealthRange = "today" | "7d" | "30d";
export const HEALTH_RANGES: readonly HealthRange[] = ["today", "7d", "30d"];

export interface HealthRun {
  label: string;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: RunOutcome;
}

export interface HealthCounts {
  runs: number;
  /** Finished one way or another: succeeded + failed + partial. */
  settled: number;
  succeeded: number;
  failed: number;
  partial: number;
}

export interface HealthWindow {
  start: Date;
  prevStart: Date;
  prevEnd: Date;
  /** "hour" for today, "day" otherwise. */
  bucket: "hour" | "day";
  buckets: Array<{ start: Date; end: Date }>;
}

export interface Health {
  range: HealthRange;
  current: HealthCounts;
  previous: HealthCounts;
  /** Distinct automations the period's failures came from. */
  failedAutomations: number;
  series: Array<HealthCounts & { start: string }>;
  bucket: "hour" | "day";
  runningNow: number;
  /** How long the longest run still going has been going; null when nothing runs. */
  longestRunningMs: number | null;
  /** Median time of the period's settled runs; null when none settled with an end time. */
  medianMs: number | null;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function windowOf(range: HealthRange, dayStart: Date, now: Date): HealthWindow {
  if (range === "today") {
    const n = Math.max(1, Math.ceil((now.getTime() - dayStart.getTime()) / HOUR));
    return {
      start: dayStart,
      prevStart: new Date(dayStart.getTime() - DAY),
      prevEnd: new Date(now.getTime() - DAY),
      bucket: "hour",
      buckets: Array.from({ length: n }, (_, i) => ({ start: new Date(dayStart.getTime() + i * HOUR), end: new Date(dayStart.getTime() + (i + 1) * HOUR) })),
    };
  }
  const days = range === "7d" ? 7 : 30;
  const start = new Date(dayStart.getTime() - (days - 1) * DAY);
  return {
    start,
    prevStart: new Date(start.getTime() - days * DAY),
    prevEnd: start,
    bucket: "day",
    buckets: Array.from({ length: days }, (_, i) => ({ start: new Date(start.getTime() + i * DAY), end: new Date(start.getTime() + (i + 1) * DAY) })),
  };
}

export function countsOf(runs: HealthRun[]): HealthCounts {
  const c: HealthCounts = { runs: runs.length, settled: 0, succeeded: 0, failed: 0, partial: 0 };
  for (const r of runs) {
    if (r.outcome === "done") c.succeeded++;
    else if (r.outcome === "stopped") c.failed++;
    else if (r.outcome === "partial") c.partial++;
  }
  c.settled = c.succeeded + c.failed + c.partial;
  return c;
}

const within = (r: HealthRun, from: Date, to: Date) => r.startedAt != null && r.startedAt >= from && r.startedAt < to;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** `runs` may include runs from before the previous period that are still going — they count only as running now. */
export function healthOf(range: HealthRange, runs: HealthRun[], dayStart: Date, now: Date): Health {
  const w = windowOf(range, dayStart, now);
  // `now + 1ms` so a run that started this instant is in the period.
  const end = new Date(now.getTime() + 1);
  const current = runs.filter((r) => within(r, w.start, end));
  const previous = runs.filter((r) => within(r, w.prevStart, w.prevEnd));
  const running = runs.filter((r) => r.outcome === "running");
  const longest = running.reduce<number | null>((m, r) => (r.startedAt ? Math.max(m ?? 0, now.getTime() - r.startedAt.getTime()) : m), null);
  return {
    range,
    current: countsOf(current),
    previous: countsOf(previous),
    failedAutomations: new Set(current.filter((r) => r.outcome === "stopped").map((r) => r.label)).size,
    series: w.buckets.map((b) => ({ start: b.start.toISOString(), ...countsOf(current.filter((r) => within(r, b.start, b.end))) })),
    bucket: w.bucket,
    runningNow: running.length,
    longestRunningMs: longest,
    medianMs: median(
      current.filter((r) => r.outcome !== "running" && r.startedAt && r.endedAt).map((r) => r.endedAt!.getTime() - r.startedAt!.getTime()),
    ),
  };
}
