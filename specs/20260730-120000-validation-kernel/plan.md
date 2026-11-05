# Implementation Plan: Validation Kernel & Request Boundary Hardening

**Branch**: `krt/guardrail_validation` | **Date**: 2026-07-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260730-120000-validation-kernel/spec.md`

---

## Summary

Establish the validation kernel for the Foundry parent API — a shared Zod primitives
module (`src/validation/`), a declarative `validate()` middleware applied to every
mounted Express route including path params, and an opaque error-handler contract.
This closes:
- **Hole 1** (path-param 500s → 400s),
- **Hole 2** (unvalidated bodies on the highest-consequence routes),
- **Hole 6** (`errorHandler` leaking `err.message` and `TetherError` upstream bodies),
- **Hole 8 (partly)** (DB CHECK constraints on four status-enum columns).

All design decisions are documented in `research.md`. No source behaviour changes for
valid requests. No new external dependencies.

---

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js ≥20 (ESM, `.js` specifiers in imports)

**Primary Dependencies**: Express 4.21, Zod 3.24 (already installed), Drizzle ORM 0.38

**Storage**: PostgreSQL 16 — four existing columns gain CHECK constraints via a new
Drizzle migration (no new tables, no data migration)

**Testing**: Vitest 2.1 — already installed; `vitest.config.ts` is added in this feature

**Target Platform**: Linux server (Docker Compose single-instance)

**Performance Goals**: Validation is synchronous Zod parsing — adds < 1 ms per request;
no measurable throughput impact expected

**Constraints**: Zero behaviour change for valid requests. The `event` field on the execute
route stays intentionally free-form — `z.unknown()` only (see `research.md §D3`). The
`network` field migrates from boolean to `z.enum(["none","bridge"])` — one client-side
caller must be updated.

**Scale/Scope**: 10 route files, ~30 path-param usages, 6 service schemas, 4 DB columns

---

## Constitution Check

**Process gates (Articles I-VIII)**

- [x] **II. Test-First** — every behaviour change has a named test:
  - Table-driven path-param test (`src/routes/params.test.ts`) covers every mounted UUID route.
  - `src/validation/primitives.test.ts` — positive and negative cases for each primitive.
  - `src/validation/middleware.test.ts` — validate() factory, including pass-through.
  - `src/middleware/error.middleware.test.ts` — shape, non-leakage, requestId presence.
  - Per-route body tests in `src/routes/execute.test.ts` and `src/routes/fire.test.ts`.
  - Migration smoke test (DB check constraints reject invalid values).
- [x] **IV. Simplicity** — no new external dependencies. `crypto.randomUUID()` (Node built-in)
  replaces any UUID package. The `validate()` factory is ~10 lines. The `src/validation/`
  module is additive; nothing existing is removed, only moved or extended.
- [x] **V. Observability** — 500-path errors are logged server-side with the full error
  message, stack, and request ID. TetherError upstream body and status are logged. A caller
  receiving an opaque 500 can correlate via `X-Request-Id`. New failure path (413 on
  oversized body) is handled by Express natively with a clear status code.
- [x] **VII. Documentation Currency** — this plan ships with `research.md`, `data-model.md`,
  `contracts/`, and `quickstart.md`. `security.md §5` is amended via
  `/speckit-update-standards` after the feature ships (the gap between the standard's claim
  and the code is closed by this feature).
- [x] **VIII. Secrets Hygiene (NON-NEGOTIABLE)** — no credentials in source. The request
  ID is a random UUID, not a secret. No new environment variables.

**Foundry gates (Articles IX-XV)**

- [x] **IX. Harness Boundary** — n/a. This feature touches only Express routes, middleware,
  and DB schema. No Tether calls, no new HTTP paths to the runtime.
- [x] **X. Generated Code Is Untrusted (NON-NEGOTIABLE)** — n/a. This feature does not
  touch generation, audit, or execution logic. The `event` body on the execute route is
  intentionally free-form; the spec and code comment document this explicitly so a future
  reviewer does not lock it into a closed schema.
- [x] **XI. Least-Privilege Data Access (NON-NEGOTIABLE)** — n/a. This feature does not
  add, change, or remove credentials or database grants.
- [x] **XII. Workspace Isolation** — n/a. No new tables; all existing workspace scopes
  are unchanged.
- [x] **XIII. Manifest Is the Contract** — n/a. This feature does not touch manifest
  generation or prompt composition.
- [x] **XIV. Synthetic Demo Data Only (NON-NEGOTIABLE)** — n/a. No demo data, no fixtures,
  no real data.
- [x] **XV. No Silent Side Effects** — the errorHandler change makes opaque 500s **more**
  diagnosable (request ID + server-side logging), not less. All current side effects
  (execution, trigger firing) are unchanged. New failure paths (validation 400, size 413)
  are explicit and synchronous.

**Foundational standards**

- [x] **frameworks.md** — stays within the recorded stack. Zod, Express, Drizzle, Vitest
  are all existing dependencies. `vitest.config.ts` is a configuration file for an
  existing tool, not a new dependency.
- [x] **security.md** — this feature closes the gap recorded in §5 ("validation at the
  route boundary, not in services") and holes 1, 2, 6, 8. It does not worsen any §9 gap.
  After shipping, §5 is amended via `/speckit-update-standards` to reflect the new reality.
- [x] **design.md** — n/a. This feature is server-side only; no UI changes.

---

## Project Structure

### Documentation (this feature)

```text
specs/20260730-120000-validation-kernel/
├── plan.md              ← this file
├── research.md          ← design decisions
├── data-model.md        ← module structure + schema entities + DB changes
├── contracts/
│   ├── validate-middleware.md
│   └── error-response.md
├── quickstart.md        ← verification guide
└── tasks.md             ← generated by /speckit-tasks
```

### Source Code Changes

```text
foundry/packages/server/
├── vitest.config.ts                           [NEW] explicit test config
├── src/
│   ├── validation/                            [NEW MODULE]
│   │   ├── index.ts                           [NEW] re-exports everything
│   │   ├── primitives.ts                      [NEW] zUuid, zEnvVarName, zIdentifier,
│   │   │                                             zHttpUrl, zPositiveInt, zIsoDate,
│   │   │                                             zNetworkMode
│   │   ├── middleware.ts                      [NEW] validate() factory
│   │   ├── primitives.test.ts                 [NEW] unit tests
│   │   ├── middleware.test.ts                 [NEW] unit tests
│   │   └── schemas/
│   │       ├── workspace.schema.ts            [NEW, moved from workspace.service.ts]
│   │       ├── datasource.schema.ts           [NEW, moved from datasource.service.ts]
│   │       ├── tool.schema.ts                 [NEW, moved from tool.service.ts]
│   │       ├── trigger.schema.ts              [NEW, moved from trigger.service.ts]
│   │       ├── secret.schema.ts               [NEW, moved from workspace-secret.service.ts]
│   │       ├── script.schema.ts               [NEW, moved from script-generation.service.ts]
│   │       └── stub.schema.ts                 [NEW] Zod equivalents of hand-rolled validators
│   ├── middleware/
│   │   ├── auth.middleware.ts                 [unchanged]
│   │   ├── error.middleware.ts                [MODIFIED] opaque 500, requestId, TetherError
│   │   ├── error.middleware.test.ts           [NEW] shape + non-leakage tests
│   │   └── request-id.middleware.ts           [NEW] UUID per request → res.locals + header
│   ├── routes/
│   │   ├── app.ts                             [MODIFIED] request-id middleware, per-route limits
│   │   ├── workspaces.ts                      [MODIFIED] validate() on params + body
│   │   ├── scripts.ts                         [MODIFIED] validate() on params + body (execute)
│   │   ├── triggers.ts                        [MODIFIED] validate() on params + body (fire/webhook)
│   │   ├── tools.ts                           [MODIFIED] validate() on params + body
│   │   ├── datasources.ts                     [MODIFIED] validate() on params + body
│   │   ├── workspace-secrets.ts               [MODIFIED] validate() on params + body
│   │   ├── stub-api.ts                        [MODIFIED] Zod replaces hand-rolled validators
│   │   ├── stubs.ts                           [MODIFIED] validate() on workspaceId + name params
│   │   └── params.test.ts                     [NEW] table-driven: all UUID params → 400 on bad input
│   ├── services/
│   │   ├── workspace.service.ts               [MODIFIED] schema removed; imports type from validation
│   │   ├── datasource.service.ts              [MODIFIED] schema removed; imports type from validation
│   │   ├── tool.service.ts                    [MODIFIED] schema removed; imports type from validation
│   │   ├── trigger.service.ts                 [MODIFIED] schema removed; imports type from validation
│   │   ├── workspace-secret.service.ts        [MODIFIED] schema removed; imports type from validation
│   │   └── script-generation.service.ts       [MODIFIED] schema removed; imports type from validation
│   └── db/
│       └── schema.ts                          [MODIFIED] Drizzle check() on 4 status columns
└── drizzle/
    └── 0009_validation_checks.sql             [NEW] generated migration
