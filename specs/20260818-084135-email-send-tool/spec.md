# Feature Specification: Email delivery tool (`foundry_email_send`)

**Feature Branch**: `20260818-084135-email-send-tool` (current branch is `v1-alpha-email-tool-integration` — see plan.md Constitution Check)

**Created**: 2026-08-18

**Status**: Draft

**Input**: User description: "add an email tool so that it can be used by the llm to send the
generated output of the script in the email of the user"

**Clarifications taken before drafting** (2026-08-18):

| Question | Answer |
|---|---|
| Transport | **Microsoft Graph `sendMail`**, app-only (client credentials). All secrets in `.env` for now — no Key Vault in this feature. |
| Recipients | **Requester by default, plus an allowlist.** The LLM may name other addresses only if they pass the allowlist. |
| Integration point | **A workspace tool ref** the drafter composes as a `tool` step, downstream of the `code`/`script` step. No new step kind, no compiler change. |

---

## Why this is not "already done"

The workspace already exposes `mail_send` and `mail_send_template`. Those are **simulated**: they
are `ops-api` endpoints that insert a row into `mail_outbox` and return a synthetic `message_id`.
Nothing leaves the building. This feature adds the first tool in Foundry that puts a real message in
a real person's inbox — so it is defined by its **refusals** at least as much as by its send path.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A generated automation emails its script output to the person who ran it (Priority: P1)

A user describes a goal in chat ("pull the attendance rollup and email me the summary"). The drafter
composes a flow whose `code` step produces the output and whose next step is a `tool` step with
`ref: foundry_email_send`, passing the upstream output as the message body. The user approves and
test-runs the flow. A real email arrives in **their own** mailbox — the signed-in identity that
pressed "test run" — with the script output as the body. Neither the model nor the flow YAML had to
name an address for this to happen.

**Why this priority**: This is the requested capability in one sentence, and it is the only story
that must work for the feature to be worth shipping.

**Independent Test**: In a seeded workspace, arm a two-step flow (`code` → `foundry_email_send`) with
no `to` parameter, run it as a signed-in user, and confirm (a) the step returns
`{status: "sent", message_id, recipients: [<requester>]}`, (b) an audit row exists, (c) the mailbox
receives it.

**Acceptance Scenarios**:

1. **Given** a flow run started by a signed-in user, **When** a `foundry_email_send` step runs with
   `subject` and `body` and no `to`, **Then** the message is delivered to that user's email address
   and the step result names the resolved recipient.
2. **Given** the same step, **When** it succeeds, **Then** a row is recorded naming the workspace,
   the flow execution, the resolved recipients, the subject, the Graph message id and the outcome —
   and **not** the message body.
3. **Given** the step result, **When** it is rendered on the run page, **Then** the resolved
   recipient is visible so "who did this email?" is answerable without reading logs.

---

### User Story 2 — An automation emails a named colleague, only if the allowlist permits (Priority: P1)

A user asks for a flow that emails the finance rollup to `ap-team@<company>`. The drafter passes
`to: ["ap-team@<company>"]`. The address clears the allowlist, so it is delivered. A second flow that
names `someone@gmail.com` is refused at the step with a message the drafter can read and correct.

**Why this priority**: "Requester only" would make the tool useless for the operational reports
these flows exist to produce; an unbounded `to` would make the LLM an exfiltration channel. The
allowlist is the whole design, so it ships with the send path, not after it.

**Independent Test**: With `MAIL_ALLOWED_RECIPIENT_DOMAINS` set to one domain, run the step once with
an in-domain address (delivered) and once with an out-of-domain address (refused, nothing sent).

**Acceptance Scenarios**:

1. **Given** an address whose domain is on the allowlist, **When** the step runs, **Then** it is
   delivered and the audit row names it.
2. **Given** an address that is not on the allowlist and is not the requester, **When** the step
   runs, **Then** the step fails with `422` naming the rejected address and the allowlist rule, and
   **no message is sent to any recipient in that call** — including the allowed ones.
3. **Given** a mixed list of allowed and rejected addresses, **When** the step runs, **Then** the
   whole call is refused rather than partially delivered.
4. **Given** a workspace with its own narrower allowlist, **When** an address passes the global list
   but not the workspace list, **Then** it is refused.

---

### User Story 3 — The tool refuses, loudly, when it cannot know who to email (Priority: P1)

A scheduled run, a trigger fire or a harness run has no person behind it (`flow_run_requests.kind`
is `trigger`/`system`, or the run predates the record). A `foundry_email_send` step in such a run
with no explicit `to` has nobody to default to. It fails with a message that says exactly that and
tells the author to name a recipient.

**Why this priority**: The failure mode this prevents is silent — an unattended schedule that emails
nobody, or worse, that guesses. `actor` on a system run is the literal string `system`, and a
version of this feature that "just tried it" would produce a delivery failure at Graph instead of a
refusal at Foundry.

