# Implementation Plan: Automation UI redesign — StackAI / Langdock / Langflow structure

**Branch**: `20260812-205352-automation-ui-redesign` | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260812-205352-automation-ui-redesign/spec.md`

## Summary

Restructure the automation creation surfaces and the flow/run detail pages so each build type
reads as its reference product, while keeping Foundry's existing dual palette and design tokens
untouched and preserving all current behaviour (FR-008):

- **Manual builder → Langflow**: a three-region canvas-first surface — searchable, categorised
  component palette (left), open canvas (centre, with minimap + zoom), node inspector (right).
- **Chat → Langdock**: a conversation composer beside a live workflow canvas that updates as turns
  land.
- **Template → StackAI**: the blueprint shelf as a browsable, searchable, category-grouped library.
- **Flow / run pages**: the same DAG anatomy as the builder (editable on flow, read-only on run).
- **One design language**: a shared typography scale, spacing rhythm and motion vocabulary expressed
  through the existing tokens; no new colours (FR-007).

This is presentation-only: no new endpoints, no new data, no migrations. The three doors, chat
first-message routing, ref-mapping refusal, armed-vs-draft banner and the refusal grammar are
unchanged.

## Technical Context

**Language/Version**: TypeScript 5, React 18 (Next.js 14 App Router)

**Primary Dependencies**: Tailwind CSS (custom token config), `@xyflow/react` (React Flow 12) for the
canvas, Radix primitives (via the local `ui/` components), vitest + React Testing Library, Playwright
(for browser walks)

**Storage**: N/A — no data change. Node positions already live in `flow_step_positions`.

**Testing**: `pnpm` workspace — client/server vitest suites, `scripts/ui-honesty-check.sh`,
`e2e:ui` (two periods), `scenarios:verify`, browser walks via the Playwright harness in
`plans/frontend-2026-08-12/phase-3-chat/browser-walk/`.

**Target Platform**: Web (desktop-first; surfaces fold on narrow windows).

**Project Type**: Web application (monorepo — `packages/client` UI, `packages/server` API).

**Performance Goals**: Canvas interactions stay fluid (dagre layout memoised; no per-keystroke
relayout). New motion respects `prefers-reduced-motion`.

**Constraints**: Must not introduce new colours (FR-007); must not change behaviour (FR-008); every
touched surface records a browser walk (FR-009); gate set stays green (SC-004).

**Scale/Scope**: 3 mode surfaces + 2 detail pages + shared design language. ~15 source files, of
which the heavy lifts are `FlowBuilder.tsx`, `FlowCanvas.tsx`, `StepInspector.tsx`, `FlowLibrary.tsx`
and `globals.css`.

## Constitution Check

- **I. Spec-First** — PASS: work is on feature branch `20260812-205352-automation-ui-redesign` with
  spec/plan/tasks; all source edits are referenced in tasks.md.
- **II. Test-First** — PASS: component tests accompany each surface change; browser walks are the
  visual evidence; existing suites must stay green.
- **III. Code Review** — PASS (deferred): `/speckit-comply` before PR.
- **IV. Simplicity** — PASS: reuse the existing workbench/panel anatomy and `ui/` primitives; add a
  palette-only workbench variant rather than a new layout system.
- **V. Observability** — N/A (no new failure paths).
- **VI. Branch discipline** — PASS: timestamp branch, one feature.
- **VII. Documentation currency** — PASS: spec/plan/tasks + `docs/programmes/README.md` updated
  together.
- **VIII. Secrets** — PASS: no credentials involved.

## Project Structure

### Documentation (this feature)

```text
specs/20260812-205352-automation-ui-redesign/
├── plan.md              # this file
├── research.md          # design-language decisions (Phase 0)
├── quickstart.md        # validation guide (Phase 1)
└── tasks.md             # /speckit-tasks output
```

No `data-model.md` or `contracts/` — the feature introduces no data and no external interface.

### Source Code (repository root)

```text
packages/client/src/
├── app/
│   ├── (app)/flows/new/page.tsx      # three doors + mode dispatch (approach/compose)
│   ├── (app)/flows/[id]/page.tsx     # flow detail — same DAG anatomy, armed/draft banner
│   ├── (app)/runs/[id]/page.tsx      # run detail — read-only DAG
│   └── globals.css                   # design-language tokens/classes (typography, spacing, motion)
├── tailwind.config.ts                # type scale / spacing / motion token mapping
├── components/
│   ├── flow/
│   │   ├── FlowBuilder.tsx           # manual builder — three-region (palette/canvas/inspector)
│   │   ├── StepStrip.tsx             # → becomes the searchable, categorised palette
│   │   ├── StepInspector.tsx         # inspector pane (fields, inputs/outputs)
│   │   ├── FlowCanvas.tsx            # canvas + minimap/zoom + node anatomy
│   │   ├── ChatWorkbench.tsx         # chat + live workflow split (Langdock)
│   │   ├── ChatPanel.tsx             # conversation composer
│   │   ├── FlowLibrary.tsx           # template library shelf (StackAI)
│   │   └── FlowReview.tsx / ReplayControl.tsx / RevisionBanner.tsx  # shared anatomy reuse
│   ├── layout/Workbench.tsx          # workbench grid variants (add palette variant if needed)
│   └── ui/                           # existing primitives (Button, Field, Tile, Badge, ...)
```

**Structure Decision**: single `packages/client` frontend; the surfaces are composed from the
existing `workbench` grid + `ui/` primitives, with one new palette weight for the manual builder.
No new directories.

## Phases

### Phase A — Design language (foundation)
- Establish the concrete UI hierarchy (FR-012): a closed seven-step **type scale** as tailwind
  `fontSize` tokens (`micro` 10 / `caption` 11 / `xs` 12 / `body` 13 — the rest are Tailwind
  defaults `sm`/`lg`/`xl`); a **motion** vocabulary (`--dur-fast`/`--dur-base` + one easing curve)
  with a single global `prefers-reduced-motion` kill switch; and the existing colour palette
  untouched. Confirm the existing type scale, spacing rhythm and motion are already tokenized and
  shared (no new colours); reuse the existing `inspector` workbench variant for the three-region
  layout rather than adding a palette variant (see research.md D-3/D-5).

### Phase H — Template authoring  *(after D)*
- Add a "Build it for me" panel to the template surface (`FlowLibrary.tsx`): a description box that
  runs the existing generation job (`startFlowGeneration` → poll `getFlowGenerationJob`) with a
  progress read-out, then snapshots the flow via `saveFlowTemplate` and refreshes the shelf. No new
  endpoints (FR-013).

### Phase G — Hierarchy application  *(after B–E, before F)*
- Collapse the ~333 arbitrary font-size literals in the creation/flow/run surfaces to the seven-step
  scale (`text-[9px]`/`text-[10px]` → `text-micro`; `text-[11px]` → `text-caption`;
  `text-[11.5px]`/`text-[12px]` → `text-xs`; `text-[12.5px]`/`text-[13px]` → `text-body`).
  Scoped to `components/flow/**`, `components/layout/**`, the shared `components/ui/**` primitives
  those surfaces render, and the four pages `flows/new`, `flows`, `flows/[id]`, `runs/[id]`.
- Ensure each surface composes through the layer order (tokens → atoms → composites → pages) with
  the positioning ownership above; no surface re-invents spacing.

### Phase B — Manual builder (Langflow)  *(parallel with C)*
- `FlowBuilder` → searchable, category-grouped palette (left) + canvas (centre, minimap/zoom
  already present) + inspector (right).

### Phase C — Chat (Langdock)  *(parallel with B)*
- `ChatWorkbench` + `ChatPanel`: conversation bubbles + composer, live workflow pane beside; fold on
  narrow windows; preserve first-message routing and arrangement persistence.
- Chat reads as a clean GPT-esque conversation (bubbles + composer bar), and a right-hand inspector
  expands when a node is selected — node info (kind, ref, dependencies, contract) with the flow
  page's narrow edits (retry, approval gate, remove).

### Phase D — Template (StackAI)  *(parallel with B/C)*
- `FlowLibrary`/`TemplateSurface`/`BlueprintShelf`: browsable, searchable, category-grouped shelf;
  honest empty state; refs stated on each card.

### Phase E — Flow & run pages  *(after B/C/D)*
- Apply the shared node/canvas anatomy and status language to `/flows/[id]` and `/runs/[id]`;
  run page stays read-only.

### Phase F — Coherence + verification  *(last)*
- Cross-surface design-language sweep (US5); browser walks for every touched surface; full gate set.

## Complexity Tracking

None — no new dependencies, no new architecture. The only addition is a workbench palette variant
and design-language tokens, both justified by FR-001/FR-007.
