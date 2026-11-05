/** Bars per day, stacked by series — plain SVG (the client has no chart library). */
export function StackedBars({
  days,
  series,
  format,
}: {
  days: string[];
  series: Array<{ label: string; colour: string; values: Record<string, number> }>;
  format: (n: number) => string;
}) {
  const totals = days.map((d) => series.reduce((a, s) => a + (s.values[d] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const W = 720, H = 140, gap = 2;
  const bw = Math.max(2, W / Math.max(1, days.length) - gap);
  if (max === 0) return <p className="text-sm text-muted">Nothing in this period.</p>;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-40 w-full" role="img" aria-label={`Peak ${format(max)} in a day`}>
        {days.map((d, i) => {
          let y = H;
          return (
            <g key={d}>
              <title>{`${d}: ${series.map((s) => `${s.label} ${format(s.values[d] ?? 0)}`).join(", ")}`}</title>
              {series.map((s) => {
                const v = s.values[d] ?? 0;
                const h = (v / max) * H;
                y -= h;
                return v ? <rect key={s.label} x={i * (bw + gap)} y={y} width={bw} height={h} fill={s.colour} rx={1} /> : null;
              })}
            </g>
          );
        })}
        <text x={0} y={H + 14} className="fill-[var(--dim)] text-[10px]">{days[0]}</text>
        <text x={W} y={H + 14} textAnchor="end" className="fill-[var(--dim)] text-[10px]">{days[days.length - 1]}</text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.colour }} aria-hidden />
            {s.label}
          </span>
        ))}
        <span className="ml-auto">peak {format(max)} / day</span>
      </div>
    </div>
  );
}
