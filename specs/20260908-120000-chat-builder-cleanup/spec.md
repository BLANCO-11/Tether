# Feature Specification: Chat Builder Cleanup

**Feature Branch**: `20260908-120000-chat-builder-cleanup`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "in the chat builder, when a workflow is built and if user wants to do a test run, it would show a workflow input needed box on top of chat, that is not needed anymore since we have that in the right side pane testing pane. secondly the suggestion component, it should be collapsable and expandable vertically instead of always visible."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Test run without chat-top input box (Priority: P1)

A user who built a workflow in the chat builder clicks Test workflow and supplies required starting values once, in the right-side testing pane.

**Why this priority**: Removes a duplicate input surface; the chat-top strip and the testing pane disagree about ownership of the run.

**Independent Test**: Build a flow with a required input, open Test workflow, confirm no input strip renders above the chat transcript while the testing pane still lists the input.

**Acceptance Scenarios**:

1. **Given** a chat-built flow with pending required inputs, **When** the chat pane renders, **Then** no `ChatInputValues` strip is shown above the transcript.
2. **Given** the user clicks Test workflow, **When** the testing pane opens, **Then** required inputs remain fillable there and a test run still starts.

---

### User Story 2 - Collapsible suggestions (Priority: P2)

A user reading chat suggestions can collapse them vertically to reclaim composer space and expand them again.

**Why this priority**: Suggestions are useful but currently always visible, pushing the transcript/composer.

**Independent Test**: With suggestions present, toggle the collapse control and confirm the chip row hides/shows without sending anything.

**Acceptance Scenarios**:

1. **Given** suggestions exist, **When** the user collapses them, **Then** the chip row hides and a compact expand control remains.
2. **Given** suggestions are collapsed, **When** the user expands them, **Then** the full chip row returns.

---

### Edge Cases

- Flow with no pending inputs: chat renders exactly as before minus the strip (no empty placeholder).
- Flow with no suggestions: no collapse control renders (nothing to collapse).
- Suggestions arrive while collapsed: stay collapsed until the user expands (no layout jump, no auto-send).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Chat pane MUST NOT render the `ChatInputValues` "Starting values" strip above the transcript.
- **FR-002**: Required test inputs MUST remain available in the right-side testing pane (`TestWorkbenchPanel`).
- **FR-003**: Chat suggestion row MUST have a collapse/expand control (vertical), collapsed state defaults to expanded, persisted for the session only (component state).
- **FR-004**: Collapsed suggestions MUST NOT send messages, change selection, or alter layout outside the suggestion row.
- **FR-005**: Dead input-strip plumbing that only served the removed strip (state, props, imports) MUST be removed; shared test-run props (`testing`, `testOutputs`, `testNotice`, `onTest`) MUST stay.

### Key Entities

- **Chat suggestion row**: derived, tappable chat follow-ups rendered above the composer.
- **Test inputs**: required workflow starting values collected at test time in the testing pane.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With a pending-input flow, chat shows zero input strips while the testing pane still accepts all required values and starts a run.
- **SC-002**: Users can collapse and expand the suggestion row in one click each, and the choice holds until the next reload.
- **SC-003**: No existing chat-builder test regresses except tests that asserted the removed strip (updated deliberately).

## Assumptions

- The right-side testing pane (`TestWorkbenchPanel` via `openTestWithValues`/`initialValues`) is the single owner of test inputs.
- Collapse state is session-local `useState`, not persisted to storage.
- `ChatInputValues.tsx` file itself is left in place (flow page may still import `InputValuesPanel`, not this); only its mount in `ChatWorkbench` is removed.
