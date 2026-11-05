# Feature Specification: Builder Clarification Loop — Durable Answer State

**Feature Branch**: `20261001-174640-builder-clarify-loop`

**Created**: 2026-10-01

**Status**: Draft

**Input**: User description: "Structural fix for the chat workflow builder's clarification loop: answers given by the user are lost between clarification rounds, the component that raised an objection never receives the answer, and the loop has no termination condition — producing endlessly repeated questions, unsatisfiable objections, and a stuck 'Needs your input' state."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An answer once given is never lost (Priority: P1)

A user is building a workflow through chat. The builder asks a clarifying
question (e.g. "What do you mean by 'relevant body message'?"). The user
answers in their own words. In every subsequent round of the same build —
including rounds where the builder asks a *different* question or revisits an
earlier one — the system already knows and applies everything the user said
before. The user is never asked a question whose answer they have already
supplied.

**Why this priority**: This is the root defect. Without durable answer state,
every other clarification behaviour is broken: questions repeat, objections go
unanswered, and the build cannot converge. It is the minimum slice that makes
the builder usable.

**Independent Test**: Drive a multi-round build where the user answers three
distinct questions across three turns; assert that the state carried into each
round contains all prior answers verbatim, and that no question asked in round
N was already answered in round M (M < N).

**Acceptance Scenarios**:

1. **Given** the builder has asked "What do you mean by X?" and the user answered, **When** a later round recomputes open questions from the unchanged goal, **Then** X is not re-opened and the stored answer is applied to the build.
2. **Given** the user has answered questions A and B, **When** the builder starts a new clarification round, **Then** the round receives the combined answer state for A and B, not an empty state.
3. **Given** the user corrects an earlier answer, **When** the next round runs, **Then** the correction supersedes the original answer and the original is not re-asked or re-applied.

---

### User Story 2 - Objections are answered by the answer (Priority: P1)

