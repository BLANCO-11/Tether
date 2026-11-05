---
description: "Task list for V2 — authentication and authorization on the unguarded surfaces"
---

# Tasks: Authentication and authorization on the unguarded surfaces (V2)

**Input**: Design documents from `/specs/20260803-000000-auth-unguarded-surfaces/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: **REQUIRED, and written first.** Article II is binding, SC-007 requires
a negative test per requirement that fails when its guard is removed, and FR-022
makes an automated test client the *acceptance condition* for keeping the progress
socket. This is not a project where tests are optional — V1 shipped 49 green
checkboxes over a mass-assignment hole, and the whole reason V2 exists in this
form is that its tests could not fail.

**Organization**: grouped by user story. Phase order follows
[plan.md](plan.md#sequencing) rather than raw spec priority: US2 is P1 but runs
last because it has no consumer, so it carries the least regression risk and the
most need for its own test client. US4 depends on US3's allowlist existing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1 (MCP bridge), US2 (progress socket), US3 (proxy), US4 (roles)

## Path Conventions

pnpm workspace monorepo. All paths are repo-relative from `/home/kriti/foundry`:

- Server: `foundry/packages/server/src/`
- Bridge: `foundry/packages/mcp-bridge/src/`
- Client: `foundry/packages/client/src/`

Work on branch `krt/guardrail_validation` in the **main checkout**, not a worktree.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: environment plumbing and the bridge's missing test runner.

- [X] T001 [P] Add `WS_ALLOWED_ORIGINS` and `MCP_BRIDGE_REQUIRE_AUTH` placeholder lines with explanatory comments to `foundry/.env.example` (Article VIII, FR-018)
- [X] T002 [P] Add both variables to your local `foundry/.env` (gitignored — never commit it); set `WS_ALLOWED_ORIGINS=http://localhost:4002` and `MCP_BRIDGE_REQUIRE_AUTH=true`
- [X] T003 [P] Pass `WS_ALLOWED_ORIGINS` to the `server` service and `MCP_BRIDGE_REQUIRE_AUTH` to the `mcp-bridge` service in `foundry/infra/docker-compose.yml`
- [X] T004 Add `vitest` (^2.1.9, matching `server`) as a devDependency and a `"test": "vitest run"` script to `foundry/packages/mcp-bridge/package.json`; the package has no test runner today (justified in plan.md Complexity Tracking)
- [X] T005 [P] Add `foundry/packages/mcp-bridge/vitest.config.ts` mirroring the server's config so the bridge's tests run identically
- [X] T006 Read `WS_ALLOWED_ORIGINS` in `foundry/packages/server/src/config/index.ts` as `wsAllowedOrigins: readonly string[]`, empty when unset (fail closed) — no `process.env` at call sites. **Corrected during implementation**: `MCP_BRIDGE_REQUIRE_AUTH` does *not* belong here. `packages/mcp-bridge` does not import the server's config module (it has none of its own either), so the flag is read in the bridge's own auth module under T035. Putting it in the server's config would have created a value the consuming package cannot reach

**Checkpoint**: `pnpm --filter @foundry/mcp-bridge test` runs and reports zero tests rather than erroring.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the one identity primitive that US1 and US2 both build on
([workspace-credential.contract.md](contracts/workspace-credential.contract.md),
[data-model.md](data-model.md)).

**⚠️ CRITICAL**: US1 and US2 cannot begin until this phase is complete and green.

### Schema

