# Feature Specification: Flow History Name Snapshot

**Feature Branch**: `20260918-123817-flow-history-name-snapshot`

**Created**: 2026-09-18

**Status**: Draft

**Input**: User description: "Snapshot the flow's display name onto each flow execution at run-start time, so the History route shows the flow name as it was at the moment that specific run happened, rather than the current live name or the Kestra slug."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the run's actual name in History (Priority: P1)

A workspace member opens the History view to review past runs of their automations. Today, each run is labeled with the automation's internal slug (e.g. `pending_invoices_sheet`), not the human-readable name they gave the workflow. They want each run in the list to be labeled clearly and meaningfully, reflecting what that workflow was actually called.

**Why this priority**: This is the core value of the feature — without it, History remains hard to scan and the slug-based labels stay confusing. Nothing else in this feature matters without this working.

**Independent Test**: Run a workflow that has a real display name set, then open History. The run should appear labeled with that name (not the internal slug, not a raw ID).

**Acceptance Scenarios**:

1. **Given** a workflow named "Rachit V1" is run, **When** the user opens History, **Then** the run for that execution is labeled "Rachit V1".
2. **Given** a workflow has never been given a name and still shows its system-assigned default (e.g. "Untitled flow oj7q"), **When** it is run, **Then** the run in History is labeled with that same default name.

---

### User Story 2 - Each run keeps the name it had when it ran (Priority: P1)

A user renames a workflow after it has already been run one or more times. They expect History to act as an accurate record of the past: older runs should still show the name the workflow had *at the time they ran*, and only new runs (after the rename) should show the new name. Renaming a workflow must never retroactively relabel runs that already happened.

**Why this priority**: This is what makes History trustworthy as a historical record rather than a live mirror of current workflow names. Without this, a rename would silently rewrite the past, which is misleading and was explicitly identified as an unacceptable side effect of a simpler "look up the current name" approach.

**Independent Test**: Run a workflow while it is named "A", rename it to "B", then run it again. History should show one run labeled "A" and a separate, later run labeled "B" for the same workflow.

**Acceptance Scenarios**:

1. **Given** a workflow named "A" was run and later renamed to "B", **When** the user views History, **Then** the earlier run still shows "A" and any run started after the rename shows "B".
2. **Given** a user renames a workflow multiple times between runs, **When** they view History, **Then** each run independently reflects the name that was in effect at the moment that specific run started.

---

### User Story 3 - Names in History cannot be edited from History itself (Priority: P2)

A user browsing History should be able to trust that the name shown for a run is a fixed historical fact, not something that can be changed or drift from that view. The workflow's name can only be changed from the workflow's own editing screen — never from History.

**Why this priority**: This protects the integrity of the historical record established by User Story 2. It's a natural consequence of the design rather than new functionality, but it matters enough to state explicitly so it isn't accidentally undermined by a future "quick edit" affordance in History.

**Independent Test**: Attempt to find any control in History that changes a run's displayed name; confirm none exists, and confirm the only place a workflow's name can be changed is on the workflow itself.

**Acceptance Scenarios**:

1. **Given** a user is viewing History, **When** they look for a way to rename a run or its workflow, **Then** no such control is present in History.
2. **Given** a user renames a workflow from the workflow screen, **When** they return to History, **Then** only runs started after the rename reflect the new name (per User Story 2).

---

### Edge Cases

- What happens when a run is started for a workflow that has never been explicitly named (still on its system-assigned default name)? The default name at that moment is captured and shown, same as any other name.
- What happens when a workflow is deleted after it has been run? Runs that already captured a name at the time they started continue to display that captured name; the deletion does not blank it out.
- What happens to runs that occurred before this feature existed (no captured name available)? These are explicitly out of scope for correction — they continue to display using today's existing fallback labeling behavior (the automation's internal slug, or a generic placeholder if that is also unavailable). No attempt is made to reconstruct their true historical name.
- What happens if a workflow's name is blank or whitespace-only at the moment a run starts? The run falls back to the same existing placeholder behavior used today for a missing name.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST record the workflow's display name at the exact moment each run starts, and preserve that recorded name unchanged for the lifetime of the run record, regardless of later changes to the workflow's name.
- **FR-002**: The History view MUST display, for each run, the name that was recorded for that run at its start time, rather than the workflow's current live name or its internal slug.
- **FR-003**: When a recorded name is not available for a run (runs that predate this feature), the History view MUST fall back to today's existing labeling behavior, so no run is ever left without a label.
- **FR-004**: Renaming a workflow MUST NOT change the displayed name of any run that already started before the rename.
- **FR-005**: The History view MUST NOT provide any way to edit or change a run's displayed name; a workflow's name can only be changed from the workflow's own editing surface.
- **FR-006**: If a workflow has no explicitly-set name at run start (i.e. still on its system-assigned default), the system MUST capture and display that default name the same way it would a user-chosen name.
- **FR-007**: Deleting a workflow after it has been run MUST NOT remove or blank out the recorded name already captured on its past runs.

