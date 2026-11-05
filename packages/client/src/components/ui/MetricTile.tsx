// src/components/ui/MetricTile.tsx — the figure tile with a trend line, one definition.
//
// The dashboard's "Runs and health" row and a workflow's own page show the same kind of figure (runs, success rate,
// failures). Two copies of the tile would drift the way FlowStatusPill's three copies did, so both read this one.
import Link from "next/link";
import type { ReactNode } from "react";

type Size = "md" | "sm";

/** A trend line, decoration only — the figure beside it carries the number (aria-hidden). Two points or nothing. */
export function Sparkline({ values, stroke, size = "md" }: { values: number[]; stroke: string; size?: Size }) {
  if (values.length < 2) return null;
  const w = size === "sm" ? 56 : 74;
  const h = size === "sm" ? 20 : 26;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values.map((v, i) => [(i * w) / (values.length - 1), h - 3 - ((v - min) / (max - min || 1)) * (h - 6)] as const);
  const [lx, ly] = pts[pts.length - 1]!;
  const place = size === "sm" ? "bottom-2.5 right-3" : "right-3.5 top-4";
  return (
    <svg width={w} height={h} aria-hidden data-testid="sparkline" className={`absolute ${place} ${stroke}`}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={size === "sm" ? 2 : 2.5} fill="currentColor" />
    </svg>
  );
}

/** A figure: label (with an optional coloured dot), the number, a note, and an optional trend line. */
export function MetricTile({
  label,
  dot,
  value,
  valueTone,
  sub,
  note,
  spark,
  href,
  size = "md",
  children,
}: {
  label: string;
  dot?: string;
  value?: string;
  valueTone?: string;
  sub?: string;
  note?: ReactNode;
  spark?: ReactNode;
  /** A link when given; otherwise a plain tile (one holding a button must not sit inside a link). */
  href?: string;
  size?: Size;
  /** Extra content under the note — e.g. a status tag and its action. */
  children?: ReactNode;
}) {
  const sm = size === "sm";
  const box = `relative flex flex-col gap-0.5 rounded-lg border border-line bg-surface ${
    sm ? "min-h-[96px] px-3 pb-2.5 pt-2.5" : "px-4 pb-3 pt-3.5"
  }`;
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-caption text-muted">
        {dot && <span className={`${sm ? "h-1.5 w-1.5" : "h-2 w-2"} shrink-0 rounded-full ${dot}`} aria-hidden />}
        {label}
      </span>
      {value != null && (
        <span className={`${sm ? "text-[22px]" : "text-[28px]"} font-medium leading-tight tabular-nums ${valueTone ?? "text-text"}`}>
          {value}
          {sub && <small className={`ml-1 ${sm ? "text-caption" : "text-[14px]"} font-normal text-muted`}>{sub}</small>}
        </span>
      )}
      {note != null && <span className={`flex flex-wrap items-center gap-x-1.5 ${sm ? "text-[11px]" : "text-caption"}`}>{note}</span>}
      {children}
      {spark}
    </>
  );
  return href ? (
    <Link
      href={href}
      className={`${box} transition-[background-color,border-color] duration-150 hover:border-line-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}
