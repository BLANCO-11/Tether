# Azure Boards work items — Email delivery tool (`foundry_email_send`)

Two **User Story** work items covering feature `20260818-084135-email-send-tool`.
Source of truth: [spec.md](./spec.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md).

> **Status note.** All 51 tasks in `tasks.md` are complete and a real email was delivered
> (T043 — Graph correlation id `d450e6fc-b962-4093-881b-8cf7881d0690`). File these as
> **Closed/Done** with the evidence below if you are recording delivered work; file as **New**
> only if the board is being used to re-plan this from scratch.

---

## User Story 1 — Email the automation's output to the person who ran it

| Field | Value |
|---|---|
| **Work Item Type** | User Story |
| **Title** | Send a flow's generated output by email to the person who ran it |
| **Area Path** | `Foundry\Platform\Flows` |
| **Iteration Path** | *(set to your sprint)* |
| **Priority** | 1 |
| **Risk** | 2 - Medium |
| **Story Points** | 13 |
| **Tags** | `email`, `microsoft-graph`, `foundry_email_send`, `spec-kit`, `20260818-084135-email-send-tool` |
| **Value Area** | Business |

### Description

**As a** user who has authored an automation in Foundry,
**I want** the flow to email me the output its script produced, without anyone having to type my
address into the flow,
**So that** the result of an unattended run reaches me in my own mailbox instead of only existing
inside a run page.

Foundry's existing `mail_send` / `mail_send_template` tools are **simulated** — they write a row to
`mail_outbox` in ops-api and nothing leaves the building. This story adds the first tool that puts a
real message in a real inbox, via **Microsoft Graph `sendMail`** (app-only, client credentials),
exposed as an ordinary workspace tool ref (`foundry_email_send`) that the drafter composes as a
`tool` step downstream of the `code` step. No new step kind, no compiler change.

Because it is the first genuinely-delivering tool, it is defined by its refusals as much as its send
path: it must never return a success shape for a message that was not sent (the repo's recurring
false-green defect class — `llmConnected: true`, `faFallback`).

Covers spec.md **US1**, **US3**, **US4** and FR-001…FR-005, FR-008, FR-009, FR-010, FR-011,
FR-013, FR-014.

### Acceptance Criteria

1. **Given** a flow run started by a signed-in identity, **when** a `foundry_email_send` step runs
   with `subject` and `body` and **no** `to`, **then** the message is delivered to that identity's
   address and the step result returns `{status: "sent", message_id, recipients: [...],
   resolved_from: "requester"}`.
