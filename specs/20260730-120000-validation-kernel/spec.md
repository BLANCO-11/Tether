# Feature Specification: Validation Kernel & Request Boundary Hardening

**Feature Branch**: `krt/guardrail_validation`

**Created**: 2026-07-30

**Status**: Draft

**Input**: User description: "Validation kernel and request-boundary hardening for the Foundry parent API: shared zod primitives in a src/validation/ module, a declarative validate({params,query,body}) middleware applied to every mounted Express route including path params, replacement of the hand-rolled validators in routes/stub-api.ts with the shared primitives, a non-leaking errorHandler contract (opaque 500s, stable 400 shape with a request-id correlation token), and per-route body-size limits. Closes holes 1, 2, 6, and 8 (partly) from docs/validation-and-guardrails-roadmap.md §V1."

## Context

This is **V1 of the Validation & Guardrails roadmap** (`docs/validation-and-guardrails-roadmap.md`). It establishes the validation infrastructure the rest of the programme reuses. Nothing here touches auth, rate-limiting, prompt-boundary, or execution-boundary controls — those are V2–V6.

Four holes from the current-state audit are in scope:

- **Hole 1** — path params (`workspaceId`, `scriptId`, `dsId`, `tid`, `id`) are never validated; a non-UUID surfaces as a Postgres driver 500.
- **Hole 2** — the highest-consequence routes (`POST /:scriptId/execute`, `POST /:tid/fire`, `POST /api/triggers/:token/webhook`, `routes/stubs.ts`) accept unvalidated bodies.
- **Hole 6** — `errorHandler` leaks: it echoes `err.message` on 500 and returns the raw `TetherError` upstream body to callers.
- **Hole 8 (partly)** — status-enum columns (`scripts.status`, `triggers.type`, `execution_results.status`, `audit_verdict`) are plain `varchar`; a manual write can persist a value no code path can interpret.

Two cross-cutting decisions settled here (see roadmap §V1 "Decisions to make in /speckit-plan"):

- **Schema location**: the standard (`security.md §5`) says schemas live at the route boundary, not in services; but they currently live in services. This feature moves them to a `src/validation/` module.
- **Request IDs**: V3 owns rate-limiting and request-id infrastructure, but V1 needs a request ID to make opaque 500s diagnosable. V1 pulls request-ID generation forward as the minimal slice V3 will extend.

---

## User Scenarios & Testing

### User Story 1 — Malformed path params return 400, not 500 (Priority: P1)

A developer calls `GET /api/workspaces/not-a-uuid/scripts` or any other route with a non-UUID path parameter. Today that request reaches Postgres and returns a 500 with the driver's error message in the body. After this feature, it returns a structured 400 response that names the invalid field, without any server internals leaking.

**Why this priority**: A 500 that echoes a Postgres error message is the most visible surface defect — it is exploitable for information gathering and it is the kind of thing a security review flags immediately. It is also the simplest fix once the middleware exists.

**Independent Test**: Can be fully tested against a running server (or a test harness) by sending a request with `"not-a-uuid"` in any path-param position and asserting the status is 400 and the body matches `{error: "validation_error", issues: [...]}`.

**Acceptance Scenarios**:

1. **Given** a mounted route with a `:workspaceId` path parameter, **When** a caller sends `GET /api/workspaces/not-a-uuid/scripts`, **Then** the response is `400` with body `{error: "validation_error", issues: [{path: ["params", "workspaceId"], ...}]}` and no Postgres or stack-trace text appears anywhere in the response.
2. **Given** any route with a UUID path param, **When** a well-formed UUID is supplied, **Then** the response is identical to today's (no behaviour change for valid requests).
3. **Given** a route with `:scriptId`, `:dsId`, `:tid`, `:id` path params, **When** each is tested independently with an invalid value, **Then** each returns 400 naming its own field.

---

### User Story 2 — High-consequence request bodies are validated at the route boundary (Priority: P1)

An operator or automated caller sends a request to `POST /:scriptId/execute`, `POST /:tid/fire`, `POST /api/triggers/:token/webhook`, or a stub route with an unexpected or oversized body. Today those bodies are forwarded to services or container stdin without validation. After this feature, unrecognised fields, wrong types, or over-limit bodies are rejected at the route boundary before any downstream action is taken.

**Why this priority**: These routes reach execution. A bad `network` value or an unbounded `event` payload flowing into Docker run or a trigger fire is a correctness and safety issue, not merely a usability one.

