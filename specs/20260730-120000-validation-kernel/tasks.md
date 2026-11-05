# Tasks: Validation Kernel & Request Boundary Hardening

**Feature**: `specs/20260730-120000-validation-kernel`
**Branch**: `krt/guardrail_validation`
**Date**: 2026-07-30

**Input**: Design documents — `plan.md`, `spec.md`, `research.md`, `data-model.md`,
`contracts/validate-middleware.md`, `contracts/error-response.md`, `quickstart.md`

---

## Phase 1: Setup

**Purpose**: Establish test infrastructure before any source changes. `pnpm test` must
pass (zero tests is a valid baseline) before the first source commit.

- [X] T001 Add `vitest.config.ts` to `foundry/packages/server/` with node environment, include glob `src/**/*.test.ts`, and verbose reporter so `pnpm --filter @foundry/server test` runs correctly

**Checkpoint**: `pnpm --filter @foundry/server test` exits 0.

---

## Phase 2: Foundational — Validation Kernel

**Purpose**: The `src/validation/` module is a prerequisite for every user story.
No route changes happen in this phase.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Create `foundry/packages/server/src/validation/primitives.ts` exporting `zUuid`, `zEnvVarName`, `zIdentifier`, `zHttpUrl`, `zPositiveInt`, `zIsoDate`, `zNetworkMode` as Zod schemas with JSDoc comments stating what each validates and what it replaces
- [X] T003 [P] Create `foundry/packages/server/src/validation/primitives.test.ts` with at least one positive and two negative test cases per primitive (false-positive cases are load-bearing — a primitive that accepts anything has not been validated)
- [X] T004 Create `foundry/packages/server/src/validation/middleware.ts` exporting the `validate(opts: {params?, query?, body?}): RequestHandler` factory; each provided schema is parsed via `.parse()` against the corresponding `req.*` segment; ZodError propagates as a synchronous throw
- [X] T005 [P] Create `foundry/packages/server/src/validation/middleware.test.ts` covering: params-only validation, body-only validation, combined params+body, omitted segments pass through unmodified, ZodError on invalid input, valid input reaches the next handler with coerced values
- [X] T006 Create `foundry/packages/server/src/validation/index.ts` re-exporting all primitives and `validate` from `./primitives.js` and `./middleware.js` (schema re-exports added incrementally in Phase 3)

**Checkpoint**: `pnpm --filter @foundry/server test` + `pnpm --filter @foundry/server typecheck` pass. The `src/validation/` module compiles and all primitive/middleware tests are green.

---

## Phase 3: User Story 1 — Malformed path params return 400, not 500 (Priority: P1)

**Goal**: Every route with a UUID path parameter rejects invalid values with 400
`{error:"validation_error",issues:[...]}` instead of a Postgres-driver 500.

**Independent Test**: `src/routes/params.test.ts` — table-driven: each mounted UUID route
returns 400 when any path param is `"not-a-uuid"`.

### Schema file creation (parallel — different files, no inter-dependencies)

