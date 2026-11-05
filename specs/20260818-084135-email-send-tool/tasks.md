# Tasks: Email delivery tool (`foundry_email_send`)

**Input**: Design documents from `/specs/20260818-084135-email-send-tool/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [contracts/mail-send.md](./contracts/mail-send.md)

**Tests**: Test-first per Article II. Each of the four refusals (no requester, not allowlisted,
unconfigured, over cap) gets its test **before** the branch that satisfies it exists. No new test
framework; server suites are `vitest` in `packages/server`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1..US5 from spec.md, or `INFRA` for foundational work

## Environment state (verified 2026-08-18)

Already present in `/foundry/.env` — **do not re-add, do not rename**:

```
MAIL_GRAPH_TENANT_ID  MAIL_GRAPH_CLIENT_ID  MAIL_GRAPH_CLIENT_SECRET_VALUE
MAIL_SENDER_UPN       MAIL_ALLOWED_RECIPIENT_DOMAINS
```

Not set, and correctly so — every one has a default: `MAIL_ENABLED` (absent = on when configured;
only the literal `false` disables), `MAIL_MAX_BODY_BYTES`, `MAIL_MAX_RECIPIENTS`, `MAIL_SELF_BASE`.

---

## Phase 0: Gate the branch (BLOCKING — do this first)

**Purpose**: The spec-gate hook, `.githooks/pre-commit` and `ci/spec-policy.sh` all key off the
branch name. Every task below writes source. On the current branch the first write is refused.

- [x] T001 [INFRA] Resolve the branch. Current branch is `v1-alpha-email-tool-integration`, which
  does not match the mandated `YYYYMMDD-HHMMSS-slug` regex (Constitution Article VI). Either
  `git branch -m 20260818-084135-email-send-tool`, or create that branch from the current one and
  continue there. Confirm with `bash ci/spec-policy.sh` (or attempt one write) that the gate passes
  **before** T002.
  ⚠ **`specs/` is gitignored (`.gitignore:125`), and the two gates disagree about that.**
  `.githooks/pre-commit` resolves the feature dir off the **filesystem**
  (`-d "$ROOT/specs/$BRANCH"`, else the newest), so local commits pass. But
  `ci/check-spec-compliance.sh:61` derives `FEATURE_DIRS` from the **git diff** and fails with
  *"PR changes source files but touches nothing under specs/"* when nothing there changed — and an
  ignored directory never appears in a diff, so **the PR gate refuses the merge**. Decide before
  writing code: `git add -f specs/20260818-084135-email-send-tool/` (which is effectively what the
  already-tracked spec dirs are), or move the durable reasoning into `docs/` as that `.gitignore`
  comment recommends. Not resolvable in code.
- [x] T002 [INFRA] **Node 22 first, then the baseline.** `.node-version` says `22`, both
  `package.json`s say `>=22`, and this machine is on **v20.20.2** — and since the 2026-08-18 pull
  `packages/client/vitest.config.ts` **throws at config load** on Node < 22 rather than silently
  skipping its 21 jsdom files. So `pnpm -r test` dies at the client package before a single
  assertion runs. `nvm use` (or install 22), confirm `node -v`, then take the baseline:
  `pnpm typecheck` and `pnpm -r test`. Record any pre-existing failure here so it is not later
  mistaken for this feature's doing.

**Checkpoint**: gate passes, baseline recorded. Source edits may begin.

---

## Phase 1: Recipient policy — pure, first, and where the security lives

**Purpose**: The allowlist and the requester default, with no I/O. Everything in this phase is unit
testable with no database, no express and no Graph, so it is written first and reviewed hardest.

**⚠ CRITICAL**: US2 and US3 are satisfied *here*. The route (Phase 4) only wires this up.

- [x] T003 [INFRA] Add `EMAIL_RE` to `packages/server/src/services/mail-recipients.ts`. The server
  has no address regex today (`ops-api/src/routes/ops.ts` has one; it is a different package and
  must not be imported — ops-api is the simulated service). Deliberately conservative: a single `@`,
  no whitespace, a dot in the domain. Export it so the tests assert the wording of what it rejects.
- [x] T004 [US2] [P] Write `packages/server/src/services/mail-recipients.test.ts` FIRST, covering
  the allowlist matrix from contracts §3: global pass/fail × workspace-narrowed/absent × mixed
  allowed-and-rejected list, requester-always-permitted, case-insensitive dedup, and the
  `MAIL_ALLOWED_RECIPIENT_DOMAINS`-empty ⇒ requester-only rule. Assert the refusal **names the
  rejected address and the rule** — a bare `false` return is not an acceptable shape.
- [x] T005 [US3] [P] Extend that test file with requester resolution over all six
  `requestedByKind` values (`user`, `replay`, `trigger`, `system`, `schedule`, `unknown`), plus a
  `user` run whose `requestedBy` is **not** an address (an Entra OID, or the literal `system`) —
  every non-`user`/`replay` case and the non-address case must refuse, never fall through.
- [x] T006 [US2] Implement `resolveRecipients()` in `mail-recipients.ts`: pure, takes
  `{explicitTo, explicitCc, requester, workspaceAllowlist, deploymentAllowlist, caps}` and returns a
  discriminated union — `{ok: true, to, cc, resolvedFrom}` or
  `{ok: false, status, message, detail}`. **Refuse the whole call if any recipient fails** (FR-007);
  there is no partial-send code path to accidentally take later.
- [x] T007 [US2] Implement the caps in the same module (recipient count, subject length, subject
  newline rejection, body byte length). Every cap refusal names `actual` and `allowed` (FR-013).
  Byte length, not `.length` — a UTF-8 report is not its character count.

**Checkpoint**: `vitest run src/services/mail-recipients.test.ts` green. The policy is provable
without a database.

---

## Phase 2: Config and storage

**Purpose**: One read site for the Graph secret; one place a send is recorded.

- [x] T008 [INFRA] Add the `mail` block to `packages/server/src/config/index.ts`, mirroring
  `datasourceHostAllowlist`'s parse-and-freeze shape: `tenantId`, `clientId`, `clientSecret`
  (`MAIL_GRAPH_CLIENT_SECRET_VALUE`), `senderUpn`, `allowedDomains: string[]`, `enabled`,
  `maxBodyBytes`, `maxRecipients`, `selfBase`. Expose derived `configured: boolean` and
  `missing: string[]` so FR-008 can name every absent variable in **one** refusal.
  `enabled` is `process.env.MAIL_ENABLED !== "false"` — absent means on (plan.md Decision 4).
- [x] T009 [INFRA] Add the documented placeholders to `.env.example` in that file's existing prose
  style: names only, no values, plus the two operator notes (admin consent for the `Mail.Send`
  **application** permission, and the Exchange application access policy scoping the app to
  `MAIL_SENDER_UPN`). State plainly that this is a deliberate `.env`-rather-than-Key-Vault deviation
  from `FOUNDRY_SECRET_SOURCE` and that production should move it.
- [x] T010 [INFRA] Add `emailSends` to `packages/server/src/db/schema.ts` per contracts §4, with a
  CHECK-constrained `outcome`, `workspaceId` FK cascade, nullable `flowExecutionId` FK, and an index
  on `(flow_execution_id)` — the run page reads by execution. Write the docblock stating **why there
  is no body column** (it is the script's output, may carry tenant PII, and the record answers
  "sent, to whom, did it work" without it).
- [x] T011 [INFRA] Add the nullable `mailRecipientAllowlist` (jsonb `string[]`) column to
  `workspaces` in the same file, with a docblock: `null` means "no narrowing", `[]` means "requester
  only", entries are addresses or bare domains.
- [x] T012 [INFRA] Generate migration **0039** with `pnpm db:generate` — **never hand-write the
  SQL**. `src/db/migrations-journal.test.ts` asserts files ↔ journal entries in **both** directions
  (`0031` once shipped with a file and no entry, so it never ran anywhere). Run `pnpm db:migrate`.
  ⚠ **Check the new entry's `when` in `_journal.json` exceeds every applied row's `created_at`.**
  Drizzle's watermark is `max(created_at)` and its test is `created_at < folderMillis`; a merge once
  rewrote an applied migration's `when`, which made `0033` re-run for ever with
  `relation "flow_chat_threads" already exists` — a rewritten timestamp that reads like a corrupt
  database. `0038`'s `when` is `1786800000000`, so 0039's must be above that.
- [x] T013 [INFRA] `packages/server/src/repositories/email-send.repo.ts`: `record(...)` and
  `listByExecution(workspaceId, flowExecutionId)`. Insert must be resilient in the same spirit as
  `recordStepRun` — but ⚠ **unlike** that one, a failed insert here is NOT swallowed: this row is the
  only evidence a real message left the building, so log loudly and let the error surface.
- [x] T014 [INFRA] [P] `email-send.repo.test.ts`: one row per outcome (`sent`/`refused`/`failed`),
  and an assertion that the body string appears in **no** column of the inserted row (FR-009).

**Checkpoint**: migration applied, `pnpm typecheck` green, repo tests green.

---

## Phase 3: Graph transport

**Purpose**: The only module that reads the Graph credential, behind a seam tests can count calls on.

- [x] T015 [US4] Write `packages/server/src/services/mail.service.test.ts` FIRST: unconfigured
  refusal names every missing variable at once (`424`); `MAIL_ENABLED=false` gives the distinct
  disabled message (`409`); a `202` from Graph is success; a `200`-with-body or any non-`202` is
  **not** treated as success; a `429` retries exactly once honouring `Retry-After` and then fails.
- [x] T016 [US1] Implement `services/mail.service.ts`:
  `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
  `grant_type=client_credentials` **and `scope=https://graph.microsoft.com/.default`** (Graph's
  client-credentials grant requires the scope — this is exactly why the existing
  `resolveOAuth2Bearer` could not be reused; see plan.md Decision 1), then
  `POST https://graph.microsoft.com/v1.0/users/{senderUpn}/sendMail`.
  Dial through `guardedFetch(url, init, STRICT)` from `@foundry/shared` — **STRICT, not PERMISSIVE**:
  both hosts are external, so this follows `ops-proxy.ts`'s posture, not the tool path's.
