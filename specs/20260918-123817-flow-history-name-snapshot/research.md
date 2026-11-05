# Phase 0 Research: Flow History Name Snapshot + ID columns

No NEEDS CLARIFICATION markers remain in Technical Context — this feature reuses
existing, already-proven patterns in this codebase rather than introducing new ones.
Each decision below names the precedent it follows.

## Decision 1: Freeze the workflow id the same way the workflow name is frozen

**Decision**: Add `flow_executions.flow_id_snapshot uuid` (nullable, no FK), written
at `begin` alongside the existing `flow_id_snapshot`'s sibling `flow_name_snapshot`,
read in preference to the live `flow_id` pointer for display.

**Rationale**: `flow_executions.flow_id` is `uuid("flow_id").references(() =>
flows.id, { onDelete: "set null" })` — deleting the workflow blanks it. The exact same
failure mode was already solved for the *name* in this branch's prior batch
(`flow_name_snapshot`, migration `0069`, written in `routes/executions.ts`'s `begin`
handler, read in `runLabel()`). Reusing that identical mechanism for the id is the
smallest-diff, most-consistent option — same table, same write-site, same read-time
preference-then-fallback shape.

**Alternatives considered**:
- *Derive the id from `kestra_flow_id` (the slug) instead of snapshotting a second
  column.* Rejected: the slug is a different identifier (Kestra's, not Foundry's
  uuid — see CLAUDE.md's I-23 discussion), and the spec explicitly asks for the
  *workflow id*, which is Foundry's `flows.id` uuid, not the Kestra slug.
- *Look up the id live via the `flow_id` FK at read time and accept it going blank on
  delete.* Rejected outright by the spec's User Story 5 acceptance criteria — a
  deleted workflow's runs must keep showing their original Workflow ID.

## Decision 2: One shared `CopyableId` component for both id columns

**Decision**: A single `components/ui/CopyableId.tsx` renders the copy button +
truncated text for both the Workflow ID and Run ID columns, rather than duplicating
truncate/copy/toast logic per column.

**Rationale**: The two columns have identical presentation and interaction rules
(5-char truncation, copy button before the text, toast on success/failure, `"—"` with
no button when the id is `null`) and differ only in *which* id string is passed in.
This is the case Article IV's simplicity principle treats as extraction-worthy — not
"three similar lines," but one control instantiated twice with different data.

**Alternatives considered**: Inline JSX per cell in `history/page.tsx` — rejected as
duplicated logic that would drift (e.g. a truncation-length change requiring two
edits instead of one), the same class of risk CLAUDE.md repeatedly calls out for
duplicated rules in this codebase (e.g. `ENV_NAME_RE`, `AUTH_STYLES` before V7).

## Decision 3: Reuse the existing `useToast()` provider for copy feedback

**Decision**: `CopyableId`'s copy button calls `useToast()` (from
`packages/client/src/lib/toast.tsx`, already mounted app-wide via `ToastProvider` in
`app/layout.tsx`) on both success and failure of `navigator.clipboard.writeText`.

**Rationale**: A toast system already exists and is already used across ~40 files in
this client. Building a second notification mechanism for one new feature would
violate Article IV (simplicity) with no offsetting benefit. The existing best-effort
clipboard pattern (`FlowIntegrationPanel.tsx`, `AllowRequest.tsx`) already handles the
"clipboard API absent over plain HTTP" edge case via `navigator.clipboard?.writeText`
+ `.then()/.catch()`; this feature adds the toast call into those same branches
instead of the current inline "copied" text-swap those two files use (which this
feature does not touch — they are unrelated screens).

**Alternatives considered**: A new toast-free inline "Copied" label swap (as
`FlowIntegrationPanel.tsx` does today) — rejected because the user explicitly asked
for toast feedback, and a table cell is a worse place than a dedicated button for an
in-place text swap (fixed-width truncated cell has no room to grow).

## Decision 4: Extend `DataTable`'s existing `run` named set rather than a new grid

**Decision**: Modify the existing `run` entry in `DataTable.tsx`'s `SETS` map from 5
to 6 columns (`time, workflowName, workflowId, runId, status, actions`), rather than
hand-rolling a new grid on the History page.

**Rationale**: `DataTable.tsx`'s own docblock states its purpose is precisely to stop
each page inventing its own grid template (measured: 9 bespoke grids before it
existed, plan.md §0 / D-94). History already uses the `run` set; this feature is
exactly the "a page that genuinely needs a new shape adds a set HERE" case the file
describes as the intended way to extend it.

**Alternatives considered**: A parallel `run-v2` set — rejected; there is one History
page, so versioning the set serves no purpose and would leave a dead `run` definition
behind (the codebase's `docs/GAPS.md`-style intolerance for controls/definitions that
exist but aren't exercised applies here too).

## Decision 5: Truncation and search behavior

**Decision**: Exactly 5 leading characters + `…` for display (user-specified);
`title={fullId}` for hover; full id copied verbatim. Search box extended to also
match `flowIdSnapshot ?? flowId` in addition to the existing `automation`, `text`,
and `id` (run id) matches.

**Rationale**: Truncation length and copy-vs-display split are explicit user
requirements. Search extension is a judgment call (user deferred it): once the
Workflow ID is its own visible column, a user copying a partial id into search and
expecting a hit is the more consistent behavior — the existing search already matches
the Run ID (`r.id`) for the same reason.

**Alternatives considered**: Leave search unchanged (Workflow ID not searchable) —
rejected as an inconsistency a user would notice (Run ID searchable, Workflow ID
not, with no visible reason why).