- [X] T007 [P] [US1] Create `foundry/packages/server/src/validation/schemas/workspace.schema.ts` exporting `createWorkspaceSchema`, `updateWorkspaceSchema`, `workspaceParamsSchema` (`z.object({workspaceId: zUuid})`); move schemas from `workspace.service.ts`
- [X] T008 [P] [US1] Create `foundry/packages/server/src/validation/schemas/script.schema.ts` exporting `generateScriptSchema`, `scriptParamsSchema` (`z.object({workspaceId: zUuid, scriptId: zUuid})`), and `executeBodySchema` (`z.object({network: z.boolean().optional(), event: z.unknown().optional()})`); the `network` field stays boolean to preserve the existing API contract (AD-1 not approved for V1); add explicit comment at `event` field: "intentionally free-form — see research.md §D3"; move schemas from `script-generation.service.ts`
- [X] T009 [P] [US1] Create `foundry/packages/server/src/validation/schemas/trigger.schema.ts` exporting `createTriggerSchema`, `updateTriggerSchema`, `triggerParamsSchema` (`z.object({workspaceId: zUuid, scriptId: zUuid, tid: zUuid})`), and `fireBodySchema` (`z.object({payload: z.unknown().optional()})`); move schemas from `trigger.service.ts`
- [X] T010 [P] [US1] Create `foundry/packages/server/src/validation/schemas/datasource.schema.ts` exporting `createDatasourceSchema`, `updateDatasourceSchema`, `schemaAllowlistSchema`, `createDatasourceInputSchema`, `datasourceParamsSchema` (`z.object({workspaceId: zUuid, dsId: zUuid})`); move schemas from `datasource.service.ts`
- [X] T011 [P] [US1] Create `foundry/packages/server/src/validation/schemas/tool.schema.ts` exporting `createToolSchema` (with its `superRefine` auth rules intact), `updateToolSchema`, `generateDummySchema`, `toolParamsSchema` (`z.object({workspaceId: zUuid, id: zUuid})`), and `AUTH_STYLES` constant (re-import it in `tool.service.ts`); move schemas from `tool.service.ts`
- [X] T012 [P] [US1] Create `foundry/packages/server/src/validation/schemas/secret.schema.ts` exporting `createSecretSchema`, `updateSecretSchema`, `secretParamsSchema` (`z.object({workspaceId: zUuid, id: zUuid})`); move schemas from `workspace-secret.service.ts`

### Wire schema exports

- [X] T013 [US1] Update `foundry/packages/server/src/validation/index.ts` to re-export all schemas from `./schemas/workspace.schema.js`, `./schemas/script.schema.js`, `./schemas/trigger.schema.js`, `./schemas/datasource.schema.js`, `./schemas/tool.schema.js`, `./schemas/secret.schema.js`

### Update services — remove schema definitions, import types from validation module (parallel)

- [X] T014 [P] [US1] Update `foundry/packages/server/src/services/workspace.service.ts` — remove inline schema, import `CreateWorkspaceInput` and `UpdateWorkspaceInput` types from `../validation/index.js`
- [X] T015 [P] [US1] Update `foundry/packages/server/src/services/script-generation.service.ts` — remove inline schema, import `GenerateScriptInput` type from `../validation/index.js`
- [X] T016 [P] [US1] Update `foundry/packages/server/src/services/trigger.service.ts` — remove inline schema, import `CreateTriggerInput` and `UpdateTriggerInput` types from `../validation/index.js`
- [X] T017 [P] [US1] Update `foundry/packages/server/src/services/datasource.service.ts` — remove inline schema, import input types from `../validation/index.js`
- [X] T018 [P] [US1] Update `foundry/packages/server/src/services/tool.service.ts` — remove inline schema and `AUTH_STYLES` definition; import `createToolSchema`, `AUTH_STYLES`, and input types from `../validation/index.js`
- [X] T019 [P] [US1] Update `foundry/packages/server/src/services/workspace-secret.service.ts` — remove inline schema, import input types from `../validation/index.js`

### Update routes — add validate({ params }) (parallel — different files)

- [X] T020 [P] [US1] Update `foundry/packages/server/src/routes/workspaces.ts` — add `validate({ params: workspaceParamsSchema })` to every route that reads `req.params.workspaceId`; import `validate`, `workspaceParamsSchema`, body schemas from `../validation/index.js`
- [X] T021 [P] [US1] Update `foundry/packages/server/src/routes/scripts.ts` — add `validate({ params: scriptParamsSchema })` to every route that reads `req.params.scriptId` or `req.params.workspaceId`; body validation is in Phase 4
- [X] T022 [P] [US1] Update `foundry/packages/server/src/routes/triggers.ts` — add `validate({ params: triggerParamsSchema })` to every route that reads `:tid`, `:scriptId`, or `:workspaceId`; body validation is in Phase 4
- [X] T023 [P] [US1] Update `foundry/packages/server/src/routes/datasources.ts` — add `validate({ params: datasourceParamsSchema })` to every route with `:dsId` or `:workspaceId`
- [X] T024 [P] [US1] Update `foundry/packages/server/src/routes/tools.ts` — add `validate({ params: toolParamsSchema })` to every route with `:id` or `:workspaceId`
- [X] T025 [P] [US1] Update `foundry/packages/server/src/routes/workspace-secrets.ts` — add `validate({ params: secretParamsSchema })` to every route with `:id` or `:workspaceId`
- [X] T026 [P] [US1] Update `foundry/packages/server/src/routes/stubs.ts` — add `validate({ params: z.object({ workspaceId: zUuid, name: z.string().min(1).max(255) }) })` to routes that read `:workspaceId` and `:name`