- [x] T017 [US1] Token cache: process-global `Map`, expiry minus a safety margin, capped TTL —
  mirroring `oauth2TokenCache` in `step-execution.service.ts` rather than inventing a second idiom.
  Export a `resetMailTokenCache()` test seam, as that file does.
- [x] T018 [US1] Message shape: `{message: {subject, body: {contentType: "Text", content},
  toRecipients, ccRecipients}, saveToSentItems: true}`. **`contentType: "Text"` is not a
  preference** — it is what stops injected upstream content rendering as HTML in a recipient's client
  (spec.md Edge Cases).
- [x] T019 [US1] Return `{messageId, requestId}` read from the `request-id` / `client-request-id`
  response headers, since Graph answers `202` with an **empty body** and there is no provider message
  id. Document that in the function's docblock so no reader assumes an RFC 5322 Message-ID.
- [x] T020 [US4] Failure mapping: token-exchange or `sendMail` failure → `502` carrying
  `{status, graphError, requestId}` and **never** the request body — copy the reasoning from
  `resolveOAuth2Bearer`'s detail-narrowing comment, which exists so a broken provider echo cannot
  leak a client secret into logs.
- [x] T021 [INFRA] [P] `mail-secret-single-reader.test.ts`: a grep test in the style of
  `revision-author.test.ts` asserting `config.mail.clientSecret` (and
  `MAIL_GRAPH_CLIENT_SECRET_VALUE`) is read in exactly one module. A second read site fails the
  suite (SC-004).
  ⚠ **Scope the walk to `src/`, exactly as that file does** (`const SRC = path.resolve(
  import.meta.dirname, "..")`). Since the 2026-08-18 pull `build` runs `tsconfig.build.json`, which
  keeps `*.test.ts` out of `dist/` but still emits every non-test module — so a walk rooted at the
  package would find `dist/services/mail.service.js` and report a phantom second read site on any
  machine that has run `pnpm build`. That tsconfig's docblock records the twin of this bug:
  grep-the-tree suites matching their own compiled copies.

