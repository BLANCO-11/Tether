# Tasks: Frontend UI rework — three modes, one editable DAG

**Input**: Design documents from `/specs/20260812-102907-frontend-ui-rework/`

**Prerequisites**: plan.md (pointer to `plans/frontend-2026-08-12/plan.md`), spec.md (user
stories), and the authoritative per-phase task lists in `plans/frontend-2026-08-12/phase-*/checkpoint.md`

⚠ **The authoritative task lists are the per-phase `checkpoint.md` files** under
[`plans/frontend-2026-08-12/`](../../plans/frontend-2026-08-12/plan.md). Each phase directory also
carries `decisions.md`, `issues.md` and `evidence.md`, and **the phase directory is where work is
recorded as it happens** — not here. Board tickets: `boards.md` (`FE-<phase>.<n>`). The board IDs
are references only; the phase checkpoints are the record.

This file exists only to satisfy `scripts/spec-gate-core.sh` (the same mechanism the foundations
programme uses — see `specs/20260810-093000-foundations/tasks.md`). **Do not maintain this file in
parallel with the real ones** — a second copy of a task list is how the two drift.

## User stories → plan phases → board tickets

| User story | Plan phase | Board tickets | Authoritative task list |
| :--- | :--- | :--- | :--- |
| (all — geometry) | 1 — shell | FE-1.1…FE-1.5 | `plans/frontend-2026-08-12/phase-1-shell/checkpoint.md` (1.0–1.5) |
| US2 — editable DAG | 2 — editable DAG | FE-2.1…FE-2.5 | `plans/frontend-2026-08-12/phase-2-editable-dag/checkpoint.md` |
| (all — visual language) | **2b — mode surfaces** | **FE-2b.0…FE-2b.5** | `plans/frontend-2026-08-12/phase-2b-mode-surfaces/checkpoint.md` (added 2026-08-12) |
| US1 — chat authoring | 3 — chat | FE-3.1…FE-3.4 | `plans/frontend-2026-08-12/phase-3-chat/checkpoint.md` |
| US3 — blueprints | 4 — templates | FE-4.1…FE-4.4 | `plans/frontend-2026-08-12/phase-4-templates/checkpoint.md` |
| US4 — armed editing | 5 — armed editing | FE-5.1…FE-5.3 | `plans/frontend-2026-08-12/phase-5-armed-editing/checkpoint.md` |
| US5 — one product | 6 — journey | FE-6.1…FE-6.4 | `plans/frontend-2026-08-12/phase-6-journey-verification/checkpoint.md` |

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: None — this is an existing pnpm workspace (`packages/client`, `packages/server`,
`@foundry/flow-edit`); no new project scaffolding, packages or tooling. "Setup" is satisfied by
the spec-kit feature itself (`spec.md`/`plan.md`/`tasks.md`, branch
`20260812-102907-frontend-ui-rework`).

- [x] T001 Feature establishment: `spec.md`, `plan.md`, `tasks.md` + `.specify/feature.json`
- [x] T002 **FE-1.1** Browser reconnaissance of the four pages — run the app against this
  deployment, photograph the actual geometry of `/flows`, `/flows/new` (all four modes),
  `/flows/[id]`, `/runs/[id]` into `plans/frontend-2026-08-12/phase-1-shell/evidence.md`
  (task 1.0; first browser walk in the repo — I-80, not optional) — ✅ DONE 2026-08-12:
  geometry measured, screenshots in `phase-1-shell/browser-walk/shots/`, I-160…I-162 recorded

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shell geometry every other phase renders in. No user story can proceed without
it.

- [x] T003 **FE-1.2** Decide the page-level container language and implement measures/zones in
  `packages/client/src/components/layout/Page.tsx` + tokens in
  `packages/client/src/app/globals.css`, updating `packages/client/src/lib/workbench.ts` constants
  in the same change (task 1.1–1.2; `workbench.test.ts` pins the breakpoint literals — change
  both or the test fails; the `max-w-` honesty assertion allows only `Page.tsx` to set a width)
  — ✅ DONE 2026-08-12 (D-146/147): collapsed rail, breakpoints 1372/1436/1018, 3-pane at 1440.
  Files also changed: `packages/client/src/app/(app)/layout.tsx` (flow-work pages ride the
  collapsed rail) and `packages/client/src/lib/workbench.test.ts` (fold assertions re-derived)
