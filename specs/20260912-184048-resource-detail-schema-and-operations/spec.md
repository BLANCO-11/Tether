# Feature Specification: Resource detail shows schema and DB operations

**Feature Branch**: `fix/resource-detail-schema-and-operations`

**Created**: 2026-09-12

**Status**: Draft

**Input**: User description: "In the data source tab in resource page, for a data source there should be schema and db operation components also present, which is currently not there in the UI. Investigate it and fix it."

## Context

Navigation's **Datasources** entry points at `/resources?type=datasource`. Each row opens
`/resources/[id]`, which today renders a header, a figures strip, "Workflows using it", a
"Published mapping" note, a Connection definition list and an Audit disclosure — and **no schema
tree and no DB operations panel**.

The older surface `/data-sources/[id]` does have all three panes (schema, sandbox, DB operations),
but nothing in the sidebar routes there any more except "Onboard a datasource". So the components
exist and work; the surface a person is actually sent to does not mount them.

The consequence is not cosmetic. A DB operation is the *only* callable read a `query` step can
name — a step carries `<datasource>.<operation>`, never SQL. With the panel absent from the surface
people reach, a datasource's readers can be neither seen nor created from the place the product
sends them, and the page's own "Published mapping" text points at a "data source schema view" that
navigation no longer offers.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what a datasource actually exposes (Priority: P1)

A person opens a datasource from the Datasources tab and sees the tables and columns Foundry
discovered, read through the same read-only credential an automation gets.

**Why this priority**: It is the question the page exists to answer, and it is the precondition for
Story 2 — an operation can only be built against a schema that is on screen.

**Independent Test**: Open a seeded datasource (e.g. `finance_demo`) from
`/resources?type=datasource` and confirm the discovered tables render. Delivers value alone: the
schema is readable without the operations panel.

**Acceptance Scenarios**:

1. **Given** a datasource with discovered tables, **When** its resource detail page is opened,
   **Then** a Schema section lists those tables and can be expanded to columns.
2. **Given** a datasource with no discovered tables, **When** the page is opened, **Then** the
   Schema section states that nothing has been discovered yet rather than rendering empty.
3. **Given** a resource that is not a datasource (email, Slack, REST connector), **When** its page
   is opened, **Then** no Schema section is rendered at all.

---

### User Story 2 - See and create the readers a query step can name (Priority: P1)

A person sees the DB operations already defined on the datasource, and can create another, from the
same page.

**Why this priority**: Equal to Story 1 — this is the capability the report is about. Without it the
callable catalogue is unreachable from the surface navigation leads to.

**Independent Test**: On a seeded datasource, confirm existing operations are listed and the builder
opens; create one and confirm it appears.

**Acceptance Scenarios**:

1. **Given** a datasource with existing DB operations, **When** its page is opened, **Then** those
   operations are listed by name.
2. **Given** a datasource whose schema is empty, **When** the operations builder is opened, **Then**
   it refuses to open and says why, rather than presenting an unusable form.
3. **Given** a resource that is not a datasource, **When** its page is opened, **Then** no DB
   operations section is rendered.

---

### User Story 3 - Know which data a draft run will read (Priority: P3)

A person can see whether a draft run against this datasource reads fixtures or production.

**Why this priority**: Genuinely useful and already built, but it answers a different question from
the report. Shipping Stories 1 and 2 without it still closes the reported gap.

**Acceptance Scenarios**:

1. **Given** a datasource, **When** its page is opened, **Then** the sandbox state is stated
   plainly, including that with no sandbox a draft run reads production.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The resource detail page MUST render a Schema section for datasource-category
  resources, listing the entities discovered for that datasource.
- **FR-002**: The resource detail page MUST render a DB operations section for datasource-category
  resources, listing existing operations and offering creation.
- **FR-003**: Both sections MUST be rendered **only** for datasource-category resources. A
  connector or tool resource MUST render neither.
- **FR-004**: The category decision MUST have exactly one definition in the client, shared by the
  resources list and the resource detail page. A second copy is forbidden.
- **FR-005**: An empty schema MUST render as an explicit "nothing discovered" statement, never as a
  blank pane and never as a claim that the datasource has no tables when the read failed.
- **FR-006**: The existing page regions (header, figures, workflows-using-it, Connection, Audit)
  MUST be preserved; this feature adds regions and removes none.
- **FR-007**: The stale sentence directing a person to "the data source schema view" MUST be
  removed or corrected once the schema is present on this page, so no on-screen text points at a
  surface navigation does not offer.
- **FR-008**: No new API surface, route, service or table. The feature MUST reuse the existing
  reads the page or the panels already perform.

### Non-Functional / Guardrails

- **NFR-001**: Adding reads to this page MUST NOT break its existing test file, whose `@/lib/api`
  mock is a whole-module replacement — an omitted export returns `undefined` and crashes every test
  in the file.
- **NFR-002**: Rows MUST never be fetched or previewed on this page; only schema metadata is
  exposed, preserving the schema-only visibility property the operations panel is built on.

## Success Criteria *(mandatory)*

- **SC-001**: From the Datasources tab, a person can reach a datasource and see its discovered
  tables without navigating to any other surface.
- **SC-002**: From that same page, a person can list and create the readers a workflow step can
  name, in one visit.
- **SC-003**: Opening a non-datasource resource shows neither section — verified in both directions
  so the gate cannot pass by rendering nothing everywhere.
- **SC-004**: No on-screen sentence refers a person to a surface navigation does not offer.
- **SC-005**: The client test suite and the UI honesty check stay green, with the new behaviour
  covered in both directions.

## Assumptions

- A resource's category is derived from its connector id, not stored — matching how the resources
  list already decides it.
- Datasources that cannot be introspected (S3, SFTP) are still datasource-category; their panes
  degrade to the honest-empty states in FR-005 and US2 scenario 2 rather than being hidden. This
  keeps the category rule single and avoids a second engine-specific rule that could drift.
- The legacy `/data-sources/[id]` page is left in place; this feature does not delete it.

## Out of Scope

- Deleting or redirecting the legacy `/data-sources/[id]` surface.
- Any change to how operations are compiled, checked or proposed on the server.
- Field-level mapping or AI-visibility modelling for generic resources.