**Checkpoint**: `mail.service.test.ts` green with zero real network calls.

---

## Phase 4: The endpoint

**Purpose**: Wire policy + transport + record behind a credential of its own.

- [x] T022 [INFRA] `services/mail-service-key.ts`: derive the key as
  `HMAC_SHA256(config.parentApiKey, "foundry-mail:v1").hex.slice(0, 40)`, byte-identically to how
  `opsServiceKey` derives its five. Nothing new to distribute, nothing committed, and rotation
  follows `PARENT_API_KEY`.
- [x] T023 [INFRA] `middleware/mail-key.middleware.ts`: `requireMailKey` compares the
  `X-Foundry-Mail-Key` header against T022's value with `crypto.timingSafeEqual` on equal-length
  buffers; absent or wrong ⇒ `401`. **Not `requireApiKey`** — a tool presenting `PARENT_API_KEY`
  would mean the master credential sits in `workspace_secrets` and rides along on every email step
  (plan.md Decision 5).
- [x] T024 [US3] Write `routes/mail.test.ts` FIRST: `401` without the key; `400` on unknown body
  fields; a body-supplied `workspaceId` is **ignored** (FR-010); no `x-foundry-run` and no `to` ⇒
  `422`; a `trigger`-kind run with no `to` ⇒ `422` naming the run kind and the remedy.
