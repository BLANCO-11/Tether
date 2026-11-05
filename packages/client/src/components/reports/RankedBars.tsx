// Horizontal bars, biggest first (2026-10-28): the shape of "Cost by workspace". Plain HTML, widths as percentages of
// the biggest bar. A row opens the thing it names; the rolled-up "Other" row is only a total and cannot be opened.

import { topRows, usd, type ReportGroup } from "@/lib/reports";

export function RankedBars({ groups, noun, colourOf, onOpen }: {
  groups: ReportGroup[];
  noun: "workspace" | "workflow" | "person";
  colourOf: (g: ReportGroup) => string;
  onOpen: (g: ReportGroup) => void;
}) {
  const rows = topRows(groups, 8);
  const max = rows.length ? Math.max(...rows.map((r) => r.costUsd), 0.000001) : 1;
  if (!rows.length) return <p className="text-sm text-muted">No usage in this period for this selection.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="min-w-0 truncate text-left">
              {r.name}
              {r.note ? <small className="block truncate text-[11px] text-dim">{r.note}</small> : null}
            </span>
            <span className="h-2.5 overflow-hidden rounded-full bg-line" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${(r.costUsd / max) * 100}%`, background: r.group ? colourOf(r.group) : "var(--muted)" }} />
            </span>
            <span className="min-w-[3.5rem] text-right font-semibold tabular-nums text-text">
              {usd(r.costUsd)}
              <small className="block text-[11px] font-normal text-muted">{Math.round(r.share * 100)}%</small>
            </span>
          </>
        );
        const cls = "grid w-full grid-cols-[minmax(80px,38%)_1fr_auto] items-center gap-3 rounded-md px-1 py-1 text-sm text-text";
        return (
          <li key={r.key}>
            {r.group ? (
              <button type="button" aria-label={`Open ${noun} ${r.name}`} title={`${r.name}: ${usd(r.costUsd)}, ${Math.round(r.share * 100)}% of this selection`} onClick={() => onOpen(r.group!)} className={`${cls} hover:bg-accent/10`}>
                {inner}
              </button>
            ) : (
              <div className={`${cls} opacity-75`}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