**Independent Test**: Can be tested by sending a request with `network: "host"` to the execute route (rejected), an object instead of an allowed-shape body to the fire route, and a 2 MB payload to the webhook route (rejected by per-route limit before the body is parsed).

**Acceptance Scenarios**:

1. **Given** `POST /:scriptId/execute`, **When** the body contains `{network: "host"}`, **Then** the response is `400 validation_error` and no Docker run is attempted.
2. **Given** `POST /:scriptId/execute`, **When** the body is `{event: <any JSON value>}`, **Then** the request is accepted (the `event` field is intentionally free-form; only the envelope is validated, not the shape of `event`).
3. **Given** `POST /api/triggers/:token/webhook`, **When** the body exceeds the per-route size limit, **Then** the response is `413` before the body is parsed — no payload is stored.
4. **Given** `routes/stubs.ts` query and body params, **When** a caller supplies an out-of-range or wrong-type value, **Then** the response is `400 validation_error` instead of an unhandled exception.
5. **Given** any validated route, **When** a valid well-formed request is sent, **Then** the response is identical to today's (no behaviour change for valid requests).

---

### User Story 3 — Server errors don't leak internals; they're diagnosable from logs (Priority: P2)

A caller triggers an unexpected server error (bug, upstream failure, database error). Today the response body echoes `err.message` or the full `TetherError` upstream body. After this feature, the response contains only an opaque error code and a request ID that a server-side operator can correlate with the full logged context. The full error is logged server-side.

**Why this priority**: Information leakage through error messages is a well-known attack vector. However, fixing it without request IDs would make the system harder to debug. Request IDs make the tradeoff safe.

**Independent Test**: Can be tested by inducing a 500 (e.g., by stopping the database connection mid-request) and asserting that the response body contains a `requestId` field but does not contain any stack trace, database error, or upstream response body.

**Acceptance Scenarios**:

1. **Given** an unexpected internal error, **When** the error handler responds, **Then** the body is `{error: "internal_error", requestId: "<uuid>"}` — no `message`, no stack trace, no upstream body.
2. **Given** a `TetherError` from the upstream runtime, **When** the error handler responds, **Then** the body is `{error: "upstream_error", requestId: "<uuid>"}` and the upstream status and body are logged server-side only.
3. **Given** a Zod validation error, **When** the error handler responds, **Then** the body is `{error: "validation_error", issues: [{path, code, message}]}` — the existing stable shape is preserved; no request ID is needed on a 400.
4. **Given** a request, **When** the request ID is set, **Then** it appears in the response as `X-Request-Id` header on every response (success and error alike), and in the server-side log at the start of request processing.

---

### User Story 4 — Stub-API hand-rolled validators are replaced by shared primitives (Priority: P2)

A developer reading `routes/stub-api.ts` sees `intParam`, `enumParam`, date regexes and `EMAIL_RE` — a validation vocabulary inconsistent with the rest of the API. After this feature, those validators are rewritten using the shared `src/validation/` primitives, so there is one validation vocabulary, the caps are preserved, and the behaviour is identical for valid requests.

**Why this priority**: Consistency is a correctness property here — the hand-rolled validators apply different rules than Zod, increasing the chance of drift. But behaviour is preserved, so this is lower risk than holes 1/2/6.

**Independent Test**: Can be tested by running the existing stub-api functionality and asserting that all previously valid stub calls still succeed and that invalid values (bad dates, out-of-range limits, invalid emails) still produce 400 responses.

**Acceptance Scenarios**:

1. **Given** a stub-api route that previously used `intParam()`, **When** a string is supplied where an integer is expected, **Then** the response is `400 validation_error` (same as before, new implementation).
2. **Given** the email recipients cap (50), **When** 51 recipients are supplied, **Then** the response is `400` — the cap is preserved.
3. **Given** a valid stub-api request that succeeded today, **When** the same request is sent after this feature, **Then** it still succeeds with the same response shape.

---

### User Story 5 — Status-enum DB columns carry CHECK constraints (Priority: P3)

A developer or operator writes directly to the database (e.g., in a migration or a manual fix) and mistypes a status value. Today that value is stored and then silently breaks any code path that matches on the enum. After this feature, the database rejects the write with a constraint violation.

**Why this priority**: This is a defence-in-depth measure against a class of bugs that is hard to reproduce and easy to overlook. It doesn't affect the normal request path at all.