### Path-param test suite

- [X] T027 [US1] Write `foundry/packages/server/src/routes/params.test.ts` — table-driven Vitest test that spins up the Express app with mocked service layer (supertest) and for every route in the table asserts: status 400 when any UUID param is `"not-a-uuid"`, body `{error:"validation_error"}`, no Postgres error text in body; table must enumerate all mounted UUID routes from workspaces, scripts, triggers, datasources, tools, workspace-secrets, stubs

**Checkpoint**: All T027 table rows pass. `grep -r 'req\.params\.' packages/server/src/routes/` shows every hit accompanied by a `validate(` call in the same file.

---

## Phase 4: User Story 2 — High-consequence request bodies validated at route boundary (Priority: P1)

**Goal**: `POST /:scriptId/execute`, `POST /:tid/fire`, and `POST /api/triggers/:token/webhook`
reject invalid or oversized bodies before any downstream service is called.

**Independent Test**: Send `{network:"host"}` to execute → 400. Send >64KB body to webhook → 413.
Send valid body → response identical to today.

- [X] T028 [US2] Update `foundry/packages/server/src/routes/scripts.ts` execute route — add `express.json({ limit: "256kb" })` middleware before the handler and `validate({ body: executeBodySchema })` middleware after it; preserve the existing `req.body?.network !== false` boolean semantics (AD-1 not approved — `network` stays boolean in V1); add comment at the handler: "event is intentionally free-form — see research.md §D3 and executeBodySchema"
- [X] T029 [US2] Update `foundry/packages/server/src/routes/triggers.ts` fire route — add `express.json({ limit: "64kb" })` before the handler and `validate({ body: fireBodySchema })` middleware after it; update the handler to read `req.body?.payload` (already the field name, no change needed)
- [X] T030 [US2] Update `foundry/packages/server/src/routes/triggers.ts` webhook route — add `express.json({ limit: "64kb" })` before the handler; the entire body is accepted as-is and forwarded, so no body schema is needed, only the size cap

**Checkpoint**: `pnpm test` passes. Valid execute/fire/webhook requests are unchanged. 413 on oversized webhook. 400 on `{network:"host"}` to execute.

---

## Phase 5: User Story 3 — Server errors don't leak internals; diagnosable from logs (Priority: P2)

**Goal**: 500-class error responses are opaque (`{error:"internal_error",requestId}` or
`{error:"upstream_error",requestId}`); the full error is logged server-side with the request ID.

**Independent Test**: Induce a 500 (or use the error-middleware unit test) and confirm
no `err.message`, stack trace, or upstream body in the response body; `requestId` is present
and equals the `X-Request-Id` header.

- [X] T031 [US3] Create `foundry/packages/server/src/middleware/request-id.middleware.ts` — exports `requestId` Express middleware that calls `crypto.randomUUID()`, sets `res.locals.requestId`, calls `res.setHeader("X-Request-Id", id)`, and logs `[request] METHOD PATH requestId=<uuid>` at the start of every request
- [X] T032 [US3] Update `foundry/packages/server/src/app.ts` — import `requestId` from `./middleware/request-id.middleware.js` and mount it with `app.use(requestId)` before all routes and before the global `express.json()` call so every request (including 404s) receives an ID
- [X] T033 [US3] Update `foundry/packages/server/src/middleware/error.middleware.ts` — implement four-case handler matching `contracts/error-response.md` exactly: (1) ZodError → 400 `{error:"validation_error",issues}` unchanged; (2) TetherError → 502 `{error:"upstream_error",requestId}` with upstream body+status logged server-side only; (3) app error with `statusCode` 4xx → that status `{error:"request_error",message,requestId}`; (4) all other errors → 500 `{error:"internal_error",requestId}` with full error logged server-side; `requestId` read from `res.locals.requestId`
- [X] T034 [US3] Write `foundry/packages/server/src/middleware/error.middleware.test.ts` — Vitest unit tests covering all four error-handler paths, asserting: ZodError yields `{error:"validation_error",issues}` with no `requestId`; TetherError yields `{error:"upstream_error",requestId}` with no upstream body or status in response; generic Error yields `{error:"internal_error",requestId}` with no `err.message`; 409 app error yields `{error:"request_error",message,requestId}`; `X-Request-Id` header present on every response

