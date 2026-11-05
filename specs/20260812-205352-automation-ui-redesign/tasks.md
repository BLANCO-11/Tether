# Tasks: Automation UI redesign — StackAI / Langdock / Langflow structure

**Input**: Design documents from `/specs/20260812-205352-automation-ui-redesign/`

**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Tests**: Component tests are updated/extended where a surface changes (test-first per the
constitution). Existing suites must stay green; no new test framework is introduced.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1..US5)

---

## Phase 1: Setup (Baseline)

**Purpose**: Confirm a green baseline before any structural change.

- [x] T001 Establish baseline: run client+server `tsc --noEmit` and vitest suites; confirm
  `scripts/ui-honesty-check.sh` = 0 FAIL before touching source.

---

## Phase 2: Foundational — design language (Blocking Prerequisites)

**Purpose**: The shared typography scale, spacing rhythm, motion vocabulary, the palette workbench
variant and the node anatomy. Every story composes from these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 [P] Confirm the type scale + spacing rhythm are already tokenized and shared —
  `tailwind.config.ts` maps `var(--*)` and the surfaces share one de facto scale; no new colours
  needed (FR-007). (Revised: reuse, not add — see research.md D-5.)
- [x] T003 [P] Confirm motion is already reduced-motion-aware (existing `prefers-reduced-motion`
  guards in `globals.css`) — no new tokens introduced (YAGNI).
- [x] T004 Reuse the existing `inspector` workbench variant for the three-region manual builder
  (no new `wb-palette` variant; D-3 revised to keep the 1440px fold).
- [x] T005 Leave `packages/client/src/lib/workbench.ts` widths unchanged — `inspector` (196+268)
  already fits `MIN_CANVAS_W` at 1440, pinned green by `workbench.test.ts`.

**Checkpoint**: Foundation ready — the three story surfaces can begin in parallel.

---

## Phase 3: User Story 1 — Manual builder reads as a canvas-first node builder (Priority: P1) 🎯 MVP

**Goal**: Three-region Langflow-style surface — searchable categorised palette (left), open canvas
(centre, with minimap + zoom), node inspector (right).

**Independent Test**: Open the manual builder; confirm palette / canvas / inspector regions; search
filters the palette; a component added from the palette renders as a node with a category marker and
kind in words; selecting a node opens its inspector; minimap/zoom present.

### Implementation for User Story 1

- [x] T006 [US1] Keep the three-region `inspector` workbench in
  `packages/client/src/components/flow/FlowBuilder.tsx` (palette / canvas / inspector already the
  shape) and refine it to read as Langflow.