- [x] T025 [US1] Implement `routes/mail.ts` — `POST /api/mail/send`. Zod body schema, `.strict()` so
  unknown keys are rejected rather than dropped. Resolve the execution from `x-foundry-run`, then
  take `requestedBy` / `requestedByKind` **off the `flow_executions` row** — do not join
  `flow_run_requests` (plan.md Decision 3; copy the select shape from
  `step-approval.service.ts:374-380`). Workspace comes from that row too, never from the body.
- [x] T026 [US2] Order of operations, and it is load-bearing: **config check → policy check →
  record-intent → send → record-outcome.** No Graph call may happen before `resolveRecipients()`
  returns `ok`, and SC-002's test asserts zero transport calls on every refusal path.
- [x] T027 [US1] Response shape per contracts §2, including `resolved_from` (`requester` |
  `explicit`) so the destination is explainable on the run page without reading the flow.
- [x] T028 [INFRA] Mount in `app.ts`: `app.use("/api/mail", requireMailKey, mailRouter)` — at its
  **exact path**, never `app.use("/api", ...)`. The warning about that form is already written at
  `app.ts:88-94`; read it before mounting.
- [x] T029 [US4] [P] Route-level config refusals: `424` unconfigured (naming every missing
  variable), `409` when `MAIL_ENABLED=false`. Both recorded in `email_sends` as `refused`.

**Checkpoint**: `curl` the endpoint with the derived key and a fabricated `x-foundry-run`; confirm a
real message arrives, and that every refusal path returns its documented status.

---

## Phase 5: Registration — making it reachable by the drafter

**Purpose**: The tool exists in real workspaces, with its params and a description that cannot be
confused with the simulated one.

- [x] T030 [US1] `services/platform-tool-catalogue.ts`: export `platformToolCatalogue()` returning
  the single `foundry_email_send` spec from contracts §1 (`authStyle: "header"`,
  `authParamName: "X-Foundry-Mail-Key"`, `secretEnvName: "FOUNDRY_MAIL_KEY"`, `method: "POST"`,
  `url: ${config.mail.selfBase}/api/mail/send`). Separate from `demoToolCatalogue()` — that one is
  demo data seeded by `demo:seed`, and this capability is not demo data (plan.md Decision 6).
