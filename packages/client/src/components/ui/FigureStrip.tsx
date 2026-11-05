// src/components/ui/FigureStrip.tsx — the pack's figures strip: ONE full-width
// card, four figures in one row, figure over label.
//
// ⚠ THIS IS DELIBERATELY NOT `FigureGrid`. S-29 § Layout is explicit — *"The
// figures strip is a single full-width card, four figures in one row, figure over
// label — a different shape from S-01's 2 × 2 `This month` card."* The two
// shapes read differently: a row inside one card is a person comparing four
// counts at a glance; a 2×2 grid is four panels in one region. Same primitives,
// different composition, so it is a different component rather than a prop on
// that one.
//
// ⚠ The figures here are the ones real data can answer. `S-29 § States` is blunt
// that every non-flagship workflow renders what it *does* have and never borrows
// the flagship's figures — so the caller passes what it computed, never a
// measured copy that would be a claim the model cannot make.
import type { ReactNode } from "react";
import { STATUS_STYLE, type StatusWord } from "@/lib/status";

export type StripFigure = {
  /** The number. Short — this is a figure, never a sentence. */
  value: string;
  /** What it counts, in sentence case, under the value. */
  label: ReactNode;
  /** One line under the label. Optional; the pack's 4th figure uses it. */
  note?: ReactNode;
  tone?: StatusWord;
};

export function FigureStrip({ items }: { items: StripFigure[] }) {
  return (
    <div className="grid grid-cols-2 gap-y-4 rounded-lg border border-line bg-surface px-4 py-4 sm:grid-cols-4">
      {items.map((f, i) => (
        <div
          key={i}
          className={`${i > 0 ? "sm:border-l sm:border-line sm:pl-6" : ""} px-1 py-1 sm:py-0`}
        >
          <div className="text-[26px] font-normal leading-none text-text">{f.value}</div>
          <div className="mt-2 text-caption text-dim">{f.label}</div>
          {f.note && (
            <div className={`mt-1.5 text-caption ${STATUS_STYLE[f.tone ?? "draft"].text}`}>{f.note}</div>
          )}
        </div>
      ))}
    </div>
  );
}
