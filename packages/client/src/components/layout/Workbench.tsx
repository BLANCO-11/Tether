// src/components/layout/Workbench.tsx — input on one side, canvas on the other,
// in the same place at every step. ui-upgrade Phase 6.1, D-79.
//
// ── What this is FOR (D-79, from review feedback) ────────────────────────────
//
// *"For a DAG workflow visualizer it should have its own space on the page, not
// in between other components."* Authoring an automation is not filling in a
// record — it is watching a graph take shape. So the canvas gets a pane at full
// height, in a fixed position, and the thing that changes between the three
// approaches is what the OTHER pane holds. That is what makes the graph feel
// like one place rather than a widget that reappears in three shapes.
//
// ── It folds; it does not squeeze (I-72, D-105) ──────────────────────────────
//
// Below the variant's own fold width the grid collapses to one column — input
// above, canvas below at full width and at least 380px tall. The alternative is
// a canvas narrower than three nodes, which cannot show a relationship and is
// therefore not a graph (D-79). ⚠ **The fold is in `globals.css`, and its three
// literals are proven equal to `foldWidth()` by `lib/workbench.test.ts`** — a
// media query is static text, so the derived number cannot be interpolated.
//
// ⚠ **This component owns no width and no measure.** The page still declares
// `<Page measure="wide">`; the workbench fills it. Two things choosing a width
// is D-78 all over again, one level in.
"use client";

import type { CSSProperties, ReactNode } from "react";
import type { WorkbenchVariant } from "@/lib/workbench";
import { ChevronLeft, ChevronRight } from "@/components/ui/icons";


/**
 * One pane. `label` names it for a screen reader — a grid of unlabelled regions
 * is a grid nobody can navigate — and `flush` turns the padding off for a pane
 * whose child manages its own inset (the canvas).
 */
export function WorkbenchPane({ label, children }: { label: string; children: ReactNode }) {
  // ⚠ The pane itself carries no padding and no height. `WorkbenchBody` owns the
  // inset, so a head strip sits flush against the pane's own border; and the
  // canvas owns the height, through its density (D-102), so there is exactly one
  // thing deciding how tall this row is.
  // ⚠ `relative` is load-bearing, not decoration. `BuilderShell`'s resize handle
  // is `absolute inset-y-0 left-0`, and with no positioned ancestor it resolved
  // against the PAGE — so the drag affordance rendered at the far left of the
  // screen instead of the panel edge, and an invisible col-resize strip sat
  // somewhere unrelated (`UXI-028`).
  return (
    <section aria-label={label} className="wb-pane relative">
      {children}
    </section>
  );
}

/**
 * The workbench grid.
 *
 * `variant` picks the shape AND the fold width, because the two are the same
 * decision: a variant holding more fixed chrome beside the canvas runs out of
 * room for it sooner. See `lib/workbench.ts`.
 *
 * ⚠ The class name is `wb-<variant>` and the CSS is keyed on exactly that
 * string, so a new variant needs an entry in `PANES`, a rule in `globals.css`
 * and nothing else — and `workbench.test.ts` fails if it gets one without the
 * other.
 */
export function Workbench({
  variant,
  children,
  className = "",
  style,
}: {
  variant: WorkbenchVariant;
  /** `WorkbenchPane`s, in visual order. */
  children: ReactNode;
  className?: string;
  /** e.g. `--chat-w`, the chat column's width when the person has dragged it (PiBuilderWorkbench). */
  style?: CSSProperties;
}) {
  return (
    <div className={`workbench wb-${variant} ${className}`} data-variant={variant} style={style}>
      {children}
    </div>
  );
}

/**
 * A pane's own heading strip — a title, and room for one control on the right.
 *
 * ⚠ The title follows the frozen mock's `wb-pane-head` (13px medium, regular
 * case — "Chat", "Components"), NOT the uppercase eyebrow style: a pane head is
 * a name, and the creation surfaces' panes read that way on purpose.
 */
export function WorkbenchHead({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`sticky top-0 z-10 flex h-[44px] min-h-[44px] items-center gap-2 border-b border-line bg-bg/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-bg/80${className ? ` ${className}` : ""}`}>
      <h3 className="text-body font-semibold text-text">{title}</h3>
      {children && <span className="ml-auto flex items-center gap-2">{children}</span>}
    </div>
  );
}

/** The scrolling body of a pane, under its head. Flush = frontier chat: gap-0, no inset, inner thread handles scroll. */
export function WorkbenchBody({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return (
    <div className={`flex flex-1 min-h-0 flex-col ${flush ? "gap-0 overflow-hidden p-0" : "gap-4 overflow-y-auto p-4"}`}>
      {children}
    </div>
  );
}

/**
 * A pane's collapsed form (D-28): a slim vertical rail with an expand affordance.
 * The grid column shrinks to 36px via the workbench's `-closed` classes.
 *
 * Default: rotated label (Chat). Icon mode (`icon`): glyph + optional meta
 * (e.g. step count) instead of vertical type — quieter for Canvas.
 */
export function WorkbenchRail({
  label,
  side,
  onExpand,
  icon,
  meta,
}: {
  label: string;
  /** Which side the rail sits on — decides which chevron points back in. */
  side: "left" | "right";
  onExpand: () => void;
  /** When set, the rail is icon-first (no rotated word); `label` stays the a11y name. */
  icon?: ReactNode;
  /** Short secondary signal under the icon — typically a count. */
  meta?: string;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Expand ${label}`}
      title={meta ? `${label} · ${meta}` : label}
      className={`pane-rail${icon ? " pane-rail-icon" : ""}`}
    >
      {side === "left" ? <ChevronRight s={14} /> : <ChevronLeft s={14} />}
      {icon ? (
        <>
          <span className="pane-rail-ico" aria-hidden>
            {icon}
          </span>
          {meta ? (
            <span className="pane-rail-meta" aria-hidden>
              {meta}
            </span>
          ) : null}
        </>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}
