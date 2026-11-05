// src/components/ui/FigureGrid.tsx — the pack's figure grid: figure above, label
// beneath, two by two.
//
// ⚠ THIS EXISTS BECAUSE `Tile` PUTS THEM THE OTHER WAY ROUND, AND THAT IS NOT A
// DETAIL. `Tile` renders an uppercase dim label and then a 3xl value under it;
// `S-01 § Layout` is explicit — *"`This month` is a **2 × 2 figures grid**: figure
// above, label beneath"* — and `02-design-language.md:88-89` fixes the type:
// **24–28px, weight 400, with an 11px `--dim` label beneath.** A figure grid where
// the eye meets the label first is a different reading order, so this is a
// different component rather than a variant of that one.
//
// The programme's `mapping.md` recorded the opposite conclusion during the first
// dashboard pass ("`FigureGrid` maps to the existing `Tile`") and that entry is
// **corrected, not deleted** — it was reached by comparing what the two carry
// (label, value, note, destination) without comparing the ORDER, which is the one
// thing the pack states about this card.
//
// ── WHAT IS KEPT FROM FOUNDRY'S TILE, DELIBERATELY ──────────────────────────
//
// `href` and `tone`. The pack's grid is four inert figures because its prototype
// had nowhere to navigate to; Foundry's tiles have carried a destination since
// D-17 and three tones since I-76 (a 40% success rate used to render AMBER
// because amber was the worst colour `StatTile` had). Dropping either to match a
// drawing would remove working behaviour, so the geometry follows the pack and
// the behaviour stays.
import type { ReactNode } from "react";
import Link from "next/link";
import { STATUS_STYLE, type StatusWord } from "@/lib/status";

export type Figure = {
  /** The number. Short — this is a figure, never a sentence. */
  value: string;
  /** What it counts, in sentence case. 11px, dim, beneath the value. */
  label: string;
  /** One line under the label. Optional. */
  note?: ReactNode;
  href?: string;
  tone?: StatusWord;
};

function FigureBody({ f }: { f: Figure }) {
  return (
    <>
      {/* 26px sits inside the pack's 24–28px band; weight 400, because a figure
          in a heavier weight reads as a status by itself. */}
      <div className="text-[26px] font-normal leading-none tabular-nums text-text">{f.value}</div>
      <div className="mt-2 text-caption text-dim">{f.label}</div>
      {f.note && <div className={`mt-1.5 text-caption ${STATUS_STYLE[f.tone ?? "draft"].text}`}>{f.note}</div>}
    </>
  );
}

export function FigureGrid({ items, columns = 2 }: { items: Figure[]; columns?: 2 | 3 | 4 }) {
  return (
    <div className={`grid gap-4 ${columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-2 lg:grid-cols-4"}`}>
      {items.map((f) => {
        const box = "rounded-lg border border-line bg-surface p-4 transition-[background-color,border-color,transform] duration-150 ease-out";
        return f.href ? (
          <Link key={f.label} href={f.href} className={`${box} hover:-translate-y-px hover:border-line-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:hover:translate-y-0`}>
            <FigureBody f={f} />
          </Link>
        ) : (
          <div key={f.label} className={box}>
            <FigureBody f={f} />
          </div>
        );
      })}
    </div>
  );
}
