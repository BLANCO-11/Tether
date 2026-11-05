---

description: "Task list for Flow History Name Snapshot + ID columns"
---

# Tasks: Flow History Name Snapshot (+ Workflow/Run ID columns, ID snapshot, Status relabel)

**Input**: Design documents from `specs/20260918-123817-flow-history-name-snapshot/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — all present.

**Tests**: Included (Constitution Article II — Test-First is NON-NEGOTIABLE in this repo).

**Organization**: Tasks are grouped by user story (US1–US6, per spec.md). US1/US2 were
already implemented in this branch's prior batch and are marked `[X]` with their
existing file/test evidence; US3 needs only a verification task; US4–US6 are new work.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6)

---

## Phase 1: Setup

- [x] T001 Confirm dev toolchain: Node 22.x active (`node -v`) before running client
      tests — `vitest.config.ts` throws below Node 22 per CLAUDE.md's "client's whole
      rendering test layer" note. No file changes; verification only.

---

## Phase 2: Foundational (blocking prerequisite for US4)

**Purpose**: The one piece of shared UI infrastructure both new id columns need.

- [x] T002 [P] Add a `Copy` icon (clipboard-style, same `S`-wrapper convention as the
      rest of the file) to `packages/client/src/components/ui/icons.tsx`.

**Checkpoint**: Icon available — `CopyableId` (US4) can now be built.

---

## Phase 3: User Story 1 — See the run's actual name in History (Priority: P1) 🎯 already implemented

**Goal**: History labels a run with the workflow's display name, not its internal slug.

**Independent Test**: Run a named workflow; its History row shows that name.

**Status**: Implemented in this branch's prior batch. Listed here for traceability
and to preserve the constitution's per-story task record.

- [X] [US1] Migration `packages/server/drizzle/0069_add_flow_name_snapshot.sql` adds
      `flow_executions.flow_name_snapshot`.
- [X] [US1] `packages/server/src/db/schema.ts` declares `flowNameSnapshot` on
      `flowExecutions`.
- [X] [US1] `packages/server/src/routes/executions.ts`'s `begin` handler writes
      `flowNameSnapshot: flowRow?.name ?? null`.
- [X] [US1] `packages/server/src/services/flow-visibility.service.ts` exposes
      `flowNameSnapshot` on `ExecutionView` via `executionBase`.
- [X] [US1] `packages/client/src/lib/foundry-client.ts` (`FAFlowExecutionSummary`) and
      `packages/client/src/lib/types.ts` (`FlowExecutionSummary`) carry
      `flowNameSnapshot`.
- [X] [US1] `packages/client/src/lib/adapters.ts`'s `runLabel()` prefers
      `flowNameSnapshot` over `flowName` over `"Unnamed run"`.
- [X] [US1] Tests: `packages/client/src/lib/adapters.test.ts`,
      `packages/client/src/lib/run-history.test.ts` cover the fallback chain.

**Checkpoint**: US1 functional and tested independently. (No action needed this pass.)

---

## Phase 4: User Story 2 — Each run keeps the name it had when it ran (Priority: P1) 🎯 already implemented

**Goal**: Renaming a workflow never relabels a past run.

**Independent Test**: Run while named "A", rename to "B", run again — History shows
one "A" row and one "B" row.

**Status**: Delivered entirely by US1's freeze-at-write mechanism above — a run's
`flow_name_snapshot` is written once, at `begin`, and never updated. No separate
tasks; the guarantee IS the write-once column plus the read-time preference for it.

**Checkpoint**: US2 functional — covered by US1's tests (the rename/re-run case is
exercised by `run-history.test.ts`'s "prefers the name-at-run-time snapshot" case).

---

## Phase 5: User Story 3 — Names in History cannot be edited from History (Priority: P2)

**Goal**: No control in History changes a run's displayed name or id.

**Independent Test**: Inspect History for any rename/edit affordance; confirm none.

- [x] T003 [P] [US3] Audit `packages/client/src/app/(app)/history/page.tsx` for the
      absence of any name/id-editing control (this is a negative assertion — the page
      has none today; the task is to add a render test that fails if one is ever
      introduced). Add the assertion to
      `packages/client/src/app/(app)/history/page.test.tsx` (created in T016 below) —
      e.g. `expect(screen.queryByRole("button", { name: /rename/i })).toBeNull()`.

**Checkpoint**: US3 verified by a standing regression test, not by code that doesn't
otherwise need to exist.

---

## Phase 6: User Story 4 — Workflow ID and Run ID are their own columns, and are copyable (Priority: P1)

**Goal**: History splits the combined "Automation" cell into Workflow Name / Workflow
ID / Run ID columns; each id is truncated to 5 chars + `…` with a copy-to-clipboard
button, confirmed by toast.

**Independent Test**: Open History; confirm three separate columns; confirm copy
buttons place the full id on the clipboard with a toast confirming it.

**Depends on**: Phase 2 (Copy icon).

### Tests for User Story 4 (write first, confirm they fail before implementing)

- [x] T004 [P] [US4] `packages/client/src/components/ui/CopyableId.test.tsx` — new
      file. Cases: renders first 5 chars + `…` for a given id; `title` attribute
      carries the full id; clicking the copy button calls
      `navigator.clipboard.writeText` with the FULL (untruncated) id; a mocked
      `useToast()` is called with a success message on resolve and a failure message
      on reject; `id: null` renders `"—"` with no copy button.

### Implementation for User Story 4

- [x] T005 [US4] Implement `packages/client/src/components/ui/CopyableId.tsx` —
      `{ id: string | null }` props, 5-char truncation, copy icon button (from T002)
      placed before the truncated text, `useToast()` (from `lib/toast.tsx`) on
      success/failure, best-effort `navigator.clipboard?.writeText(...).then().catch()`
      pattern matching `FlowIntegrationPanel.tsx`/`AllowRequest.tsx`.
- [x] T006 [US4] Add `flowId?: string | null` to the `Run` type in
      `packages/client/src/lib/types.ts` (currently absent from `Run`, though present
      on `FlowExecutionSummary`).
- [x] T007 [US4] Populate `flowId: e.flowId ?? null` in `runFromFlowExecution` in
      `packages/client/src/lib/adapters.ts`.
- [x] T008 [US4] Extend the `run` entry in `SETS` in
      `packages/client/src/components/ui/DataTable.tsx` from 5 to 6 columns:
      `grid-cols-[130px_1.4fr_140px_140px_0.7fr_88px]`, columns
      `time, workflowName, workflowId, runId, status, actions` (replacing `subject`
      and `summary`).
- [x] T009 [US4] Update `packages/client/src/app/(app)/history/page.tsx`: split the
      `rows` mapping's `subject` cell into `workflowName` (plain `r.automation` text,
      no longer sharing a cell with the id) and `workflowId`
      (`<CopyableId id={r.flowId ?? null} />`); add a `runId` cell
      (`<CopyableId id={r.id} />`); update the `heads` prop
      (`workflowName: "Workflow name", workflowId: "Workflow ID", runId: "Run ID"`).
- [x] T010 [P] [US4] Create `packages/client/src/app/(app)/history/page.test.tsx` (if
      it doesn't already exist) asserting: the three columns render distinctly; each
      id column shows a truncated value; the copy button is present per row.

**Checkpoint**: US4 functional and independently testable — Workflow ID at this
point reflects the LIVE `flowId` pointer (still blanks on delete; US5 fixes that
next without touching this UI layer again).

---

## Phase 7: User Story 5 — Workflow ID also survives the workflow being deleted (Priority: P1)

**Goal**: Deleting a workflow after it has run must not blank the Workflow ID column
for its past runs — same guarantee as US1/US2, applied to the id instead of the name.

**Independent Test**: Run a workflow, note its Workflow ID, delete the workflow,
confirm the same run's Workflow ID is unchanged in History.

**Depends on**: Phase 6 (US4) — this phase upgrades the Workflow ID column's data
source; it does not change its rendering.

### Tests for User Story 5 (write first, confirm they fail before implementing)

- [x] T011 [P] [US5] `packages/server/src/services/flow-visibility.test.ts` — assert
      `executionBase` passes `flowIdSnapshot` through unchanged (mirror the existing
      `flowNameSnapshot` assertion in this file).
- [x] T012 [P] [US5] Server test asserting `begin` (in `routes/executions.ts`) writes
      `flowIdSnapshot` from the same `flowRow` lookup used for `flowNameSnapshot` —
      extend the existing executions route test file, or add one if none currently
      exercises `begin`'s snapshot writes directly.
- [x] T013 [P] [US5] `packages/client/src/lib/adapters.test.ts` — new cases for
      `runWorkflowId()`: snapshot present → use it; snapshot null + live `flowId`
      present → use live id; both null → `null`.
- [x] T014 [P] [US5] `packages/client/src/lib/run-history.test.ts` — mirror the
      existing "prefers the name-at-run-time snapshot"/"falls back to the slug"/
      "keeps the snapshot even for a run whose flow has since been deleted" cases,
      but asserting `run.flowId`/`run.flowIdSnapshot` instead of `run.automation`.

### Implementation for User Story 5

- [x] T015 [US5] New migration
      `packages/server/drizzle/00XX_add_flow_id_snapshot.sql`:
      `ALTER TABLE "flow_executions" ADD COLUMN "flow_id_snapshot" uuid;`
      (no FK — must survive the referenced flow row's deletion, matching
      `flow_name_snapshot`'s design). Update `packages/server/drizzle/meta/_journal.json`
      per the repo's migration convention (see CLAUDE.md's "a new migration's `when`
      must exceed every applied `created_at`" note).
- [x] T016 [US5] Add `flowIdSnapshot: uuid("flow_id_snapshot")` to the
      `flowExecutions` table definition in `packages/server/src/db/schema.ts`,
      immediately beside `flowNameSnapshot`, with a docblock mirroring that field's
      ("frozen at begin-time, survives deletion, never updated").
- [x] T017 [US5] `packages/server/src/routes/executions.ts`'s `begin` handler: add
      `flowIdSnapshot: flowRow?.id ?? null` alongside the existing
      `flowNameSnapshot: flowRow?.name ?? null` line.
- [x] T018 [US5] `packages/server/src/services/flow-visibility.service.ts`: add
      `flowIdSnapshot: string | null` to `ExecutionView` and to `executionBase`'s
      input/output, mirroring `flowNameSnapshot`.
- [x] T019 [US5] `packages/client/src/lib/foundry-client.ts`: add
      `flowIdSnapshot: string | null` to `FAFlowExecutionSummary`.
- [x] T020 [US5] `packages/client/src/lib/types.ts`: add `flowIdSnapshot` to
      `FlowExecutionSummary` and to `Run`.
- [x] T021 [US5] `packages/client/src/lib/adapters.ts`: add
      `runWorkflowId(e: { flowId: string | null; flowIdSnapshot?: string | null })`
      exported alongside `runLabel()`, same preference-then-fallback shape (per
      `contracts/execution-view-contract.md`); populate `flowExecutionSummaryFromFA`
      and `runFromFlowExecution`'s `Run.flowIdSnapshot`.
- [x] T022 [US5] `packages/client/src/app/(app)/history/page.tsx`: change the
      `workflowId` cell (added in T009) from `<CopyableId id={r.flowId ?? null} />`
      to `<CopyableId id={runWorkflowId(r)} />`.
- [x] T023 [US5] Manual verification: `quickstart.md` Scenario 3 (delete the flow,
      confirm the Workflow ID column is unchanged) and Scenario 5 (pre-existing rows
      fall back honestly).

**Checkpoint**: US4 + US5 together deliver the full Workflow ID guarantee — visible,
truncated, copyable, AND immune to the workflow's later deletion.

---

## Phase 8: User Story 6 — The Action column becomes Status, in plain words (Priority: P2)

**Goal**: Header reads "Status"; badge text reads `completed`/`stopped`/`running`.

**Independent Test**: View History; confirm header wording and badge text for each
outcome.

**Depends on**: Phase 6 (US4) only for the column-key rename (`summary` → `status`
happened in T008); otherwise independent of US5.

### Tests for User Story 6

- [x] T024 [P] [US6] Extend `packages/client/src/app/(app)/history/page.test.tsx`
      (from T010) with cases asserting the header cell reads "Status" and that badge
      text for each outcome reads `completed`/`stopped`/`running` (never the
      `run.*`-prefixed spelling).

### Implementation for User Story 6

- [x] T025 [US6] `packages/client/src/app/(app)/history/page.tsx`'s `actionBadge()`:
      change `label` values from `run.completed`/`run.stopped`/`run.running` to
      `completed`/`stopped`/`running`.
- [x] T026 [US6] Same file's `heads` prop: confirm the `status` key (from T008/T009)
      renders the header word "Status" (not "Action").

**Checkpoint**: All six user stories independently functional and tested.

---

## Phase 9: User Story 7 — Workflow ID and Run ID navigate to their detail pages (Priority: P2)

**Goal**: Clicking a Workflow ID goes to `/flows/:id`; clicking a Run ID goes to `/runs/:id`.
The copy button stays independent — clicking it never navigates.

**Independent Test**: Click a Workflow ID text; confirm navigation to that flow's
page. Click a Run ID text; confirm navigation to that run's page. Click a copy
button; confirm no navigation occurred.

**Depends on**: Phase 6 (US4) — extends `CopyableId`, the same component both
id columns already use; Phase 7 (US5) for the Workflow ID's target value
(`runWorkflowId(r)`, not the bare live `flowId`).

### Tests for User Story 7 (write first, confirm they fail before implementing)

- [x] T032 [P] [US7] Extend `packages/client/src/components/ui/CopyableId.test.tsx`:
      an `href` prop renders the truncated text as a link with that `href`;
      omitting `href` keeps it a plain `<span>` (no behavior change for any
      existing caller); clicking the copy button does not error and does not
      require the link to be present (independent controls); `id: null` still
      renders no link regardless of `href` (nothing to point at).
- [x] T033 [P] [US7] Extend `packages/client/src/app/(app)/history/page.test.tsx`: the
      Workflow ID text is a link to `/flows/:id` (using `runWorkflowId(r)`,
      not the bare `flowId`); the Run ID text is a link to `/runs/:id`; an
      orphaned run's Workflow ID cell (no snapshot, no live id) has no link.

### Implementation for User Story 7

- [x] T034 [US7] `packages/client/src/components/ui/CopyableId.tsx`: add an
      optional `href?: string` prop. When present, the truncated-text span
      becomes a `next/link` `<Link>` to `href` (still carrying `title` for the
      full id on hover); the copy button stays a plain sibling `<button>`,
      never nested inside the link, so the two controls cannot conflict.
- [x] T035 [US7] `packages/client/src/app/(app)/history/page.tsx`: pass
      `href={\`/flows/${runWorkflowId(r)}\`}` to the Workflow ID cell's
      `CopyableId` (only when `runWorkflowId(r)` is non-null — the null case
      already renders the no-link "—" placeholder) and
      `href={\`/runs/${r.id}\`}` to the Run ID cell's (`r.id` is always
      present, so this is unconditional).

