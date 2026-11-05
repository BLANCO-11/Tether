# Feature Specification: Remove Named Queries (DB Operations Only)

**Feature Branch**: `20260910-000402-remove-named-queries`

**Created**: 2026-09-10

**Status**: Draft

**Input**: User description: "Remove named queries completely, we are only gonna have db operations"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Authors read data only through DB operations (Priority: P1)

A flow author adding a data step sees one data option — DB operation — in the
canvas menu, the catalogue, and the data-source page. Hand-written named SQL
cannot be created, edited, proposed, or picked anywhere in the product.

**Why this priority**: Two ways to read data means two review standards, two
SQL dialects to audit, and a menu that offers steps the team agreed to drop.
One path is the whole value.

**Independent Test**: Open the builder, the data-source page, and the chat
builder; confirm no surface offers, lists, or accepts a named query, and a
`query`-kind step backed by a DB operation still drafts, runs, and arms.

**Acceptance Scenarios**:

1. **Given** the canvas menu is open, **When** the author reads the kind list, **Then** no named-query entry is offered and `DB operation` is the only data kind.
2. **Given** a data-source page, **When** it renders, **Then** the named-query panel is gone and the DB-operations panel remains.
3. **Given** a request to create, check, propose, update, or delete a named query, **When** it reaches the server, **Then** it is refused with a message naming DB operations as the path.

---

### User Story 2 - Existing flows survive the removal (Priority: P1)

Flows that already contain `datasource` steps are not left broken and silent:
each one is accounted for — converted to an equivalent DB operation or
explicitly flagged — before the kind stops compiling.

**Why this priority**: Deletion without migration turns armed production flows
into refuse-on-write traps. The removal is only safe if every existing
`datasource` step has a known fate.

**Independent Test**: Seed the demo workspaces, run the removal migration,
and confirm every previously-armed flow either still runs or names exactly
which step needs a human decision.

**Acceptance Scenarios**:

1. **Given** a `datasource` step whose SQL is expressible as a DB operation, **When** migration runs, **Then** the step becomes a `query` step against an equivalent operation and its runs still pass.
2. **Given** a `datasource` step that cannot be expressed as an operation, **When** migration runs, **Then** the flow is flagged with the step id and reason, never silently rewritten.
3. **Given** a stored named query no flow references, **When** migration runs, **Then** it is removed and the removal is reported.

---

### User Story 3 - No dead copy or dead code remains (Priority: P2)

No panel, test, doc, chat hint, drafter prompt, or review string still offers
or explains named queries after the removal.

**Why this priority**: A removed feature that is still advertised is a support
ticket generator — the user already reported the menu advertising removed
kinds once.

**Independent Test**: Search client, server, and docs for named-query
surfaces; every hit is either removed or is a historical record (migration
note, changelog) that says so.

**Acceptance Scenarios**:

1. **Given** the full test suite runs, **When** it finishes, **Then** zero tests create, mock, or assert named-query behaviour.
2. **Given** the chat builder lacks a data component, **When** it explains the gap, **Then** it names DB operations only.

---

### Edge Cases

- A `datasource` step in a revision that is already approved and armed: the approval binds that revision, so migration writes a new revision rather than editing history.
- A named query referenced by `refInterfaces()` import checks: imports naming it fail closed with the operation path named.
- Demo seeders, showcase, UAT scaffolding, and e2e journeys that install or call named queries: converted or deleted alongside, not left as the only remaining writers.
- `datasource` steps rendered on old run pages: history still renders (read path), only authoring is removed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The product MUST NOT offer named-query creation, editing, proposing, checking, or deletion on any surface (data-source page, builder, chat builder, API).
- **FR-002**: The canvas menu MUST NOT offer the `datasource` kind (already cut from `MENU_KINDS`; this feature removes the kind end to end).
- **FR-003**: The server MUST refuse `datasource`-kind steps on the write path with a message naming DB operations.
- **FR-004**: Every flow containing `datasource` steps MUST be rebuilt ("refresh all flows where old stuff is there, re do it" — user decision 2026-09-10): each affected flow is re-authored on DB operations as a new revision, and no `datasource` step survives the pass.
- **FR-005**: Stored named queries no flow references MUST be removed and reported, not left orphaned.
- **FR-006**: Chat, drafter, review, and empty-state copy MUST name DB operations only.
- **FR-007**: The suite MUST contain zero named-query tests, mocks, or fixtures after removal (deleted or converted, never re-pinned to removed behaviour).

