// src/components/layout/Page.tsx — the five zones, and the only thing in the app
// allowed to set a page's width.
//
// ── THE MEASURED PROBLEM THIS REPLACES (ui-upgrade, D-77 and D-78) ────
//
// Before this component, every page picked its own width: `max-w-5xl` in eleven
// files, `max-w-4xl` in four, `max-w-3xl` in two — and nothing distinguished
// them. `/organization` and `/data-sources/[id]` were 4xl, `/keys` was 5xl, and
// no rule said why. Ordering was per-page too: `/keys` interleaved a runtime
// card, an agent-tenant card, a collision banner, a missing-value banner, two
// tables and a footnote in no legible order — six things where a reader is
// looking for one.
//
// So: three measures chosen by ARCHETYPE, and five zones in one fixed order.
//
//   1 header    title · one-line purpose · at most two actions
//   2 notices   errors, blocks, refusals, audits — page level, full width
//   3 controls  scope · search · filter · view
//   4 content   the collection, form, workbench or console
//   5 related   libraries, imports, "learn more" — below a wider gap
//
// A zone may be absent. A zone may never be reordered, and nothing renders
// outside one.
//
// ⚠ `Page` owns the measure AND the gaps; a page never sets a width or a margin
// again. That is not tidiness — it is what makes the rule CHECKABLE. Phase 4's
// exit is an honesty assertion that no file under `app/(app)` contains `max-w-`,
// and that assertion only means something if there is somewhere else for the
// width to live.
//
// ⚠ Zone 5 sits below a deliberately larger gap. `/flows` renders `FlowLibrary`
// flush against the automation list today, where it reads as more of the list
// rather than as a different question. The gap is the whole difference.
import type { ReactNode } from "react";

/**
 * The three measures. Pick by what the page IS, never by what fits.
 *
 * - `page` (1160px) — index, detail, console. The default, and most pages.
 * - `form` (680px) — a wizard or a single-record form. One column of fields;
 *   wider hurts, because a text input the width of a desk is harder to scan.
 * - `wide` (1440px) — the workbench only. A canvas is content, not a column.
 */
export type Measure = "page" | "form" | "wide";

const MEASURE: Record<Measure, string> = {
  page: "max-w-page",
  form: "max-w-form",
  wide: "max-w-wide",
};

/**
 * The page frame: one measure, centred, with the zone rhythm between children.
 *
 * ⚠ `children` should be `<Zone>`s and nothing else. That is not enforced by the
 * type — React makes that awkward and the escape hatch would be worse than the
 * rule — but a bare element here gets the zone gap without the zone semantics,
 * which is how the ordering rule decays.
 */
export function Page({
  measure = "page",
  children,
  className = "",
}: {
  measure?: Measure;
  children: ReactNode;
  className?: string;
}) {
  return (
    // ⚠ **No padding here — the shell owns the inset** (D-95). `(app)/layout.tsx`
    // has padded `<main>` since long before this component existed, so a page
    // that also padded itself was padded twice; `/triggers` demonstrated it for
    // one phase. `Page` owns the MEASURE and the ZONE RHYTHM; the shell owns the
    // gap between chrome and content. Two owners of one number is how they drift.
    <div className={`mx-auto w-full ${MEASURE[measure]} ${className}`}>
      {/* The gap BETWEEN zones. Zone 5 adds to it rather than replacing it, so
          the "related" separation is visibly larger than a section break. */}
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}

/** Which of the five a block of content is. The order here is the order on screen. */
export type ZoneName = "header" | "notices" | "controls" | "content" | "related";

// Zone 5 is the only one with chrome of its own: extra space above, and a
// hairline. Everything else is spacing.
const ZONE: Record<ZoneName, string> = {
  header: "",
  notices: "",
  controls: "",
  content: "",
  related: "mt-6 border-t border-line pt-8",
};

/**
 * One zone. `gap` is the space between the zone's OWN children — the page owns
 * the space between zones, a zone owns the space inside itself, and neither
 * knows about the other's.
 *
 * `as` exists because zone 1 should be a `<header>` and the rest usually should
 * not; a page that needs a `<section>` or an `<aside>` says so here rather than
 * wrapping the zone in one, which would put an element outside a zone.
 */
export function Zone({
  name,
  children,
  gap = "normal",
  as: Tag = "div",
  className = "",
}: {
  name: ZoneName;
  children: ReactNode;
  /** `tight` for stacked banners, `normal` for sections, `none` when the child owns its own spacing. */
  gap?: "none" | "tight" | "normal";
  as?: "div" | "header" | "section" | "aside";
  className?: string;
}) {
  const gapClass = gap === "none" ? "" : gap === "tight" ? "flex flex-col gap-3" : "flex flex-col gap-4"; // mock .zone gap 16
  return (
    // `data-zone` is not styling — it is how a test, a screenshot review or a
    // person with dev tools open can see the structure the rule describes. A
    // layout rule nobody can inspect is a layout rule nobody can check.
    <Tag data-zone={name} className={`${gapClass} ${ZONE[name]} ${className}`.trim()}>
      {children}
    </Tag>
  );
}