**Checkpoint**: All seven user stories independently functional and tested.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [x] T027 [P] Extend the search box in `packages/client/src/app/(app)/history/page.tsx`
      to also match `r.flowIdSnapshot ?? r.flowId` (research.md Decision 5), in
      addition to the existing `r.automation`/`r.text`/`r.id` matches.
- [x] T028 [P] Add a dated entry to `CLAUDE.md` describing the ID-snapshot + column
      split + status relabel change, in the same PR (Constitution Article VII).
- [x] T029 Run `pnpm --filter @foundry/server test` and (on Node 22)
      `pnpm --filter @foundry/client test`. ⚠ Client: green except one
      documented pre-existing flake (`runs/[id]/page.test.tsx`'s `emailsForRun`
      mock gap, unrelated, predates this session). Server: 14 unrelated
      pre-existing failures (RBAC/`workspace_role_assignments` schema drift on
      this dev DB) confirmed untouched by this diff — this feature's own two
      targeted test files pass cleanly, standalone and in the full run.
- [x] T030 Ran `/speckit-comply` before requesting review (Constitution Article
      III) — PASS for this feature's diff, with one unrelated pre-existing HIGH
      finding (`FlowCanvas.tsx`/`Sidebar.tsx`, modified before this session,
      not covered by this feature's tasks — flagged, not fixed here).
- [ ] T031 Walk through all six `quickstart.md` scenarios against a dev
      deployment. NOT run — automated-test equivalents (listed in
      `quickstart.md`'s own "Automated equivalents" section) all pass, but no
      manual click-through of a live deployment was performed this session.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: No dependencies; blocks Phase 6 (US4) only — US1/US2/US3
  need nothing from it.
- **US1 (Phase 3) / US2 (Phase 4)**: Already complete; no dependency on Phase 2.
- **US3 (Phase 5)**: Depends only on the History page existing (it does); independent
  of Phase 2 and of US4–US6, though its test file is added alongside T010/T016.
- **US4 (Phase 6)**: Depends on Phase 2 (Copy icon).
- **US5 (Phase 7)**: Depends on Phase 6 (upgrades the Workflow ID cell's data source;
  does not change its markup).
- **US6 (Phase 8)**: Depends on Phase 6 for the `status` column key existing; not on
  Phase 7.
- **Polish (Phase 9)**: Depends on US4–US6 (Phases 6–8) being complete.

### Critical path

Phase 2 → Phase 6 (US4) → Phase 7 (US5) → Phase 8 (US6) can run right after Phase 6 →
Phase 9. US1/US2/US3 (Phases 3–5) have no dependency on this path and are already
done or trivial.

### Parallel Opportunities

- T011–T014 (US5 tests) can all be written in parallel — four different files.
- T027/T028 (Polish) are independent of each other.
- T003 (US3) can be done any time after the History page test file exists (T010).

---

## Implementation Strategy

### MVP scope for THIS pass

US1/US2 are already shipped on this branch. The next meaningful increment is
**US4 + US5 together** (Phases 2, 6, 7) — a Workflow ID column that is both visible
and delete-proof is the actual ask; shipping US4 alone (live `flowId`, still blanks
on delete) is a real but incomplete step, useful mainly as a mid-point checkpoint.
US6 (Phase 8) is small and can ride along with US4/US5 in the same PR. US3 (Phase 5)
is a one-task regression guard, cheap to include anywhere.

### Incremental delivery

1. Phase 1 + Phase 2 → foundation ready.
2. Phase 6 (US4) → Workflow ID/Run ID columns visible and copyable → validate → could
   ship alone if needed.
3. Phase 7 (US5) → Workflow ID now survives deletion → validate.
4. Phase 8 (US6) → Status relabel → validate.
5. Phase 5 (US3) → regression guard in place.
6. Phase 9 → polish, docs, full test run, `/speckit-comply`.