**Independent Test**: Fire the same flow from a schedule/trigger and confirm a `422` naming the
absent requester; add `to` with an allowlisted address and confirm it then sends.

**Acceptance Scenarios**:

1. **Given** a run with no person requester, **When** the step runs with no `to`, **Then** it fails
   with `422` and a message naming the run kind and the remedy ("name a recipient in `to`").
2. **Given** a tool test call made outside any run, **When** no `to` is given, **Then** the same
   refusal applies.
3. **Given** a person requester whose recorded `actor` is not a well-formed address, **Then** the
   same refusal applies — a display string is never used as a destination on the assumption it is
   an address.

---

### User Story 4 — Email is off by default and says so (Priority: P2)

On a deployment where the Graph app registration has not been configured, the tool is present but
disabled. Any call fails with a configuration message naming the missing environment variables. It
never falls back to the simulated `mail_send`, and it never returns a success shape for a message
that was not sent.

**Why this priority**: This repo's recurring defect class is the false green (`llmConnected: true`
from a probe that only lists models; `faFallback` returning fabricated rows). A mail tool that
reports `sent` without sending is that defect with a customer-visible blast radius.

**Independent Test**: Unset `GRAPH_CLIENT_SECRET`, run the step, confirm a `424` naming the variable
and that `GET /api/health` (or the workspace secrets audit) reports email as unconfigured.

**Acceptance Scenarios**:

1. **Given** incomplete Graph configuration, **When** the step runs, **Then** it fails with `424`
   naming every missing variable at once.
2. **Given** incomplete configuration, **When** the workspace is provisioned, **Then** the tool is
   still registered (so the refusal is reachable and nameable) but reports itself unconfigured.
3. **Given** `MAIL_ENABLED=false`, **When** the step runs, **Then** it fails with a message saying
   email delivery is switched off for this deployment.

---

### User Story 5 — The drafter can tell the real tool from the simulated one (Priority: P2)

The manifest presents both `mail_send` (simulated, `ops-api`) and `foundry_email_send` (real). Each
description states which it is in its first clause, so a drafter composing a demo flow does not
reach for the real sender and a drafter composing a real automation does not reach for the
simulation.

**Why this priority**: Two tools with near-identical names and purposes in one manifest is the
condition under which a drafter picks by coin-flip. This is cheap to prevent at registration time
and expensive to diagnose afterwards.

**Independent Test**: Render the manifest for a seeded workspace and assert both descriptions carry
their `REAL DELIVERY` / `SIMULATED` first clause.

**Acceptance Scenarios**:

1. **Given** a rendered manifest, **When** both tools appear, **Then** each description opens by
   stating real vs simulated delivery.
2. **Given** the generation prompt's existing "do not add a notification unless the goal names it"
   rule, **When** a goal does not mention email, **Then** the drafter does not add an email step.
   (Existing behaviour; asserted here because this feature raises its cost.)

---

### Edge Cases

- **Body size.** A script output larger than the configured cap is refused with the actual and
  allowed sizes named, not silently truncated. (Truncating a report and delivering it is a wrong
  answer wearing a success shape.)
- **Recipient count.** More than the configured maximum (default 10) is refused before any send.
- **Duplicate / malformed addresses.** Deduplicated case-insensitively; a malformed address refuses
  the whole call naming the offender.
- **Graph throttling (429) or transient 5xx.** Surfaces as a step failure with the Graph status and
  `request-id`; no automatic retry beyond one bounded retry on `429` honouring `Retry-After`.
- **Partial batch.** A `tool` step can carry several param items (`params[]`). Each item is one
  message; allowlist refusal in one item refuses that item, and the existing all-items-failed →
  step-failure rule applies unchanged.
- **Prompt injection reaching the body.** Upstream content can contain attacker text. The subject is
  single-line-clamped, so injected content cannot forge headers.

  ⚠ **AMENDED 2026-08-18 — the body is now sent as HTML, and the objection is answered differently.**
  This bullet read *"the body is sent as **plain text** … so injected content cannot render as HTML in
  the recipient's client"*, and that was the whole reason HTML was out of scope. It is amended rather
  than rewritten, because the risk it named has not gone away — only the control has.

  The body a flow passes is now **data, not the message**: `services/mail-report.ts` renders it into a
  report (see FR-014 below) and **escapes every value it interpolates**, so the only markup in the
  message is produced by that module's own string literals. `mail-report.test.ts` asserts a body
  carrying `<script>`, `<a href>` and `onerror=` arrives as visible text.

  ⚠ The rule that keeps this true: **a value is data, and data is escaped.** `mail.service.ts` still
  defaults to `Text`; `HTML` is opt-in and has exactly one legitimate producer. A caller passing
  markup straight through with `contentType: "HTML"` would defeat the control, and there is no such
  caller.