**Checkpoint**: `pnpm test` passes including error.middleware.test.ts. Invariants in `contracts/error-response.md` are all testable and passing.

---

## Phase 6: User Story 4 — Stub-API hand-rolled validators replaced by shared primitives (Priority: P2)

**Goal**: `intParam`, `enumParam`, date regexes, and `EMAIL_RE` in `routes/stub-api.ts`
are eliminated; the shared Zod primitives and `validate()` middleware handle all validation.
All caps (recipients ≤ 50, attachments ≤ 10, limit 1–200/1–500) are preserved.

**Independent Test**: Previously valid stub-api calls still return the same responses.
Previously invalid values (bad dates, out-of-range limits, invalid emails) return
`{error:"validation_error"}` instead of unhandled exceptions.

- [X] T035 [US4] Create `foundry/packages/server/src/validation/schemas/stub.schema.ts` with Zod equivalents: `zPositiveInt`-based integer params with `.min()/.max()` refinements matching each route's range, `z.enum([...])` for enum params, `zIsoDate` for date params, `z.string().email()` for email fields, `z.array(z.string().email()).max(50)` for recipients, `z.array(...).max(10)` for attachments; export named schemas per route group
- [X] T036 [US4] Update `foundry/packages/server/src/routes/stub-api.ts` — replace every `intParam`, `enumParam`, date-regex guard, and `EMAIL_RE` check with `validate({ query: ... })` or `validate({ body: ... })` using schemas from `stub.schema.ts`; delete the `intParam`, `enumParam`, `EMAIL_RE` helper definitions; add `express.json({ limit: "512kb" })` to the stub-api router (before route handlers) so stub routes have their own body-size cap independent of the global 2MB limit
- [X] T037 [US4] Update `foundry/packages/server/src/validation/index.ts` to re-export schemas from `./schemas/stub.schema.js`
- [X] T038 [US4] Verify caps preserved: confirm `stub.schema.ts` has `recipients` capped at ≤ 50, `attachments` at ≤ 10, and each `limit` param at the correct range (1–200 or 1–500 per endpoint) — run `pnpm test` and confirm no previously-valid stub call now fails

**Checkpoint**: `pnpm test` passes. `grep -r 'intParam\|enumParam\|EMAIL_RE' packages/server/src/routes/` returns zero hits (SC-004).

---

## Phase 7: User Story 5 — Status-enum DB columns carry CHECK constraints (Priority: P3)

**Goal**: The four status-enum columns (`scripts.status`, `triggers.type`,
`execution_results.status`, `test_results.audit_verdict`) have Postgres CHECK constraints
so any direct write of an invalid value is rejected at the DB level.

**Independent Test**: Attempt to insert a row with `status = 'invalid_status'` directly
via psql — Postgres rejects with a constraint violation. Normal application writes succeed.

- [X] T039 [US5] Update `foundry/packages/server/src/db/schema.ts` — add Drizzle `check()` constraints to four tables using the pattern `(t) => ({ statusCheck: check("scripts_status_check", sql\`${t.status} IN ('draft','generating','completed','archived')\`) })`; allowed values per column: scripts.status `('draft','generating','completed','archived')`, triggers.type `('manual','schedule','poll','webhook')`, execution_results.status `('running','succeeded','failed','timed_out','error')`, test_results.audit_verdict `('clean','warn','fail') OR audit_verdict IS NULL` (nullable column)
- [X] T040 [US5] Generate the Drizzle migration by running `pnpm --filter @foundry/server db:generate` from `foundry/`; review the generated `drizzle/0009_*.sql` for correctness (four `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` statements); do not hand-edit the migration
- [X] T041 [US5] Apply the migration to the dev database by running `pnpm --filter @foundry/server db:migrate` from `foundry/`; confirm `db:migrate` exits 0 and the constraints appear in `\d scripts` via psql
- [X] T042 [US5] Write `foundry/packages/server/src/db/schema.test.ts` — integration smoke test (requires `DATABASE_URL` env) that inserts a row with `status = 'invalid_status'` into each constrained table via the Drizzle client and asserts the insert throws a constraint-violation error; also asserts that a valid status value is accepted

