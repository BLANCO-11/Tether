# Feature Specification: DB operation row detail (expand/collapse)

**Feature Branch**: `fix/ui-bugs` (existing branch — no new branch created; small UI fix)

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "Check out the snapshot, make changes in the db operation div, when i click on each db operations it should expand and show the details about the db operation and show the query"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Expand a DB operation row to see its detail (Priority: P1)

A person viewing a datasource's "DB operations" panel sees a flat list of saved
operations (kind, name, param/join counts, ref). They want to inspect one
without opening the full builder — what table it reads, its columns, joins,
parameters, sort/limit, and the compiled SQL — by clicking the row itself.

**Why this priority**: This is the entire ask. Without it the panel is a list
of names with no way to see what an operation actually does short of editing
a step that references it.

**Independent Test**: Load a datasource with at least one saved DB operation,
click its row, and confirm the detail (target table, columns, joins, filters,
sort/limit, compiled SQL) renders inline beneath the row with no page
navigation and no new network request beyond what already loaded the list.

**Acceptance Scenarios**:

1. **Given** a datasource with a saved DB operation, **When** the person
   clicks the operation's row, **Then** the row expands in place to show the
   operation's target table, its projected columns, any joins, its
   filters/parameters, sort/limit/distinct (when set), and the compiled SQL.
2. **Given** an expanded row, **When** the person clicks the row again,
   **Then** it collapses back to the summary line.
3. **Given** two saved operations, **When** the person expands the first and
   then the second, **Then** both remain expanded independently (expanding
   one does not collapse the other).

### Edge Cases

- An operation with no joins, no filters, and no sort/limit still expands
  and shows the sections that do apply (target table, columns) without
  rendering empty sections as errors.
- The click target for expand/collapse must not conflict with any other
  interactive element in the row (there are none today, but the expand
  affordance itself — e.g. a chevron — must be part of the row's click
  target, not a separate control that silently does nothing when missed).
- Keyboard users can reach and toggle a row without a mouse (the row is a
  real interactive element, not a `div` with only an `onClick`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each row in the DB operations list MUST be clickable/toggleable
  and MUST expand to reveal that operation's detail when activated (click or
  keyboard activation).
- **FR-002**: The expanded detail MUST show: the target schema/table, the
  projected columns (with their source column and aggregate, when set), any
  joins (kind, table, join columns), filters (column, operator, bound
  parameter name), sort columns and direction, limit, and whether the
  operation is distinct — each only when present in the spec.
- **FR-003**: The expanded detail MUST show the operation's compiled SQL
  text (`compiledSql`, already returned by the list endpoint) so a reviewer
  can read exactly what runs.
- **FR-004**: Expanding a row MUST NOT issue any additional network request —
  every field shown is already present on the object the list endpoint
  returns (`spec`, `compiledSql`, `paramsSchema`).
- **FR-005**: Each row's expanded/collapsed state MUST be independent of
  every other row's state.
- **FR-006**: Rows MUST default to collapsed.
- **FR-007**: The expand control MUST be reachable and operable via keyboard
  (a real button/interactive element with an accessible expanded state), not
  a bare `div` with a mouse-only handler.

### Key Entities

- **DB operation** (`FADatasourceOperation`): a saved, named, visual-spec-built
  read against one datasource — carries `spec` (target table, columns, joins,
  filters, sort, limit, distinct), `compiledSql`, and `paramsSchema`. Already
  fetched in full by the panel; this feature only changes how much of it is
  rendered and when.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person can see an operation's target table, joins, filters,
  and compiled SQL without leaving the DB operations panel or opening the
  builder, in one click.
- **SC-002**: Expanding a row adds zero additional network requests (verified
  by inspection — the detail is derived entirely from data the panel already
  holds).
- **SC-003**: Multiple rows can be open at once, each independently.

## Assumptions

- No new backend endpoint or field is needed — `listOperations` already
  returns `spec`, `compiledSql`, and `paramsSchema` per operation
  (`packages/client/src/lib/foundry-client.ts`'s `FADatasourceOperation`).
- The readback/output-column-provenance view (`Readback`, `OutputColumns` in
  `OperationReview.tsx`) is NOT required for this feature — those are
  server-composed from `POST …/operations/check` and would need an extra
  round trip per row on first expand. Out of scope; a future feature can add
  a lazy "why" call if wanted, per FR-004's zero-extra-request bound for v1.
- This is a small, self-contained client-only UI change on an existing
  branch (`fix/ui-bugs`); no new git branch is created for it.