```

---

## Implementation Phases

The roadmap working style (from project memory) requires small ordered slices, committed
only when green. Each sub-task below is an independently committtable unit.

### Phase A: Validation primitives + middleware (no route changes yet)

**A1. Create `vitest.config.ts`**
Explicit node environment, include glob, verbose reporter. Confirm `pnpm test` still passes.

**A2. Create `src/validation/primitives.ts`**
Define `zUuid`, `zEnvVarName`, `zIdentifier`, `zHttpUrl`, `zPositiveInt`, `zIsoDate`,
`zNetworkMode`. Each with a JSDoc comment stating what it validates and what it replaces.

**A3. Write `src/validation/primitives.test.ts`**
For each primitive: at least one valid value (positive test) and at least two invalid
values covering distinct failure modes (negative tests). False-positive tests are
load-bearing — a primitive that accepts "anything" has passed, not been validated.

**A4. Create `src/validation/middleware.ts`**
The `validate()` factory. Returns an Express RequestHandler. Synchronous; ZodErrors
propagate as throws.

**A5. Write `src/validation/middleware.test.ts`**
Test cases: params-only validation, body-only validation, combined, omitted segments
pass through, ZodError on invalid input, valid input is coerced (e.g., trimmed string).

**A6. Create `src/validation/index.ts`**
Re-export primitives, middleware, and (once created) all schema files.

*Commit gate: `pnpm test` passes, `pnpm typecheck` passes.*

---

### Phase B: Schema migration (move from services to `src/validation/schemas/`)

Move schemas one service at a time. Each move is a separate commit. For each:
1. Create `src/validation/schemas/<name>.schema.ts` with the schema definition.
2. Update the service to import the schema TYPE only from the new location (or delete
   the schema entirely if the route already imports it).
3. Update the route to import the schema from `src/validation/` and call `validate()`.
4. Run `pnpm typecheck` to confirm no type errors.

**B1. `workspace.service.ts` → `workspace.schema.ts`**
Add `workspaceParamsSchema`. Update `workspaces.ts` route.

**B2. `script-generation.service.ts` → `script.schema.ts`**
Add `scriptParamsSchema` and `executeBodySchema` (new). Update `scripts.ts`.
Document the intentionally free-form `event` field with an explicit comment at the
schema definition AND at the route handler.

**B3. `trigger.service.ts` → `trigger.schema.ts`**
Add `triggerParamsSchema` and `fireBodySchema` (new). Update `triggers.ts`.

**B4. `datasource.service.ts` → `datasource.schema.ts`**
Add `datasourceParamsSchema`. Update `datasources.ts`.

**B5. `tool.service.ts` → `tool.schema.ts`**
The `createToolSchema` has complex `superRefine` auth rules — move as-is. The
`AUTH_STYLES` constant is referenced by both the schema and service internals;
export it from the schema module and re-import in the service. Update `tools.ts`.

**B6. `workspace-secret.service.ts` → `secret.schema.ts`**
Add `secretParamsSchema`. Update `workspace-secrets.ts`.

**B7. `routes/stubs.ts` → `stub.schema.ts` (params)**
The stub router uses `:workspaceId` and `:name`. The name is not a UUID — use
`z.string().min(1).max(255)`. Add to stub.schema.ts.

*Commit gate per step: `pnpm test` + `pnpm typecheck` pass.*

---

### Phase C: Stub-API Zod migration (replace hand-rolled validators)

**C1. Create `src/validation/schemas/stub.schema.ts`**
Define Zod equivalents:

| Hand-rolled | Zod equivalent |
|-------------|----------------|
| `intParam(name, min?, max?)` | `zPositiveInt` with `.min()/.max()` refinements |
| `enumParam(name, values)` | `z.enum([...])` |
| Date regex `YYYY-MM` | `zIsoDate` (already defined in A2) |
| `EMAIL_RE` check | `z.string().email()` |
| `recipients.length <= 50` | `z.array(z.string().email()).max(50)` |
| `attachments.length <= 10` | `z.array(...).max(10)` |
| `limit` clamp 1–200 or 1–500 | `zPositiveInt.min(1).max(200)` or `.max(500)` |

**C2. Update `routes/stub-api.ts`**
Replace each use of `intParam`, `enumParam`, date regex, `EMAIL_RE` with schema
parsing using `validate({ query: ... })` or `validate({ body: ... })` at the route
level. Remove `intParam`, `enumParam`, `EMAIL_RE` helper functions.

**C3. Verify caps preserved**
Check that each replaced validator preserves the exact cap from the roadmap:
- recipients ≤ 50 ✓
- attachments ≤ 10 ✓
- `limit` 1–200 or 1–500 depending on endpoint ✓

*Commit gate: `pnpm test` passes. No existing valid stub-api call now fails.*

---

### Phase D: Error middleware + request-ID

**D1. Create `src/middleware/request-id.middleware.ts`**
Uses `crypto.randomUUID()` (Node 20 built-in). Sets `res.locals.requestId`.
Logs `[request] <method> <path> requestId=<uuid>` at start.
Sets `X-Request-Id` header on the response (using `res.on("finish", ...)` to ensure
it is set even when the handler sends before the middleware chain completes, or more
simply by calling `res.setHeader("X-Request-Id", id)` immediately and relying on
Express to include it).

**D2. Mount request-ID middleware in `app.ts`**
Add before all routes:
```ts
import { requestId } from "./middleware/request-id.middleware.js";
app.use(requestId);
```
This ensures every request — including 404s and pre-auth failures — gets an ID.

**D3. Update `src/middleware/error.middleware.ts`**

Three changes:
1. **ZodError path (400)**: unchanged shape `{error, issues}`. No request ID needed.
2. **TetherError path**: remove `body` and `status` from response. Return
   `{error: "upstream_error", requestId: res.locals.requestId}` with HTTP 502.
   Log the upstream body and status: `console.error("[error:upstream] requestId=%s status=%d body=%j", requestId, err.status, err.body)`.
3. **500 path**: remove `message` from response. Return
   `{error: "internal_error", requestId: res.locals.requestId}`.
   Log the full error: `console.error("[error:internal] requestId=%s", requestId, err)`.
4. **4xx app-error path**: keep `message`, add `requestId`.

**D4. Write `src/middleware/error.middleware.test.ts`**
Test cases:
- ZodError → 400, shape matches exactly, no `requestId`, no `message` beyond issues.
- TetherError → 502, `{error: "upstream_error", requestId}`, response does NOT contain
  the upstream `body` or `status`.
- Generic Error → 500, `{error: "internal_error", requestId}`, response does NOT
  contain `err.message`.
- App error with statusCode 409 → 409, `{error: "request_error", message, requestId}`.
- `X-Request-Id` header present on every response.

*Commit gate: `pnpm test` passes. The error contract matches `contracts/error-response.md` exactly.*

---

### Phase E: Per-route body-size limits

**E1. Update `app.ts`**
Add per-route `express.json()` middleware before the route handler for:
- `/api/triggers/:token/webhook` → `express.json({ limit: "64kb" })`
- `/:tid/fire` → `express.json({ limit: "64kb" })`
- `/:scriptId/execute` → `express.json({ limit: "256kb" })`
- `/stub-api/*` → `express.json({ limit: "512kb" })`

In Express, a per-route parser is added as a middleware in the route's middleware chain,
before the handler:
```ts
webhookRouter.post(
  "/:token/webhook",
  express.json({ limit: "64kb" }),  // ← per-route override
  validate({ ... }),
  asyncHandler(async (req, res) => { ... }),
);
```
The global `express.json({ limit: "2mb" })` remains for all other routes.

*Commit gate: 413 returned for oversized payloads on constrained routes; valid payloads
accepted; typecheck passes.*

---

### Phase F: Path-param test suite

**F1. Write `src/routes/params.test.ts`**

Table-driven test: for every route with a UUID path param, assert that sending
`"not-a-uuid"` returns 400 with `{error: "validation_error"}` and not 500.

Route table (enumerate all):
```ts
const routes = [
  { method: "GET",    path: "/api/workspaces/BADID/scripts" },
  { method: "GET",    path: "/api/workspaces/BADID/tools" },
  { method: "GET",    path: "/api/workspaces/BADID/datasources" },
  { method: "GET",    path: "/api/workspaces/BADID/secrets" },
  { method: "GET",    path: "/api/workspaces/BADID" },
  { method: "GET",    path: "/api/workspaces/BADID/scripts/BADID2" },
  { method: "DELETE", path: "/api/workspaces/BADID/scripts/BADID2" },
  { method: "GET",    path: "/api/workspaces/BADID/scripts/BADID2/tests" },
  { method: "GET",    path: "/api/workspaces/BADID/scripts/BADID2/versions" },
  { method: "POST",   path: "/api/workspaces/BADID/scripts/BADID2/execute" },
  // ... triggers, tools, datasources, workspace-secrets
];
```

The test spins up the Express app without DB connections (mock the service layer or
use supertest with the real app but mock the repo calls). Each test sends the request
and asserts status === 400 and body.error === "validation_error".

*Commit gate: all table-driven tests pass. The table is exhaustive — adding a new
UUID route without updating the table is a failing test.*

---

### Phase G: DB CHECK constraints

**G1. Update `src/db/schema.ts`**

Add Drizzle `check()` to four tables. Example for `scripts`:
```ts
import { check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const scripts = pgTable("scripts", {
  // ... existing columns unchanged ...
}, (t) => ({
  // ... existing indexes ...
  statusCheck: check("scripts_status_check",
    sql`${t.status} IN ('draft', 'generating', 'completed', 'archived')`),
}));
```

Similarly for `triggers.type`, `execution_results.status`, `test_results.audit_verdict`
(with `OR audit_verdict IS NULL` for the nullable column).

**G2. Generate migration**

```bash
cd foundry
pnpm --filter @foundry/server db:generate
```

Review the generated `drizzle/0009_*.sql` for correctness. Do not hand-edit.
Commit the generated migration alongside the schema change.

**G3. Apply migration (dev environment)**

```bash
pnpm --filter @foundry/server db:migrate
```

**G4. Write migration smoke test**
In `src/db/schema.test.ts` (or co-locate with the affected repo): attempt to insert
an invalid status value via the Drizzle client and assert it throws a constraint
violation. This test requires a real DB connection (use the test DB URL from env).
Mark it as an integration test if needed, separate from the unit suite.

*Commit gate: migration applies cleanly, `pnpm test` passes including smoke test.*

---

### Phase H: Delete the stray untracked file

**H1. Delete `foundry/packages/client/guardrail_validaton.md`**

This is a stray duplicate of the roadmap document (with a typo in the name). It is
untracked and should be removed from the working tree.

```bash
rm foundry/packages/client/guardrail_validaton.md
```

No commit needed (the file is untracked). Confirm with `git status` that it is gone.

---

## Complexity Tracking

No constitution violations. No new dependencies. No new architectural layers beyond
`src/validation/` which is called for by the security standard and the roadmap.

The only noteworthy complexity justification:

| Item | Why Needed | Simpler Alternative Rejected Because |
|------|------------|-------------------------------------|
| `src/validation/` module | Security standard §5 requires schemas at the route boundary; they are currently in services | Leaving them in services perpetuates the standard violation; the move is the standard's own prescribed remedy |
| Request ID in V1 | `errorHandler` can only return opaque 500s if there is a correlating token | Deferring to V3 means keeping the leaking handler until V3 ships; the ID is trivial (one UUID, zero dependencies) and pays for the 500 fix immediately |

---

## Architectural Decisions Needing Approval

The following decisions affect external callers and are flagged for the user's review
before implementation begins:

### AD-1: `network` field migration — boolean to string enum (BREAKING)

**Current**: `POST /:scriptId/execute` accepts `{ network: false }` to disable networking.
Any non-`false` value (including absent) enables the bridge network.

**V1**: `network` becomes `z.enum(["none", "bridge"]).optional()`. The default (absent)
becomes `"bridge"`.

**Impact**: The client's "Execute" button currently sends `network: false` or omits
the field. After V1, it must send `network: "none"` to disable networking. This is a
breaking change if any external caller uses the boolean form.

**Recommendation**: Accept the migration — the string enum is more explicit and
necessary for V6's real network policy. Update the client call in the same PR.

**Alternative if rejected**: Validate as `z.boolean().optional()` in V1 (no behaviour
change) and defer the enum migration to V6.

### AD-2: `validate()` replaces all direct `.parse(req.body)` calls in routes

**Current**: Routes call `schema.parse(req.body)` directly (e.g., `generateScriptSchema.parse(req.body)`).

**V1**: Routes call `validate({ body: schema })` middleware instead. The service receives
already-validated data.

**Impact**: The `validate()` middleware pattern is the mechanism that makes
"every route is validated" auditable by grep. Without it, routes can still call
`.parse()` and bypass the audit. The change is purely structural — same Zod schemas,
same validation, different call site.

**Recommendation**: Accept. The migration is mechanical and the grep-auditable property
is the stated goal.

---

## Post-ship: Standards amendment

After this feature ships, run `/speckit-update-standards` to amend `security.md §5`:
- Change "Validation does not live in services or repositories" from an aspiration to
  a fact (the code now matches the standard).
- Note the `src/validation/` module as the canonical location.
- Record that holes 1, 2, 6, and 8 (partly) are closed.