**Checkpoint**: Migration applies cleanly. `pnpm test` passes including schema.test.ts. Normal application writes (existing integration test paths) are unaffected.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Verification, cleanup, and spec-kit compliance gate before PR.

- [X] T043 [P] Delete the stray untracked file `foundry/packages/client/guardrail_validaton.md` (typo'd name, duplicate of roadmap doc); file is untracked so no git operation needed — just `rm` and confirm `git status` shows it gone
- [X] T044 [P] Run grep audit SC-004: `grep -r 'intParam\|enumParam\|EMAIL_RE' packages/server/src/routes/` must return zero hits — if any remain, update the corresponding route before committing
- [X] T045 [P] Run grep audit SC-005: `grep -r '\.parse(req\.' packages/server/src/routes/` must return zero hits — every validation call goes through `validate()`, not direct `.parse(req.body)` calls
- [X] T046 Run `pnpm --filter @foundry/server test` and confirm all tests pass including: `src/validation/primitives.test.ts`, `src/validation/middleware.test.ts`, `src/middleware/error.middleware.test.ts`, `src/routes/params.test.ts`, `src/db/schema.test.ts`
- [X] T047 Run `pnpm --filter @foundry/server typecheck` and confirm exit 0 with no type errors
- [X] T048 Run the existing end-to-end smoke test `pnpm e2e` from `foundry/` and confirm all existing integration paths (workspace → tool → datasource → generate → execute → trigger → fire) behave identically to pre-V1 for valid inputs (SC-008)
- [X] T049 Run `/speckit-comply` and resolve any CRITICAL findings before opening the PR; constitution §III requires this gate

**Checkpoint**: All audits pass. PR can be opened. After merge, run `/speckit-update-standards` to amend `security.md §5` to record holes 1, 2, 6, 8 as closed and `src/validation/` as the canonical schema location.

---

## Phase 9: Post-implementation audit corrections (2026-08-03)

**Why this phase exists**: an independent audit of the Phase 1–8 diff — run against
the live API, not just the test suite — found that `validate()` called `.parse()` and
**discarded the result**. The middleware therefore rejected bad requests (so every
Phase 3–6 negative test passed) while silently dropping everything the parse
*produces*. Three consequences, all reproduced live:

1. **Defaults never applied.** `GET /stub-api/hr/employees` returned all 62 rows
   instead of the `limit` default of 50; `GET /stub-api/hr/attendance/summary` with
   no `period` returned **HTTP 500** rather than defaulting to `DEMO_PERIOD`.
2. **Coercion never applied.** `?limit=3` reached the handler as the string `"3"`
   and was echoed in the JSON response as `"3"` instead of `3`.
3. **Undeclared keys not stripped** — the serious one. Pre-V1, routes called
   `schema.parse(req.body)` and passed the *parsed* object on, so zod's default
   key-stripping was load-bearing security. Passing raw `req.body` to services whose
   repositories spread it into `.set({...data})` created a mass-assignment hole:
   - `PATCH /api/workspaces/:id` wrote caller-supplied `tetherApiKey` and
     `tetherTenantId` — an **encrypted-at-rest credential column overwritten with
     attacker plaintext** (verified in Postgres).
   - `PATCH .../tools/:toolId` wrote `workspaceId` and `isDummy`, **moving a tool
     into another workspace** — crossing the Article XII isolation boundary.
   - `PATCH .../triggers/:tid` exposed `webhookToken` and `scriptId` the same way.

- [X] T050 Fix `src/validation/middleware.ts` — assign each parsed segment back onto
  the request (`req.params`, `req.body`; `req.query` via `Object.defineProperty`,
  since it is a getter in Express 4/5). This single change restores defaults,
  coercion and key-stripping, closing all three consequences above
- [X] T051 Add write-back tests to `src/validation/middleware.test.ts` — coerced query
  values, query defaults, body defaults, and stripping of undeclared `params`/`body`
  keys. The existing tests could not fail on this bug: they only asserted `next()`
  was called with/without a ZodError
- [X] T052 Create `src/routes/request-boundary.test.ts` — the app-level suite T027
  specified but did not deliver (T027 shipped `params.test.ts`, which unit-tests the
  zod objects in isolation and never mounts a route, so it cannot detect an unwired
  or result-discarding `validate()`). Mounts real routes on a real Express app over
  a real socket: path-param 400s, body key-stripping, execute-envelope cases, body
  caps, query coercion/defaults, request-id behaviour. No new dependency (node
  `http` + `fetch`, not supertest)
- [X] T053 Create `src/validation/body-limit.ts` and replace the three hand-rolled
  `Content-Length` guards (T028/T029/T030) and `stubBodyLimit` (T036). Those read a
  caller-supplied header that is **absent on `Transfer-Encoding: chunked`**, so a
  300 KB body passed the 256 KB execute cap and reached the handler (verified live).
  `express.json`'s `verify` hook now records the real byte count and `bodyLimit(n)`
  compares against that
- [X] T054 Update `src/app.ts` — mount `requestIdMiddleware` **before**
  `express.json` (T032 specified this; it was mounted after, so a >2mb body was
  rejected with no request id and no log line), and pass `verify: recordRawBodySize`
- [X] T055 Fix `src/middleware/request-id.middleware.ts` — honour an inbound
  `X-Request-Id` only when it is a UUID. It was reflected verbatim into the response
  header, the error body and the server log, so a caller could forge log entries and
  poison the identifier V1's diagnosability depends on. Also add the
  `[request] METHOD PATH requestId=…` log line T031 specified but omitted
- [X] T056 Wire the shared primitives into the schemas. T002 created seven
  primitives but only `zUuid` was ever imported — `tool.schema.ts`,
  `datasource.schema.ts` and `workspace-secret.schema.ts` each re-declared the env-var
  regex inline and `stub.schema.ts` re-declared the date regexes, so SC "one
  validation vocabulary" was not met. `zEnvVarName` is now used by all three and
  `zIsoDay`/`zYearMonth` by `stub.schema.ts`
- [X] T057 Correct `zEnvVarName` from `^[A-Z_][A-Z0-9_]*$` to `^[A-Za-z_][A-Za-z0-9_]*$`.
  The uppercase-only form contradicted the rule the API has always enforced, so
  adopting the primitive as written would have 400'd lowercase `secretEnvName` values
  that are valid and already stored. Updated the `rejects lowercase` test, which
  asserted the wrong contract, and kept the load-bearing negatives (leading digit,
  hyphen, space, `$`, empty)
- [X] T058 Add `emptyAsAbsent` and apply it to every optional/defaulted stub-api query
  field. The deleted `str()` helper mapped `""` to `undefined`, so `?limit=` and
  `?region=` were ignored; under the new schemas `z.coerce.number()` turned `""` into
  `0` and `z.enum()` rejected it, 400-ing requests that previously succeeded
- [X] T059 Re-verify: `pnpm --filter @foundry/server test` (194 passed, 23 skipped —
  the skips are the pre-existing `hr_demo`-unreachable suites),
  `pnpm --filter @foundry/server typecheck` clean, and a live re-run of all ten
  regression probes against the running API

**Checkpoint**: all ten live probes pass — stub-api default limit is 50 again,
`limit` is a number again, `attendance/summary` no longer 500s, empty query values
are ignored, both mass-assignment paths are closed, the body cap holds under chunked
encoding, `X-Request-Id` is sanitised, path params still 400, and valid CRUD is
unchanged.

**Not addressed here (correctly out of V1 scope)**: `/mcp` and progress-WS
authentication, the Next-proxy in-route session check, and `roles` enforcement are
V2. Rate limiting and the timing-unsafe `requireApiKey` comparison are V3. No new
rate-limit or sanitisation dependency was added (Article IV).

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Foundational — Validation Kernel)
    ↓