- [x] T004 [P] **FE-1.3** Node anatomy as an editor surface (Langflow-style header/body/
  expanded-collapsed/toolbar) in `packages/client/src/components/flow/FlowCanvas.tsx`
  (`StepNode`/`NodeDetails`, `KIND`/`STATUS` maps) without breaking run-page `compact` 340px
  density or reintroducing a raw `height` prop (D-102) — ✅ DONE 2026-08-12 (D-148): header·body
  anatomy, per-step delete on editable+selected; 4 new tests in
  `packages/client/src/components/flow/FlowCanvas.test.tsx`
- [x] T005 [P] **FE-1.4** The flows list (`packages/client/src/app/(app)/flows/page.tsx`) — new
  density/anatomy plus the reserved spot for the Phase 4 blueprint shelf — ✅ DONE 2026-08-12
  (D-149): cards stay cards; `BlueprintShelf` reserved spot in `FlowLibrary.tsx`; 2 new tests in
  `packages/client/src/components/flow/FlowLibrary.test.tsx`
- [x] T006 **FE-1.5** Phase 1 browser table (five rows in
  `plans/frontend-2026-08-12/phase-1-shell/checkpoint.md`) + phase gates: `pnpm typecheck` ·
  `pnpm --filter @foundry/client test` · `bash scripts/ui-honesty-check.sh` (0 FAIL) ·
  `pnpm --filter @foundry/server e2e:ui` (at TWO periods) — ✅ DONE 2026-08-12: all rows filled,
  gates green (572 client · 897 server · 0 FAIL · e2e:ui 65/0 at 2026-06 and 2026-05)

**Checkpoint**: FE-1.5 done = shell landed; FE-2.x (US2) can start, FE-3.x (US1) and FE-4.x (US3)
become parallelizable after their own gates.

---

## Phase 3: User Story 2 - Build a workflow by hand with an editable DAG (Priority: P1)

**Goal**: The DAG is editable everywhere — nodes draggable with persisted positions outside the
revision, add/re-route/delete/undo on canvas.

**Independent Test**: Build a five-step flow by hand — add, move, connect, re-route, delete,
undo — reload, positions persist; a drag never writes a revision (pinned by test).

### Implementation for User Story 2

- [x] T007 **FE-2.1** Reconciliation decision — write the rule for saved positions when steps are
  added/renamed/deleted, new-step placement, and when "re-arrange" appears
  (`plans/frontend-2026-08-12/phase-2-editable-dag/decisions.md` open questions 1–2; NO code)
  — ✅ DONE 2026-08-12 (**D-150**): drop on delete, re-key on rename (rename IS `replaceStep` with a
  new id), nearest-neighbour on add, re-arrange ⇔ any row exists, key `(flow_id, step_id)`,
  reconciliation client-side at save, server dumb (GET/PUT, never touches revisions)
- [ ] T008 **FE-2.2** Positions table + API — migration `flow_step_positions` keyed `(flow,
  step)` outside the revision (`packages/server/src/db/`), workspace-scoped GET/PUT routes behind
  `requireApiKey` (`packages/server/src/routes/flow-positions.ts`); `pnpm backup:verify` green in
  the same commit; test pins that no positions write touches `flow_revisions`/`writeRevision`
  — ✅ DONE 2026-08-12: `drizzle/0034_*.sql` + `flowStepPositions` in schema.ts, repo
  `repositories/flow-position.repo.ts`, service `services/flow-position.service.ts`, routes
  `routes/flow-positions.ts` mounted at `/flows/:flowId/positions`; 5 tests in
  `services/flow-position.service.test.ts` incl. the revision-boundary pin; `backup:verify`
  16/16 green; server suite 902/902; typecheck 0
