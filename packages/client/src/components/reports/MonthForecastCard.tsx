"use client";

// Where this calendar month is heading (2026-10-30). Shown on the screen only: no download, email or file carries it,
// because a projection is a guess and a file that is forwarded keeps it for years. It always covers the current month,
// whatever period the page is set to, and it follows the same filters (workspaces, workflow, person).
//
// The method is the one the server states in `report-forecast.ts`: the average of the recent complete days, carried
// over the days left. Three states are drawn and none of them is blank: the forecast; "not enough days yet", which is
// a real answer and not an error; and "could not be worked out", so a failed read is never mistaken for a quiet month.

import { useEffect, useState } from "react";
import { getReportForecast } from "@/lib/api";
import { niceMax, usd, type MonthForecast, type ReportQuery } from "@/lib/reports";

const W = 300;
const H = 170;
const L = 40;
const R = 6;
const T = 8;
const B = 20;
const PW = W - L - R;
const PH = H - T - B;

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export function MonthForecastCard({ query }: { query: ReportQuery }) {
  const [f, setF] = useState<MonthForecast | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    Promise.resolve(getReportForecast(query))
      .then((r) => live && setF(r ?? null))
      .catch(() => live && (setF(null), setFailed(true)));
    return () => {
      live = false;
    };
  }, [query]);

  return (
    <section className="pane min-w-0 p-4" aria-label="Month-end forecast">
      <h2 className="text-body font-semibold text-text">Month-end forecast</h2>
      <p className="mb-3 text-caption text-dim">{f ? monthName(f.month) : "This month"} · on screen only, not in downloads</p>
      {failed ? (
        <p className="text-sm text-muted">The forecast could not be worked out just now. The figures on the page are not affected.</p>
      ) : !f ? (
        <p className="text-sm text-muted">Working it out…</p>
      ) : !f.enough ? (
        <p className="text-sm text-muted">
          Not enough days yet. A forecast needs at least 3 complete days this month, and {f.completeDays} {f.completeDays === 1 ? "has" : "have"} passed. So far: {usd(f.soFar)}.
        </p>
      ) : (
        <Forecast f={f} />
      )}
    </section>
  );
}

function Forecast({ f }: { f: MonthForecast }) {
  const top = niceMax(Math.max(f.high ?? 0, f.projected ?? 0, f.soFar));
  const x = (day: number) => L + (PW * (day - 1)) / Math.max(f.daysInMonth - 1, 1);
  const y = (v: number) => T + PH - (PH * v) / top;
  const line = (pick: (p: MonthForecast["series"][number]) => number | null) =>
    f.series
      .filter((p) => pick(p) !== null)
      .map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)} ${y(pick(p)!).toFixed(1)}`)
      .join(" ");
  const ticks = [0, 1, 2, 3];
  const end = f.series[f.daysInMonth - 1];

  return (
    <div>
      <div className="text-caption text-dim">Projected month-end cost</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-text">{usd(f.projected!)}</div>
      <div className="mt-0.5 text-xs text-muted">Likely between {usd(f.low!)} and {usd(f.high!)}</div>

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cost so far this month and the projection to month end, ${usd(f.projected!)}`} className="mt-3 h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y((top * t) / 3)} y2={y((top * t) / 3)} stroke="var(--line)" strokeWidth="1" />
            <text x={L - 6} y={y((top * t) / 3) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{usd((top * t) / 3)}</text>
          </g>
        ))}
        <path d={line((p) => p.projected)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 4" />
        <path d={line((p) => p.actual)} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
        <circle cx={x(f.today)} cy={y(f.soFar)} r="3.5" fill="var(--accent)" />
        <circle cx={x(f.daysInMonth)} cy={y(end.projected ?? f.projected!)} r="3.5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
        <text x={L} y={H - 4} fontSize="10" fill="var(--muted)">1</text>
        <text x={x(f.today)} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--muted)">today</text>
        <text x={W - R} y={H - 4} textAnchor="end" fontSize="10" fill="var(--muted)">{f.daysInMonth}</text>
      </svg>

      <ul className="mt-2 space-y-1 text-xs text-muted">
        <li className="flex items-center gap-2"><i className="inline-block h-0.5 w-4 bg-accent" aria-hidden />So far {usd(f.soFar)}</li>
        <li className="flex items-center gap-2"><i className="inline-block w-4 border-t-2 border-dashed border-accent" aria-hidden />Projected from today</li>
      </ul>
      <p className="mt-2 text-xs text-muted">
        Average {usd(f.avgDaily!)} a day over the last {f.basisDays} complete {f.basisDays === 1 ? "day" : "days"}, carried to the end of the month. A guess, not a promise.
      </p>
    </div>
  );
}