Phase 3 (US1) ──── Phase 5 (US3) can start after Phase 2
Phase 4 (US2)      Phase 6 (US4) can start after Phase 2
                    Phase 7 (US5) can start after Phase 2, independent of all others
    ↓
Phase 8 (Polish) — after all user stories are complete
```

- **US3 (Phase 5)** depends only on Phase 2 (needs `validate()` primitives for error-middleware tests, needs app.ts knowledge)
- **US4 (Phase 6)** depends only on Phase 2 (needs primitives and middleware for stub.schema.ts)
- **US5 (Phase 7)** depends only on Phase 1 (needs vitest.config.ts for the smoke test; no dependency on other stories)
- **US1 and US2 are ordered** (US2 adds body validation on top of the params schemas US1 creates)

### Within Each Phase

- Tasks marked `[P]` can run concurrently (different files, no dependencies on each other)
- Within US1: schema files (T007–T012) → index update (T013) → service updates (T014–T019) → route updates (T020–T026) → test (T027)
- Within Phase 2: T002/T003 together → T004 → T005/T006 together

---

## Parallel Execution Examples

### US1: Schema migration fan-out

```bash
# Run all schema file creations together (T007–T012):
Task: "Create workspace.schema.ts in src/validation/schemas/"
Task: "Create script.schema.ts in src/validation/schemas/"
Task: "Create trigger.schema.ts in src/validation/schemas/"
Task: "Create datasource.schema.ts in src/validation/schemas/"
Task: "Create tool.schema.ts in src/validation/schemas/"
Task: "Create secret.schema.ts in src/validation/schemas/"

