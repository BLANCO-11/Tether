# Tasks: Resource detail shows schema and DB operations

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Branch**: `fix/resource-detail-schema-and-operations`

Tasks are ordered by dependency. `[P]` = parallelisable with the task beside it.

## Phase 0 — Baseline (do first, or the gates mean nothing)

- [x] **T001** Capture the pre-change baseline so "still green" is checkable, not asserted:
  `pnpm --filter @foundry/client test`, `typecheck`, `./scripts/ui-honesty-check.sh`.
  Record the counts in the completion note. *(Rationale: the repo has been burned by comparing
  against a remembered baseline; `ui-honesty-check.sh` has known pre-existing FAILs on this branch
  family and they must be diffed, not eyeballed.)*

## Phase 1 — The one category definition (FR-004)

- [x] **T002** Create `packages/client/src/lib/resource-category.ts`: move `ResourceCategory`,
  `VALID_TYPES` and `categoryFor` out of `app/(app)/resources/page.tsx` verbatim — no behaviour
  change in this task.
- [x] **T003** Update `app/(app)/resources/page.tsx` to import from the new module and delete its
  local copies. The list's rendering must be byte-identical in behaviour.
- [x] **T004** [P] Add `packages/client/src/lib/resource-category.test.ts`: postgres/mysql →
  `datasource`; email/slack/rest/connector → `connector`; tool/app → `tool`; unknown →
  `datasource`. Include the ordering trap (a connector id containing both "tool" and "connector").

## Phase 2 — Mount the components (FR-001, FR-002, FR-003)

- [x] **T005** In `app/(app)/resources/[id]/page.tsx`, derive `isDatasource` from the shared
  `categoryFor` and render, in the content zone, for datasources only:
  - a **Schema** section wrapping `AssetTree` with the `metadata` the page already fetches,
    including the table count and the honest-empty statement (FR-005);
  - a **DB operations** section wrapping `DbOperationsPanel` with `datasourceId={id}` and
    `schema={metadata ?? []}`;
  - a `SandboxPanel` (US3/D-3), ranked last.
- [x] **T006** Remove the stale "Field mapping is available in the data source schema view"
  sentence and reconcile the "Published mapping" block with the schema now being on the page
  (FR-007). Do not delete any other existing region (FR-006).
- [x] **T007** Update the page docblock to state the added regions and the datasource-only gate
  (Constitution VII).

## Phase 3 — Tests (Constitution II; NFR-001)

- [x] **T008** **Extend the `@/lib/api` mock in `app/(app)/resources/[id]/page.test.tsx` before
  running anything.** Add every export the newly mounted components import
  (`listOperations`, `createOperation`, `checkOperation`, `proposeOperation`, and whatever
  `SandboxPanel` reads). ⚠ This is a whole-module mock: an omitted export returns `undefined`, is
  invoked, and crashes **all** tests in the file — the documented `tools/page.test.tsx` failure.
  Leave a comment saying so for the next person adding a read to this page.
- [x] **T009** Add both-directions tests (SC-003): a datasource resource renders Schema and DB
  operations; a connector resource renders **neither**. A one-sided test passes against a page that
  renders nothing at all.
- [x] **T010** [P] Add the honest-empty test (FR-005): datasource with empty metadata renders the
  "nothing discovered" statement, not a blank pane.
- [x] **T011** Confirm the pre-existing S-52 tests (header, figures, Connection, Audit, Law 7
  honest empty) still pass unchanged — FR-006 is satisfied by their passing, not by inspection.

## Phase 4 — Verify

- [x] **T012** Run the full client suite, typecheck, and `ui-honesty-check.sh`; diff against T001.
- [x] **T013** **Perturbation check** (repo practice: a control that cannot fail is worse than
  none). For each new control, revert it and confirm a test goes red:
  1. render the sections unconditionally → the connector-direction test fails;
  2. drop the mock additions from T008 → the file crashes;
  3. re-duplicate `categoryFor` into the detail page → the shared-module test still passes but the
     duplication is visible in review (record this one as *not* mechanically caught, honestly).
- [~] **T014** PARTIAL. The data half is verified against the live database: every datasource is
  `postgres` (so all are datasource-category), `finance_demo` has 6 operations, `legal_demo` has a
  non-empty schema and 0 operations (the honest-empty list), `hr_demo_alt` has neither. The
  production build compiles `/resources/[id]`. The web image was rebuilt and the container
  recreated, and the SERVED bundle now contains the schema pane and no longer contains the stale
  pointer (grepped inside the running container). ⚠ **A signed-in browser render was not performed**
  — `/resources` 307s to `/login` and there are no headless credentials here. The panes are proven
  present in the shipped bundle and by the jsdom render tests, not by a human looking at them.
- [x] **T015** Compliance run. ⚠ `ci/check-spec-compliance.sh` **fails at gate 0** on this branch:
  it accepts only `YYYYMMDD-HHMMSS-name` or `hotfix/*`. Verified that it rejects **`release/beta`
  itself** for the same reason, so this is a pre-existing conflict between the constitution and
  `docs/VERSIONING.md`, not something this feature introduced. The user chose to keep the `fix/*`
  branch; the gate mismatch is recorded as a governance item.

## Out of scope (do not do here)

- Deleting or redirecting `/data-sources/[id]`.
- Any server-side change to operation compile/check/propose.
- Resolving the Constitution VI ↔ VERSIONING.md branch-naming conflict — flagged in plan.md for a
  human decision.
