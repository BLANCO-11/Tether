# Implementation Plan: Email delivery tool (`foundry_email_send`)

**Branch**: `20260818-084135-email-send-tool` | **Date**: 2026-08-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260818-084135-email-send-tool/spec.md`

## Summary

Give the drafter one new callable ref, `foundry_email_send`, that puts a real message in a real
mailbox through Microsoft Graph — so a generated flow can end with "…and email me the result".

The whole design turns on one constraint: **the recipient policy has to be enforced inside Foundry,
not by the mail provider.** Graph will happily deliver to whatever address is in the request body, so
if the registered tool pointed straight at `graph.microsoft.com` the model would own the destination
and there would be no allowlist to speak of. So the tool points at a **new Foundry-owned endpoint**
(`POST /api/mail/send`), which:

1. resolves the default recipient from the run's recorded requester — using the `x-foundry-run`
   header the tool executor **already sends** ([step-execution.service.ts:340-360](../../packages/server/src/services/step-execution.service.ts#L340-L360)), so the destination comes from a
   header Foundry sets and the flow cannot;
2. checks every model-named address against a two-layer allowlist;
3. calls Graph app-only with credentials read from `.env` in exactly one place;
4. records the attempt without the body.

Nothing in the compiler, the step-kind vocabulary, or `invokeTool` changes. The tool is an ordinary
row in `tools` with a URL and an auth style, which is what keeps this feature small.

**Shape of the change**: **37 files** — 17 new (3 of them generated migration artefacts), 20 edited
— across 1 migration, 1 new route, 4 new services, 1 platform-tool registration, 1 config block, and
the tests that prove the four refusals. The full inventory is in "Source Code" below.

## Technical Context

**Language/Version**: TypeScript 5, Node ≥ 22, ESM (`"type": "module"`)

**Primary Dependencies**: express, drizzle-orm, zod, `@foundry/shared` (`guardedFetch`, egress
profiles), `@foundry/redact`. **No new npm dependency** — Graph is two `fetch` calls; `nodemailer`
and `@azure/msal-node` are both avoided (see Decision 2).

**Storage**: PostgreSQL via drizzle. One new table (`email_sends`) and one new nullable column on
`workspaces` (`mail_recipient_allowlist`), in migration **0039** (0038 is the current head —
`packages/server/drizzle/meta/_journal.json`; `migrations-journal.test.ts` asserts the journal stays
consistent, so generate the migration with `pnpm db:generate`, never hand-write the SQL).

**Testing**: `vitest` (server package). New suites: `mail.service.test.ts`,
`mail-recipients.test.ts`, `routes/mail.test.ts`, plus a grep test in the style of
`revision-author.test.ts` asserting the Graph secret has exactly one read site.

**Target Platform**: Linux server (Foundry API container), reachable from itself over loopback.

**Project Type**: Web application (monorepo: `packages/server` API, `packages/client` Next.js UI).
Client work in this feature is display-only.

**Performance Goals**: One Graph token per process, cached to just short of expiry (mirroring
`oauth2TokenCache`). One `sendMail` call per param item; no fan-out.

**Constraints**: Graph secret in `.env` only (per clarification) — not Key Vault, not
`workspace_secrets`, not the manifest. Body never persisted or logged. Refusal before send, never
after.

**Scale/Scope**: 28 server files, 5 client files, 4 root/docs files. No client redesign — the client
work is one new fetch method and three display changes.

## Re-verified against the 2026-08-18 pull (`b887a43..c648e5f`, 8 commits)

The pull touched **no `packages/server/src` file and no migration**, so every server-side fact this
plan rests on was re-checked and still holds: `x-foundry-run` is sent at
`step-execution.service.ts:446`; `requestedBy` / `requestedByKind` are at `db/schema.ts:980`/`984`;
`tool.service.ts:145` still refuses a tool with no url; `tool-catalogue.test.ts:22` still asserts 15
tools; `DENIED_SEGMENTS`, `ComponentName` and `ToolActivity.tsx` are unchanged; the migration head is
still **0038**; and the five `MAIL_*` variables are still in `.env`.

Four things did change, and they are folded into the tasks that hit them:

| Change | Cost to this plan |
|---|---|
| `packages/client/vitest.config.ts` now **throws on Node < 22** (it was silently skipping 21 jsdom files). This machine is on v20.20.2. | `pnpm -r test` fails before any assertion. **T002 now upgrades Node first.** |
| `build` moved to `tsconfig.build.json`, which keeps `*.test.ts` out of `dist/` but still emits every non-test module. | T021's grep test must root its walk at `src/`, or `dist/services/mail.service.js` reads as a phantom second secret read site. |
| `tools/page.tsx` gained the prompt-boundary panel; Edit/Remove moved **388-389 → 412-413**, and `tools/page.test.tsx` now covers the page across ~35 cases. | Line refs corrected; T048 extends that test file rather than adding one. |
| `lib/api.ts` / `foundry-client.ts` gained `listPromptBoundaryWarnings`, which is the current model for a new read. | T037 follows that layering; the client file count goes 5 → 7. |

⚠ **`docs/programmes/`, `docs/intent/` and `docs/ui-mock/` are now gitignored and deleted from the
tree.** T045's targets — `docs/kestra-migration/progress/{DECISIONS,00-STATUS}.md` — are explicitly
**still tracked** (that `.gitignore` section says so and names the cost of ignoring `docs/`
wholesale), so the docs task is unaffected.

## Constitution Check

- **I. Spec-First** — PASS with a caveat: this directory exists before any source edit. **The
  current branch is `v1-alpha-email-tool-integration`, which is not a timestamp branch and will fail
  `ci/spec-policy.sh`.** Resolve before the first source write: either rename to
  `20260818-084135-email-send-tool`, or branch from it and record the exemption. Do not start
  implementation on the current branch name.
  ⚠ **And `specs/` is gitignored (`.gitignore:125`), which the two gates disagree about.**
  `.githooks/pre-commit` finds the feature dir on the **filesystem**, so local commits pass;
  `ci/check-spec-compliance.sh:61` resolves it from the **git diff** and fails a PR that changes
  source while touching nothing under `specs/`. An ignored directory never appears in a diff, so the
  merge gate refuses. This is a repo-level contradiction, not something this feature can code around
  — see T001 for the two ways out.
- **II. Test-First** — PASS: each of the four refusals (no requester, not allowlisted, unconfigured,
  over cap) is written as a test before its branch exists. SC-002's "zero Graph calls" assertion
  needs the transport behind an injectable seam, so that seam is part of the first task, not a
  retrofit.
- **III. Code Review** — deferred to PR; `/speckit-comply` before review.
- **IV. Simplicity** — PASS. No new dependency, no new step kind, no builtin-tool concept (Decision
  1 rejects three heavier alternatives). The one genuine addition is the audit table, justified by
  FR-009 and Article V.
- **V. Observability** — PASS: every refusal names the input, the rule, and the remedy; every
  attempt is recorded. The body is the single deliberate omission and the spec says why.
- **VI. Branch discipline** — **ACTION REQUIRED**, see Article I above.
- **VIII. Secrets Hygiene** — PASS by construction: `.env` holds the values, `.env.example` gets
  documented placeholders only, `config/index.ts` is the sole read site, SC-004's grep test enforces
  it, and the pre-push/CI secret scanners cover the rest. **The Graph secret must not be seeded into
  `workspace_secrets`** — see Decision 4.

## Project Structure

### Documentation (this feature)

```text
specs/20260818-084135-email-send-tool/
├── spec.md                     # what and why (done)
├── plan.md                     # this file
├── contracts/
│   └── mail-send.md            # the endpoint + tool param contract (done)
└── tasks.md                    # 48 tasks in 8 phases (done)
```

### Source Code — complete file inventory

Every path below was checked to exist (or, for new files, to not already exist) on 2026-08-18. Task
IDs refer to [tasks.md](./tasks.md).

#### New — server (17 files)

⚠ **Was 14 when this plan was written; three were added during implementation** and are marked as
such below. The generated-migration and edited tables that follow are unchanged.

| File | Purpose | Task |
|---|---|---|
| `packages/server/src/services/mail-recipients.ts` | `EMAIL_RE`, `resolveRecipients()`, the caps. Pure — no I/O. **This is where the feature's security lives.** | T003, T006, T007 |
| `packages/server/src/services/mail-recipients.test.ts` | Allowlist matrix + all six requester kinds. | T004, T005 |
| `packages/server/src/services/mail.service.ts` | Graph token + `sendMail`. The **only** reader of the client secret. | T016–T020 |
| `packages/server/src/services/mail.service.test.ts` | Config refusals, `202`-only success, one bounded `429` retry. | T015 |
| `packages/server/src/services/mail-service-key.ts` | `HMAC(PARENT_API_KEY, "foundry-mail:v1")` — the endpoint's own credential. | T022 |
| `packages/server/src/services/mail-secret-single-reader.test.ts` | Grep test: one read site for the secret (SC-004). | T021 |
| `packages/server/src/services/platform-tool-catalogue.ts` | The `foundry_email_send` spec + `registerPlatformTools()`. | T030, T031 |
| `packages/server/src/services/platform-tool-names.ts` | **Added during implementation.** The reserved-name constants. A module of its own because `tool.service.ts` must refuse the names while `platform-tool-catalogue.ts` registers them, and the catalogue imports the service — so the service cannot import the catalogue back. | T046 |
| `packages/server/src/services/platform-tool-cli.ts` | **Added during implementation.** The `mail:register` backfill. NOT folded into `demo/cli.ts` as T033 suggested — this is a platform capability, and putting its backfill behind the demo CLI is the category error Decision 6 rejects. | T033 |
| `packages/server/src/services/mail-end-to-end.test.ts` | **Added during implementation.** Drives the real `stepExecutionService.tool` against the real mounted route over real HTTP, transport stubbed. The only place that proves `invokeTool` sends `x-foundry-run` and that `applyAuth` presents the derived key. | T041, T042 |
| `packages/server/src/services/platform-tool-catalogue.test.ts` | Tool appears in a rendered manifest, with `<auth>` and its params. | T035 |
| `packages/server/src/services/tool-reserved-name.test.ts` | The reserved-name guard (see the `tool.service.ts` row below). | T047 |
| `packages/server/src/middleware/mail-key.middleware.ts` | `requireMailKey`, timing-safe. **Not** `requireApiKey`. | T023 |
| `packages/server/src/routes/mail.ts` | `POST /api/mail/send`. | T025–T027, T029 |
| `packages/server/src/routes/mail.test.ts` | `401`/`400`/`422`, body-`workspaceId`-ignored. | T024 |
| `packages/server/src/repositories/email-send.repo.ts` | `record()`, `listByExecution()`. | T013 |
| `packages/server/src/repositories/email-send.repo.test.ts` | A row per outcome; **no body in any column**. | T014 |

#### New — generated, never hand-written (3 files)

`packages/server/drizzle/0039_<name>.sql`, `drizzle/meta/0039_snapshot.json`, and the appended entry
in `drizzle/meta/_journal.json` — all three from `pnpm db:generate` (T012).
`db/migrations-journal.test.ts` compares files ↔ journal entries **in both directions**, because
`0031` once shipped with a file and no entry and therefore never ran anywhere.

#### Edited — server (11 files)

| File | Change | Task |
|---|---|---|
| `packages/server/src/config/index.ts` | The `mail` block with `configured` / `missing`. | T008 |
| `packages/server/src/db/schema.ts` | `emailSends` table (+ CHECK on `outcome`, index on `flow_execution_id`) and `workspaces.mailRecipientAllowlist`. | T010, T011 |
| `packages/server/src/app.ts` | `app.use("/api/mail", requireMailKey, mailRouter)` — at its **exact path**; read the warning at `app.ts:88-94` first. | T028 |
| `packages/server/src/services/tool.service.ts` | Reserved-name guard: `create`/`update`/`remove` refuse `foundry_email_send`. Without it the tools page (Edit + Remove on every row, `page.tsx:412-413`) can delete the platform tool or repoint its URL at a host that would then receive `FOUNDRY_MAIL_KEY`. | T046 |
| `packages/server/src/services/workspace.service.ts` | Call `registerPlatformTools` in `create`, after the row exists. | T032 |
| `packages/server/src/routes/flow-executions.ts` | `GET /:execId/emails` for the run page. A sub-route on the existing router, not a new one. | T037 |
| `packages/server/src/services/health.service.ts` | Add `mail` to `ComponentName`; **config check, not a live probe.** | T040 |
| `packages/server/src/demo/tool-catalogue.ts` | `SIMULATED (…)` prefix on `mail_send` + `mail_send_template`. | T034 |
| `packages/server/src/demo/tool-catalogue.test.ts` | Assert the new prefixes. ⚠ Its `it("registers 15 tools")` must stay 15 — the platform tool is a **separate** catalogue and must not be counted here. | T034 |
| `packages/server/src/demo/provision.ts` | Call `registerPlatformTools` so a reseed does not drop the tool. | T033 |
| `packages/server/package.json` | `mail:register` backfill script. | T033 |

#### Edited — client (7 files)

| File | Change | Task |
|---|---|---|
| `packages/client/src/lib/foundry-client.ts` | `emailsForRun(wsId, execId)` + the `FAEmailSend` type, beside the existing flow-execution methods. | T037 |
| `packages/client/src/lib/api.ts` | Re-export the type and hold any workspace resolution — the layering `listPromptBoundaryWarnings` (`api.ts:575-583`) demonstrates. | T037 |
| `packages/client/src/components/flow/ToolActivity.tsx` | A labelled real-delivery section. **Read its docblock first** — it fetches `foundryApi.demoCallsForRun`, i.e. `api_call_log` *through ops-api*, so without this a real send is invisible on the run page. | T038 |
| `packages/client/src/components/flow/StepDetail.tsx` | Label `recipients` / `resolved_from` (it already parses `{results[]}`, so this may be labels only). | T039 |
| `packages/client/src/app/(app)/tools/page.tsx` | Platform-managed badge; suppress Edit/Remove (lines 412-413) for the reserved name so the UI matches the server's refusal. | T046 |
| `packages/client/src/app/(app)/tools/page.test.tsx` | Extend — it renders this page across ~35 cases. Do not add a second file. | T048 |
| `packages/client/src/app/api/foundry/[...path]/route.ts` | Add `mail` to `DENIED_SEGMENTS`. Defence in depth, not a fix: that proxy is a **deny** list that forwards everything else with `PARENT_API_KEY`, so `/api/foundry/mail/send` would be browser-reachable — it already fails closed because the route wants `X-Foundry-Mail-Key`, not the parent key. Denying it states the intent where the other two non-browser surfaces are stated. | T048 |

#### Edited — repo root and docs (4 files)

| File | Change | Task |
|---|---|---|
| `.env.example` | Documented placeholders (names only) + the two Azure operator steps + the deliberate `.env`-not-Key-Vault note. | T009 |
| `CLAUDE.md` | Line ~1656 asserts *"All 15 tools authenticate"*. Still true of the demo catalogue, ambiguous once a 16th tool sits in the workspace — qualify it and name the platform tool. | T045 |
| `docs/kestra-migration/progress/DECISIONS.md` | The seven decisions in this plan. | T045 |
| `docs/kestra-migration/progress/00-STATUS.md` | Tool inventory / capability line. | T045 |

#### Deliberately NOT changed — and why

Worth stating, because each is a file a reader would expect to see here:

| File | Why it stays untouched |
|---|---|
| `services/step-execution.service.ts` | The whole point of Decision 1. `foundry_email_send` is an ordinary HTTP tool; `invokeTool` already sends `x-foundry-run` and already dials loopback under `PERMISSIVE`. |
| `services/flow-compiler.service.ts` | No new step kind. Its docblock lists the six places a kind must be written down; a tool ref costs none of them. |
| `services/flow-validator.service.ts`, `flow-expression.service.ts` | A normal ref validates and expresses like any other. |
| `packages/ops-api/**` | That service is the *simulated* SaaS. Real outbound mail does not belong in it, and it cannot see the requester. |
| `packages/mcp-bridge/**` | Exposes its own four fixed schema-drill tools, not workspace tools. |
| `packages/shared/src/egress/**` | `STRICT` and `guardedFetch` already exist; T016 just calls them. |
| `infra/docker-compose.yml` | `env_file: ../.env` already forwards every `MAIL_*`, and `MAIL_SELF_BASE`'s default (`http://localhost:4000`) resolves both inside the server container and from a host-run harness. |
| `services/health.service.ts::expectedMigrations()` | Reads `_journal.json` at runtime — no hand-maintained migration list. (But an unapplied 0039 *will* show as unhealthy, so T012's `db:migrate` is not optional.) |

**Structure Decision**: The send path lives in `packages/server` because it needs the Foundry
database (`flow_executions` for the requester, the workspace allowlist) and the identity record.
It deliberately does **not** live in `packages/ops-api`: that service is the *simulated* SaaS whose
whole purpose is that nothing it does escapes the deployment, and it cannot see the requester.

## Key Decisions

### Decision 1 — The tool is a real HTTP endpoint Foundry owns, not a "builtin" tool

`tool.service.ts`'s `superRefine` says *"Every tool is a real HTTP endpoint"*, and the file carries a
long docblock on why `isDummy` tools were deleted rather than kept. Three alternatives were
considered and rejected:

| Alternative | Rejected because |
|---|---|
| A new `builtin` column on `tools` dispatched inside `invokeTool` | Re-opens the invariant the dummy-tool deletion closed, needs `url`/`method` to become optional, and touches `refFingerprints`, `refInterfaces`, the tools UI and the validator — for no capability the endpoint does not already give. |
| A new `notify` step kind | The compiler's own docblock lists **six** places a kind must be written down, and the user chose a tool ref. A kind also cannot be enabled per workspace. |
| Register the tool straight against `graph.microsoft.com` with `authStyle: oauth2_client_credentials` | Tempting — the OAuth2 style already exists. But (a) the recipient policy becomes unenforceable, which is the feature's main requirement, and (b) `resolveOAuth2Bearer` sends no `scope` parameter, and Graph's client-credentials grant **requires** `scope=…/.default`, so it would not authenticate anyway without widening the tool schema for every tool. |

So: a normal `tools` row whose `url` is `${config.mail.selfBase}/api/mail/send`, `method: POST`.
`invokeTool` needs **no change at all**, and loopback is already permitted — the tool path dials with
the `PERMISSIVE` egress profile ([step-execution.service.ts:479-492](../../packages/server/src/services/step-execution.service.ts#L479-L492)).

### Decision 2 — Graph over raw `fetch`, two calls, no SDK

`POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
`grant_type=client_credentials&scope=https://graph.microsoft.com/.default`, then
`POST https://graph.microsoft.com/v1.0/users/{senderUpn}/sendMail` with the message JSON. Graph
returns `202 Accepted` with an empty body on success — so **`202` with no body is the success
signal**, and the correlation id comes from the `request-id`/`client-request-id` response headers.
`@azure/msal-node` buys nothing here and `nodemailer` is the wrong transport for the chosen answer.

Token caching mirrors `oauth2TokenCache` in `step-execution.service.ts` (expiry minus a safety
margin, capped) rather than inventing a second caching idiom. It is a *separate* cache: that one is
keyed by workspace + tool and reads `workspace_secrets`; this one is process-global and reads config.

### Decision 3 — The requester default is read off the execution row, and validated as an address before it is used as one

`invokeTool` already sends `x-foundry-run: <flowExecutionId>` to whatever endpoint the tool names.
`/api/mail/send` reads it and loads the execution.

**Read `flow_executions.requestedBy` / `requestedByKind` directly — do NOT join
`flow_run_requests`.** Those three columns ([db/schema.ts:968-984](../../packages/server/src/db/schema.ts#L968-L984)) are copied onto the execution row at
`begin`, and their docblock is explicit about why: *"Copied onto the row at `begin`, never read
through the pointer later. Deriving it from `flow_run_requests` at read time would let a deleted
request row rewrite the history of a run that already happened."* Emailing is a read of run history
and gets the same rule. `step-approval.service.ts:374-380` already selects exactly these three for
the self-decision gate — copy that shape.

⚠ `requestedBy` holds what `requesterOf` put there: `user.email ?? user.subject` for a person, and
the literal `"system"` / `"trigger:<name>"` otherwise. It is documented as *"for display … never
used to decide identity"*. Using it as a **destination** is adjacent to that prohibition, so the
rule is explicit and tested:

- use it only when `requestedByKind` is `user` or `replay`, **and**
- only when it matches the address regex, **else refuse** (FR-005 / User Story 3).

That keeps the honest failure — "this run has no person, name a recipient" — instead of trying to
email the literal string `system`, or the Entra OID of a session whose token carried no email. If a
later feature wants a stronger link, the follow-up is a dedicated `requester_email` column, not a
loosening of this check.

### Decision 4 — Config in one block, `.env` only

```
MAIL_GRAPH_TENANT_ID=
MAIL_GRAPH_CLIENT_ID=
MAIL_GRAPH_CLIENT_SECRET_VALUE=         # ⚠ _VALUE suffix — matches AZURE_VAULT_CLIENT_SECRET_VALUE
MAIL_SENDER_UPN=                        # the mailbox messages are sent from
MAIL_ALLOWED_RECIPIENT_DOMAINS=         # comma-separated; the outer bound
MAIL_ENABLED=                           # optional kill switch; only "false" disables
MAIL_MAX_BODY_BYTES=262144
MAIL_MAX_RECIPIENTS=10
MAIL_SELF_BASE=http://localhost:4000
```

**These are the names already present in the deployment's `.env` as of 2026-08-18** — the secret is
`MAIL_GRAPH_CLIENT_SECRET_VALUE`, following the existing `AZURE_VAULT_CLIENT_SECRET_VALUE`
convention in that file. Do not rename it to `MAIL_GRAPH_CLIENT_SECRET` for tidiness; the operator's
file is the source of truth and a silent rename presents as an unconfigured deployment.

⚠ **`MAIL_ENABLED` defaults to enabled-when-configured, not to off.** The first draft of this plan
said off-by-default; that is wrong here, because the five variables above are already set and an
absent `MAIL_ENABLED` would make a fully-configured deployment refuse every send with a message
about a variable nobody was told to add. The rule is: **only the literal string `false` disables**;
absent means "on if configured". The kill switch survives, and the unconfigured case still refuses
with `424` — so there is no false green either way.

Read once in `config/index.ts` (mirroring `datasourceHostAllowlist`'s parse-and-freeze shape) and
exposed as `config.mail`. Deliberately **`MAIL_*`-prefixed and distinct from the existing
`MAIL_API_KEY`**, which is the *simulated* mail service's workspace-secret name — a collision there
would trip `shadowedSecretCollisions` and fail the step with a confusing 409.

`config.mail.configured` is a derived boolean plus a `missing: string[]`, so FR-008 can name every
missing variable in one refusal instead of one per attempt.

**Not Key Vault** — the clarification says `.env` for now. Recorded as the one deliberate deviation
from `FOUNDRY_SECRET_SOURCE`/`AZURE_VAULT_*`, with a note in `.env.example` that production should
move it.

### Decision 5 — The endpoint's own derived credential

`/api/mail/send` is mounted behind a dedicated gate, not `requireApiKey`: a tool call that carried
`PARENT_API_KEY` would mean the master credential sits in `workspace_secrets` and travels on every
email step. Instead, derive one like `opsServiceKey` already does:

```ts
mailServiceKey = HMAC_SHA256(PARENT_API_KEY, "foundry-mail:v1").hex.slice(0, 40)
```

seeded into `workspace_secrets` under **`FOUNDRY_MAIL_KEY`**, presented by the tool as
`authStyle: "header"`, `authParamName: "X-Foundry-Mail-Key"`, and compared timing-safely in
`mail-key.middleware.ts`. Same pattern, same reasoning, no new key material to distribute.

The workspace is taken from the resolved execution, never from the body or a header (FR-010) — the
key authenticates *"the executor called me"*, and the execution row establishes *whose run it is*.

### Decision 6 — A platform-tool catalogue, separate from the demo catalogue

`demoToolCatalogue()` is demo data seeded by `demo:seed`. `foundry_email_send` must exist in real
tenant workspaces, so it goes in a new `platform-tool-catalogue.ts` applied by
`workspace.service.ts` on create **and** by an idempotent backfill (`pnpm mail:register`, or folded
into the existing provision paths) for the workspaces that already exist. Registration is
unconditional even when Graph is unconfigured — an absent tool produces *"unknown tool"* and a
wasted redraft cycle, where a present-but-unconfigured tool produces the `424` that names the fix
(User Story 4, scenario 2).

### Decision 7 — Two tools that send mail must not read alike

The manifest will list `mail_send` (simulated) and `foundry_email_send` (real). Both descriptions get
a leading clause — `SIMULATED (demo mail service, nothing is delivered)` and
`REAL DELIVERY to a live mailbox` — so the drafter's choice is made on stated fact. This is a
two-string edit and is the cheapest defence available against the wrong tool being picked.

## Workstreams

Ordered so each lands testable on its own. Tasks come from `/speckit-tasks`; this is the shape they
should follow.

**W1 — Recipient policy, pure and first.** `services/mail-recipients.ts`: given
`{explicitTo, explicitCc, requester, workspaceAllowlist, deploymentAllowlist, caps}` return either a
resolved recipient set or a typed refusal. No I/O, no Graph, no express. Every Story-2/3 acceptance
scenario and every edge case (dedup, malformed, count cap, mixed list) is a unit test here. This is
where the feature's security lives, so it is the part with no dependencies.

**W2 — Config + schema.** `config.mail` with `configured`/`missing`; `email_sends` table and the
`workspaces.mail_recipient_allowlist` column; migration 0039 via `pnpm db:generate`;
`email-send.repo.ts`. `.env.example` placeholders documented in the file's existing prose style.

**W3 — Graph transport.** `services/mail.service.ts`: token fetch + cache, `sendMail`, the `202`
success rule, header correlation ids, one bounded `429` retry honouring `Retry-After`, and a
`sendRaw` seam so tests can assert zero calls (SC-002). The **only** module that reads
`config.mail.graph*`; SC-004's grep test pins that.

**W4 — Route + gate.** `middleware/mail-key.middleware.ts`, `routes/mail.ts`, mount in `app.ts` at
its exact path (`app.use("/api/mail", requireMailKey, mailRouter)` — never `app.use("/api", …)`,
per the warning already in `app.ts`). Zod body schema, execution resolution from `x-foundry-run`,
W1 for policy, W3 for send, W2 for the record. Refusal statuses: `422` policy, `424` unconfigured,
`502` Graph failure, `409` disabled.

**W5 — Registration + manifest.** `platform-tool-catalogue.ts`, hook into workspace create and the
provision/backfill paths, seed `FOUNDRY_MAIL_KEY`, re-render the manifest, and edit the two demo
descriptions (Decision 7). Assert the tool appears in a rendered manifest with its params and its
`REAL DELIVERY` clause.

**W6 — Run-page visibility + docs.** Show resolved recipients and outcome so "who got this email?"
is answerable in the UI (Story 1, scenario 3).

⚠ **This is not free, and the reason matters.** `ToolActivity.tsx` — the run page's *"the run went
green, but did it do anything?"* surface — reads `api_call_log` **through ops-api**, scoped by the
`x-foundry-run` header. Our endpoint is a Foundry route, so it writes no `api_call_log` row and a
real email send would appear **nowhere** on that panel. The component's own docblock says it exists
because of "a script that emailed 0 of 11 people and reported `clean`" — shipping a *real* sender
that is invisible on exactly that panel would reintroduce that failure with a live blast radius. So
W6 reads `email_sends` for the execution and renders it alongside tool activity, clearly labelled as
real delivery. The step result JSON (`recipients`, `resolved_from`) also flows through
`StepDetail.tsx` for free, but that is the detail view, not the evidence surface.

Update `docs/kestra-migration/` (the tool inventory and the progress/DECISIONS notes) in the same PR
(Article VII).

**W7 — Gates.** `pnpm -r test`, `pnpm typecheck`, `pnpm kestra:check`, `demo:verify`,
`scenarios:verify`, the secret scanners, `/speckit-comply`. Plus one manual end-to-end: a chat-authored
flow that emails the requester, run against the real Graph app registration.

## Testing Strategy

| Requirement | Proof |
|---|---|
| FR-004 / FR-005 | `mail-recipients.test.ts` over all five requester kinds + a non-address `actor`. |
| FR-006 / FR-007 | Allowlist matrix (global pass/fail × workspace narrow/absent × mixed list), each asserting the transport seam recorded **zero** calls. |
| FR-008 | Config table with each variable missing in turn; assert `424` and that every missing name appears in one message. |
| FR-009 | Repo test: a row per outcome; assert the body string appears in no column. |
| FR-010 | Route test: a body-supplied `workspaceId` is ignored; a wrong/absent mail key is `401`. |
| FR-011 / SC-004 | Grep test: the client-secret config path has exactly one read site; a second one fails the suite. |
| FR-013 | Cap refusals name actual and allowed values. |
| Story 1 end-to-end | Existing harness style (`kestra:phase*`/`scenarios:verify`) with the transport stubbed, plus one real manual send. |

## Risks

| Risk | Mitigation |
|---|---|
| `Mail.Send` app permission grants send-as-anyone in the tenant; admin consent is required and broad. | Scope it with an Exchange **application access policy** limiting the app to the single `MAIL_SENDER_UPN` mailbox. Note this in `.env.example` and the docs as an operator step, not an optional nicety. |
| Injected content from upstream steps reaching a human inbox with Foundry's return address. | Plain-text body only, single-line subject, no HTML in v1, and the flow still passes gate 2/3 approval before it can be armed. |
| The allowlist is set to `*` or left empty in a hurry, quietly widening the blast radius. | An **empty** `MAIL_ALLOWED_RECIPIENT_DOMAINS` means "requester only" (fail-closed), not "anything". No wildcard value is accepted. |
| Graph secret rotation breaks every armed flow at once. | The refusal names the variable; `config.mail.missing` and the health surface report unconfigured state before a run needs it. |
| Two mail tools confuse the drafter. | Decision 7, plus the generation prompt's existing "no unbidden notification" rule. |
| `.env`-only secret is weaker than the repo's Key Vault posture. | Accepted per clarification; recorded here and in `.env.example` as a deliberate, revisitable deviation. |

## Complexity Tracking

| Addition | Why needed | Simpler alternative rejected because |
|---|---|---|
| `email_sends` table | FR-009 / Article V — the only evidence a real message left the building. | `api_call_log` in ops-api never sees this call, and a log line is not queryable from the run page. |
| `workspaces.mail_recipient_allowlist` column | The chosen answer was "requester default **+ allowlist**", and a deployment-wide list cannot express a per-tenant narrowing. | Env-only was considered; it makes every workspace on a deployment share one recipient policy. Nullable, so the column costs nothing until used. |
| `platform-tool-catalogue.ts` | The tool must exist outside demo workspaces. | Adding it to `demoToolCatalogue()` would tie a real capability to `demo:seed`. |