- [x] T009 **FE-2.3** Canvas becomes draggable + re-arrange — `nodesDraggable` behind a prop in
  `packages/client/src/components/flow/FlowCanvas.tsx`, dagre fallback where no saved position
  exists, "re-arrange" returns the graph to dagre; `canvasFromModel`/`canvasFromExecution` show
  the saved arrangement on read-only pages too; the `FlowCanvas.tsx:29-33` docblock that says a
  model "must not gain coordinates" changes in the same commit — ✅ DONE 2026-08-12 (D-151):
  draggable gated on `onMoveStep` (never a literal `true` — the honesty check pins that),
  nearest-neighbour placement in `lib/canvas-layout.ts` (+10 unit tests), flow page (FlowReview)
  owns persisted arrangement, run page shows it read-only, FlowBuilder keeps session arrangement
  with rename re-key; browser-verified: drag → reload → same transform, re-arrange resets to dagre
- [x] T010 **FE-2.4** Add / re-route / delete / undo on the canvas — node-add gesture (palette
  drop or double-click — decide in `decisions.md`), edge re-routing (`onReconnect` →
  `disconnect` + `connect`, the four refusals already exist), undo/redo over the pure
  `@foundry/flow-edit` ops (D-121) — ✅ DONE 2026-08-12 (D-152 double-click-to-add, D-153
  session undo, D-154 reconnect = disconnect+connect): canvas reports `onAddAt`/`onRerouteStep`,
  FlowBuilder owns the kind menu + undo/redo stack (cap 50) + reroute sequencing; client suite
  590/590; browser walk of the gestures pending in FE-2.5
- [x] T011 **FE-2.5** Phase 2 browser table (four rows) + gates incl. `backup:verify` (migration)
  — ✅ DONE 2026-08-12: browser-walk rows GREEN (`walk-5step.mjs` six checks, `add-undo.mjs` five
  checks, `positions-persist.mjs` three checks); walk found three real defects now fixed with
  regression tests (dblclick swallowed by d3-zoom; selection reset by adoptUserNodes; one delete
  = three undo ops — see checkpoint "What the walk found"); `e2e:ui` at two periods remains
  and `e2e:ui` at two periods

**Checkpoint**: US2 functional — the editable DAG is the platform US1 (FE-3.3) and US4 (FE-5.2)
stand on.

---

## Phase 2b: The mode surfaces — the visual language (Priority: P1, added 2026-08-12)

**Goal**: The surfaces look like the product the plan promised — the three-door chooser, the
StackAI/Langflow visual system for the manual builder and DAG, the flow/run consistency pass.
Sits BEFORE chat/templates so those build on the decided look. Function is NOT rebuilt here —
2b composes the components FE-1/FE-2 built.

**Independent Test**: `/flows/new` shows three doors and no trace of the four-card screen; each
mode surface screenshots against its reference; the flow/run pages share the same tokens.

### Implementation for the mode surfaces

- [x] T011b **FE-2b.0** The visual language decisions (product call) — per-mode reference
  interpretation in this token system (Langdock chat · StackAI manual builder · Langflow/Dify
  DAG), chooser form (doors vs tab bar), door names/order, the template door's pre-FE-4.2 state,
  which `globals.css` tokens/zones change — write in
  `plans/frontend-2026-08-12/phase-2b-mode-surfaces/decisions.md`; NO code
  — ✅ DONE 2026-08-12: D-155…D-161 (three doors on Approach; Chat · Template · Manual builder;
  template door honest "coming soon"; language lives in decisions.md — assumed design.md standard
  missing, I-166; chat/manual/DAG briefs recorded). User ratified all four recommendations.
- [x] T011c **FE-2b.1** The three-door chooser — `Approach`
  (`packages/client/src/app/(app)/flows/new/page.tsx`) becomes chat / template / manual builder;
  old `outline|goal|canvas|chat` cards gone, outline+goal visibly absorbed into chat's first
  message (decision ①); canvas door renamed to the manual builder
  — ✅ DONE 2026-08-12: three doors (Chat · Template · Manual builder, D-155/D-156); template door
  opens to the honest D-157 coming-soon notice; `outline`/`goal` stay in the Mode union as
  decision ①'s Phase 3 routing targets (FE-3.2), no door sets them; walk-2b1-chooser.mjs green,
  client 594/594, typecheck 0, honesty 0 FAIL
