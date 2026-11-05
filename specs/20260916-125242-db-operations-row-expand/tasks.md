# Tasks: DB operation row detail (expand/collapse)

**Input**: `spec.md`, `plan.md` in this directory

## Phase 1: Implementation (User Story 1, P1)

- [x] **T001** In `packages/client/src/components/data/DbOperationsPanel.tsx`,
  extract the row markup into an `OperationRow({ op }: { op: FADatasourceOperation })`
  component with local `useState(false)` open state. [FR-001, FR-005, FR-006]
- [x] **T002** Make the row header a real `<button type="button" aria-expanded>`
  wrapping the existing summary line (kind chip, name, param/join counts, ref)
  plus a `ChevronRight` that rotates 90° when open (reuse `AssetTree`/
  `InspectorSection` idiom — `transition-transform duration-fast ease-app`).
  [FR-001, FR-007]
- [x] **T003** When open, render the detail body from `op.spec`:
  - Target: `spec.base.schema` (if present) + `.` + `spec.base.table`
  - Columns: each `alias` with its source (`aggregate(column)` or `column`)
  - Joins (only if `spec.joins.length > 0`): kind, table, `onLeft = onRight`
  - Sort (only if `spec.sort.length > 0`): column + direction
  - Limit / Distinct (only if set)
  [FR-002]
- [x] **T004** Render the parameters section reusing `Params` from
  `./OperationReview` with `op.paramsSchema`. [FR-002]
- [x] **T005** Render the compiled SQL (`op.compiledSql`) directly in the
  detail body (a `<pre>` block, matching the existing SQL styling used
  elsewhere in this file) — visible as soon as the row is expanded, no
  second nested toggle. [FR-003]
- [x] **T006** Confirm no new `useAsync`/`listOperations`/`checkOperation`
  call is introduced by the expand path (`FR-004` — zero extra requests).

## Phase 2: Tests

- [x] **T007** In `DbOperationsPanel.test.tsx`: clicking a row's header shows
  its detail (target table + compiled SQL text present); clicking again
  hides it. [FR-001, FR-006]
- [x] **T008** In `DbOperationsPanel.test.tsx`: expanding two different rows
  leaves both expanded (independent state). [FR-005]

## Phase 3: Verification

- [x] **T009** `pnpm --filter @foundry/client test -- DbOperationsPanel` green
  (36/36, run via `npx vitest run` on Node 22 per the repo's Node-version note).
- [x] **T010** `pnpm --filter @foundry/client typecheck` clean (`tsc --noEmit`).
- [x] **T011** `scripts/ui-honesty-check.sh` — 239 PASS / 0 FAIL, unchanged.
- [x] **T012** `src/app/routes.smoke.test.tsx` — 40/40, `/data-sources/[id]` unaffected.