2. **Given** a successful send, **then** an `email_sends` row records workspace, flow execution,
   resolved recipients, subject, Graph correlation id and outcome — and **no column contains the
   message body** (it is the script's output and may carry tenant PII).
3. **Given** a run with no person behind it (`requestedByKind` of `trigger`/`system`/`schedule`/
   `unknown`), or a `user` run whose `requestedBy` is not a well-formed address, **when** the step
   runs with no `to`, **then** it fails `422` naming the run kind and the remedy ("name a recipient
   in `to`"). It never guesses and never lets Graph produce the failure instead.
4. **Given** incomplete Graph configuration, **when** the step runs, **then** it fails `424` naming
   **every** missing environment variable in one refusal; **given** `MAIL_ENABLED=false`, it fails
   `409` with a distinct "switched off for this deployment" message. Both are recorded as `refused`.
5. **Given** a `202` from Graph, **then** that alone is success — a `200`-with-body or any other
   status is **not** treated as success; a `429` is retried exactly once honouring `Retry-After`,
   then fails `502` carrying `{status, graphError, requestId}` and never the request body.
6. **Given** a completed run, **when** the run page is opened, **then** the real-delivery section of
   `ToolActivity` names the recipients and the outcome — a real send is never invisible on the
   surface that exists to answer "did it actually do anything?".
7. **Given** the deployment, **then** `GET /api/health` reports a `mail` component as `up` when
   configured and `down` with `missing[]` when not — a **config check, never a live probe** (no test
   message is sent to prove health).
8. **Given** the whole path, **then** the Graph client secret is read in exactly **one** module,
   pinned by a grep test that fails the suite on a second read site.

### Child Tasks

**Task 1 — Build the Microsoft Graph transport and its configuration block**
Add the `mail` config block (`tenantId`, `clientId`, `clientSecret`, `senderUpn`, `allowedDomains`,
`enabled`, caps, `selfBase`) with derived `configured`/`missing`, plus `services/mail.service.ts`:
client-credentials token exchange with `scope=https://graph.microsoft.com/.default`, a process-global
token cache with a safety margin, the `sendMail` call through `guardedFetch(…, STRICT)`, and
`{messageId, requestId}` read from the response headers. Tests first.
*Done when*: a `202` is the only success, `429` retries once honouring `Retry-After` then fails `502`
with `{status, graphError, requestId}` and never the request body, `424` names every missing variable
at once, `MAIL_ENABLED=false` gives a distinct `409`, and a grep test proves the Graph secret is read
in exactly one module. Zero real network calls in the suite.

**Task 2 — Ship `POST /api/mail/send` behind its own derived credential, with an audit row**
Derive `X-Foundry-Mail-Key` as an HMAC of `PARENT_API_KEY` and guard the route with
`requireMailKey` (timing-safe compare) — deliberately **not** `requireApiKey`, so the master
credential never lands in `workspace_secrets`. Add the `emailSends` table (migration 0039) and
`email-send.repo.ts`, then the strict-Zod route that takes workspace and requester off the
`flow_executions` row and ignores any body-supplied `workspaceId`.
*Done when*: the order of operations is config check → policy check → record-intent → send →
record-outcome; a failed audit insert surfaces rather than being swallowed; the response carries
`resolved_from`; and a test asserts the body string appears in no column of the row.

**Task 3 — Make a real send visible on the run page and the health surface**
Add `GET /api/workspaces/:ws/executions/:id/emails` (redacted through the existing pass), the client
`emailsForRun` call, a clearly labelled real-delivery section in `ToolActivity.tsx`, recipient and
`resolved_from` labels in `StepDetail.tsx`, and a `mail` component in `health.service.ts`.
*Done when*: a real send names its recipient and outcome on the run page — `ToolActivity` reads
`api_call_log` through ops-api and this endpoint writes no such row, so without this the send appears
nowhere — and health reports `up`/`down` + `missing[]` from a **config check, never a live probe**.

### Definition of Done

- `pnpm typecheck`, `pnpm -r test`, `pnpm kestra:check`, `demo:verify`, `scenarios:verify`,
  `scripts/ui-honesty-check.sh` green (every `demo:*`/`scenarios:*` needs `--filter @foundry/server`).
- One real email delivered from a test run, with the `email_sends` row and Graph correlation id
  recorded on the work item.
- `docs/kestra-migration/progress/DECISIONS.md` and the tool inventory updated (Article VII).

---

## User Story 2 — Bound and disambiguate who real email can reach

| Field | Value |
|---|---|
| **Work Item Type** | User Story |
| **Title** | Enforce a recipient allowlist and protect the platform email tool |
| **Area Path** | `Foundry\Platform\Flows` |
| **Iteration Path** | *(set to your sprint)* |
| **Priority** | 1 |
| **Risk** | 1 - High |
| **Story Points** | 8 |
| **Tags** | `email`, `security`, `allowlist`, `spec-kit`, `20260818-084135-email-send-tool` |
| **Value Area** | Architectural |

### Description

**As a** platform owner,
**I want** every address a flow tries to email checked against a deployment-wide and
workspace-level allowlist, and the real email tool clearly distinguishable from the simulated one
and impossible to delete or repoint,
**So that** an LLM composing a flow cannot become an exfiltration channel, cannot pick the wrong
sender by coin-flip, and cannot have its credential handed to a host somebody repointed the tool at.

"Requester only" would make the tool useless for the operational reports these flows exist to
produce; an unbounded `to` would make the drafter an exfiltration channel. The allowlist is the
whole design, so it ships **with** the send path, not after it — and the policy is a pure module
with no I/O, unit-testable without a database, express or Graph.

Covers spec.md **US2**, **US5** and FR-006, FR-007, FR-012, FR-013, plus tasks.md Phase 5/5b.

### Acceptance Criteria

1. **Given** `MAIL_ALLOWED_RECIPIENT_DOMAINS` is set, **when** a step names an in-domain address,
   **then** it is delivered and the audit row names it; **when** it names an out-of-domain address
   that is not the requester, **then** the call fails `422` naming **the rejected address and the
   rule** (a bare `false` is not an acceptable refusal shape) and nothing is sent.
2. **Given** a mixed list of allowed and rejected recipients, **then** the **whole call is refused**
   — there is no partial-send code path (FR-007).
3. **Given** a workspace with its own narrower `mailRecipientAllowlist`, **then** an address passing
   the global list but not the workspace list is refused. `null` = no narrowing, `[]` = requester
   only, entries are addresses or bare domains.
4. **Given** any refusal path, **then** **zero** transport calls are made — asserted by a counting
   seam on the Graph transport (SC-002), and the `email_sends` row reads `refused` with the address
   named.
5. **Given** caps on recipient count, subject length, subject newlines and body size, **then** each
   refusal names `actual` and `allowed`; body size is measured in **bytes**, not characters.
   Addresses are deduplicated case-insensitively; a malformed address refuses the whole call naming
   the offender.
6. **Given** a rendered workspace manifest, **then** `foundry_email_send`'s description opens with
   the real-delivery clause, both `mail_send` and `mail_send_template` open with
   `SIMULATED (demo mail service — nothing is delivered).`, and the real tool carries an `<auth>`
   element.
7. **Given** the tool is platform-managed, **then** `create` refuses the reserved name
   `foundry_email_send`, and `update`/`remove` refuse on a row carrying it, with a message naming
   `mail:register` as the way to restore it. The tools page shows a platform-managed badge with
   Edit/Remove suppressed, and `mail` is in the browser proxy's `DENIED_SEGMENTS`.
8. **Given** a newly created workspace, **then** the tool is registered **unconditionally** — even
   when Graph is unconfigured, so the user gets the `424` that names the fix rather than "unknown
   tool" and a wasted redraft cycle. Registration is idempotent, backfillable via `mail:register`,
   and re-renders the manifest.

### Child Tasks

**Task 1 — Write the recipient policy as a pure, database-free module**
`services/mail-recipients.ts`: a conservative `EMAIL_RE`, `resolveRecipients()` taking
`{explicitTo, explicitCc, requester, workspaceAllowlist, deploymentAllowlist, caps}` and returning a
discriminated union, the four caps (recipient count, subject length, subject newlines, body **bytes**),
and the nullable `workspaces.mailRecipientAllowlist` column. Tests written first, covering the full
allowlist matrix, all six `requestedByKind` values, the non-address requester, case-insensitive dedup
and the empty-allowlist ⇒ requester-only rule.
*Done when*: no I/O in the module; any rejected recipient refuses the whole call (no partial-send code
path exists to take later); every refusal names the rejected address and the rule, and every cap
refusal names `actual` and `allowed`. Provable with `vitest run` and no database.

**Task 2 — Register `foundry_email_send` in every workspace and disambiguate the simulated tools**
`platformToolCatalogue()` (separate from `demoToolCatalogue()` — this is a product capability, not demo
data) plus an idempotent `registerPlatformTools(workspaceId)` that upserts the tool and puts the derived
`FOUNDRY_MAIL_KEY` secret, called from `workspaceService.create`, from `demo/provision.ts` and from a
`mail:register` backfill script. Prefix the two demo tools' descriptions with
`SIMULATED (demo mail service — nothing is delivered).`
*Done when*: registration is unconditional — an unconfigured deployment still gets the tool so the `424`
names the fix instead of producing "unknown tool" — the manifest is re-rendered after registration and
bumps once, not per call, and a manifest test asserts the real-delivery clause, the two `SIMULATED`
clauses, the four params and the `<auth>` element.

**Task 3 — Guard the platform tool against deletion and repointing**
Add a reserved-name guard to `tool.service.ts` (`create` refuses the name; `update`/`remove` refuse on a
row carrying it, naming `mail:register` as the remedy), a platform-managed badge on the tools page with
Edit/Remove suppressed, and `mail` in the browser proxy's `DENIED_SEGMENTS`.
*Done when*: the tool cannot be deleted or repointed from either the UI or the API — the likely event is
accidental deletion breaking every armed flow, and a repointed endpoint would be handed `FOUNDRY_MAIL_KEY`
by the executor. A reserved **name** rather than an `isPlatform` column, so it stays greppable and out of
`refFingerprints`.

### Definition of Done

- `vitest run src/services/mail-recipients.test.ts` green — the policy is provable with no database.
- The reserved tool cannot be deleted or repointed from either the UI or the API.
- A fresh workspace and an existing one both list `foundry_email_send`; the manifest version bumped
  once, not per call.

---

## Suggested board hierarchy

```
Feature: Real email delivery for automations (foundry_email_send)
├── User Story 1 — Send a flow's generated output by email to the person who ran it   (13 pts)
│     ├── Task — Build the Microsoft Graph transport and its configuration block          (5 pts)
│     ├── Task — Ship POST /api/mail/send behind its own derived credential, with an audit row  (5 pts)
│     └── Task — Make a real send visible on the run page and the health surface         (3 pts)
└── User Story 2 — Enforce a recipient allowlist and protect the platform email tool      (8 pts)
      ├── Task — Write the recipient policy as a pure, database-free module               (3 pts)
      ├── Task — Register foundry_email_send in every workspace and disambiguate the simulated tools  (3 pts)
      └── Task — Guard the platform tool against deletion and repointing                  (2 pts)
```

**Dependency**: US2's policy task is written **before** US1's endpoint task wires it up, and US2's
registration task needs the derived key and mounted route from US1's endpoint task. Link them as
*Predecessor/Successor* rather than resequencing the board — the two stories are delivered together.
