# Feature Specification: Clear test inbox

**Feature Branch**: `release/beta` (subagent: no branch switch — shared workspace; see Assumptions)

**Created**: 2026-09-14

**Status**: Draft

**Input**: User description: "Add a 'clear inbox' button to the test-mail inbox in the app, and deploy it working. The inbox in question holds TEST mails (used to verify flows like the HR attendance report email). Boring, minimal change: one button, one action (delete/clear all mails in the test inbox), with confirmation if that matches app conventions."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Clear the test inbox after verifying a flow (Priority: P1)

A person testing an automation (for example the HR attendance-screening flow, which
sends its verification emails through the simulated `test_email_send` / `mail_send`
tool) opens Resources → Email box, sees the leftover test emails from earlier runs,
and presses a "Clear test inbox" button. After confirming, the simulated list is
empty, so the next test run's emails can be read without older runs mixed in.

**Why this priority**: This is the whole feature — without it there is no way to
empty the test inbox from the product, and stale test emails make each new
verification run harder to read.

**Independent Test**: Seed two rows into the demo mail capture table, open the
Email box, press the button, confirm — the simulated list renders its read-and-empty
state ("Nothing has called test_email_send ... yet").

**Acceptance Scenarios**:

1. **Given** the simulated list shows test emails, **When** the person presses
   "Clear test inbox" and confirms, **Then** the simulated list is empty and the
   page says nothing has called the simulated tool yet.
2. **Given** the simulated list shows test emails, **When** the person presses the
   button and cancels the confirmation, **Then** nothing is deleted and the list
   is unchanged.
3. **Given** the demo mail service cannot be reached, **When** the person presses
   the button and confirms, **Then** the page reports the clear failed and does
   not present the list as empty.

---

### User Story 2 - Shared scope is stated, not discovered (Priority: P2)

The simulated capture table has no workspace column: clearing it removes every
workspace's test emails on the deployment. The confirmation says so, so nobody
learns this by deleting a colleague's verification emails.

**Why this priority**: The page already states the list is not workspace-scoped;
a delete button that stayed silent about the same fact would be the one
dishonest control on an otherwise honest page.

**Independent Test**: Open the confirmation and read it — it names the shared,
every-workspace scope.

**Acceptance Scenarios**:

1. **Given** the confirmation dialog is open, **When** the person reads it,
   **Then** it states the clear removes test emails from every workspace on the
   deployment and cannot be undone.

### Edge Cases

- The simulated table is already empty: the button still works and reports zero
  cleared (a clear of nothing is not an error).
- The parent cannot reach ops-api mid-clear: the failure renders as a failure
  (toast + list left as it was), never as an empty list.
- Real delivered mail is untouched: rows in the workspace-scoped send record
  (including delivered/refused/failed outcomes) are never deleted by this action.
- Chat messages, tickets, pages and the tool-call log are untouched: the clear
  targets the mail capture table only, unlike the harness-wide reset.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Email box page MUST offer a "Clear test inbox" action beside
  the simulated ("Test emails from the simulated tool") list.
- **FR-002**: The action MUST ask for confirmation naming the shared,
  every-workspace scope before deleting anything, following the app's `Confirm`
  modal convention for destructive actions.
- **FR-003**: Confirming MUST delete all rows in the demo mail capture table and
  refresh the list to its read-and-empty state.
- **FR-004**: Cancelling the confirmation MUST delete nothing.
- **FR-005**: The clear MUST NOT delete workspace-scoped send records, chat
  messages, tickets, pages, or tool-call log rows.
- **FR-006**: A clear that cannot be completed MUST surface as an error and MUST
  NOT render the list as empty.
- **FR-007**: The backend clear path MUST be scoped to the single mail capture
  table (allowlisted by name, mirroring the existing record-read allowlist), not
  a caller-supplied identifier or a truncate-all.

### Key Entities

- **Simulated test email**: a row in the demo mail service's capture table
  (`mail_outbox`), written by the simulated mail tool; carries sender,
  recipients, subject, body, status — and no workspace.
- **Clear result**: the count of deleted test emails, returned so the page can
  confirm what happened.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person with test emails in the inbox empties it with two clicks
  (clear, confirm) and sees the empty state within seconds.
- **SC-002**: After clearing, reading the capture table returns zero rows while
  every other capture table and the workspace send record are unchanged.
- **SC-003**: Cancelling the confirmation leaves every test email in place
  (zero rows deleted).

## Assumptions

- The "test inbox" is the **simulated** list (`test_email_send` / `mail_send` →
  ops-api `mail_outbox`), because that is the tool the HR attendance
  verification flow sends through. The workspace-scoped send record (which holds
  evidence that real mail left the building) is deliberately out of scope.
- Confirmation follows the `Confirm` modal convention (`components/ui/Confirm.tsx`,
  danger + explicit label), as used for workspace deletion — not `window.confirm`.
- Work is done on the shared `release/beta` checkout without switching branches
  and left uncommitted, per the assignment;normal branch/commit flow is the
  main agent's call.
- The existing harness-wide reset (truncate-all) is reused by nothing here: a
  button that also wiped chat/tickets/pages/call-log would be a broader action
  than its label promises.