### Key Entities

- **Run (Flow Execution)**: A single execution of a workflow. Each run now carries its own permanently recorded copy of the workflow's display name as it existed when that run started, in addition to its existing identity information (run ID, status, timing, and the workflow's internal slug).
- **Workflow (Flow)**: The reusable automation definition a user creates, names, and edits. Its display name is mutable and not guaranteed unique across workflows; it is the source value copied into a run's recorded name at the moment the run starts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can identify which workflow a run belongs to by reading the run's label in History, without needing to cross-reference an internal slug or ID, for 100% of runs started after this feature ships.
- **SC-002**: Renaming a workflow changes the displayed name of 0% of previously-started runs in History; only runs started after the rename show the new name.
- **SC-003**: 100% of runs — including those whose workflow has since been deleted — continue to display a non-blank label in History after this change, with no regression from current behavior.
- **SC-004**: Users reviewing History require no additional documentation or support explanation to understand why a run is labeled the way it is (i.e. the label reflects a name they recognize as having set themselves, or the existing fallback they already understand).

---

### User Story 4 - Workflow ID and Run ID are their own columns, and are copyable (Priority: P1)

A user scanning History wants to distinguish the workflow's own identity from this specific run's identity, and wants to copy either one without hand-selecting a long id. Today both identifiers are stacked into a single "Automation" cell with no copy affordance.

**Why this priority**: This is a direct usability requirement for the same audit-trail use case User Story 1 serves — a person pasting an id into a support ticket or another tool needs a reliable, low-friction way to get the exact value.

**Independent Test**: Open History and confirm the table has separate "Workflow ID" and "Run ID" columns, each showing a short, fixed-width, truncated form of the id with a copy button, and that clicking the copy button places the *full* id on the clipboard.

**Acceptance Scenarios**:

1. **Given** a run in the History list, **When** the user looks at the Workflow ID and Run ID columns, **Then** each shows only the first 5 characters of its id followed by an ellipsis, in a fixed-width cell — never the full id inline.
2. **Given** a user clicks the copy button beside a truncated id, **When** the copy completes, **Then** the full, untruncated id is on the clipboard and a toast confirms the copy.
3. **Given** a user clicks the copy button and the clipboard write fails (e.g. insecure context), **When** the failure occurs, **Then** a toast says the copy could not be completed — never a silent no-op.

---

### User Story 5 - Workflow ID also survives the workflow being deleted (Priority: P1)

Just as the workflow's *name* must be frozen onto a run at start time (User Story 2) so a later rename can't relabel history, the workflow's *id* must also be frozen at start time so that deleting the workflow doesn't blank the Workflow ID column for runs that already happened.

**Why this priority**: `flow_executions.flow_id` is set to NULL when its flow is deleted (existing FK behavior, `ON DELETE SET NULL`), so without a captured copy, every run of a deleted workflow would lose its Workflow ID column value — the identical failure mode User Story 2 already fixed for the name, on the other identifier.

**Independent Test**: Run a workflow, note its Workflow ID as shown in History, delete the workflow, and confirm the same run in History still shows the same Workflow ID.

**Acceptance Scenarios**:

1. **Given** a workflow is run and then deleted, **When** the user views that run in History, **Then** the Workflow ID column still shows the id the workflow had, not a blank value.
2. **Given** a run that predates this capture (no snapshot available and the workflow has since been deleted), **When** the user views it in History, **Then** it falls back to today's existing behavior for an orphaned run (no fabricated id).

---