- **Secrets in the body.** The redaction pass that already exists for step output is applied to the
  audit record; the message body itself is never logged or stored.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A workspace MUST expose a tool named `foundry_email_send` that sends one plain-text
  email per param item via Microsoft Graph `sendMail`, app-only.
- **FR-002**: The tool MUST be registered as an ordinary workspace tool (name, description,
  `paramsSchema`, URL, method, auth), so it appears in the manifest, is fingerprinted, and is
  composable by the drafter as a `tool` step with no compiler or step-kind change.
- **FR-003**: Parameters MUST be `subject` (string, required), `body` (string, required),
  `to` (array, optional), `cc` (array, optional). No other parameters in v1.
- **FR-014** *(added 2026-08-18)*: The endpoint MUST render `body` into a formatted report before
  sending — tabular data as tables, prose as prose — rather than delivering the raw step output.
  Rendering MUST happen server-side, MUST escape every caller-supplied value, and MUST refuse (never
  truncate) a report that renders larger than the configured ceiling.
- **FR-004**: When `to` is absent or empty, the recipient MUST be resolved from the run's recorded
  requester (`flow_run_requests` via the executing `flow_executions` row) and MUST be used only when
  the requester kind is `user` or `replay` **and** the recorded actor is a well-formed address.
- **FR-005**: When the requester cannot be resolved under FR-004 and no `to` is given, the call MUST
  fail with `422` naming the run kind and the remedy. It MUST NOT send.
- **FR-006**: Every explicitly named recipient (`to`/`cc`) MUST pass the allowlist: a two-layer rule
  where the deployment-level domain list (`MAIL_ALLOWED_RECIPIENT_DOMAINS`) is the outer bound and a
  per-workspace list, when present, narrows it further. The resolved requester address is always
  permitted regardless of either list.
- **FR-007**: A call containing any rejected recipient MUST be refused in full — no partial send.
- **FR-008**: Sending MUST be refused with `424` when Graph configuration is incomplete, and with a
  distinct message when `MAIL_ENABLED=false`. Neither may return a success shape.
- **FR-009**: Every send attempt — delivered or refused — MUST be recorded with workspace, flow
  execution, resolved recipients, subject, outcome, Graph message/request id, and failure reason.
  The message **body** MUST NOT be persisted or logged.
- **FR-010**: The tool endpoint MUST authenticate the caller with a dedicated derived credential
  (its own env-var name in `workspace_secrets`), never the parent API key directly, and MUST derive
  workspace and run context from the execution the executor names — never from the request body.
- **FR-011**: Graph credentials MUST be read from environment configuration only, in one place, and
  MUST NOT be stored in `workspace_secrets`, rendered into the manifest, logged, or returned in any
  API response.
- **FR-012**: The tool's description MUST state that delivery is real, and the simulated `mail_send`
  description MUST state that it is simulated.
- **FR-013**: Body size, recipient count and subject length MUST be capped and each cap MUST be
  named in its refusal message.
- **FR-014**: The registration MUST be idempotent and MUST apply to non-demo workspaces (it is a
  platform tool, not a demo-catalogue entry).

### Key Entities

- **Email send record** — one row per attempt: workspace, flow execution (nullable), step id,
  resolved recipients, subject, outcome (`sent` | `refused` | `failed`), Graph message id, Graph
  request id, failure reason, created-at. No body.
- **Workspace recipient allowlist** — an optional per-workspace list of allowed addresses and/or
  domain suffixes that narrows the deployment allowlist.

## Success Criteria *(mandatory)*

- **SC-001**: A chat-authored flow that says "email me the result" runs end-to-end and delivers a
  real message to the requester's mailbox, with no address written into the flow.
- **SC-002**: No path exists by which a model-supplied address outside the allowlist receives mail —
  demonstrated by a test that asserts the refusal and asserts zero Graph calls were made.
- **SC-003**: With Graph unconfigured, every call refuses with a message naming the missing
  variables, and no call reports success.
- **SC-004**: The Graph client secret appears in exactly one module's read path and in no log line,
  response body, manifest render, or database row — asserted by a grep test in the style of
  `revision-author.test.ts`.
- **SC-005**: Existing gates stay green: server/client vitest suites, `kestra:check`,
  `scenarios:verify`, `demo:verify`, the secret scanners, and `/speckit-comply`.

## Out of Scope

- HTML bodies and templates. (Attachments were out of scope in v1 and are now supported: a text
  file a step built, or a `.csv`/`.xlsx` file the server generates from structured rows — see
  `contracts/mail-send.md` for the enforced rules.)
- Delegated send (on-behalf-of the signed-in user); v1 sends from one configured mailbox.
- Azure Key Vault sourcing for the Graph secret — deliberately deferred, per the clarification.
- Reply handling, inbound mail, threading, read receipts, bounce webhooks.
- A UI for editing the workspace allowlist (API only in v1).
- Replacing or removing the simulated `mail_send` tools.