**Independent Test**: Can be tested by attempting to insert a row with an invalid `scripts.status` value directly via a database client and asserting the insert is rejected with a constraint violation.

**Acceptance Scenarios**:

1. **Given** the `scripts.status` column, **When** a value not in `{pending, generating, completed, failed}` is written, **Then** Postgres rejects it with a check-constraint violation.
2. **Given** the `execution_results.status` column, **When** an invalid value is written, **Then** Postgres rejects it.
3. **Given** the `test_results.audit_verdict` column, **When** a value not in `{clean, warn, fail}` is written, **Then** Postgres rejects it.
4. **Given** a normal application write that supplies a valid status, **When** the write executes, **Then** it succeeds as before.

---

### Edge Cases

- What happens when the body-size limit is hit before the JSON parser runs? The 413 must be returned before any body parsing and before any service call.
- What if a UUID path param contains valid UUID characters but is the wrong version or variant? The `zUuid` primitive MUST use RFC 4122 UUID format validation (standard UUID regex or `z.string().uuid()`). Postgres `uuid` type accepts any RFC 4122 UUID, so this is consistent.
- What if the hand-rolled stub validators and the new Zod validators differ in edge cases? The Zod implementation takes precedence; if a previously-accepted value is now rejected, that is an intentional tightening (not a regression) and must be noted in the plan.
- What if an unhandled rejection outside `asyncHandler` reaches the error middleware? The opaque-500 rule applies regardless of how the error reached the handler.
- Does the `event` body on execute have any size limit? Yes — an envelope-level byte cap is applied (size limit in bytes; the exact value is decided in the plan). The shape of `event` is NOT validated.

---

## Requirements

### Functional Requirements