- [x] T031 [US1] `registerPlatformTools(workspaceId)`: idempotent upsert (create-or-update by name,
  the same shape `provision.ts:103-126` already uses) **plus** `workspaceSecretService.put` of
  `FOUNDRY_MAIL_KEY` with T022's derived value and a description saying it is derived from
  `PARENT_API_KEY`. ⚠ Verify the name does not collide with anything else in the workspace —
  `MAIL_API_KEY` (the *simulated* service's secret) already exists there, and a collision would trip
  `shadowedSecretCollisions` and fail the step with a confusing `409`.
- [x] T032 [US1] Call `registerPlatformTools` from `workspaceService.create` in
  `services/workspace.service.ts`, after the workspace row exists. Register **unconditionally**, even
  when Graph is unconfigured: an absent tool produces "unknown tool" and a wasted redraft cycle,
  where a present-but-unconfigured tool produces the `424` that names the fix (US4 scenario 2).
- [x] T033 [US1] Backfill for existing workspaces: a `mail:register` script in
  `packages/server/package.json` (`tsx src/services/platform-tool-catalogue.ts` with a small CLI, or
  fold into `demo/cli.ts`), idempotent, printing what it created vs updated. Also call it from
  `demo/provision.ts` so a reseed does not leave the tool behind.
- [x] T034 [US5] Edit `demo/tool-catalogue.ts`: prefix the `mail_send` and `mail_send_template`
  descriptions with `SIMULATED (demo mail service — nothing is delivered).` Two strings, and the
  cheapest defence available against the drafter picking the wrong sender.
- [x] T035 [US5] [P] `platform-tool-catalogue.test.ts`: render the manifest for a workspace via
  `manifestBuilderService` and assert (a) `foundry_email_send` appears with its four params, (b) its
  description opens with the real-delivery clause, (c) both simulated tools open with theirs, and
  (d) the tool carries an `<auth>` element (a registration with no credential would 401 silently).
- [x] T036 [US1] Re-render the manifest after registration (`manifestBuilderService.buildAndPersist`)
  wherever T031/T033 run, matching `provision.ts` step 6. A registered tool absent from the manifest
  is invisible to the drafter.

**Checkpoint**: a fresh workspace and an existing one both list `foundry_email_send`; the manifest
version bumped once, not per call.

---

## Phase 5b: Protect the registration

**Purpose**: The tools page offers **Edit** and **Remove** on every row
(`app/(app)/tools/page.tsx:412-413` — 388-389 before the 2026-08-18 pull), and `routes/tools.ts`
backs both with no exemptions. So the
platform tool can be deleted — breaking every armed flow that uses it — or repointed at another host,
which would then be handed `FOUNDRY_MAIL_KEY` by the executor.

⚠ This is not a *new* class of problem (any workspace admin can repoint any tool and read any
secret), which is why the answer is a cheap, greppable name guard and not a permissions redesign. The
likely event is accidental deletion, and that is worth refusing.

- [x] T046 [INFRA] Add a reserved-name guard to `services/tool.service.ts`: `create` refuses the name
  `foundry_email_send` (so a user cannot register their own tool under it), and `update`/`remove`
  refuse when the target row carries it. Refuse with a message that says it is platform-managed and
  names `mail:register` as the way to restore it. A reserved **name** rather than an `isPlatform`
  column, deliberately — a column would land in `refFingerprints`, `refInterfaces`, the tools UI and
  the update schema for no capability the name check does not already give (plan.md Decision 1's
  reasoning, applied a second time).
- [x] T047 [INFRA] [P] `services/tool-reserved-name.test.ts`: create/update/remove each refused,
  every other name unaffected, and the refusal message names the remedy.
- [x] T048 [INFRA] [P] Client: platform-managed badge on the `foundry_email_send` row in
  `app/(app)/tools/page.tsx` with Edit/Remove suppressed — they are at **lines 412-413** since the
  pull moved them — so the UI does not offer an action the API will refuse. ⚠ **Extend the existing
  `app/(app)/tools/page.test.tsx`**, which renders this page across ~35 cases; do not add a second
  file. Its fixtures use other tool names, so a suppression keyed on the reserved name leaves them
  green. **And** add `mail` to `DENIED_SEGMENTS` in
  `app/api/foundry/[...path]/route.ts`. That proxy is a **deny** list that forwards everything else
  with `PARENT_API_KEY`, so `/api/foundry/mail/send` is browser-reachable today; it already fails
  closed (the route wants `X-Foundry-Mail-Key`, and the parent key buys nothing there), so this
  states intent alongside the two other documented non-browser surfaces rather than fixing a hole.

**Checkpoint**: the platform tool cannot be deleted or repointed from the UI or the API.

---

## Phase 6: Evidence and visibility

**Purpose**: A real send must be visible on the surface that exists to answer "did it actually do
anything?" — or this feature reintroduces the exact failure that surface was built for.

- [x] T037 [US1] `GET /api/workspaces/:workspaceId/executions/:id/emails` (or extend the existing
  run-detail payload in `services/flow-visibility.service.ts`) returning `email_sends` rows for the
  execution, redacted through the existing pass. Recipients and outcome, never a body.
  Client side, follow the layering the pull's `listPromptBoundaryWarnings` demonstrates: the
  `FAEmailSend` type and the raw call in `lib/foundry-client.ts`, the type re-exported and any
  workspace resolution in `lib/api.ts` (`api.ts:575-583` is the model), `lib/types.ts` only if the
  UI needs its own shape. `ToolActivity.tsx` already calls `foundryApi.*` directly for
  `demoCallsForRun`, so a direct call there is consistent rather than a shortcut.
- [x] T038 [US1] Surface it in `packages/client/src/components/flow/ToolActivity.tsx` as a clearly
  labelled real-delivery section. ⚠ **Read that file's docblock first.** It reads `api_call_log`
  *through ops-api*, scoped by `x-foundry-run` — our endpoint is a Foundry route and writes no
  `api_call_log` row, so without this task a real email send appears **nowhere** on the run page.
  The component exists because of "a script that emailed 0 of 11 people and reported `clean`";
  shipping an invisible real sender would restage that with a live blast radius.
- [x] T039 [US1] [P] Confirm `StepDetail.tsx` renders the step result's `recipients` /
  `resolved_from` without change (it already parses `{results[]}`); add the field labels if not.
- [x] T040 [US4] [P] Report mail configuration on the health surface: add `mail` to `ComponentName`
  in `services/health.service.ts`, reporting `down` + `missing[]` when unconfigured and `up` when
  configured. **A config check, not a live probe** — do not send a test message to prove health, and
  do not report `up` from the mere presence of a token endpoint (`LLM_CONNECTED_CAVEAT` in that same
  file is the documented example of that mistake).

**Checkpoint**: run a flow that emails; the run page names the recipient and the outcome.

---

## Phase 7: End-to-end and gates

- [x] T041 [US1] End-to-end with the transport stubbed, in the existing harness style: author a
  two-step flow (`code` → `foundry_email_send`) via the flow service, run it as a signed-in
  identity, assert the step result names the requester as recipient and an `email_sends` row exists.
- [x] T042 [US2] SC-002 proof: the same flow with a non-allowlisted `to`; assert `422`, assert the
  transport seam recorded **zero** calls, and assert the `email_sends` row is `refused` with the
  address named.
- [x] T043 [US1] ✅ **DONE — a real email was delivered.** Execution
  `68254629-5f1b-4968-a09f-85404b1efc17`, flow `attendance_report_email`, test-run as a signed-in
  identity: every step `success`, the run `succeeded`, and the `email_sends` row reads
  `outcome: sent`, `recipients: ["mayank.lohani@microland.com"]`, `resolved_from: requester` —
  **no address anywhere in the flow.** Graph correlation id
  **`d450e6fc-b962-4093-881b-8cf7881d0690`**. `GET /flow-executions/:id/emails` returns that record,
  so T037/T038's evidence surface is proven against a real send too.
  Sent as `aicoe@microland.com` from app `c78c325a-f33e-40dd-a35c-6c1cc74d404a` in tenant
  `ba39b069-731a-4eb6-95d8-9867f496c24b` — a **different app registration** from the one this plan was
  written against, supplied by the user with `Mail.Send` consented (`roles` now carries it). Admin
  consent and the Exchange application access policy are therefore proven in place, which is exactly
  what a stubbed suite cannot show.
- [x] T044 [INFRA] Full gate set: `pnpm typecheck`, `pnpm -r test`, `pnpm kestra:check`,
  `pnpm --filter @foundry/server demo:verify`, `pnpm --filter @foundry/server scenarios:verify`,
  `bash scripts/ui-honesty-check.sh`, the pre-commit/pre-push secret scanners, and `/speckit-comply`.
  ⚠ **Every `demo:*`/`finance:*`/`scenarios:*` script needs `--filter @foundry/server`** — none is
  aliased at the root, and the bare form fails with exit 254 in a way that reads like a broken script.
  Fix or explicitly justify every finding.
- [x] T045 [INFRA] Article VII docs currency, same PR: `docs/kestra-migration/` tool inventory,
  `progress/DECISIONS.md` (the seven decisions in plan.md), and `CLAUDE.md` if the tool inventory is
  restated there.

**Checkpoint**: gates green, one real email received, docs current. Ready for review.

---

## Phase 8: The first real run's findings (added 2026-08-18, after T041–T045)

**Purpose**: T043's first real attempt failed, and not in this feature's code. Both fixes belong to
this feature because they are what stands between it and its own acceptance criterion.

- [x] T049 [US1] Fix the flow that failed. Execution `e097b55b` died rendering `send_email`'s
  params: `…results[0].data.text | jq('tostring | @json') | first` hands `jq` a bare
  `java.lang.String`, and `jq` parses its input as JSON. **The step never made an HTTP request**, so
  no `email_sends` row existed and nothing reported an email problem. Corrected by moving the
  selection inside jq — `…results[0].data | jq('.text | @json') | first` — saved as revision 2 of
  flow `ceb7a2d7` through `POST /flows/:id/revisions` so the app's own compile and validation ran.
  Verified by test-running it: the step rendered, reached `/api/mail/send`, resolved
  `mayank.lohani@microland.com` from the requester, and recorded a row.
- [x] T050 [INFRA] Stop the drafter generating that shape again — a one-flow fix leaves the next
  draft with the same defect. Two halves, I-118's pairing (*the prompt is what the model obeys, the
  check is what catches it when the model does not*):
  · `checkPluckedThenJq` in `services/flow-output-shape.ts`, registered in `SHAPE_CHECKS` so
    **refine runs it too** (I-119 is the record of three checks enforced on a generated model and not
    on an edited one). Flags only the **unquoted** plucked-then-jq form; a leaf in quotes is the
    documented correct form and `checkJsonPositions` exists to permit it.
  · A rule beside the one that taught the shape, in `flow-generation.service.ts`'s draft prompt.
  Tests first: 8 new cases in `flow-output-shape.test.ts` (44 total) plus the registry's I-38
  fixture in `flow-model-findings.test.ts`, which fails if a check is added without one.

