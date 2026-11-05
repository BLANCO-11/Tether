/**
 * The month-end forecast shown on the cost screen (2026-10-30). Screen only: it is not in the PDF, the workbook, the zip or
 * the email, because a projection is a guess and a file that is forwarded for years should hold only what happened.
 *
 * The method is deliberately plain: the average daily cost of the recent complete days, carried over the days left.
 *
 *   projected = cost so far + average × (the rest of today + every day after it)
 *
 * "Recent" is the last 7 complete days, or every complete day if fewer than 7 have passed. Today is left out of the
 * average (it is part of a day and would drag it down) and counted as it stands. With fewer than 3 complete days there
 * is too little to average, and the answer says so instead of guessing. The range is one standard deviation of the daily
 * cost, scaled to the days left, so a spiky month shows a wide range rather than a confident single number.
 */
import { isoDay, type ReportRun } from "./report.service.js";

const DAY = 86_400_000;
export const BASIS_DAYS = 7;
// TEMPORARY (2026-11-02, for testing): was 3. Restore to 3 and drop the today-only fallback below when done.
export const MIN_DAYS = 0;

export interface ForecastPoint {
  /** Day of the month, 1-based. */
  day: number;
  /** Cumulative cost to the end of this day; null after today. */
  actual: number | null;
  /** The projected cumulative cost, from today (equal to `actual` there) to the last day; null before today. */
  projected: number | null;
}

export interface MonthForecast {
  /** `2026-10`. */
  month: string;
  daysInMonth: number;
  /** Today's day of the month. */
  today: number;
  soFar: number;
  /** False when too few complete days have passed to average. Everything below is then null. */
  enough: boolean;
  completeDays: number;
  /** How many days the average was taken over. */
  basisDays: number;
  avgDaily: number | null;
  projected: number | null;
  low: number | null;
  high: number | null;
  series: ForecastPoint[];
}

/** First day and last day of the UTC month holding `now`, as `YYYY-MM-DD`. */
export function monthBounds(now: Date): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { from: isoDay(new Date(Date.UTC(y, m, 1))), to: isoDay(new Date(Date.UTC(y, m + 1, 0))) };
}

export function forecastMonth(runs: readonly ReportRun[], now: Date = new Date()): MonthForecast {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const today = now.getUTCDate();
  const monthStart = Date.UTC(y, m, 1);

  const daily = new Array<number>(daysInMonth).fill(0);
  for (const r of runs) {
    const i = Math.floor((Date.parse(r.at) - monthStart) / DAY);
    if (i >= 0 && i < today) daily[i] += r.costUsd; // nothing after today can exist; a clock skew is ignored, not counted
  }

  const cumulative: number[] = [];
  daily.slice(0, today).reduce((a, v, i) => (cumulative[i] = a + v), 0);
  const soFar = cumulative[today - 1] ?? 0;

  const completeDays = today - 1;
  const base: Omit<MonthForecast, "series"> = {
    month: `${y}-${String(m + 1).padStart(2, "0")}`,
    daysInMonth,
    today,
    soFar,
    enough: false,
    completeDays,
    basisDays: 0,
    avgDaily: null,
    projected: null,
    low: null,
    high: null,
  };
  const actualOnly = (): ForecastPoint[] =>
    daily.map((_, i) => ({ day: i + 1, actual: i < today ? cumulative[i] : null, projected: null }));
  if (completeDays < MIN_DAYS) return { ...base, series: actualOnly() };

  const fractionOfToday = (now.getTime() - Date.UTC(y, m, today)) / DAY;
  let basis = daily.slice(Math.max(0, completeDays - BASIS_DAYS), completeDays);
  // TEMPORARY: on the 1st there is no complete day, so today's cost so far is scaled to a whole day.
  if (basis.length === 0) basis = [fractionOfToday > 0 ? daily[today - 1] / fractionOfToday : daily[today - 1]];
  const avg = basis.reduce((a, v) => a + v, 0) / basis.length;
  const sd = Math.sqrt(basis.reduce((a, v) => a + (v - avg) ** 2, 0) / basis.length);

  const daysLeft = daysInMonth - today + (1 - fractionOfToday);
  const projected = soFar + avg * daysLeft;
  const spread = sd * Math.sqrt(daysLeft);
  const low = Math.max(soFar, projected - spread);
  const high = projected + spread;

  // A straight line from where the month stands to where it is projected to end.
  const series: ForecastPoint[] = daily.map((_, i) => {
    const day = i + 1;
    const projectedAt = day < today ? null : day === today ? soFar : soFar + ((projected - soFar) * (day - today)) / (daysInMonth - today || 1);
    return { day, actual: day <= today ? cumulative[i] : null, projected: projectedAt };
  });
  return { ...base, enough: true, basisDays: basis.length, avgDaily: avg, projected, low, high, series };
}