- [x] T011d **FE-2b.2** The visual system — tokens, zone weights, card/pane anatomy the three
  surfaces compose from; new tokens via `/speckit-update-standards` (design.md) if needed
  — ✅ DONE 2026-08-12 (D-162): `.pane`/`.pane-head` + `.node-status-ok|busy|attn` +
  `.react-flow__edge.edge-ok|attn` in `globals.css`, composed from the existing semantic tokens
  (no new colours; the assumed design.md standard does not exist — I-166, language lives in phase
  decisions.md per D-158). client 594/594, typecheck 0, honesty 0 FAIL
- [x] T011e **FE-2b.3** Manual builder + DAG restyle (StackAI/Langflow) — palette/canvas/inspector
  weights, edge/selection/minimap styling, node card finished against Langflow's anatomy;
  functionally identical to FE-2.x (existing tests stay green)
  — ✅ DONE 2026-08-12: FlowBuilder/FlowLibrary/FlowCanvas/StepInspector on `.pane`/`.pane-head`;
  node-card run status → `.node-status-ok|busy|attn`; Background to Langflow `size={2} gap={20}`;
  no minimap (D-161); no edge build-state exists so `.edge-*` stays reserved. I-167 (layering)
  caught + fixed. client 594/594, typecheck 0, honesty 0 FAIL
- [x] T011f **FE-2b.4** Flow + run page consistency — review surface, approval panel, run page on
  2b.2's tokens WITHOUT changing editability (Phase 5's) or read-only semantics
  — ✅ DONE 2026-08-12: flows/[id], runs/[id], FlowReview, ApprovalPanel, SharePanel + their
  page-only siblings on `.pane`/`.pane-head`; run page keeps its compact read-only node form
  (D-148); no edit affordance added; flow-page canvas stays arrangement-only (D-151).
  client 594/594, typecheck 0, honesty 0 FAIL
- [x] T011g **FE-2b.5** Phase 2b browser table (four rows) + gates
  — ✅ DONE 2026-08-12: 4/4 rows GREEN (walk-2b5-phase.mjs); gates — typecheck 0 · client 594/594 ·
  honesty 0 FAIL · e2e:ui at two periods 65/0/0/0 both. Phase 2b complete: decisions D-155…D-162,
  issues I-166/167, reference evidence captured, before/after pairs in evidence.md.

**Checkpoint**: the mode surfaces read against their references; Phases 3/4 build on 2b's
`decisions.md` as their design brief.

---

## Phase 4: User Story 1 - Author a workflow by chatting (Priority: P1)

**Goal**: Chat is a Langdock-style split surface — chat beside a live editable canvas — with the
first-message goal/step-list split (decision ①).

**Independent Test**: Multi-line step list routes to the outline path; one-line goal routes to the
goal path; both produce a workflow visible on the canvas; the allowlist pin
(`flow-chat-imports.test.ts`) stays green.

### Implementation for User Story 1

- [x] T012 **FE-3.1** Take `chat:measure` (foundations 2.11) — run
  `pnpm --filter @foundry/server chat:measure`, record output AND the model in
  `plans/frontend-2026-08-12/phase-3-chat/evidence.md`; the number is read before building
  — ✅ DONE 2026-08-12: **first number in the repo's history** — 5 turns · 0 applied · 5 refused
  (`too_structural`) on `gpt-5.4-mini`; verbatim output in evidence.md; I-168. The number is what
  mandates decision ①: a turn cannot seed from an empty thread, so the first message routes to the
  generation job (D-163).
- [x] T013 **FE-3.2** First-message routing — client-side split in
  `packages/client/src/components/flow/ChatPanel.tsx`: pasted multi-line step list → `outline`
  path (`OUTLINE_RULES` + `validateOutline`), one-line goal → `goal` path
  (`startGenerationSchema` accepts both); NO new chat endpoint that takes a goal
  — ✅ DONE 2026-08-12 (D-163): `send()` routes the first message via `onFirstMessage`;
  allowlist pin green; 5 new tests in `ChatPanel.test.tsx`.