- [x] T051 [INFRA] **The twin check, and a lesson about prompts.** The next draft
  (`fa04cfc3`, flow `05f072f0`) was generated *after* T050 shipped, avoided the shape T050 forbids,
  and took the adjacent one: `"body":"{{ …data.text }}"` — the prose inside quotes, where its
  newlines made the body invalid JSON (`Illegal unquoted character (CTRL-CHAR, code 10)`). Again
  `request: null`, again no `email_sends` row, again nothing reporting an email problem.
  ⚠ **That is the form `checkJsonPositions` exists to permit** (*"a scalar plucked out of one belongs
  in quotes"* — true of an address, false of model prose), and `checkPluckedThenJq` skips quoted
  positions for the same stated reason. The blind spot was shared by both.
  · `checkFreeTextInQuotes` in `services/flow-output-shape.ts`, registered in `SHAPE_CHECKS`. Narrow
    by design: only a **free-text leaf** (`.text`/`.note`) off an **`llm_complete`** step, so a
    single-line scalar in quotes stays silent.
  · **T050's prompt rule rewritten.** It had said only what NOT to do, and the model moved to the
    neighbouring mistake — a rule forbidding one of two adjacent errors relocates the error rather
    than removing it. It now leads with the one correct expression and names both wrong forms under it.
  · Fixed flow `05f072f0` as revision 2 (attested `user`), after which the run succeeded — see T043.

**Checkpoint**: both rendering defects fixed and guarded; a real email delivered (T043).

---

## Dependencies

```
T001 ──▶ everything (branch gate)
T002 ──▶ everything (baseline)

Phase 1  (T003→T007)         independent of Phases 2–3
Phase 2  (T008→T014)         T008 before T015/T029; T010–T012 before T013
Phase 3  (T015→T021)         needs T008
Phase 4  (T022→T029)         needs Phase 1 + Phase 2 + Phase 3
Phase 5  (T030→T036)         needs T022 (derived key) + T028 (route mounted)
Phase 5b (T046→T048)         needs T030 (the reserved name exists to guard)
Phase 6  (T037→T040)         needs T013 (rows exist) + T025 (route returns shape)
Phase 7  (T041→T045)         needs everything
```

**Genuinely parallel**: T004/T005 (same new file — coordinate, or write sequentially), T014, T021,
T035, T039, T040, T047, T048. Everything else is on the chain above.

**51 tasks — all complete.** Numbering is by phase, so T046–T048 (Phase 5b) run before T037–T040 (Phase 6).

## MVP boundary

**T001–T029 plus T030–T033 is the smallest shippable slice** — a drafter can compose the tool and a
real email reaches the requester. T034–T036 (drafter disambiguation), T046–T048 (protecting the
registration) and T037–T040 (evidence surface) are not optional for a *merge*: T038 in particular is
what keeps this feature from being a silent sender. Do not cut Phase 6 to hit a date; cut Phase 6's
health line (T040) instead.

## File inventory — every file this feature touches

The same table as [plan.md](./plan.md)'s "Source Code — complete file inventory", indexed by task so
it can be worked through in order. Paths verified 2026-08-18.

### New files (17)

| # | Path | Task |
|---|---|---|
| 1 | `packages/server/src/services/mail-recipients.ts` | T003, T006, T007 |
| 2 | `packages/server/src/services/mail-recipients.test.ts` | T004, T005 |
| 3 | `packages/server/src/services/mail.service.ts` | T016–T020 |
| 4 | `packages/server/src/services/mail.service.test.ts` | T015 |
| 5 | `packages/server/src/services/mail-service-key.ts` | T022 |
| 6 | `packages/server/src/services/mail-secret-single-reader.test.ts` | T021 |
| 7 | `packages/server/src/services/platform-tool-catalogue.ts` | T030, T031 |
| 8 | `packages/server/src/services/platform-tool-catalogue.test.ts` | T035 |
| 9 | `packages/server/src/services/tool-reserved-name.test.ts` | T047 |
| 10 | `packages/server/src/middleware/mail-key.middleware.ts` | T023 |
| 11 | `packages/server/src/routes/mail.ts` | T025–T027, T029 |
| 12 | `packages/server/src/routes/mail.test.ts` | T024 |
| 13 | `packages/server/src/repositories/email-send.repo.ts` | T013 |
| 14 | `packages/server/src/repositories/email-send.repo.test.ts` | T014 |
| 15 | `packages/server/drizzle/0039_<name>.sql` | T012 (generated) |
| 16 | `packages/server/drizzle/meta/0039_snapshot.json` | T012 (generated) |
| 17 | *(appended entry)* `packages/server/drizzle/meta/_journal.json` | T012 (generated) |

### Edited — server (16)

| # | Path | What | Task |
|---|---|---|---|
| 1 | `packages/server/src/config/index.ts` | the `mail` block | T008 |
| 2 | `packages/server/src/db/schema.ts` | `emailSends` + `workspaces.mailRecipientAllowlist` | T010, T011 |
| 3 | `packages/server/src/app.ts` | mount at the exact path | T028 |
| 4 | `packages/server/src/services/tool.service.ts` | reserved-name guard | T046 |
| 5 | `packages/server/src/services/workspace.service.ts` | register on create | T032 |
| 6 | `packages/server/src/routes/flow-executions.ts` | `GET /:execId/emails` | T037 |
| 7 | `packages/server/src/services/health.service.ts` | `mail` component (config check) | T040 |
| 8 | `packages/server/src/demo/tool-catalogue.ts` | `SIMULATED` prefixes | T034 |
| 9 | `packages/server/src/demo/tool-catalogue.test.ts` | assert prefixes; **count stays 15** | T034 |
| 10 | `packages/server/src/demo/provision.ts` | call `registerPlatformTools` | T033 |
| 11 | `packages/server/package.json` | `mail:register` script | T033 |
| 12 | `packages/server/src/services/flow-output-shape.ts` | `checkPluckedThenJq` + `checkFreeTextInQuotes` | T050, T051 |
| 13 | `packages/server/src/services/flow-output-shape.test.ts` | 15 cases across both | T050, T051 |
| 14 | `packages/server/src/services/flow-model-findings.ts` | register both in `SHAPE_CHECKS` | T050, T051 |
| 15 | `packages/server/src/services/flow-model-findings.test.ts` | I-38 fixtures for both checks | T050, T051 |
| 16 | `packages/server/src/services/flow-generation.service.ts` | the draft-prompt rule (rewritten by T051) | T050, T051 |

### Edited — client (7)

| # | Path | What | Task |
|---|---|---|---|
| 1 | `packages/client/src/lib/foundry-client.ts` | `emailsForRun` | T037 |
| 2 | `packages/client/src/components/flow/ToolActivity.tsx` | real-delivery section | T038 |
| 3 | `packages/client/src/components/flow/StepDetail.tsx` | recipient labels | T039 |
| 4 | `packages/client/src/lib/api.ts` | re-export `FAEmailSend`, workspace resolution | T037 |
| 5 | `packages/client/src/app/(app)/tools/page.tsx` | platform-managed badge (actions at 412-413) | T046, T048 |
| 6 | `packages/client/src/app/(app)/tools/page.test.tsx` | extend, do not add a file | T048 |
| 7 | `packages/client/src/app/api/foundry/[...path]/route.ts` | `mail` in `DENIED_SEGMENTS` | T048 |

### Edited — root and docs (4)

| # | Path | What | Task |
|---|---|---|---|
| 1 | `.env.example` | placeholders + the two Azure operator steps | T009 |
| 2 | `CLAUDE.md` | qualify *"All 15 tools authenticate"* (≈line 1656) | T045 |
| 3 | `docs/kestra-migration/progress/DECISIONS.md` | the seven decisions | T045 |
| 4 | `docs/kestra-migration/progress/00-STATUS.md` | tool inventory line | T045 |

### Must NOT be edited

`step-execution.service.ts`, `flow-compiler.service.ts`, `flow-validator.service.ts`,
`packages/ops-api/**`, `packages/mcp-bridge/**`, `packages/shared/src/egress/**`,
`infra/docker-compose.yml`, and `docs/kestra-migration/01…10` (the **pinned design** — implementation
does not edit those). plan.md's "Deliberately NOT changed" table gives the reason for each; if one of
them looks like it needs a change, that is a signal the design drifted, not a task.

## Deliberately not in this feature

Attachments, HTML bodies, templates, delegated (on-behalf-of) send, Key Vault sourcing for the Graph
secret, inbound/bounce handling, and a UI for editing the workspace allowlist (API only in v1). All
recorded in spec.md "Out of Scope".