- [X] T007 Add the `workspaceApiCredentials` table to `foundry/packages/server/src/db/schema.ts` per [data-model.md](data-model.md): all 14 columns, `workspaceId` NOT NULL with `onDelete: "cascade"`, `scriptId` nullable cascading to `scripts`, unique index on `keyId`, index on `workspaceId`
- [X] T008 Add the three CHECK constraints in the same table definition: `audience IN ('mcp','ws_progress')`, `audience <> 'ws_progress' OR script_id IS NOT NULL`, `single_use = false OR expires_at IS NOT NULL` (follows V1's precedent of enforcing enums in the database, not only in Zod)
- [X] T009 Generate the migration with `pnpm --filter @foundry/server drizzle-kit generate` — **generated, never hand-written** (frameworks.md); expect `foundry/packages/server/drizzle/0010_*.sql` plus its snapshot
- [X] T010 Apply the migration and confirm all three constraints exist with `psql "$DATABASE_URL" -c "\d workspace_api_credentials"`

### Tests first

- [X] T011 Write `foundry/packages/server/src/db/schema.test.ts` additions asserting each new CHECK constraint rejects an invalid row and accepts a valid one, and that deleting a workspace cascades its credentials away (Article XII)
- [X] T012 Write `foundry/packages/server/src/auth/workspace-credential.test.ts` covering every row of the contract's test table: round trip per audience, cross-workspace rejection (**the Article XI over-grant test**), audience isolation, revocation, expiry, single-use second-use failure, concurrent double-use where exactly one wins, malformed tokens rejected before any query, and plaintext absent from the stored row
- [X] T013 [P] Add to that suite the indistinguishability assertions for SC-003: unknown `keyId` and wrong secret must return the identical `ok:false` shape, and the unknown-key path must still perform a `scrypt` against a dummy salt so the two are not separable by timing class

### Implementation

- [X] T014 Create `foundry/packages/server/src/validation/schemas/workspace-credential.schema.ts` using V1's primitives (`zUuid`, etc.) for issue-request bodies and params — no locally re-declared regexes
- [X] T015 Implement `foundry/packages/server/src/auth/workspace-credential.ts` with `issue`, `verify`, `revoke` exactly as typed in [the contract](contracts/workspace-credential.contract.md): `fdy_<keyId>.<secret>` format, `randomBytes` generation, per-credential salt, `scrypt` digest, `timingSafeEqual` comparison
- [X] T016 Implement the token parser inside that module so a malformed token is rejected on shape (single `.`, exact part lengths, base64url charset) **before** any database query
- [X] T017 Implement single-use consumption as a conditional `UPDATE … WHERE id = $1 AND consumed_at IS NULL` and require it to affect exactly one row, so two concurrent presentations cannot both succeed
- [X] T018 Ensure `verify` authorizes before it looks anything up, so no path can reveal whether a workspace or script exists (FR-003)
- [X] T019 Add the auth refusal logger — `[auth] refused surface=… reason=… keyId=… requestId=…` — logging `keyId` but never the secret or the token (Article V)
- [X] T020 Create `foundry/packages/server/src/routes/workspace-credentials.ts` with issue / list / revoke, mounted behind `requireApiKey`, validated with `validate()` from V1, returning the plaintext token **only** from the issue response
- [X] T021 Mount the credentials router in `foundry/packages/server/src/app.ts` alongside the other `requireApiKey` routers
- [X] T022 [P] Write `foundry/packages/server/src/routes/workspace-credentials.test.ts` asserting the issue endpoint requires the API key, the plaintext appears exactly once and never on list, and revoke takes effect immediately

**Checkpoint**: `pnpm --filter @foundry/server test` green; the over-grant test passes; V1's 194 tests still pass untouched.

---

## Phase 3: User Story 1 — Datasource schema is not readable by strangers (P1)

**Goal**: `POST /mcp` requires a workspace-scoped credential, and `workspaceId`
leaves the tool contract entirely.

**Independent test**: call each tool with no credential and get no schema data;
call with workspace A's credential and confirm there is no way to ask for B.

**Contract**: [mcp-bridge-auth.contract.md](contracts/mcp-bridge-auth.contract.md)

### Tests first

- [X] T023 [US1] Write `foundry/packages/mcp-bridge/src/auth.test.ts` covering: missing header, malformed token, unknown/revoked/expired credential, and a `ws_progress` credential rejected for audience mismatch — all returning the identical body
- [X] T024 [P] [US1] Write `foundry/packages/mcp-bridge/src/index.test.ts` asserting an unauthenticated `list_tables` returns 401 **and that no table or column name appears anywhere in the response body**
- [X] T025 [P] [US1] Add a test that a credential for workspace A cannot reach workspace B's schema by any input (SC-003, Article XII) and that a workspace with no datasources returns an empty result rather than an error
- [X] T026 [P] [US1] Add a test that `GET /health` remains unauthenticated and returns 200
- [X] T027 [P] [US1] Add a fail-closed test: with `MCP_BRIDGE_REQUIRE_AUTH` unset or malformed, authentication is still required
- [X] T028 [P] [US1] Add a golden-response test pinning one tool's output for a fixed fixture, so FR-006's "byte-identical for valid calls" is enforced rather than asserted

### Implementation

- [X] T029 [US1] Create `foundry/packages/mcp-bridge/src/auth.ts` as the bridge's verification entry point, and export `pool` from `foundry/packages/mcp-bridge/src/schema-store.ts` so verification uses the same connection pool rather than opening a second one. **Decide and record** here whether the verifier is single-source (imported from `packages/server/src/auth/`) or duplicated — see [research.md](research.md) R2; if duplicated, T030 is mandatory
- [X] T030 [US1] If and only if T029 chose duplication: add a conformance test in both packages running identical fixtures through both verifiers and asserting identical `VerifyResult`s. Two verifiers allowed to drift is worse than one duplicated on purpose
- [X] T031 [US1] Add credential extraction and verification to `POST /mcp` in `foundry/packages/mcp-bridge/src/index.ts`, refusing **before** `buildServer()` or the transport is constructed
- [X] T032 [US1] Remove `workspaceId` from all four tool input schemas in `index.ts` and bind the verified workspace into the per-request closure instead. Do **not** keep the parameter and compare it — that leaves the next tool author a hole to fall into
- [X] T033 [US1] Replace `tableName` / `columnName` `z.string()` with V1's `zIdentifier` in all four tool schemas (FR-004)
- [X] T034 [US1] Mount V1's `requestIdMiddleware` and `errorHandler` in the bridge, replacing the hand-rolled 500 at `index.ts:73-76` (FR-017)
- [X] T035 [US1] ~~Implement the fail-closed `MCP_BRIDGE_REQUIRE_AUTH` switch~~ — **flag removed instead.** Implementing it showed it cannot mean anything: with `workspaceId` no longer a tool input there is no workspace to derive without a credential, so an "auth off" mode could only work by putting the vulnerability back in the tool contract behind a flag. Dead config reads like an escape hatch that exists, so the variable was dropped from `.env.example`, `.env`, compose and `auth.ts`. A test asserts it cannot quietly return
- [X] T036 [US1] Commit the tool-contract change as its **own commit** (breaking API changes do not ride along with infrastructure changes). **Note**: nothing registers the bridge today — `docker-compose.yml:111-116` and `client/src/lib/run-prompt.ts:12` both say so — so there is no Tether registration to update in step and this change breaks no live caller. Say that in the commit message so the next reader does not go looking for a migration that was never needed

**Checkpoint**: bridge suite green; an unauthenticated tool call leaks nothing; US1 independently demonstrable.

---

## Phase 4: User Story 3 — A signed-in user cannot reach unused parent-API paths (P1)

**Goal**: the proxy checks the session itself and forwards only allowlisted paths.

**Independent test**: widen the middleware matcher and confirm the route still
refuses; request a path the UI never calls and confirm nothing reaches `:4000`.

**Contract**: [proxy-allowlist.contract.md](contracts/proxy-allowlist.contract.md)

### Tests first

- [X] T037 [US3] Write `foundry/packages/client/src/app/api/foundry/[...path]/route.test.ts` asserting a request with no session gets 401 **from the route itself**, with `auth()` mocked to return null and the middleware bypassed entirely
- [X] T038 [P] [US3] Add the **SC-005** test: simulate the matcher excluding `/api/foundry` and assert an unauthenticated request is still refused
- [X] T039 [P] [US3] Add tests that a non-allowlisted path returns 403 **and that no upstream `fetch` occurred** (assert on a mocked fetch's call count, not just the status)
- [X] T040 [P] [US3] Add path-normalisation tests: `..`, `.`, empty segments, `%2f`, `%2F`, `%5c`, `%5C` — each 403 before matching
- [X] T041 [P] [US3] Add a wrong-method test: an allowlisted path called with a method its entry does not list returns 403
- [X] T042 [P] [US3] Add passthrough tests for FR-012: status, body bytes, `content-type` and `content-disposition` identical to the upstream response, including a 204 and a `text/plain` download
- [X] T043 [P] [US3] Add an FR-013 test: when upstream is unreachable the 502 body contains **no** `e.message`
- [X] T044 [US3] Write `foundry/packages/client/src/lib/proxy-allowlist.test.ts` implementing **FR-011**: mechanically extract every proxy path template from `lib/foundry-client.ts` and `lib/adapters.ts` and assert each is covered by an allowlist entry. This test — not research R5's table — is the source of truth

### Implementation

- [X] T045 [US3] Create `foundry/packages/client/src/lib/proxy-allowlist.ts` exporting the `AllowEntry[]` and a `match(method, segments)` function, with entries derived from the extraction in T044 (start from research R5's table, then let the test correct it)
- [X] T046 [US3] Implement segment-level normalisation and rejection in `proxy-allowlist.ts`, matching on the `path[]` array Next supplies rather than a rejoined string
- [X] T047 [US3] Add `const session = await auth()` and a 401 refusal to `foundry/packages/client/src/app/api/foundry/[...path]/route.ts`, before any allowlist or upstream work
- [X] T048 [US3] Wire the allowlist check into the route, refusing with 403 before any `fetch` to the parent API
- [X] T049 [US3] Remove `e.message` from the 502 `upstream_unreachable` envelope in that route (FR-013) — a V1-contract leak the V1 audit did not reach because the proxy lives in the client package

**Checkpoint**: client suite green; deleting the `auth()` call fails T037 and T038; the UI still works end to end.

---

## Phase 5: User Story 4 — The `roles` claim means something (P2)

**Goal**: one enforcement point for `roles`, in the proxy allowlist.

**Depends on**: Phase 4 (the allowlist must exist to carry the role).

**Independent test**: a non-admin session is refused `POST /demo/reset`; an admin
session is forwarded.

### Tests first

- [X] T050 [US4] Add tests to `proxy-allowlist.test.ts` and the route test: a session without `admin` calling `POST /demo/reset` gets 403, a session with `admin` (or `superadmin`) is forwarded, and the same for `POST /demo/provision`
- [X] T051 [P] [US4] Add a test that a session with an empty or absent `roles` array is treated as having no roles — never as unrestricted (fail closed)
- [X] T052 [P] [US4] Add a codebase assertion for **SC-006**: no populated-but-unenforced authorization claim remains — i.e. `roles` now has a reader outside `auth.ts`

### Implementation

- [X] T053 [US4] Add the optional `requiredRole` field to `AllowEntry` in `foundry/packages/client/src/lib/proxy-allowlist.ts` and set it to `"admin"` on the two `/demo/*` entries
- [X] T054 [US4] Enforce `requiredRole` against `session.user.roles` in the proxy route, refusing with 403; treat `superadmin` as satisfying `admin`
- [X] T055 [US4] Add a comment at the enforcement point stating the gate's honest limit — it constrains the browser through the proxy, **not** a `PARENT_API_KEY` holder talking to `:4000` directly (Article XV; describing it more broadly would recreate the defect FR-014 removes)

**Checkpoint**: `roles` has exactly one enforcement point and a negative test; SC-006 satisfied.

---

## Phase 6: User Story 2 — Generation activity streamed only to entitled callers (P1)

**Goal**: the progress socket authenticates the upgrade, checks `Origin`, and
verifies entitlement.

**Runs last** because it has no consumer: least regression risk, most need for
its own test client.

**Independent test**: the FR-022 test client — every refusal path, driven over a
real socket.

**Contract**: [progress-socket-auth.contract.md](contracts/progress-socket-auth.contract.md)

### Ticket endpoint — tests first

- [X] T056 [US2] **(was falsely marked complete; written for real 2026-08-03)** Write `foundry/packages/server/src/auth/progress-ticket.test.ts`: minting requires the script to belong to the named workspace, the ticket is single-use with a 30s TTL and `script_id` set, and a script in another workspace is refused without revealing whether it exists
- [X] T057 [P] [US2] **(was falsely marked complete; written for real 2026-08-03)** Add route tests to `foundry/packages/server/src/routes/scripts.test.ts` (or a new sibling) asserting `POST /:scriptId/progress-ticket` requires `requireApiKey` and validates its params with V1's `validate()`

### Ticket endpoint — implementation

- [X] T058 [US2] Implement `foundry/packages/server/src/auth/progress-ticket.ts` as a thin wrapper over `workspace-credential.issue` with `audience:"ws_progress"`, `singleUse:true`, `ttlSeconds:30`, and the script-to-workspace check
- [X] T059 [US2] Add `POST /:scriptId/progress-ticket` to `foundry/packages/server/src/routes/scripts.ts`, behind `requireApiKey`, with `validate({params: scriptParamsSchema})` and a `bodyLimit` consistent with the other routes
- [X] T060 [P] [US2] Add the ticket-mint path to the proxy allowlist in `foundry/packages/client/src/lib/proxy-allowlist.ts` so the browser can obtain one (and T044's coverage test stays green)

### Socket — tests first (the FR-022 test client)

- [X] T061 [US2] Write `foundry/packages/server/src/ws/progress-server.test.ts` with a Node `ws` client against a real listener on an ephemeral port. Cover: no ticket, malformed ticket, `Origin` absent, `Origin` not allowlisted
- [X] T062 [P] [US2] Add the suffix-matching test: `Origin: http://evil-localhost:4002` must be refused when `http://localhost:4002` is allowed — exact match only, no suffix or wildcard logic
- [X] T063 [P] [US2] Add the ordering test that matters: a **bad `Origin` with a valid ticket** is refused **and the ticket remains unconsumed**, so a cross-site attempt cannot burn the legitimate client's single use
- [X] T064 [P] [US2] Add tests for cross-workspace subscription (ticket bound to a script in B, `scriptId` in A → refused, no event ever sent), ticket reuse, two concurrent upgrades with one ticket (exactly one wins), expired ticket, and an `mcp` credential presented as a ticket
- [X] T065 [P] [US2] Add the assertion that a refused upgrade produces a plain HTTP 401/403 with **no socket established** — never a `101` followed by an error frame, which is the current behaviour and is itself a disclosure
- [X] T066 [P] [US2] Add the happy-path test: a valid ticket subscribes and receives `{type:"progress",…}` with a payload shape identical to today's
- [X] T067 [P] [US2] **(was falsely marked complete; written for real 2026-08-03)** Add the FR-021 test: revoke the workspace credential mid-subscription and assert the socket closes with `1008` within one re-check period
- [X] T068 [P] [US2] Add the fail-closed test: with `WS_ALLOWED_ORIGINS` unset, every connection is refused

### Socket — implementation

- [X] T069 [US2] Convert `foundry/packages/server/src/ws/progress-server.ts` from `new WebSocketServer({ port, path })` to `{ noServer: true }` plus an explicit `http` server and an `upgrade` listener, so a refusal is an HTTP response before any handshake completes
- [X] T070 [US2] Implement the fixed check order — ticket shape → `Origin` → `verify` → atomic consume → subscribe — with `Origin` deliberately **before** the credential (T063 is the test that pins this)
- [X] T071 [US2] Implement exact-match `Origin` checking against `config.wsAllowedOrigins`, refusing a missing `Origin`, and logging plainly at startup when the list is empty so an operator is not left guessing why everything is refused
- [X] T072 [US2] Remove the existing "accept then send `{type:'error'}`" path (`progress-server.ts:16-20`) and destroy the socket on refusal instead
- [X] T073 [US2] Implement the 60-second re-check of the underlying workspace credential for live subscriptions, closing with `1008` on revocation or workspace deletion (FR-021)
- [X] T074 [US2] Update `foundry/packages/server/src/index.ts` for the new server construction signature, keeping `config.wsPort` as the port
- [X] T075 [US2] Confirm the payload shape on the wire is unchanged for entitled callers (FR-016) — the guard is on the upgrade, not the stream

**Checkpoint**: every refusal path in the contract has a passing test; no UI behaviour changed anywhere.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T076 Run the SC-007 discipline check by hand: delete each guard listed in [quickstart.md](quickstart.md#the-tests-that-must-fail-on-purpose) one at a time and confirm at least one test fails, reverting after each. A guard whose deletion leaves the suite green is untested no matter how many other tests pass
- [X] T077 Run `pnpm --filter @foundry/server test`, `--filter @foundry/mcp-bridge test`, `--filter @foundry/client test` and all three `typecheck`s; confirm V1's 194 server tests pass **untouched** (FR-016 / SC-008). If a V1 test needed editing, investigate rather than accommodate — it means valid-request behaviour changed
- [ ] T078 [P] Walk the UI manually per [quickstart.md](quickstart.md) §5: list workspaces, open one, add a tool, generate a script, watch progress, execute. Nothing may behave differently from before V2
- [X] T079 [P] Verify SC-001 by connecting to every published port (`4000`, `4001`, `3015`, `4002`) with no credential and confirming none returns product data
- [X] T080 [P] Grep for accidental leakage: no secret or token in any log line, and no `roles`-related copy anywhere claiming to protect the parent API
- [ ] T081 Update `docs/validation-and-guardrails-roadmap.md` to mark V2 done and record that R2 remains deliberately open (Q1), so the next reader does not assume identity is solved
- [X] T082 Run `/speckit-comply` and resolve CRITICAL findings before opening the PR (team rule 5)
- [X] T083 Commit each of the five plan slices separately on `krt/guardrail_validation`, only when green (working agreement for this programme); the bridge tool-contract change stays its own commit per T036
- [ ] T084 **After merge**, run `/speckit-update-standards` to amend `security.md`: R3 closes (with the role gate's honest limit stated), R2 stays open by decision, and the two new variables are added to the §4 inventory by NAME only

---

## Dependencies & Story Completion Order

```
Phase 1 (Setup)
      │
Phase 2 (Foundational — credential primitive)   ← blocks US1 and US2
      ├──────────────► Phase 3  US1  MCP bridge
      │                Phase 4  US3  proxy session + allowlist
      │                      └──► Phase 5  US4  role gate
      └──────────────► Phase 6  US2  progress socket
                                          │
                                    Phase 7 (Polish)
```

- **US1** needs Phase 2 only. Independently shippable.
- **US3** needs nothing from Phase 2 — it is client-side. Can run in parallel with Phase 3 if two people are working.
- **US4** needs US3's allowlist.
- **US2** needs Phase 2 (tickets are credentials) and T060 touches US3's allowlist.

## Parallel Opportunities

- **Phase 1**: T001, T002, T003, T005 are independent files.
- **Phase 2**: T013 alongside T012; T022 alongside T020/T021.
- **Phase 3**: T024–T028 are all separate test cases and can be written together.
- **Phase 4**: T038–T043 likewise; T044 is a separate file again.
- **Phase 6**: T062–T068 are independent cases in one new file — parallel if split by case.
- **Phases 3 and 4 are fully independent of each other** (different packages, no shared file). This is the largest parallelisation win available.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1).** That closes the single largest
exposure: a completely unauthenticated, host-published surface that enumerates
every workspace's schema. It is independently valuable and independently
shippable.

Then Phase 4 + 5 (US3, US4) as the second increment, and Phase 6 (US2) last.

**Non-negotiable at every increment**: FR-016 — no already-valid authenticated
request changes behaviour. V1's 194 tests are the tripwire, and they must pass
without modification.


---

## Phase 8: `/speckit-comply` remediation (2026-08-03)

`/speckit-comply` returned FAIL on V2 with 5 HIGH findings. The code was sound;
the bookkeeping was not. Phase 6 was marked complete in bulk **without
per-task verification**, and three tasks claimed tests that did not exist —
the same failure mode V1 shipped (49 green checkboxes over a live hole),
reproduced inside the task list of the feature written to prevent it.

T056, T057 and T067 above are un-marked and completed below.

- [X] T085 Write `foundry/packages/server/src/auth/progress-ticket.test.ts` (closes B1/T056): minting requires the script to belong to the named workspace; a script in another workspace is refused with the SAME null result as a nonexistent one, so the endpoint cannot enumerate script ids; the ticket is single-use, 30s, with `script_id` set
- [X] T086 Add `POST /:scriptId/progress-ticket` route tests in `foundry/packages/server/src/routes/progress-ticket.route.test.ts` (closes B2/T057): the `requireApiKey` gate, a 404 that does not reveal existence, and param validation via V1's `validate()`
- [X] T087 Make the revalidation interval injectable in `foundry/packages/server/src/ws/progress-server.ts` so FR-021 is testable — `REVALIDATE_MS` is exported but the interval is hard-wired, which is why the test was skipped rather than written
- [X] T088 Write the FR-021 test (closes B3/T067): revoke the workspace credential mid-subscription and assert the socket closes with `1008` within one re-check period. **FR-021 is implemented but unproven** until this passes, and an unproven guard is the exact defect V2 exists to remove
- [X] T089 [P] Add the SC-006 regression assertion (closes C2/T052): `roles` has a reader outside `auth.ts` (`route.ts:48`). The outcome holds today, but nothing stops that reader being deleted and the claim silently reverting to unenforced
- [X] T090 [P] Reference `foundry/packages/mcp-bridge/src/schema-store.ts` in T029 (closes A1) — it was changed to export `pool` but no task named it
- [X] T091 [P] Record in spec.md that US1 acceptance scenario 4 is unreachable by construction (closes C3): with `workspaceId` gone from the tool contract, "valid credential, nonexistent workspace" cannot be expressed. It reads as untested when it is resolved by design
- [ ] T092 Re-run `/speckit-comply` and verify each `[X]` in Phase 6 individually rather than in bulk

**Not fixed here**: D1 — `krt/guardrail_validation` has no merge base with
`origin/main` (unrelated histories), so `ci/check-standards-compliance.sh`
evaluated nothing and reported a vacuous "clean". Any PR-time diff gate is
equally blind on this branch. That is a branch-topology decision for the human,
not a code fix.
