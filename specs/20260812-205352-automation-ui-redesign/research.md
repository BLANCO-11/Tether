# Research & Design Decisions — Automation UI redesign

Phase 0 output for `specs/20260812-205352-automation-ui-redesign`. Records the design-language
decisions the plan relies on. All colour questions are closed: the palette is untouched (FR-007).

## D-1: Reference-product → build-type mapping

- **Decision**: chat → **Langdock**, template → **StackAI**, manual builder → **Langflow**.
- **Rationale**: each product's structure matches the *nature* of its mode — Langdock is chat-first
  with a workflow that updates as you talk; StackAI is a browsable block/template library; Langflow
  is a canvas-first node builder. This is the user's confirmed choice (2026-08-12).
- **Alternatives considered**: the original spec input's "StackAI for manual builder" reading was
  rejected because the manual builder's essence is the node canvas, which is Langflow's signature.

## D-2: Structure fidelity — "faithful structure, Foundry-native components"

- **Decision**: adopt each product's *layout skeleton* (palette/canvas/inspector; chat+canvas split;
  browsable library), built from Foundry's `ui/` primitives and the existing `workbench` grid, not a
  pixel-clone of the reference products.
- **Rationale**: keeps the app one product (FR-007, US5) and respects the repo's "changes layout,
  not palette" discipline. The reference products' exact shadows/radii/colours are not imported.
- **Alternatives considered**: close visual clone — rejected (would fight the token system and the
  constitution's simplicity principle).

## D-3: Manual-builder region widths (Langflow)

- **Decision**: keep the existing `inspector` workbench variant — palette **196px**, canvas
  `minmax(0,1fr)`, inspector **268px**. No new variant. Fold to a single column below the canvas's
  minimum readable width (unchanged).
- **Rationale (revised during implementation)**: the three-region palette/canvas/inspector layout
  already exists and already engages at a 1440px viewport (fold at 1436, D-146). Widening the
  palette to ~260px and the inspector to ~300px would push `foldWidth` past 1440 — breaking the
  one width where the three-pane layout must be real — for six items that already fit at 196px.
  Search + category grouping fit comfortably in the existing pane.
- **Alternatives considered**: a new `wb-palette` variant (260/300) — rejected (breaks the 1440px
  fold; adds a derived-width surface for no gain).

## D-4: Node identity on the canvas

- **Decision**: every node keeps its existing kind colour (`--k-*`) **and** states its kind in words
  (name + kind label). Colour is never the only carrier.
- **Rationale**: Langflow encodes component type by colour+icon+label; Foundry already encodes kind
  by hue, and the existing guidance (globals.css) mandates the word alongside the hue. No change to
  the palette — only the anatomy that presents it.
- **Alternatives considered**: icons per kind — rejected (introduces a new icon set and a new
  colour-free mapping; the word label is already sufficient and honest).

## D-5: Typography, spacing, motion

- **Decision**: formalise a named **type scale** (eyebrow/`text-[11px]` label, `13px` body-muted,
  `14px` body, `16px`/`text-lg` field, `20px`/`text-xl` panel heading) and a **spacing rhythm**
  (4/8/12/16/24 px, expressed as tokens), and a **motion vocabulary** (120–180ms micro-transitions,
  no layout-jump animations) — all `prefers-reduced-motion`-aware and mapped in `tailwind.config.ts`.
  No new colours.
- **Rationale**: US5 (one product) requires a single scale/rhythm; today the same spacing is spelled
  inconsistently (`space-y-4` vs `space-y-3` vs `mt-2.5`) across surfaces.
- **Alternatives considered**: full design-token library dependency — rejected (YAGNI; the values
  already exist in the codebase, they just need names).

## D-6: Zoom + minimap

- **Decision**: reuse React Flow's built-in controls (zoom) and minimap, re-pointed at Foundry tokens
  (already wired in globals.css's `.react-flow` variable block). Enable them on the manual builder
  and chat canvases; keep the run page read-only and static.
- **Rationale**: "a graph larger than the viewport remains navigable" (FR-003) is React Flow's
  native capability; importing a bespoke minimap would duplicate it.
- **Alternatives considered**: custom minimap component — rejected (duplication).

## D-7: Verification

- **Decision**: browser walks (Playwright harness) are the evidence for every touched surface —
  approach doors, manual builder, chat, template shelf, flow page, run page. Functional gate set
  (typecheck, package tests, `ui-honesty-check`, `scenarios:verify`, `e2e:ui`) must stay green.
- **Rationale**: nothing in this repo has been seen rendered by a human; a visual change without a
  walk is unverified (spec edge case, FR-009).