When the builder reports "not settled yet: …" items (gaps the build planner
identified — e.g. "no row carries a customer address", "the count 'two' is
unused"), the user's reply must be delivered to the same reasoning that raised
those objections, so the objections can actually be resolved. After the
reply round, previously unresolved items are either resolved or explicitly
re-stated as still-open with a reason — never silently identical.

**Why this priority**: This is the second structural break: answers currently
reach only the interpretation step, never the planner that complained. Without
it, "Your answer did not settle these" repeats forever regardless of how well
state is preserved.

**Independent Test**: Seed a build with two known open items; supply an answer
that addresses both; assert both items are re-evaluated against the new answer
in the same turn and the turn output reflects their new status.

**Acceptance Scenarios**:

1. **Given** the planner listed open items O1 and O2, **When** the user answers in a way that resolves O1, **Then** the next round's open-item list no longer contains O1 and the turn reports O2's remaining reason.
2. **Given** the user's answer resolves no open item, **When** the round completes, **Then** the system says which specific item remains unsettled and why, and does not re-ask an already-answered question to make progress.
3. **Given** an open item refers to a value the user already stated, **When** items are recomputed, **Then** the item is closed using the stored answer without another user turn.

---

### User Story 3 - The clarification loop terminates (Priority: P2)

The builder's clarification exchange always reaches an endpoint: either the
build completes, or the user explicitly defers ("leave it" and equivalents,
including bare "leave"), or the system hits a bounded round limit and offers a
concrete choice (proceed with stated defaults, or stop). The user is never
left in an infinite question loop and never sees a question re-asked after
they have ended the exchange.

**Why this priority**: Prevents the observed "stuck at Needs your input"
dead-end. Depends on P1 stories to be meaningful but bounds the damage
independently.

**Independent Test**: Run a build where every answer is unhelpful; assert the
turn count is bounded and a terminal state (complete / deferred / bounded
offer) is reached.

**Acceptance Scenarios**:

1. **Given** the user types "leave" while a clarification is pending, **When** the answer is interpreted, **Then** it is treated as a defer of that question and the build proceeds without re-asking it.
2. **Given** clarification rounds exceed the bound, **When** the bound is reached, **Then** the system stops asking and presents the outstanding items with proposed defaults for the user to accept or stop.
3. **Given** the user defers or accepts defaults, **When** the next turn starts, **Then** no previously deferred question re-opens in that build.

---

### Edge Cases

- User answers one of several open questions and ignores the rest → the answered one closes; the rest remain open and are re-presented **with their prior ask text**, not regenerated from scratch.
- User's answer is ambiguous or matches no open question → the system states which question it could not map the reply to and re-lists open questions compactly; it does not replay the full "So far" preamble as if nothing happened.
- User answers the same question twice differently → latest answer wins; earlier answer retained only as history.
- A round produces zero model calls (deferred/replayed path) → user-visible status must distinguish "answered without a new model call" from "stuck"; a turn that leaves questions open must still advance state or say why it could not.
- Goal text is edited mid-build → open questions are recomputed from the new goal, but stored answers remain and are re-matched, not discarded.
- Build resumed after restart/redeploy → durable state (per-flow, persisted) survives; no behaviour depends on in-memory-only data.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist every user answer for the lifetime of a build and carry the complete accumulated answer set into every subsequent round of that build (no round may start with an empty answer set when answers exist).
- **FR-002**: The system MUST deliver each answer to **all** reasoning steps that raised questions or objections in the build — both the goal-interpretation step and the build-planning/gap step — in the same turn.
- **FR-003**: Question identity MUST be stable across rounds: the same underlying unknown, once asked and answered, MUST NOT be re-asked unless the user edits the goal in a way that invalidates the answer.
- **FR-004**: Open items ("not settled yet" / gaps) presented to the user MUST be recomputed after each answer; an item resolved by a stored answer MUST be closed without consuming another user turn.
- **FR-005**: The clarification loop MUST be bounded by a maximum round count per build; on reaching the bound the system MUST stop asking and present open items with proposed defaults for accept-or-stop.
- **FR-006**: The system MUST recognise defer intents including "leave", "leave it", "skip", "keep it", and equivalent plain phrasings, and MUST treat a defer as closing the question for that build (proceeding with the current draft).
- **FR-007**: A reply that cannot be mapped to any open question MUST produce an explicit "could not match your reply to: [list]" response, not a regenerated copy of a previously answered question.
- **FR-008**: Turn status shown to the user MUST truthfully distinguish: answered with model work, answered without a new model call, and awaiting input — and MUST NOT display "awaiting input" for a question the user has already answered or deferred.
- **FR-009**: Each round MUST make monotonic progress: the set of open items after an answer must be a subset of, or strictly differ from, the set before it, unless the system states a specific reason the answer changed nothing.
- **FR-010**: All clarification state MUST be stored where it survives process restarts (it already lives with the persisted build record; this MUST remain true).

### Key Entities

- **Build conversation state**: per-build record holding the accumulated answer set (question → answer, with correction history), the currently pending question (if any), and the list of open/unsettled items with their reasons.
- **Open item**: a single named gap raised by a planning step — identity (stable key), the reason text shown to the user, and status (open / resolved-by-answer / deferred / defaulted).
- **Clarification round**: one user turn within a build's clarification exchange; has a bounded ordinal and an outcome (progressed, no-change-with-reason, deferred, bounded-stop).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a scripted 5-question build, zero questions are asked twice; 100% of answered questions stay closed through to build completion.
- **SC-002**: Given answers that resolve all open items, the build completes without any further user turns beyond those answers.
- **SC-003**: No clarification exchange exceeds the configured round bound; 100% of bound-reaching exchanges end with an explicit accept-or-stop prompt.
- **SC-004**: The transcript symptom "Your answer did not settle these" with a byte-identical item list after a relevant answer occurs 0% of the time in scripted tests.
- **SC-005**: A single ambiguous reply ("leave", a reply addressing only one of three questions) advances the exchange in 100% of cases — closing, deferring, or narrowing — never returning to a prior identical question.
- **SC-006**: Users in scripted sessions complete a two-recipient email workflow (pending orders → customer + fulfilment emails) in the first conversation, without repeating any answer.

## Assumptions

- Scope is the chat workflow builder's clarification/turn state machine and its prompts; UI layout, unrelated builder features, and non-chat flows are out of scope.
- The existing durable storage location for build state (persisted with the build record) remains the system of record; this feature changes what is written there and when, not where it lives.
- Round bound default is a small number (single digits) chosen in planning; the requirement is that a bound exists and is enforced, not its exact value.
- "Relevant answer" resolution is judged by the build planner's own gap criteria; the feature requires re-evaluation and monotonic progress reporting, not a guarantee that every user answer resolves every gap.
- Existing behaviour pinned by tests (one question surfaced per turn, truthful status labels) is preserved unless it contradicts FR-008.