### Key Entities

- **Named query**: hand-written, reviewed-as-text SQL bound to a datasource; the entity being deleted.
- **DB operation**: visual-spec read (`DbOperationSpec`: base table, columns, joins, parameterised filters, sort, limit) compiled server-side to read-only SELECT; the single remaining read path.
- **Datasource step**: a flow step of kind `datasource` whose ref names `<datasource>.<query>`; must be migrated or flagged, never silently dropped.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user adding a data step reaches a running flow through DB operations alone with no named-query surface encountered.
- **SC-002**: 100% of pre-existing `datasource` steps across all seeded workspaces are converted or explicitly flagged — zero fail silently.
- **SC-003**: Full client and server suites pass with zero named-query tests, mocks, or fixtures remaining.
- **SC-004**: No user-facing string in the product names named queries as something that can be created or used.

## Assumptions

- DB operations can express every read the seeded named queries perform; anything inexpressible is flagged per US-2 rather than silently dropped.
- Read-only rendering of historical revisions and run pages keeps working; only authoring and execution of new `datasource` steps are removed.
- The canvas menu cut (seven kinds, already implemented on `alpha-v2`) is the client half of FR-002; this feature completes it.
- `trigger`/`end` structural kinds and legacy `calculate`/`condition` aliases are out of scope except where their tests mock named queries.

## Backfilled additions 2026-09-10 (from working tree)

Recorded retroactively from the implemented diff. The spec assumption "DB
operations can express every read the seeded named queries perform" did NOT
hold for the as-found compiler: five query families needed compiler or
catalogue extensions before their flows could migrate. Each extension below
was proven against the old named query's output rows before its flow was
re-authored.

### Functional Requirements (backfilled)

- **FR-008**: Composite-key joins MUST compile: `andOn` appends ANDed
  equalities to a join's `ON` (plan+priority SLA policies, tier+priority SLA
  policies). A `latestOne` lookup MUST refuse `andOn` (extra equalities go in
  the lookup's own filters). [BACKFILLED - verify with author]
- **FR-009**: Computed columns MUST compile as an expression tree
  (`{column}`, `{param}`, `{addDays}`, `{diffDays}`, `{diffMinutes}`,
  `{greatest}`, `{least}`, `{businessMinutes}`, `{coalesce}`), nestable, with
  params collected positionally after filters. `businessMinutes` walks UTC
  days Mon–Fri 09:00–17:00, the SQL spelling of the itops oracle's day-walk.
- **FR-010**: Incident SLA arithmetic MUST equal the fixture oracle's
  `consumedMins` (service clock less pauses, floored at zero) for every
  incident at every verify instant — NOT wall-clock elapsed. A clock shortcut
  pages 4 incidents the oracle calls healthy (measured 2026-09-09).
- **FR-011**: The incident operation MUST expose the escalation chain (team
  escalation address plus org fallback) so pages wake the chain; at-risk
  tickets keep the team contact. Empty team address counts as absent.
- **FR-012**: The measurement window MUST end at `as_of`
  (`LEAST(coalesce(resolved_at, as_of), as_of)`): a resolution later than the
  reading is a future the reading must not count.
- **FR-013**: Migrated flows MUST keep every user-visible text byte-identical
  except where it names the removed source; branch guards MUST read
  `length > 0` on query/shaping rows; every expression read MUST declare its
  `dependsOn`; a continuation branch MUST NOT declare `dependsOn` (validator
  refuses it) — shapes feeding a second guard live in the already-sequenced
  first shape.
- **FR-014**: A transform MUST select source rows before constructing
  aliases; jq variables MUST NOT carry a `//` fallback with a field read on
  its right side (parenthesise: `((...|select(...)) // .field)`).
  [BACKFILLED - verify with author: both rules are measured Kestra
  render-time behaviour, root cause not isolated to a version.]