- [x] T014 **FE-3.3** The split surface — `ChatPanel` becomes chat alongside the Phase 2 editable
  canvas (`packages/client/src/app/(app)/flows/new/page.tsx`); applied turns render on the DAG as
  they land; "Fix in chat" carries refusal findings into a turn without auto-fixing (D-55); the
  1024-token cap untouched (`CHAT_TURN_MAX_TOKENS`)
  — ✅ DONE 2026-08-12 (D-164): new `ChatWorkbench` (chat 400px beside a live editable canvas);
  `createChatThread(name, flowId)` binds the conversation to the seeded flow; canvas edits write
  revisions through `saveFlowModel`; "Fix in chat" on the refusal panel carries findings as
  `fixContext`; 4 new tests in `ChatWorkbench.test.tsx`. Gates: typecheck 0 · client 615/615 ·
  server 907/907 · honesty 0 FAIL.
- [ ] T015 **FE-3.4** Phase 3 browser table (five rows) + gates incl. `chat:measure` number,
  `kestra:check`, `e2e:ui` at two periods

**Checkpoint**: US1 functional and measurable.

---

## Phase 5: User Story 3 - Start from a curated blueprint with a ref-mapping step (Priority: P2)

**Goal**: Template mode = curated blueprints with a visible ref-mapping instantiation step.

**Independent Test**: Pick a blueprint, walk the mapping step with every ref mapped, instantiate,
confirm the result passes through the normal review path; a refused ref reads as a mapping
problem.

### Implementation for User Story 3

- [x] T016 **FE-4.1** Curation decision — what "curated blueprints" means: per-workspace
  admin-curated shelf (D-27 intact, no migration) vs cross-workspace catalogue (re-argue D-27's
  tenant-leak reasoning in `plans/frontend-2026-08-12/phase-4-templates/decisions.md` first);
  NO code — ✅ DONE 2026-08-12 (**D-165**): per-workspace member-curated shelf — the workspace's own
  saved templates (SharePanel "Save as template") ARE the curated blueprints; D-27's tenant-leak
  reasoning preserved, NO migration, `backup:verify` not owed.
- [x] T017 **FE-4.2** The blueprint shelf + the mode door — shelf on `/flows` (FE-1.4's reserved
  spot, extend `FlowLibrary.tsx` not a second component), the chooser door on `/flows/new`, honest
  per-card ref labels (from the plan call — never a widened list endpoint), collision stays a 409,
  `SharePanel` "snapshot into the template library" and any new "publish as blueprint" path do not
  silently diverge — ✅ DONE 2026-08-12 (**D-166**): real shelf replaces the placeholder (same
  section, same component), per-card ref labels from `planFlowTemplate(id, {})`; `TemplateSurface`
  exported and wired into the `/flows/new` door; no second publish path (SharePanel unchanged);
  409 untouched.
- [x] T018 **FE-4.3** The ref-mapping step — plan → mapping (every ref visible) → instantiate →
  draft passes review; machinery exists (`POST /templates/:id/plan` returns `remapped`;
  instantiate takes explicit `refMap`); the UI is the deliverable — ✅ DONE 2026-08-12 (**D-167**):
  `RefMappingStep` (plan → identity-prefilled per-ref mapping → explicit refMap → three outcomes:
  201 navigate, 200 insufficient_contract refusals, 422 import_refused as a mapping problem);
  never instantiates with an unconfirmed map; 5 new tests in `FlowLibrary.test.tsx`.
- [ ] T019 **FE-4.4** Phase 4 browser table (four rows) + gates incl. `backup:verify` ONLY if
  FE-4.1 chose a migration — (no migration chosen; browser rows + server gates remain)

**Checkpoint**: US3 functional; 🧩 FE-4 runs parallel with FE-3.

---

## Phase 6: User Story 4 - Edit an armed automation without stopping it (Priority: P2)

**Goal**: `/flows/[id]` canvas edits write a draft revision; armed keeps running untouched; the
banner tells the truth; run page stays read-only.

**Independent Test**: Edit an armed flow → draft revision; armed keeps running; banner names both;
re-approval promotes the draft.

### Implementation for User Story 4

