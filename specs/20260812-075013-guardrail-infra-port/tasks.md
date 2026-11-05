---

description: "Task list for Guardrail Infrastructure Port (V1/V3/V6/V7 → v1-alpha)"

---

# Tasks: Guardrail Infrastructure Port (V1/V3/V6/V7 → v1-alpha)

**Input**: Design documents from `/specs/20260812-075013-guardrail-infra-port/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-response-contracts.md, quickstart.md — all present.

**Tests**: Included. Constitution Article II (Test-First) requires every behavior change ship with a test; this repo's own convention is colocated `*.test.ts` files, asserted at the wire with a real `app.listen()` + `fetch()` where a route is involved (precedent: `packages/server/src/routes/engine-addressing.test.ts`), not `supertest` (confirmed absent from the workspace).

**Organization**: By user story (P1/P1/P1/P2 per spec.md), preceded by Setup and Foundational phases. **Decision 5 (research.md) narrowed User Story 2's actual code scope** — the concurrency-ceiling half of FR-006 is already implemented three times over (`flow-chat.service.ts`, `flow-generation-job.service.ts`, `tenant-budget.service.ts`) and is deliberately not touched; only the auth-failure-throttle half (FR-007) is new work. This is reflected below, not in spec.md (which correctly states the *outcome*, already satisfied).

## Path Conventions

pnpm workspace monorepo, root-level `packages/*`. New package: `packages/shared`. Existing packages touched: `packages/server`, `packages/client`. Every path below is a real, audited path (research.md §Summary table), not a placeholder.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new `@foundry/shared` package, wired into the monorepo exactly like `@foundry/redact` (research.md Decision 4).

- [X] T001 Create `packages/shared/package.json` (copy `packages/redact/package.json` verbatim, rename `"name"` to `"@foundry/shared"`, reset `"version"` to `"0.1.0"`) and `packages/shared/tsconfig.json` (copy `packages/redact/tsconfig.json` verbatim — no changes needed, same `NodeNext`/`declaration: true`/test-exclusion shape).
- [X] T002 Create `packages/shared/src/index.ts` re-exporting the four submodules (`validation`, `rate-limit`, `egress`, `rules`) — empty barrel exports for now, filled in by T007/T010/T013/T018.
- [X] T003 Add `"@foundry/shared": "workspace:*"` to `packages/server/package.json` and `packages/client/package.json` dependencies; add `packages/shared` to root `package.json`'s `postinstall` build-order filter list alongside `@foundry/redact`/`@foundry/flow-edit` (depends on: T001, T002).
- [X] T004 Run `pnpm install` at repo root and confirm `packages/shared/dist/` builds and `node_modules/@foundry/shared` resolves from both `packages/server` and `packages/client` (depends on: T003).

**Checkpoint**: `@foundry/shared` exists, builds, and is importable from both consumers. No behavior change yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Request id and the error-leak fix are used by every user story's rejection paths (FR-003/FR-004) — built once, here, not per-story.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T005 [P] Write `packages/server/src/middleware/request-id.middleware.test.ts`: assert a fresh UUID is set on `req.id` and echoed as the `X-Request-Id` response header even when the caller supplies its own `X-Request-Id` header (server-generated-only, research.md Decision 6) — write this test first, confirm it fails (module doesn't exist yet).
- [X] T006 Implement `packages/server/src/middleware/request-id.middleware.ts`: `requestId` middleware using `crypto.randomUUID()`, sets `req.id` (add the `declare global { namespace Express { interface Request { id: string } } }` augmentation matching the existing pattern in `identity.middleware.ts`/`step-token.middleware.ts`) and the `X-Request-Id` response header (depends on: T005 — makes it pass).
- [X] T007 Mount `requestId` first in `packages/server/src/app.ts` (before the existing permissive-CORS middleware) — the only structural change to this file's middleware order (depends on: T006).
- [X] T008 [P] Extend `packages/server/src/middleware/error.middleware.test.ts` with two new cases: an error with `statusCode >= 500` and an error with no `statusCode` at all must both produce `{ error: "internal_error", requestId: "<uuid>" }` with **no** `message` field, while the real message is logged via `console.error` (spy-asserted) tagged with `req.id` — write first, confirm it fails against current behavior (§5 of research.md: it currently leaks `err.message`).
- [X] T009 Fix `packages/server/src/middleware/error.middleware.ts`'s two leaking branches (the `statusCode >= 500` branch and the untyped fallback) per `contracts/http-response-contracts.md`'s "5xx fallback" contract — read `req.id` (now available post-T007) instead of emitting `message` in the response body (depends on: T007, T008 — makes it pass). **Do not touch** the `ZodError` or `TetherError` branches, or the 4xx `request_error` branch — none of those leak today and none are in scope.

**Checkpoint**: Every response now carries `X-Request-Id`; no 5xx response leaks a raw error message. Existing `error.middleware.test.ts` cases for `ZodError`/`TetherError`/4xx must still pass unchanged — run `pnpm --filter @foundry/server test -- error.middleware` before proceeding.

---

## Phase 3: User Story 1 - Malformed requests rejected before reaching a service or the database (Priority: P1) 🎯 MVP

**Goal**: Close the two measured validation gaps (`catalogue.ts`, `ops-proxy.ts`'s `/llm/*` routes) with a small shared validation module — without touching the ~20 routes that already validate correctly with inline `zod` (research.md Decision 3).

**Independent Test**: `GET /api/workspaces/not-a-uuid/catalogue` returns 400 naming the field, not a 500; `PUT /api/ops/llm/provider` with a non-string `baseUrl` returns 400; a well-formed request to either route is byte-identical to pre-feature behavior.

### Tests for User Story 1

- [X] T010 [P] [US1] Write `packages/shared/src/validation/validation.test.ts`: unit tests for the `validate({params, query, body})` middleware factory — a schema mismatch calls `next(err)` with a shape `error.middleware.ts`'s existing `ZodError` branch already handles (no new response-shape branch needed there); a schema match calls `next()` with no error.
- [X] T011 [P] [US1] Write `packages/server/src/routes/catalogue.test.ts` (new file, pattern from `engine-addressing.test.ts`: mount `catalogueRouter` on a fresh `express()`, real `app.listen(0, "127.0.0.1")`, real `fetch`): a non-UUID `workspaceId` returns 400 with `{ error: "validation_error", ... }`; a valid UUID reaches `flowCatalogueService.forWorkspace` unchanged (spy-asserted, matching the existing mock-the-service/assert-the-wire convention).
- [X] T012 [P] [US1] Write `packages/server/src/routes/ops-proxy.test.ts` (new file, same pattern): `PUT /llm/provider` with `baseUrl` missing/non-string/empty returns 400; a well-formed body reaches `opsClient.llm.*` unchanged.

### Implementation for User Story 1

- [X] T013 [US1] Implement `packages/shared/src/validation/index.ts`: the `validate({params, query, body})` middleware factory, parsing each present schema against `req.params`/`req.query`/`req.body` and calling `next(zodError)` on failure so the response flows through the pre-existing `ZodError` branch in `error.middleware.ts` (no duplicate response-shape code) (depends on: T010 — makes it pass).
- [X] T014 [US1] Add a `workspaceId: z.string().uuid()` params schema to `packages/server/src/routes/catalogue.ts`, applied via `validate({ params: ... })` from `@foundry/shared` (depends on: T011, T013 — makes T011 pass).
- [X] T015 [US1] Add a zod body schema to `packages/server/src/routes/ops-proxy.ts`'s `PUT /llm/provider`, `POST /llm/models`, and `POST /llm/test` (replacing the manual `String(b.baseUrl ?? "")`-style coercion with `validate({ body: ... })` from `@foundry/shared`) — `baseUrl` required non-empty string, `apiKey` optional string (depends on: T012, T013 — makes T012 pass).

**Checkpoint**: US1 independently functional — `catalogue.ts` and `ops-proxy.ts`'s LLM routes now reject malformed input at the boundary; every other route is untouched.

---

## Phase 4: User Story 2 - Expensive or abusable operations are rate-limited and capacity-bounded (Priority: P1)

**Goal**: Add auth-failure logging + throttling (the one genuinely open part of FR-005/FR-007). **Do not** build a new rate limiter or concurrency ceiling for flow generation or execution starts — `flow-chat.service.ts`, `flow-generation-job.service.ts`, and `tenant-budget.service.ts` + `routes/executions.ts` already implement FR-006 completely (research.md Decision 5). This story's implementation tasks are therefore narrower than the sample template shape.

**Independent Test**: Repeated bad API keys from one IP are logged per-attempt and 429'd with `Retry-After` once a threshold is crossed; a single bad attempt still gets a plain 401 (no premature throttling); legitimate traffic is unaffected.

### Tests for User Story 2

- [X] T016 [P] [US2] Write `packages/shared/src/rate-limit/rate-limit.test.ts`: `authFailureThrottle({windowMs, max}).isThrottled(ip)` is `false` until `recordFailure(ip)` has been called `max` times within `windowMs`, then `true`; resets after the window elapses.
- [X] T017 [US2] Write `packages/server/src/middleware/auth.middleware.test.ts` (new file) and extend `packages/server/src/middleware/identity.test.ts`: `requireApiKey`/`resolveIdentity` on a bad credential call `recordFailure(req.ip)` and log (spy-asserted) with IP + path + timestamp, never the presented key/token value; once throttled, the response is 429 with `Retry-After` instead of 401; a single failure is still a plain 401.

### Implementation for User Story 2

- [X] T018 [US2] Implement `packages/shared/src/rate-limit/index.ts` and `packages/shared/src/rate-limit/rules.ts`: `authFailureThrottle(rule)` returning `{ recordFailure(ip), isThrottled(ip) }` over an in-memory sliding-window `Map` (research.md Decisions 1, 5, 6) (depends on: T016 — makes it pass).
- [X] T019 [US2] Wire a single shared `authFailureThrottle` instance into `packages/server/src/middleware/auth.middleware.ts`'s failure branch (log + `recordFailure` + check `isThrottled` before the 401) (depends on: T017, T018).
- [X] T020 [US2] Wire the same instance into `packages/server/src/middleware/identity.middleware.ts`'s `resolveIdentity`/`requireIdentity` failure branches (depends on: T017, T018, T019 — share the one `authFailureThrottle` instance, not two independent throttles keyed the same way).
- [X] T021 [US2] Regression check (no new code): run `pnpm --filter @foundry/server test -- flow-chat.service`, `pnpm --filter @foundry/server test -- flow-generation-job.service`, and `pnpm --filter @foundry/server test -- executions` and confirm all pass unchanged — documents that FR-006's concurrency-ceiling half is satisfied by pre-existing code, per research.md Decision 5, with no code task needed to satisfy it.

**Checkpoint**: US2 independently functional — auth failures are diagnosable and throttled; generation/execution concurrency ceilings continue working exactly as before (verified, not modified).

---

## Phase 5: User Story 3 - The server never dials an operator-supplied address without checking it first (Priority: P1)

**Goal**: Generalize the existing `NEVER_A_DATABASE` classifier into a shared, two-profile egress checker (research.md Decision 2), apply the `strict` profile to the three genuinely open gaps, and re-check at dial time via a `guardedFetch` wrapper (FR-008).

**Independent Test**: Registering a poll trigger/tool endpoint/LLM `baseUrl` pointed at a private/loopback/link-local address is rejected; a public address is unaffected; a mocked DNS change between registration and dial is still caught at dial time.

### Tests for User Story 3

- [X] T022 [P] [US3] Write `packages/shared/src/egress/egress.test.ts`: `classifyHost(host, STRICT)` denies loopback/link-local/RFC1918; `classifyHost(host, PERMISSIVE)` denies loopback/link-local but allows RFC1918 (byte-for-byte the existing `datasource-target.service.ts` behavior — assert against the same fixture hosts that file's own tests use, so the two are provably equivalent for the permissive case).
- [X] T023 [P] [US3] Write a `guardedFetch` test in the same file: given a host that resolves to a public address at "registration" and a private address at "dial" (mocked DNS), `guardedFetch` rejects at dial time even though a prior `classifyHost` call on the same host succeeded — the DNS-rebinding case User Story 3 exists to close.
- [X] T024 [P] [US3] Extend `packages/server/src/services/trigger-scheduler.test.ts`: a poll trigger whose `config.url` resolves to a private/loopback/link-local address is never dialed (the `fetch` spy is never called); a public URL is dialed exactly as before.
- [X] T025 [P] [US3] Extend `packages/server/src/services/step-execution.service.test.ts`: a tool whose `tool.url` resolves to a private/loopback/link-local address is refused before the outbound call; an existing tool-call test with a public/mocked URL still passes unchanged.
- [X] T026 [P] [US3] Extend `packages/server/src/routes/ops-proxy.test.ts` (from T012): `PUT /llm/provider` with a `baseUrl` resolving to a private/loopback/link-local address returns the `egress_rejected` shape from `contracts/http-response-contracts.md`; a public `baseUrl` is unaffected.

### Implementation for User Story 3

- [X] T027 [US3] Implement `packages/shared/src/egress/index.ts`: `classifyHost(host, profile)` generalized from `packages/server/src/services/datasource-target.service.ts:403-424`'s `NEVER_A_DATABASE` logic, parameterized by `STRICT`/`PERMISSIVE` `EgressPolicyProfile` (research.md Decision 2, data-model.md) (depends on: T022 — makes it pass). **Do not modify `datasource-target.service.ts` itself** — it keeps its own implementation; this is a new, separate generalization (research.md Decision 2's explicit scope boundary).
- [X] T028 [US3] Implement `guardedFetch(url, init, profile)` in the same module: re-resolves and re-classifies the host immediately before calling the underlying `fetch` (depends on: T023, T027 — makes T023 pass).
- [X] T029 [US3] Replace the bare `fetch(cfg.url, ...)` call in `packages/server/src/services/trigger-scheduler.ts:98` with `guardedFetch(cfg.url, ..., STRICT)` (depends on: T024, T028 — makes T024 pass).
- [X] T030 [US3] Replace the bare `fetch(url, ...)` calls in `packages/server/src/services/step-execution.service.ts:254,279` (tool endpoint invocation) with `guardedFetch(url, ..., STRICT)` (depends on: T025, T028 — makes T025 pass). **Do not touch** `step-execution.service.ts:415`'s `pg.Client` datasource dial — that path relies on `datasource-target.service.ts`'s existing, separately-scoped check (research.md Decision 2), not this one.
- [X] T031 [US3] Add a zod-validated, `STRICT`-checked `baseUrl` to `packages/server/src/routes/ops-proxy.ts`'s `PUT /llm/provider` (building on T015's schema from Phase 3 — add the egress check as an additional `validate`/service-layer step, not a second schema) (depends on: T026, T027).

**Checkpoint**: US3 independently functional — the three named call sites are guarded at both registration and dial time; `datasource-target.service.ts` and its tests are untouched and still green.

---

## Phase 6: User Story 4 - Client and server validate requests against the exact same rules (Priority: P2)

**Goal**: Close the two documented client/server rule-duplication risks (`ENV_NAME_RE` in `secret-edit.ts` and `tool-edit.ts`, `AUTH_STYLES` in `tool-edit.ts`) by moving them into `@foundry/shared` and re-exporting from both sides.

**Independent Test**: An equivalence test proves the client and server consumers of `ENV_NAME_RE`/`AUTH_STYLES` produce identical accept/reject decisions for the same fixed input set, sourced from one shared implementation.

### Tests for User Story 4

- [X] T032 [P] [US4] Write `packages/shared/src/rules/rules.test.ts`: fixed input fixtures for `ENV_NAME_RE` (valid/invalid env names) and `AUTH_STYLES` (the four existing styles + one invalid), asserting the exported values directly — this is SC-006's equivalence test in its simplest correct form (one shared implementation, two importers, no drift possible by construction rather than by a duplicated-and-compared test).

### Implementation for User Story 4

- [X] T033 [P] [US4] Implement `packages/shared/src/rules/index.ts`: export `ENV_NAME_RE` and `AUTH_STYLES`, sourced by reading the current values out of `packages/server/src/services/tool.service.ts` (the server's authoritative `AUTH_STYLES` list, per the audit) and `packages/client/src/lib/secret-edit.ts`'s existing `ENV_NAME_RE` (depends on: T032 — makes it pass).
- [X] T034 [US4] Update `packages/client/src/lib/secret-edit.ts` to import `ENV_NAME_RE` from `@foundry/shared` instead of defining its own copy; remove the now-redundant local definition and its drift-risk comment (depends on: T033).
- [X] T035 [US4] Update `packages/client/src/lib/tool-edit.ts` to import `ENV_NAME_RE` and `AUTH_STYLES` from `@foundry/shared` instead of defining its own mirrored copies; remove the now-redundant local definitions and the docblock warning about drift (the warning is resolved, not just documented) (depends on: T033, T034).
- [X] T036 [US4] Update `packages/server/src/services/tool.service.ts` to import `AUTH_STYLES` from `@foundry/shared` as its own source, so the server is not the last remaining independent copy once the client imports from the shared package (depends on: T033).
- [X] T036b [US4] **Discovered during implementation, not in the original scope**: `packages/client/src/app/(app)/keys/page.tsx:92` has a THIRD, independent `ENV_NAME_RE` copy (`/^[A-Z][A-Z0-9_]{0,63}$/`) that diverges from the server's real rule (`workspace-secret.service.ts:31`, `/^[A-Za-z_][A-Za-z0-9_]*$/`) — it's stricter than the server (uppercase-only, length-capped), so it rejects some names the server would accept: a real, previously-silent client/server drift, exactly what SC-006 exists to catch. Migrate it to import from `@foundry/shared` alongside the two already-tracked copies.

**Checkpoint**: All four user stories independently functional. `ENV_NAME_RE`/`AUTH_STYLES` exist in exactly one place.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Repo-wide verification and documentation currency (Constitution Article VII).

- [X] T037 Run the full regression procedure from `quickstart.md`'s "Full regression check (SC-007)" section — `pnpm -r test` before/after comparison — and confirm the only diffs are new test files/cases from T005–T036, nothing pre-existing changed outcome.
- [X] T038 [P] Run `pnpm -r typecheck` and `pnpm -r lint` (or the closest equivalent scripts confirmed present in each `package.json`) across `packages/shared`, `packages/server`, `packages/client`.
- [X] T039 [P] Update `CLAUDE.md`'s `v1-alpha`-relevant section (or the nearest current doc-of-record for `v1-alpha`, confirmed at implementation time — this repo's `CLAUDE.md` as read during planning describes the *other* branch's programmes, not `v1-alpha`'s; determine during implementation whether `v1-alpha` has its own `CLAUDE.md`/`AGENTS.md` and update that instead) to record: the new `@foundry/shared` package, the request-id/error-leak fix, auth-failure throttling, the egress/SSRF profiles and their three guarded call sites, and the explicit statement that flow-generation/execution concurrency ceilings were audited and found already correct (Constitution Article VII — docs updated in the same PR as the behavior).
- [X] T040 Run `quickstart.md` end-to-end by hand (or via the `curl` commands it documents) against a locally running `v1-alpha` server to confirm every user story's Independent Test passes as written.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (needs `packages/shared` to exist for later stories, though T005–T009 themselves touch only `packages/server`). Blocks all user stories.
- **User Stories (Phase 3–6)**: All depend on Foundational completion. US1/US2/US3 (all P1) have no dependencies on each other and can proceed in parallel. US4 (P2) is independent of US1–3 but naturally lands last since it's lower priority.
- **Polish (Phase 7)**: Depends on all four user stories being complete.

### Within Each User Story

Tests before implementation (write-first-and-confirm-failing, per Constitution Article II and this repo's own convention). Shared-package implementation before the server/client call sites that consume it. Story complete before its checkpoint.

### Parallel Opportunities

- T005 and T008 (Phase 2 tests, different files) — parallel.
- T010, T011, T012 (US1 tests, three different files) — parallel.
- T016 (US2 test) is independent of US1/US3 test tasks — parallel across stories.
- T022, T023, T024, T025, T026 (US3 tests, five different files) — parallel.
- T032 (US4 test) — parallel with any other story's tests.
- T038, T039 (Phase 7) — parallel.

---

## Parallel Example: User Story 3

```bash
# Launch all US3 tests together (five different files, no inter-dependencies):
Task: "egress.test.ts — classifyHost STRICT/PERMISSIVE"
Task: "egress.test.ts — guardedFetch dial-time re-check"
Task: "trigger-scheduler.test.ts — poll trigger egress refusal"
Task: "step-execution.service.test.ts — tool-call egress refusal"
Task: "ops-proxy.test.ts — LLM baseUrl egress refusal"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (US1) — the validation-kernel gaps close; request id and non-leaking errors are already live from Phase 2.
3. **STOP and VALIDATE**: run `quickstart.md`'s User Story 1 section by hand.

### Incremental Delivery

1. Setup + Foundational → foundation ready (request id, no leaking 5xx).
2. US1 → validate independently → this is the MVP.
3. US2 → auth-failure throttling lands; existing concurrency ceilings reconfirmed untouched.
4. US3 → egress/SSRF profiles land on the three open gaps.
5. US4 → shared rules close the last duplication risk.
6. Polish → full regression, doc currency, manual quickstart walkthrough.

## Notes

- [P] tasks touch different files with no completed-task dependency between them.
- Every task names a real, audited file path — none are placeholders.
- **Decision 5 is the one deviation from a "textbook" task list**: User Story 2's implementation section is deliberately short (3 code tasks + 1 verification task) because the bulk of FR-006 was found already satisfied during planning. This is recorded here rather than silently generating padding tasks to make the phase "look" as substantial as the others.
- Commit after each task or logical group, per standing project convention — not automated by this file.