### User Story 6 - The Action column becomes Status, in plain words (Priority: P2)

A user scanning the History table wants a plain status word, not an internal event-name spelling.

**Why this priority**: Cosmetic but load-bearing for scanability of the audit trail; low complexity, no data model change.

**Independent Test**: Open History and confirm the column header reads "Status" (not "Action") and the badge text reads `completed` / `stopped` / `running` (not `run.completed` / `run.stopped` / `run.running`).

**Acceptance Scenarios**:

1. **Given** a completed run, **When** viewing its Status badge, **Then** it reads `completed`.
2. **Given** a stopped (failed) run, **When** viewing its Status badge, **Then** it reads `stopped`.
3. **Given** a still-running run, **When** viewing its Status badge, **Then** it reads `running`.

## Requirements *(mandatory)* — additions for User Stories 4–6

- **FR-008**: The History table MUST show Workflow ID and Run ID as their own columns, distinct from the Workflow Name column.
- **FR-009**: Each id column MUST display a fixed-width, truncated form (first 5 characters + ellipsis) of the id, never the full id inline.
- **FR-010**: Each id column MUST offer a copy-to-clipboard control that copies the full, untruncated id, and MUST confirm success or failure via a toast.
- **FR-011**: The system MUST record the workflow's id at the exact moment each run starts (mirroring FR-001 for the name) and preserve it unchanged for the lifetime of the run record, so that deleting the workflow afterward does not blank the Workflow ID column for that run.
- **FR-012**: The History table's Action column MUST be relabeled "Status" and MUST display plain status words (`completed`, `stopped`, `running`) rather than the internal event-name spelling (`run.completed`, `run.stopped`, `run.running`).

### Key Entities — addition

- **Run (Flow Execution)**, extended: also carries a permanently recorded copy of the workflow's id as it existed when the run started, independent of the (mutable, nullable-on-delete) live workflow-id pointer already on the row.

---

### User Story 7 - Workflow ID and Run ID navigate to their detail pages (Priority: P2)

A user reading History wants to jump straight from an id to the thing it identifies — the workflow's own page, or this specific run's step-by-step detail page — without copying the id and pasting it into a URL or a search box elsewhere.

**Why this priority**: A direct extension of User Story 4's copy affordance for the same audience and the same moment of use; not required for History to be trustworthy as a record (User Stories 1–3 cover that), but it turns an id a person can only copy into one they can also follow.

**Independent Test**: Open History, click a row's Workflow ID text, and confirm it navigates to that workflow's own page (`/flows/:id`). Click the same row's Run ID text, and confirm it navigates to that run's detail page (`/runs/:id`).

**Acceptance Scenarios**:

1. **Given** a run whose workflow still exists, **When** the user clicks the Workflow ID text, **Then** the browser navigates to that workflow's page.
2. **Given** any run, **When** the user clicks the Run ID text, **Then** the browser navigates to that run's detail page.
3. **Given** an orphaned run (its workflow has been deleted and no id is available to link to), **When** the user looks at the Workflow ID cell, **Then** it shows the existing "—" placeholder with no link and no copy button — there is nothing to navigate to.
4. **Given** a row with both a copy button and a linked id in the same cell, **When** the user clicks the copy button, **Then** the id is copied and the page does NOT navigate — the two controls act independently.

### Requirements *(mandatory)* — addition for User Story 7

- **FR-013**: Where a Workflow ID or Run ID is displayed and a valid target exists, the id text MUST be a link to that item's own detail page (`/flows/:id` for a Workflow ID, `/runs/:id` for a Run ID). Clicking the adjacent copy button MUST NOT trigger navigation.

## Assumptions

- Runs that occurred before this feature ships will not have their true historical name reconstructed; they will continue to display using today's existing fallback labeling (internal slug, or generic placeholder), as explicitly agreed to be out of scope.
- "Workflow display name" refers to the same editable name field already shown and edited on the workflow's own screen (distinct from the workflow's internal, immutable, system-level identifier).
- Existing behaviors that group or filter runs by their displayed label (such as dashboard summaries) are expected to automatically pick up the more accurate recorded name once available, without requiring separate changes; this is treated as a beneficial side effect, not a new requirement of this feature.
- No backfill or historical correction job is in scope for this feature.