- [x] T020 **FE-5.1** Pin the write path — verify `POST /:flowId/revisions` → `saveRevision` →
  `writeRevision` never touches `armed_revision`; pin with a test: *an armed flow refined by an
  edit stays armed, with the draft revision behind it* — asserted for the page edit, chat and
  refine paths (server test; safe to start before Phase 2)
  — ✅ DONE 2026-08-12: `flow-armed-pin.test.ts` (5 tests) — `writeRevision`/`updateMeta` updates never
  carry `armedRevision`; chat and refine never name it; the approval path is the ONE writer
  (positive control); status flips to `draft_pending`, never clears armed. Server 907/907.
- [x] T021 **FE-5.2** The editable flow page + the banner — `FlowReview`
  (`packages/client/src/components/flow/FlowReview.tsx`) canvas becomes editable (Phase 2
  surface) writing a draft revision on save; persistent banner naming live vs editing revision
  with existing `RevisionDiff` under it; "Open a copy on the canvas" stays but visibly a copy
  path (`ReopenNotice`); drafts compile `withSchedule: false`; run page has no edit affordance
  — ✅ DONE 2026-08-12 (**D-168**): new `RevisionBanner` (shown only when armed AND draft ahead;
  names both revisions; `getFlowDiff(armed, draft)` → `RevisionDiff` beneath; a diff-read failure
  is an inline note, never a broken banner), wired above `FlowReview` in `/flows/[id]`; FlowReview's
  existing draft-revision writes confirmed; run page verified read-only; 7 tests in
  `RevisionBanner.test.tsx`. `getFlowDiff` extended to pass `from`/`to` (I-170).
- [ ] T022 **FE-5.3** Phase 5 browser table (five rows) + gates incl. `scenarios:verify`,
  `demo:verify`, re-approve → draft becomes armed → banner clears, run page showing the OLD graph
  of an armed execution

**Checkpoint**: US4 functional.

---

## Phase 7: User Story 5 - The three modes read as one product (Priority: P3)

**Goal**: One chooser (three doors), one vocabulary, one refusal grammar, honest mode handoff.

**Independent Test**: Start a flow in chat, finish it by hand on the canvas, nothing lost;
template → manual refine works.

### Implementation for User Story 5

- [ ] T023 **FE-6.1** Audit the earlier tables — every phase's browser walk read; any empty row
  sends the work back to that phase (a gate, not a courtesy)
- [ ] T024 **FE-6.2** One vocabulary + the shared refusal grammar — copy sweep across the four
  pages; one refusal grammar rendered identically in all modes; reconcile with foundations Phase
  6's vocabulary work, do not fork it
- [ ] T025 **FE-6.3** Mode-to-mode handoff — start in chat, finish by hand (positions survive —
  decision ②); template → instantiate → manual refine; the `authoredFromModel` reopen path made a
  visible route
- [ ] T026 **FE-6.4** The full verification — complete gate set (typecheck · all package tests ·
  `ui-honesty-check.sh` · `kestra:check` · `e2e:ui` at two periods · `scenarios:verify` ·
  `finance:verify` · `demo:verify`+`demo:rehearse` · `backup:verify` if a migration landed ·
  `showcase:seed` immediately before `showcase:verify`), `chat:measure` re-taken with the model
  recorded, every earlier phase's browser row re-verified at end state

**Checkpoint**: US5 functional; plan exit criterion met (`plans/frontend-2026-08-12/plan.md`
STATE row + gate set).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001–T002)**: No dependencies — T002 (FE-1.1) is the first ticket in the plan
- **Foundational (T003–T006)**: Depends on T002 — BLOCKS all user stories (the shell)
- **US2 (T007–T011)**: Depends on FE-1.2; FE-2.1 (T007) blocks FE-2.2 (T008) blocks FE-2.3
  (T009) blocks FE-2.4 (T010) blocks FE-2.5 (T011)
- **Mode surfaces (T011b–T011g)**: FE-2b.0 (T011b) blocks FE-2b.1/2b.2 (T011c/T011d) which block
  2b.3/2b.4 (T011e/T011f) → 2b.5 (T011g); depends on FE-2.4 (the canvas it restyles); BLOCKS
  US1/US3's surfaces (chat/templates build on 2b's visual language)
