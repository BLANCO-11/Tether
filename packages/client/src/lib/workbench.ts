// src/lib/workbench.ts — how much room the workbench's panes need, and the
// width below which it must fold instead of squeezing. ui-upgrade Phase 6.1,
// D-105, and I-72 before it.
//
// ── Why this is arithmetic in a file rather than a breakpoint in a stylesheet ─
//
// The workbench is an input pane beside a canvas pane. A canvas needs
// `MIN_CANVAS_W` — 904px, three nodes and the two gaps between them — to show a
// relationship at all, which is the only thing it has over a list (D-79). Below
// that it must **fold** to one column, input above and canvas below at full
// width, rather than shrink: a graph zoomed until it is unreadable is not an
// error state, produces no warning, and looks deliberate (I-88 is the record of
// that shipping).
//
// ⚠ **I-72's own number was computed against the MOCK's node, not the
// product's.** It reasons *"about four nodes at 152px"*; the mock's canvas node
// is 176px (`.cnode`, with a 152px `.sm` variant) and `NODE_W` here is **232**.
// At the mock's 1340px fold the compose canvas is 636px — two nodes — so
// folding there would ship exactly the squeeze the issue exists to forbid.
// D-105 has the full recomputation and why `NODE_W` is not the lever to move.
//
// ── ⚠ The literals in globals.css are the ones that RUN ──────────────────────
//
// A CSS media query and a Tailwind class name are both static text, so nothing
// computed here can be interpolated into either. `workbench.test.ts` parses
// `globals.css` and asserts every declared breakpoint equals `foldWidth()` for
// its variant — the same shape `theme.test.ts` uses for the light-theme blocks.
// Change a pane width, or `NODE_W`, and that test goes red rather than the
// layout going quietly wrong.
import { MIN_CANVAS_W } from "@/lib/canvas-layout";

/**
 * What the shell takes before a page sees a pixel: the sidebar plus the main
 * region's padding at `lg`.
 *
 * ⚠ **The workbench assumes the COLLAPSED rail — D-146.** Flow-work pages
 * (`/flows/new` today, `/flows/[id]` in Phase 5) render immersive: the sidebar
 * auto-collapses to 56px (pack 04, 56px collapsed) so the three-pane layout can engage at a 1440
 * viewport (measured I-160 at 68px: at the expanded rail's 304px chrome the inspector
 * needs a 1608px viewport, so the DAG folded into a 135px sliver on the most
 * common laptop width; at 56px the chrome is 120px and the fold is 12px earlier).
 *
 * ⚠ Must track `Sidebar.tsx`'s `lg:w-[56px]` and `(app)/layout.tsx`'s `lg:p-8`.
 * Both are single occurrences; there is no third place to check.
 */
export const SIDEBAR_W = 56;
export const PAGE_PAD = 32;
export const SHELL_CHROME = SIDEBAR_W + PAGE_PAD * 2;

/** The `--w-wide` measure, which is what a workbench page asks `<Page>` for. */
export const WIDE_MEASURE = 1440;

/**
 * The four shapes the workbench takes, and the fixed chrome each holds beside
 * the canvas. Taken from the approved mock's own grid templates, which is why
 * they are oddly specific numbers rather than round ones.
 *
 * - `compose`     — a 400px input pane: the outline editor, the goal box.
 * - `chat`        — a 400px chat pane (D-159). The 296px step inspector is a
 *                   `.with-inspector` STATE on this variant, not a pane width,
 *                   so the fold is derived from the base 400 alone: the
 *                   inspector opens and closes without the breakpoint moving.
 * - `inspector`   — a 196px palette AND a 268px step inspector, canvas between.
 * - `canvasOnly`  — a 46px vertical tab rail and nothing else.
 */
export const PANES = {
  compose: 400,
  chat: 400,
  inspector: 196 + 268,
  canvasOnly: 46,
  builder: 320,
} as const;

/**
 * The canvas floor each variant tolerates before it folds. ⚠ User directive
 * 2026-08-13 (D-13): the mock's side-by-side geometry is the contract, and on
 * the most common laptop viewport (1265px usable) the ORIGINAL three-node
 * floor (840, D-105) put every creation surface folded — chat stacked ABOVE
 * the canvas, which the user has never once seen as the mock demonstrates it.
 * `chat`/`inspector` now fold only when the canvas would fall below two nodes
 * (the mock's own accepted geometry at D-03 gives the canvas 544px with the
 * inspector open). `compose` keeps the original three-node floor.
 */
export const MIN_CANVAS = {
  compose: MIN_CANVAS_W,
  // D-13 rev.2 (user directive, still "the chat page is the same"): the fold
  // must not exist on ANY desktop window. A VSCode-embedded preview or a
  // half-screen browser (600-900px usable) previously landed BELOW the chat
  // fold and stacked chat ABOVE the canvas — visually identical to the old
  // page. The floors below fold only at mobile/tablet-portrait widths, so
  // the mock's side-by-side geometry holds in every desktop viewport.
  chat: 188,      // fold 720px
  inspector: 204, // fold 800px
  canvasOnly: MIN_CANVAS_W,
  builder: 188,      // 320 + 188 + 120 = 628 — single 320 Inspector (unified, replaces 400+320)
} as const;

export type WorkbenchVariant = keyof typeof PANES;

/**
 * The narrowest VIEWPORT at which this variant can still give the canvas
 * `MIN_CANVAS_W`. At or above it the workbench is two (or three) columns; below
 * it, one.
 *
 * ⚠ It is capped by the measure, and that matters: `content` never exceeds
 * `--w-wide`, so a 4K monitor does not rescue a variant whose panes leave less
 * than 840 inside 1440. `inspector` is the tightest at 1436 and still fits —
 * and 1436 is deliberately below 1440 (D-146: flow-work pages ride a collapsed
 * rail, so the three-pane layout is real on a 1440 laptop, not a spec).
 */
export function foldWidth(variant: WorkbenchVariant): number {
  const panes = PANES[variant];
  const floor = MIN_CANVAS[variant];
  // ⚠ Not a type-only concern. `PANES[unknown]` is `undefined`, which makes
  // every comparison below `NaN`-false and returns `NaN` — a breakpoint that
  // silently disables itself. A variant with no entry must be an error.
  if (typeof panes !== "number" || typeof floor !== "number") {
    throw new Error(`unknown workbench variant "${variant}" — add it to PANES and to globals.css`);
  }
  const contentNeeded = panes + floor;
  if (contentNeeded > WIDE_MEASURE) {
    // Unreachable today, and it must not fail silently if a pane ever grows:
    // there would be no viewport wide enough, so the variant would fold always
    // while its stylesheet claimed a breakpoint.
    throw new Error(
      `workbench variant "${variant}" needs ${contentNeeded}px of content, more than the ${WIDE_MEASURE}px measure`,
    );
  }
  return contentNeeded + SHELL_CHROME;
}

/**
 * What the canvas actually gets at a given viewport, folded or not. Exported for
 * the tests and for anyone re-checking D-105's table by hand rather than
 * trusting it.
 */
export function canvasWidthAt(variant: WorkbenchVariant, viewport: number): number {
  const content = Math.min(WIDE_MEASURE, viewport - SHELL_CHROME);
  // Folded: the canvas is on its own row and gets the whole content width.
  return viewport < foldWidth(variant) ? content : content - PANES[variant];
}