- **FR-001**: The system MUST expose a `src/validation/` module containing shared Zod primitives: `zUuid`, `zEnvVarName`, `zIdentifier`, `zHttpUrl`, `zPositiveInt`, `zIsoDate`, and `zNetworkMode` (the allowed values for the execute route's `network` field). No other module invents its own versions of these.
- **FR-002**: The system MUST provide a `validate({params, query, body})` middleware factory that parses its Zod schemas against `req.params`, `req.query`, and `req.body` respectively. A route that passes a schema for a segment is validated; omitting a segment leaves it unvalidated. A validation failure calls `next(error)` with the ZodError so the error middleware handles it uniformly.
- **FR-003**: Every mounted Express route that accepts path parameters MUST pass a `params` schema to `validate()` using `zUuid` (or the appropriate primitive) for each parameter. A route with path params that has no `params` schema is a defect detectable by grep.
- **FR-004**: `POST /:scriptId/execute` MUST validate its body as `{network?: zNetworkMode, event?: z.unknown()}` — the envelope is validated; the value of `event` is NOT further constrained, because it is the script's own input. An explicit byte-cap is applied. This intentional decision MUST be documented in a comment at the route and in the plan, so a future reviewer does not "fix" it.
- **FR-005**: `POST /:tid/fire` MUST validate its body; the payload field is accepted as an optional `z.unknown()` (intentionally free-form, same rationale as `event`).
- **FR-006**: `POST /api/triggers/:token/webhook` MUST have a per-route body-size limit significantly smaller than the global 2 MB limit; the whole body is stored and then forwarded to a script.
- **FR-007**: `routes/stubs.ts` query and body parameters MUST be validated using the shared Zod primitives. Hand-rolled validators (`intParam`, `enumParam`, date regexes, `EMAIL_RE`) are replaced.
- **FR-008**: The caps in `routes/stub-api.ts` (recipients ≤ 50, attachments ≤ 10, `limit` 1–200 or 1–500) MUST be preserved as Zod refinements. Removing or relaxing a cap is a defect.
- **FR-009**: A request-ID middleware MUST assign a UUID to every inbound request, accessible as `res.locals.requestId` (or equivalent). The request ID MUST appear in the `X-Request-Id` response header on every response and in the server-side log at the start of processing.
- **FR-010**: The `errorHandler` MUST NOT echo `err.message` in the response body for 500-class errors. Instead it returns `{error: "internal_error", requestId: "<uuid>"}`. The full error (message, stack) MUST be logged server-side with the request ID.
- **FR-011**: The `errorHandler` MUST NOT return the `TetherError` upstream body or status to the caller. It returns `{error: "upstream_error", requestId: "<uuid>"}` with HTTP status 502. The upstream body and status are logged server-side.
- **FR-012**: The `errorHandler` 400 path (ZodError) MUST preserve the existing `{error: "validation_error", issues: [{path, code, message}]}` shape. No breaking change to the 400 contract.
- **FR-013**: DB migrations MUST add `CHECK` constraints to `scripts.status` (values: `pending|generating|completed|failed`), `triggers.type` (values matching the current enum), `execution_results.status` (values: `pending|running|succeeded|failed`), and `test_results.audit_verdict` (values: `clean|warn|fail`). The existing Drizzle enum definitions are updated to match.
- **FR-014**: A Vitest configuration file for `packages/server` MUST be added so server-side tests can be run with `pnpm test` in that package. There is currently no `vitest.config.ts` in `packages/server`.
- **FR-015**: A table-driven test suite MUST assert that every mounted route with a UUID path param returns 400 (not 500) when the param is an invalid value. The test is the mechanism that makes "every route is covered" auditable — a route added without a `validate()` call is caught when its test is written.
- **FR-016**: Per-route body-size limits MUST be applied to routes where the global `2mb` limit is excessive. At minimum: `POST /:tid/fire`, `POST /api/triggers/:token/webhook`, stub routes.

### Key Entities

- **Validation module** (`src/validation/index.ts`): a pure module exporting Zod primitives and the `validate()` middleware factory. No imports from Express routes or services; routes import from it.
- **Request ID**: a UUID generated per request, threaded through `res.locals`, the `X-Request-Id` header, and the server log.
- **DB CHECK constraint**: a database-level constraint on a status-enum column that rejects any value outside the allowed set.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every route with a UUID path param returns `400` (not `500`) when that param is non-UUID — verifiable by a table-driven test that iterates all mounted routes.
- **SC-002**: No 500 response body contains `err.message`, a Postgres driver error string, or a `TetherError` upstream body — verifiable by an error-middleware unit test that checks the response shape and asserts the absence of those fields.
- **SC-003**: Every 500 response body contains a `requestId` field whose value appears in the server log — verifiable by a test that induces a 500 and asserts the field is present and parseable as a UUID.
- **SC-004**: `grep -r 'intParam\|enumParam\|EMAIL_RE' packages/server/src/routes/` returns zero hits after this feature — the hand-rolled validators are fully replaced.
- **SC-005**: `grep -r '\.parse(req\.' packages/server/src/routes/` returns zero hits — no route calls `.parse()` directly; all validation goes through `validate()`.
- **SC-006**: Attempting to write an invalid status value to any constrained column via a direct DB client returns a constraint-violation error — verifiable by a migration smoke-test or a repository test.
- **SC-007**: `pnpm test` in `packages/server` exits 0 — the Vitest config exists, the test suite runs, and all tests pass.
- **SC-008**: All existing integration paths (workspace → tool → datasource → generate → execute → trigger → fire) behave identically to today for valid inputs — no behaviour change for valid requests.

---

## Assumptions

- The existing Zod schemas in `workspace.service.ts`, `datasource.service.ts`, `tool.service.ts`, `trigger.service.ts`, `workspace-secret.service.ts`, `script-generation.service.ts` are moved to `src/validation/` as route-level schemas without behaviour change. The service functions themselves become schema-free; callers pass validated data.
- The `network` field on the execute route currently accepts arbitrary strings. The allowed values are `none` and `bridge` (matching `execution.service.ts`). If there are other valid values, the plan will enumerate them.
- The `zNetworkMode` primitive is defined as `z.enum(["none", "bridge"])` unless the code audit in the plan reveals additional values.
- Body-size limits for the constrained routes: webhook ≤ 64 KB, fire ≤ 64 KB, stub routes ≤ 512 KB. These are reasonable defaults; the plan may adjust based on observed payload sizes.
- "Partly closes hole 8" means adding DB CHECK constraints for the four status columns. Full hole 8 closure (every enum in the schema) is deferred; the plan will enumerate which other columns are candidates.
- DB migration is Drizzle; the CHECK constraints are added as Drizzle `check()` calls in the schema plus a corresponding SQL migration.
- The `triggers.type` allowed values are those currently defined in the Drizzle schema enum — the plan will enumerate them.
- This feature does NOT modify auth middleware, rate limiting, WS authentication, or MCP bridge — those are V2 and V3.
- This feature does NOT touch the Next.js client package — client-side validation coherence is V7.
- The `POST /api/triggers/:token/webhook` route is unauthenticated by design (V2 will add auth). V1 validates the body but does not add auth to this route.