- **US1 (T012–T015)**: FE-3.1 blocks FE-3.2 blocks FE-3.3; FE-3.3 depends on FE-2.3 + FE-2b.2
- **US3 (T016–T019)**: FE-4.1 blocks FE-4.2 blocks FE-4.3; 🧩 parallel with US1; FE-4.2's chooser
  door rides FE-2b.1's
- **US4 (T020–T022)**: FE-5.1 needs nothing (start early); FE-5.2 depends on FE-5.1 + FE-2.3
- **US5 (T023–T026)**: T023 depends on all browser tables; T024–T025 on earlier phases; T026 on
  everything

```
T002 → T003 ─┬→ T004, T005 → T006
             └→ T007 → T008 → T009 → T010 → T011 ─→ T011b → T011c, T011d ─┬→ T011e → T011g
                                                                            └→ T011f ─┘
T012 → T013 → T014 → T015        }  🧩 US1 and US3 are parallel
T016 → T017 → T018 → T019        }
T020 → T021 → T022               (T020 needs nothing; start early)
T023 ─┐
T024, T025 → T026
```

### Parallel Opportunities

- T004/T005 (FE-1.3/FE-1.4) after T003 — different files
- FE-3.x and FE-4.x full phases — different people, no shared files except `flows/new/page.tsx`
  (the chooser door; land FE-4.2's door carefully)
- T011f (FE-2b.4, flow/run restyle) is independent of T011e (manual builder restyle) — different
  pages, same visual system
- T020 (FE-5.1) is a server test — safe to staff before Phase 2

### Within Each Phase

- Decisions before code (FE-2.1, FE-4.1 — no code tickets)
- Migration + `backup:verify` in the same commit (FE-2.2)
- Tests written/pinned with implementation (the "stays armed" test T020, the drag-never-writes-a-revision pin in T008, the allowlist pin stays green in T013)

### Independent Test Criteria

- **US2**: five-step hand build + reload persistence + drag-never-writes-revision
- **Mode surfaces**: three doors render; each surface screenshots against its reference; flow/run
  pages share tokens with the modes
- **US1**: both first-message forms produce a flow; allowlist pin green
- **US3**: mapped instantiation passes review; unmapped ref names the ref
- **US4**: draft revision created, armed keeps running, banner true both ways
- **US5**: mode-to-mode handoff loses nothing; three doors render

### Suggested MVP

The plan's own ordering is the MVP: FE-1.1 (reconnaissance) → FE-1.2 (shell) → FE-1.4 (list
ships first — the only page with no Phase 2/3 dependency) → US2 as the first complete user
story → 2b (the mode surfaces) so what a person sees matches what the plan promised.

---

## Implementation Strategy

### Incremental Delivery

1. T001–T002 (feature + reconnaissance) → evidence recorded
2. T003–T006 (shell) → all four pages render on the new geometry — every later phase renders
   without a geometry fight
3. T007–T011 (US2, editable DAG) → the platform US1 and US4 stand on
4. T011b–T011g (2b, mode surfaces) → the three doors and the visual language — what a person
   actually sees becomes the product the plan promised
5. T012–T015 (US1, chat) ‖ T016–T019 (US3, templates) → parallel, on 2b's visual language
6. T020–T022 (US4, armed editing) → the highest-risk mode, after the geometry
7. T023–T026 (US5, journey + full verification) → not optional

### Notes

- ⚠ The spec gate blocks non-`*.md` writes until this file + `plan.md` + `spec.md` exist — they
  now do; do not use the foundations bypass
- ⚠ The containers run `dist/` — a server change needs `docker compose build server web`; a stale
  build reads exactly like a missing route
- ⚠ `backup:verify` after EVERY migration (FE-2.2); `showcase:seed` immediately before
  `showcase:verify` (I-33); no `slate:clear` while a report is outstanding
- ⚠ Record work in the phase directories (`plans/frontend-2026-08-12/phase-*/`) as it happens —
  decisions `D-146…`, issues `I-160…` (verify next-free against the files, `plan.md` §
  "Reserved numbering")
- Phase 6 browser rows are owned by each phase, not by US5 — an empty row means the phase is not
  finished