- [x] T007 [US1] Make the palette in `packages/client/src/components/flow/FlowBuilder.tsx`
  searchable and category-grouped (`PALETTE_CATEGORIES`: Data / Logic / Human & model) with a
  per-kind colour marker. (Note: the palette lives inline in FlowBuilder — `StepStrip.tsx` is the
  run-progress strip, not the palette; the plan's file reference was corrected.)
- [x] T008 [US1] Confirm minimap + zoom controls already exist in
  `packages/client/src/components/flow/FlowCanvas.tsx` (toolbar fit/zoom + `MiniMap` for >8 nodes),
  re-pointed at existing tokens.
- [x] T009 [US1] Confirm the node card in `packages/client/src/components/flow/FlowCanvas.tsx`
  already shows kind rail + icon + name + kind-in-words (colour never the only carrier).
- [x] T010 [US1] Update `packages/client/src/components/flow/FlowBuilder.test.tsx` to assert the
  seven kinds and the "Seven kinds" copy (the old test was stale at six); search filtering is
  browser-walk verified.

**Checkpoint**: Manual builder is independently verifiable.

---

## Phase 4: User Story 2 — Chat reads as a conversation beside a live workflow (Priority: P1)

**Goal**: Langdock-style split — conversation composer beside a live workflow canvas that updates as
turns land, and folds (not squeezes) on narrow windows.

**Independent Test**: Start a chat; confirm conversation + live workflow side by side; an applied
turn updates the canvas without navigation; a dragged node keeps its position after a later turn;
narrow window folds.

### Implementation for User Story 2

- [x] T011 [US2] Restyle `packages/client/src/components/flow/ChatPanel.tsx` — the person's message
  is a bubble, the computed result (status/change-line/diff/refusal) is a card — no behaviour change.
- [x] T012 [US2] Confirm `packages/client/src/components/flow/ChatWorkbench.tsx` already splits chat
  (400px) beside the live canvas and folds below `MIN_CANVAS_W` (no change needed).
- [x] T013 [US2] `ChatPanel.test.tsx` and `ChatWorkbench.test.tsx` remain green (no markup change
  broke them).

- [x] T022 [US2] Restyle `packages/client/src/components/flow/ChatPanel.tsx` into a clean GPT-esque
  conversation: scrollable message list, user bubbles + quiet computed cards, and a simple composer
  bar (sans-serif textarea, right-aligned send) — no behaviour change.
- [x] T023 [US2] Add a right-hand node inspector to `packages/client/src/components/flow/ChatWorkbench.tsx`
  that expands when a node is selected, showing the node's kind, reference, dependencies and contract.
- [x] T024 [US2] Make the chat inspector editable through the existing `saveFlowModel` path: retry
  on/off, require approval before the step, remove the step (the flow page's narrow edits).
- [x] T025 [US2] Extend `packages/client/src/components/flow/ChatWorkbench.test.tsx` to cover the
  node-sidebar edit wiring; browser-walk the chat surface in the feature evidence.

**Checkpoint**: Chat mode is independently verifiable.

---

## Phase 5: User Story 3 — Template reads as a browsable block library (Priority: P2)

**Goal**: StackAI-style library — browsable, searchable, category-grouped blueprint shelf with an
honest empty state and refs stated on each card.

**Independent Test**: Open the template door; confirm the shelf is browsable/searchable/category
grouped; each card states its refs; an empty workspace shows an honest empty state.

### Implementation for User Story 3

- [x] T014 [US3] Rework `packages/client/src/components/flow/FlowLibrary.tsx` `BlueprintShelf` into
  a searchable, responsive-grid shelf; cards become vertical block cards with a footer Use/Delete
  row and the honest per-card ref label unchanged. (Category grouping is N/A — templates carry no
  category field; grouping is realised in the manual palette where the data exists.)
- [x] T015 [US3] `FlowLibrary.test.tsx` remains green (the "Use" accessible name is preserved).

**Checkpoint**: Template mode is independently verifiable.

---

## Phase 6: User Story 4 — Flow & run pages share the canvas language (Priority: P2)

**Goal**: The flow and run pages render the same DAG anatomy as the builder; run stays read-only;
armed/draft banner unchanged.

**Independent Test**: Open a flow page and a run page; confirm same node anatomy/status language as
the builder; run page shows no edit affordance; banner still names both revisions.

### Implementation for User Story 4

- [x] T016 [US4] Verified `packages/client/src/app/(app)/flows/[id]/page.tsx` renders the shared
  `FlowReview` → `FlowCanvas` anatomy (same node/status language; armed/draft banner intact).
- [x] T017 [US4] Verified `packages/client/src/app/(app)/runs/[id]/page.tsx` renders `FlowCanvas`
  read-only (no edit/move handlers), same anatomy.

**Checkpoint**: Flow and run pages share the builder's canvas language.

---

## Phase 7: User Story 5 — One product (Priority: P3) + Polish

**Goal**: One typography scale, spacing rhythm and motion vocabulary across every redesigned surface;
browser-walk evidence; full gate set green.

- [x] T018 [US5] Verified the three doors (`packages/client/src/app/(app)/flows/new/page.tsx`
  `ModeCard`) and mode dispatch already share the same tokens/scale as the redesigned surfaces (no
  literals to migrate).
- [x] T019 [US5] Browser walks recorded in `specs/20260812-205352-automation-ui-redesign/evidence.md`
  (manual builder, template shelf, chat; flow/run by construction).
- [x] T020 Run the full gate set: typecheck 0 · package tests · `ui-honesty-check.sh` 0 FAIL ·
  `scenarios:verify` 13/13 · `e2e:ui` at two periods.
- [x] T021 `docs/programmes/README.md` numbering: no repo-wide D/I numbers were taken by this
  feature (its research.md uses local labels), so no new row was needed; `/speckit-comply` run and
  **PASS** (no CRITICAL/HIGH findings).

---

## Phase 8: User Story 5 (continued) — explicit UI hierarchy (FR-012)

**Goal**: The three creation surfaces and the flow/run pages compose from one explicit hierarchy —
tokens → atoms → composites → pages — with a closed seven-step type scale, one motion vocabulary,
and the existing positioning ownership. No surface uses a size or a motion duration outside the
scale.

- [x] T026 [US5] Add the closed type-scale tokens to `tailwind.config.ts` (`micro` 10 / `caption` 11
  / `body` 13) and the motion tokens + one global `prefers-reduced-motion` rule to `globals.css`.
- [x] T027 [US5] Collapse the arbitrary font-size literals in the creation/flow/run surfaces to the
  seven-step scale: `text-[9px]`/`text-[10px]` → `text-micro`, `text-[11px]` → `text-caption`,
  `text-[11.5px]`/`text-[12px]` → `text-xs`, `text-[12.5px]`/`text-[13px]` → `text-body`. Scope:
  `components/flow/**`, `components/layout/**`, `components/ui/**`, and `flows/new`, `flows`,
  `flows/[id]`, `runs/[id]`.
- [x] T028 [US5] Extend `lib/` + component tests if the collapse touches an asserted class; keep the
  full gate set green. (No test asserted a size class — 619/619 pass, no test edits needed.)

---

## Phase 9: User Story 6 — author a template by describing it (FR-013)

**Goal**: The template surface offers a "Build it for me" path: describe → generate (existing job,
visible progress) → snapshot as a template via `saveFlowTemplate` → shelf refreshes. No new
endpoint.

- [x] T029 [US6] Add a `BuildTemplatePanel` to `FlowLibrary.tsx` `TemplateSurface`: a description
  box, a "Build it for me" button, generation progress (`startFlowGeneration` → poll
  `getFlowGenerationJob`), then `saveFlowTemplate` + shelf reload on success; refusal/error stated,
  nothing saved.
- [x] T030 [US6] Extend `FlowLibrary.test.tsx`: the panel generates, snapshots and reloads on
  success; a refused generation saves nothing.
- [ ] T031 [US6] Browser-walk the template-authoring path in the feature evidence.
- [x] T032 [US2] Chat seeding surfaces a progress read-out (phase + elapsed + bar) via `SeedProgress`
  while the first message is drafted, and the chat column becomes a headed `pane` (visible
  structure, not a bare grid). Covered by a new `ChatWorkbench.test.tsx` case.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; BLOCKS all user stories.
- **User Stories**: US1, US2, US3 can start in parallel once Phase 2 completes (different files).
  US4 depends on the node-anatomy work (T009) and the foundational variant. US5 is last.
- **Polish (Phase 7)**: depends on all stories.

### Parallel Opportunities

- T002 / T003 / T005 are independent files ([P]).
- After Phase 2: **US1 (Phase 3)**, **US2 (Phase 4)**, **US3 (Phase 5)** run in parallel — they
  touch different files (`FlowBuilder`/`StepStrip`/`FlowCanvas` vs `ChatPanel`/`ChatWorkbench` vs
  `FlowLibrary`).

---

## Implementation Strategy

### MVP First (US1 only)

1. Phases 1–2 (baseline + design language).
2. Phase 3 (manual builder) — validate independently.
3. STOP and validate; then US2, US3, US4, US5.

### Incremental Delivery

Each story is a self-contained visual increment on top of the shared design language.

---

## Notes

- No new colours (FR-007); no behaviour change (FR-008) — tests that assert behaviour must not
  change in meaning, only in markup where structure moved.
- Each surface's browser walk is mandatory evidence (FR-009).

---

## Phase 10: Bold sweep port (D-15..D-25)

**Purpose**: Port the D-15..D-24 mock round (`docs/ui-mock/DECISIONS.md`) into the client —
skeletons, closure empty states, dashboard run volume, flow-detail editor rail, run-strip
timing bars, rail-free data-source wizard, collapsible inspectors, honest trigger cards, and
the honesty-check pins that lock the new contract. Mock is the contract; build-time rulings
are recorded in D-25.

- **[T060] [P] Dashboard** `packages/client/src/app/(app)/dashboard/page.tsx`
  `packages/client/src/components/ops/RunVolume.tsx` `packages/client/src/components/ops/SignalsPanel.tsx`
  `packages/client/src/components/ui/Tile.tsx` — clickable tiles, run-volume pane (real rows),
  signals filter, skeleton loading.
- **[T061] [P] Shared primitives** `packages/client/src/components/ui/Skeleton.tsx`
  `packages/client/src/components/ui/EmptyState.tsx` `packages/client/src/app/globals.css` —
  skeleton shimmer + closure empty states.
- **[T062] [P] Flow detail rail** `packages/client/src/components/flow/FlowReview.tsx`
  `packages/client/src/components/flow/FlowCanvas.tsx` `packages/client/src/app/(app)/flows/[id]/page.tsx`
  `packages/client/src/app/(app)/flows/new/page.tsx` — 268px editor rail, Open-in-builder deep
  link, `?mode=` URL init.
- **[T063] [P] Run strip timing** `packages/client/src/components/flow/StepStrip.tsx` —
  proportional timing bars from real `durationMs`, failed-step styling.
- **[T064] [P] Data sources** `packages/client/src/app/(app)/data-sources/page.tsx`
  `packages/client/src/app/(app)/data-sources/new/page.tsx`
  `packages/client/src/components/data/DbOperationsPanel.tsx`
  `packages/client/src/components/ui/DataTable.tsx` — drop Tables column, rail-free wizard,
  sort note, empty state.
- **[T065] [P] Inspectors** `packages/client/src/components/flow/StepInspector.tsx`
  `packages/client/src/components/flow/ChatWorkbench.tsx`
  `packages/client/src/components/flow/ChatWorkbench.test.tsx` — collapsible sections + step rename.
- **[T066] [P] Remaining pages** `packages/client/src/app/(app)/flows/page.tsx`
  `packages/client/src/app/(app)/tools/page.tsx` `packages/client/src/app/(app)/history/page.tsx`
  `packages/client/src/app/(app)/approvals/page.tsx` `packages/client/src/app/(app)/keys/page.tsx`
  `packages/client/src/app/(app)/triggers/page.tsx`
  `packages/client/src/components/keys/CredentialsTable.tsx` — search empties, skeletons,
  honest trigger copy.
- **[T067] Honesty pins** `scripts/ui-honesty-check.sh` — 22 new contract pins (189 total).
- **[T068] Infra** `infra/docker-compose.yml` — D-05.4 gap: `migrate` gains `env_file: ../.env` so `docker compose up` survives rebuilds.
- **[T069] [P] Immersive workbenches (D-27)** `packages/client/src/app/(app)/flows/new/page.tsx`
  `packages/client/src/app/globals.css` `packages/client/src/app/(app)/layout.tsx`
  `packages/client/src/components/shell/AlphaNotice.tsx`
  `packages/client/src/components/flow/FlowCanvas.tsx`
  `packages/client/src/components/flow/ChatWorkbench.tsx`
  `packages/client/src/components/flow/FlowBuilder.tsx` — full-bleed three-pane
  workbenches (mock body.wb): chat left, canvas centre, inspector right.
- **[T070] [P] Workbench review round (D-28)** `packages/client/src/app/(app)/flows/new/page.tsx`
  `packages/client/src/app/globals.css` `packages/client/src/components/layout/Workbench.tsx`
  `packages/client/src/components/flow/FlowCanvas.tsx` `packages/client/src/components/flow/ChatWorkbench.tsx`
  `packages/client/src/components/flow/FlowBuilder.tsx` `packages/client/src/components/flow/StepInspector.tsx`
  `packages/client/src/lib/foundry-client.ts` `packages/client/src/lib/flow-scope.test.ts`
  `packages/client/src/components/flow/FlowBuilder.test.tsx`
  `packages/server/src/services/flow-catalogue.service.ts`
  `packages/server/src/services/flow-catalogue.test.ts` — full-height
  workbenches, palette sub-groups (catalogue `service` field), NodeDetails
  off on workbenches, collapsible side panes.
- **[T071] Generation ref-kind gate (D-29)** `packages/server/src/services/flow-generation.service.ts`
  `packages/server/src/services/flow-generation.test.ts` — unknownRefs checks
  existence AND step-kind/ref-kind match; DRAFT_RULES states the mapping.
- **[T072] Builder page UI cleanup** — post-D-28 review pass over the manual
  builder surface (palette density, inspector spacing, canvas chrome) per the
  user's review round.
- **[T073] DAG editable everywhere** — user directive: every DAG surface
  editable — drag & drop nodes, add/remove links, change step input/output
  shape. Today: manual builder fully editable; chat canvas editable after a
  flow lands; `/flows/[id]` canvas is read-only (edits happen via "Open a
  copy on the canvas"); `/runs/[id]` stays read-only (it is a record).
  Scope decision needed on which surfaces gain in-place editing vs. keep the
  copy-to-canvas path, and what "change input/output shape" means per kind
  (params for query/tool steps exist; code-step contracts are generated).