# Then fan-out service updates (T014–T019):
Task: "Update workspace.service.ts to import from validation module"
Task: "Update script-generation.service.ts to import from validation module"
# ...etc

# Then fan-out route updates (T020–T026):
Task: "Update workspaces.ts with validate({ params })"
Task: "Update scripts.ts with validate({ params })"
# ...etc
```

### Phase 2: Kernel bootstrap

```bash
# T002 and T003 in parallel:
Task: "Create primitives.ts"
Task: "Create primitives.test.ts"
# Then T004, then T005 and T006 in parallel.
```

---

## Implementation Strategy

### MVP (US1 + US2 only — closes holes 1 and 2)

1. Complete Phase 1 (Setup)
2. Complete Phase 2 (Foundational kernel)
3. Complete Phase 3 (US1 — params 400s)
4. Complete Phase 4 (US2 — body validation)
5. **STOP AND VALIDATE**: `pnpm test`, `pnpm e2e`, verify quickstart.md scenarios 1–3

This MVP eliminates the two highest-priority security holes (path-param 500s and
unvalidated high-consequence bodies). US3–US5 add opaque errors, stub-api consistency,
and DB constraints as follow-on increments.

### Incremental Delivery

- US1 complete → hole 1 closed (path-param 500s eliminated)
- US2 complete → hole 2 closed (execute/fire/webhook validated)
- US3 complete → hole 6 closed (errorHandler opaque)
- US4 complete → stub-api validator consistency achieved
- US5 complete → hole 8 (partly) closed (DB CHECK constraints)

### Commit Discipline

Per the project working style (memory: guardrails-roadmap-working-style.md):
- Commit only when `pnpm test` + `pnpm typecheck` are green
- Each phase gate (A–H) is a natural commit point
- Never change valid-request behaviour; verify with `pnpm e2e` after each phase

---

## Notes

- `[P]` = different files, no incomplete task dependencies — safe to parallelize
- `[USn]` = traceability label mapping to user stories in spec.md
- The `event` field on the execute body and the `payload` field on fire are intentionally
  `z.unknown()` — do not add shape validation to these fields; see `research.md §D3`
- AD-1 (network boolean → enum) and AD-2 (validate() pattern) require user approval
  before implementing Phase 4; both are documented in `plan.md §Architectural Decisions`
- After merge: run `/speckit-update-standards` to amend `security.md §5`
