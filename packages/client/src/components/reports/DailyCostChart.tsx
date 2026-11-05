"use client";

// Cost per day, stacked by what spent it (2026-10-28). Hand-drawn SVG, no chart library: the bars, the gridlines and the
// axis figures are computed from the summary the server returned and nothing else. Hovering or focusing a day shows its
// exact figures; the legend carries the period's total for each kind.

import { useState } from "react";
import { dayLabel, niceMax, usd, type ReportPurpose, type ReportSummary } from "@/lib/reports";

const W = 800;
const H = 230;
const L = 52;
const R = 8;
const T = 10;
const B = 26;
const PW = W - L - R;
const PH = H - T - B;

/** Bottom to top. Colours are the app's own tokens, so both themes follow. */
const STACK: Array<{ k: ReportPurpose; label: string; colour: string }> = [
  { k: "building", label: "Building", colour: "var(--accent)" },
  { k: "test", label: "Testing", colour: "var(--warn)" },
  { k: "live", label: "Live runs", colour: "var(--ok)" },
];
const LEGEND = [STACK[2]!, STACK[1]!, STACK[0]!];

export function DailyCostChart({ byDay, byPurpose }: { byDay: ReportSummary["byDay"]; byPurpose: ReportSummary["byPurpose"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(byDay.length, 1);
  const max = niceMax(Math.max(...byDay.map((d) => d.costUsd), 0));
  const bw = PW / n;
  const total = byPurpose.reduce((a, p) => a + p.costUsd, 0) || 1;
  const ticks = [0, 1, 2, 3, 4];
  const labelAt = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const h = hover !== null ? byDay[hover] : null;

  return (
    <section className="pane p-4" aria-label="Cost per day">
      <h2 className="text-body font-semibold text-text">Cost per day</h2>
      <p className="mb-3 text-caption text-dim">Split by what spent it. Hover a day for the exact figures.</p>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cost per day, ${dayLabel(byDay[0]?.day ?? "")} to ${dayLabel(byDay.at(-1)?.day ?? "")}`} className="h-auto w-full">
          {ticks.map((t) => {
            const y = T + PH - (PH * t) / 4;
            return (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--line)" strokeWidth="1" />
                <text x={L - 8} y={y + 4} textAnchor="end" fontSize="12" fill="var(--muted)">{usd((max * t) / 4)}</text>
              </g>
            );
          })}
          {byDay.map((d, i) => {
            let y = T + PH;
            return (
              <g
                key={d.day}
                tabIndex={0}
                role="img"
                aria-label={`${dayLabel(d.day)}: ${usd(d.costUsd)}. Live ${usd(d.live)}, testing ${usd(d.test)}, building ${usd(d.building)}.`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              >
                {STACK.map((s) => {
                  const bh = (d[s.k] / max) * PH;
                  y -= bh;
                  return bh > 0 ? <rect key={s.k} x={i * bw + L + bw * 0.14} y={y} width={bw * 0.72} height={bh} fill={s.colour} /> : null;
                })}
                <rect x={L + i * bw} y={T} width={bw} height={PH} fill={hover === i ? "var(--text)" : "transparent"} opacity={hover === i ? 0.06 : 1} />
              </g>
            );
          })}
          {labelAt.map((i, j) => (
            <text key={i} x={L + i * bw + bw / 2} y={H - 6} textAnchor={j === 0 ? "start" : j === labelAt.length - 1 ? "end" : "middle"} fontSize="12" fill="var(--muted)">
              {dayLabel(byDay[i]!.day)}
            </text>
          ))}
        </svg>
        {h ? (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 w-44 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-lg"
            style={{ left: `clamp(0%, calc(${((L + hover! * bw + bw / 2) / W) * 100}% - 88px), calc(100% - 11rem))` }}
          >
            <div className="font-semibold text-text">{dayLabel(h.day)}</div>
            <div className="tabular-nums text-text">{usd(h.costUsd)} total</div>
            {LEGEND.map((s) => (
              <div key={s.k} className="flex items-center gap-2 tabular-nums text-muted">
                <i className="inline-block h-2 w-2 rounded-sm" style={{ background: s.colour }} aria-hidden />
                {s.label}
                <span className="ml-auto">{usd(h[s.k])}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {LEGEND.map((s) => {
          const cost = byPurpose.find((p) => p.purpose === s.k)?.costUsd ?? 0;
          return (
            <li key={s.k} className="flex items-center gap-1.5">
              <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.colour }} aria-hidden />
              {s.label} {usd(cost)} · {Math.round((cost / total) * 100)}%
            </li>
          );
        })}
      </ul>
    </section>
  );
}
