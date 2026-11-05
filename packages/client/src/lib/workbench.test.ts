// src/lib/workbench.test.ts — the fold, and the literals in globals.css
// that have to keep agreeing with it. ui-upgrade Phase 6.1, D-105.
//
// ⚠ **jsdom evaluates no media query and performs no layout** (I-75), so
// `plan.md`'s *"the workbench folds correctly at 1340px and 820px"* is not
// something a client test can watch happen. What IS checkable is the seam: the
// breakpoint the stylesheet declares is the breakpoint the arithmetic produces.
// Seeing it fold is a human step, recorded as a debt in `session-notes.md` §4.
//
// This is the same shape `theme.test.ts` uses for the two light-theme blocks:
// parse the CSS that actually ships, compare it to the source of truth, and let
// a stale literal be a red test rather than a layout that is quietly wrong.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_CANVAS,
  PANES,
  SHELL_CHROME,
  WIDE_MEASURE,
  canvasWidthAt,
  foldWidth,
  type WorkbenchVariant,
} from "./workbench";
import { MIN_CANVAS_W, NODE_W } from "./canvas-layout";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8");

/** The `min-width` of the `@media` block that gives this variant its columns. */
function declaredBreakpoint(variant: WorkbenchVariant): number | null {
  // Each variant has exactly one rule granting it grid columns, inside exactly
  // one min-width block. Matched by walking the blocks rather than by one big
  // regexp, so a rule moved into the wrong block is a mismatch and not a miss.
  const blocks = [...CSS.matchAll(/@media\s*\(min-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)];
  for (const [, px, body] of blocks) {
    if (new RegExp(`\\.workbench\\.wb-${variant}\\s*\\{[^}]*grid-template-columns`).test(body)) {
      return Number(px);
    }
  }
  return null;
}

describe("the fold width is derived, not chosen", () => {
  it("gives every variant its floor of canvas at its breakpoint", () => {
    for (const variant of Object.keys(PANES) as WorkbenchVariant[]) {
      // At exactly the fold width the canvas must be exactly at the variant's
      // floor — one pixel less and the layout would be showing less than the
      // design allows and calling it a graph. `compose`/`canvasOnly` floor at
      // three nodes (D-105); `chat`/`inspector` floor at two (D-13: the mock's
      // side-by-side geometry is the contract on laptop viewports).
      expect(canvasWidthAt(variant, foldWidth(variant)), variant).toBe(MIN_CANVAS[variant]);
    }
  });

  it("gives the canvas the WHOLE content width one pixel below the fold", () => {
    // The point of folding rather than squeezing: the canvas gets more room
    // folded than it had side by side. If that is ever false the fold is a
    // downgrade and the threshold is in the wrong place.
    for (const variant of Object.keys(PANES) as WorkbenchVariant[]) {
      const at = foldWidth(variant);
      expect(canvasWidthAt(variant, at - 1), variant).toBeGreaterThan(canvasWidthAt(variant, at));
    }
  });

  it("matches the stylesheet's literals in globals.css", () => {
    // ⚠ The load-bearing test in this file. A media query is static text, so
    // the computed number cannot be interpolated into the stylesheet — this is
    // what stops the two drifting.
    for (const variant of Object.keys(PANES) as WorkbenchVariant[]) {
      expect(declaredBreakpoint(variant), `globals.css breakpoint for wb-${variant}`).toBe(
        foldWidth(variant),
      );
    }
  });

  it("finds a rule for every variant at all", () => {
    // Guard on the guard: if the parse stops matching, the loop above compares
    // `null` to a number and fails — but a variant SILENTLY dropped from the
    // stylesheet would be a variant that never gets columns, and this is what
    // says so in its own words (I-38).
    for (const variant of Object.keys(PANES) as WorkbenchVariant[]) {
      expect(declaredBreakpoint(variant), `no grid rule for wb-${variant}`).not.toBeNull();
    }
    expect(Object.keys(PANES).length).toBeGreaterThan(2);
  });
});

/**
 * ⚠ **I-72's published number was computed against the MOCK's node, and this is
 * the arithmetic that corrects it** (D-105). The issue reasons *"about four
 * nodes at 152px"*; the product's node is 232 and cannot shrink (I-66).
 */
describe("the mock's 1340px fold would have shipped the squeeze it forbids", () => {
  it("leaves the compose canvas below the product minimum at 1340", () => {
    // Not folded at 1340 under the mock's rule, so the canvas is content minus
    // the input pane — and that is below the product's MIN_CANVAS_W, which is
    // what D-79 calls not a graph.
    //
    // ⚠ D-146 (collapsed rail) changed this arithmetic: the canvas at 1340 is
    // now 808px — three 232px nodes DO fit (748px), so the old "fewer than
    // three nodes" phrasing no longer holds. The product's declared minimum
    // still does: 808 < 840, the mock's fold would still have shipped the
    // squeeze it was supposed to forbid. This assertion is the rail-agnostic
    // statement of the same fact.
    const content = Math.min(WIDE_MEASURE, 1340 - SHELL_CHROME);
    const canvas = content - PANES.compose;
    expect(canvas).toBeLessThan(MIN_CANVAS_W);
  });

  it("folds the compose variant later than the mock did, not earlier", () => {
    expect(foldWidth("compose")).toBeGreaterThan(1340);
  });
});

describe("a variant whose panes leave no room refuses rather than folding always", () => {
  it("throws when the panes cannot fit beside a canvas inside the measure", () => {
    // A pane that grew past this point would fold at every viewport while its
    // stylesheet still declared a breakpoint — a layout that is never what it
    // says it is. Better a thrown error at import than a silent permanent fold.
    expect(PANES.inspector + MIN_CANVAS_W).toBeLessThanOrEqual(WIDE_MEASURE);
    expect(() => foldWidth("nope" as WorkbenchVariant)).toThrow();
  });
});
