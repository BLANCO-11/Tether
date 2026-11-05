# Research: Validation Kernel & Request Boundary Hardening

**Feature**: V1 Validation & Guardrails (`specs/20260730-120000-validation-kernel`)
**Date**: 2026-07-30

All design decisions below were resolved by auditing the existing codebase
(`packages/server/src/`) against the roadmap (`docs/validation-and-guardrails-roadmap.md §V1`),
the security standard (`.specify/memory/security.md §5`), and the constitution.
No external research was required; every decision is grounded in the existing code.

---

## Decision 1: Schema location — move to `src/validation/`

**Decision**: Create `src/validation/` as the single home for all request schemas and
shared Zod primitives. Move schemas out of services into this module. Services no
longer export or use schemas for request parsing; routes import schemas from
`src/validation/` and pass already-validated data to services.

**Rationale**: `security.md §5` states "Zod schemas at the Express route boundary,
before any service is called. Validation does not live in services or repositories."
The code currently violates its own standard — schemas live in:
`workspace.service.ts`, `datasource.service.ts`, `tool.service.ts`,
`trigger.service.ts`, `workspace-secret.service.ts`, `script-generation.service.ts`.
Moving them makes "every route is validated" auditable by grep in one directory.

**Alternatives considered**:
- *Leave schemas in services and add route-level re-parsing* — rejected: duplicates the
  schema definition and increases the chance of drift.
- *Amend §5 to allow schemas in services* — rejected: the standard is correct; the
  code is wrong. The fix is to move the code, not accept the deviation.

**Implementation note**: The service functions are unchanged in behaviour. They keep
their TypeScript input types (derived from `z.infer<>` on the moved schemas). The
migration is: schema definition moves to `src/validation/schemas/`, routes import
schema from there and call `validate()`, services receive typed inputs.

---

## Decision 2: Request IDs pulled forward from V3

**Decision**: V1 includes a minimal request-ID middleware: one UUID per request,
placed in `res.locals.requestId`, echoed as `X-Request-Id` response header, and
logged at the start of each request.

**Rationale**: V1 makes `errorHandler` return opaque 500 responses. Without a
correlating token, an opaque 500 is not diagnosable — the operator cannot relate
the response they see to the log entry that has the error. Request IDs make the
tradeoff safe. V3 will extend this foundation (structured logging, request IDs in
`stub_call_log`, rate-limiting) without needing to retrofit the ID itself.

**Alternatives considered**:
- *Defer to V3 and keep leaking `err.message` until then* — rejected: the
  information leakage exists today; V1 can close it without waiting for V3.
- *Use a monotonic counter instead of UUID* — rejected: UUIDs are safe to expose
  externally (no count inference); counters leak request volume.

**Implementation note**: The middleware is a single file
(`src/middleware/request-id.middleware.ts`). No new package dependency — Node's
`crypto.randomUUID()` (stable since Node 19, available in Node 20+) is used.

---

## Decision 3: `event` body on `POST /:scriptId/execute` stays intentionally free-form

**Decision**: The `event` field in `POST /:scriptId/execute` is validated as
`z.unknown()`. The body schema is `{ network?: z.enum(["none","bridge"]), event?: z.unknown() }`.
Only the envelope is validated; the shape of `event` is not.

**Rationale**: The `event` field is the script's own trigger input. It is delivered
on container stdin (`json.load(sys.stdin)`) exactly as a real trigger fire would
deliver it. Locking it to a closed schema would break scripts whose trigger events
have different shapes. The existing code at `execution.service.ts` passes `event`
through to container stdin unchanged.

**This decision is explicit and must be preserved.** A comment at the route and in
this research record documents why — to prevent a future "fix" into a closed schema.

**Alternatives considered**:
- *Require `event` to be a JSON object* — rejected: trigger events can be arrays or
  primitives depending on what the trigger source produces.
- *Remove the `event` field entirely* — rejected: it is what allows a manual execute
  to provide test data; without it every manual run gets `{}` and observes fabricated
  results.

---

## Decision 4: `network` field migrates from boolean to string enum

**Decision**: `POST /:scriptId/execute`'s `network` field is validated as
`z.enum(["none", "bridge"]).optional()`. The current code treats it as a boolean
(`req.body?.network !== false`). V1 migrates to the explicit string enum.

**Rationale**: The roadmap spec says `network?: enum` for the execute body. The
execution.service.ts uses the value to select `--network=none` or `--network=bridge`
for the Docker run. Making it an explicit string enum:
- Makes the allowed values greppable and auditable without reading the service code.
- Eliminates the current footgun where any non-`false` value (including `"host"`)
  enables networking.
- Aligns with V6's goal of making `network` an "explicit, small enum backed by real
  container network configuration."

**Migration**: The route handler currently maps `network !== false` → boolean.
After V1: `"none"` → no network; `"bridge"` → bridge; omitted → bridge (default,
matching the existing default). The execution service is updated to accept the string
and map it to the Docker flag.

**Client impact**: Any caller that currently passes `network: false` must be updated
to `network: "none"`. The only known caller is the client UI's execute action.

**Alternatives considered**:
- *Keep boolean semantic, validate as `z.boolean().optional()`* — rejected: less
  explicit than the roadmap's intent; misses the "footgun where any non-false value
  enables networking" fix.
- *Accept both boolean and string during transition* — rejected: the transitional
  schema is harder to audit and the caller surface is small (one UI button).

---

## Decision 5: Vitest config — add `vitest.config.ts`

**Decision**: Add `packages/server/vitest.config.ts`. Current state: `pnpm test`
works (the `"test": "vitest run"` script exists and tests run on defaults), but
there is no explicit config file.

**What the config adds**:
- `test.environment: "node"` (explicit, not inferred from environment)
- `test.include: ["src/**/*.test.ts"]` (makes the test glob explicit)
- `test.reporters: ["verbose"]` (makes failures readable in CI)
- `test.coverage` stub (not yet wired; V3 may add collection)

**Rationale**: The roadmap says "V1 should add one rather than continuing on
defaults." Making the config explicit means the test surface is grep-auditable and
a future maintainer cannot accidentally change it by upgrading Vitest.

**No new dependency**: Vitest is already installed at `^2.1.8`.

---

## Decision 6: DB CHECK constraints — which columns and values

**Decision**: Add CHECK constraints to exactly four columns, based on code audit:

| Table | Column | Allowed values | Source |
|-------|--------|----------------|--------|
| `scripts` | `status` | `draft`, `generating`, `completed`, `archived` | `schema.ts` comment + `script-generation.service.ts` usage |
| `triggers` | `type` | `manual`, `schedule`, `poll`, `webhook` | `trigger.service.ts:createTriggerSchema` + `schema.ts` comment |
| `execution_results` | `status` | `running`, `succeeded`, `failed`, `timed_out`, `error` | `execution.service.ts` + `schema.ts` comment |
| `test_results` | `audit_verdict` | `clean`, `warn`, `fail` | `schema.ts` comment + `generation-audit.service.ts` |

**Note on `scripts.status`**: The roadmap says "pending|generating|completed|failed"
but the actual values in the codebase are `draft` (default, also used as "failed to
complete" / orphan revert state), `generating`, `completed`, `archived`. V1 uses the
actual values. If a status rename is desired (e.g., `draft → pending`), that is a
separate feature.

**Rationale**: CHECK constraints ensure a bug or manual `psql` write cannot persist a
value that no code path can interpret. They are the database's own enforcement,
independent of Zod and TypeScript.

**Implementation**: Drizzle `check()` constraint in `src/db/schema.ts` using the
`sql` tagged template; `pnpm db:generate` produces a migration; the migration is
committed. No hand-written SQL.

---

## Decision 7: Per-route body-size limits

**Decision**: Override the global `express.json({ limit: "2mb" })` for specific routes
using per-route `express.json({ limit: "..." })` middleware before the route handler:

| Route | Limit | Rationale |
|-------|-------|-----------|
| `POST /api/triggers/:token/webhook` | 64 KB | Stored in `trigger_fires.payload` and piped to script stdin; 64 KB is generous for any webhook payload |
| `POST /:tid/fire` | 64 KB | Same path as webhook; payload stored and forwarded |
| `POST /:scriptId/execute` | 256 KB | `event` is the script's test input; needs some room for realistic payloads |
| `/stub-api/*` | 512 KB | Demo stubs handle email content; 512 KB is sufficient for all realistic demo uses |

Global limit stays at 2 MB for the CRUD routes that may handle large bodies
(e.g., tool `dummyResponseTemplate`, `promptUsed` text, `task` strings up to 20 000 chars).

**Implementation note**: Per-route limits in Express are applied by adding a second
`express.json()` call to the route's middleware chain BEFORE the route handler.
Express uses the first matching `Content-Type` parser, so a per-route parser
overrides the global one for that route.

---

## Decision 8: `validate()` middleware signature

**Decision**: `validate({ params, query, body })` where each key is an optional Zod
schema. The middleware is a factory that returns an Express `RequestHandler`.

```typescript
// src/validation/middleware.ts
import { type ZodSchema } from "zod";
import type { Request, Response, NextFunction, RequestHandler } from "express";

interface ValidateOptions {
  params?: ZodSchema;
  query?: ZodSchema;
  body?: ZodSchema;
}

export function validate(opts: ValidateOptions): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (opts.params) req.params = opts.params.parse(req.params);
    if (opts.query) req.query = opts.query.parse(req.query);
    if (opts.body) req.body = opts.body.parse(req.body);
    next();
  };
}
```

Validation failures throw a `ZodError` which flows to `next(error)` via the
standard `asyncHandler`-free path (the middleware itself is synchronous; throws
propagate to Express's error chain).

**Alternatives considered**:
- *Try/catch and call `next(err)` explicitly* — not needed; Express catches synchronous
  throws from middleware automatically.
- *Return typed request augmentation* — TypeScript cannot narrow `req.params` type
  through middleware; callers must cast or use `z.infer<>`. This is a known Zod+Express
  limitation and is acceptable.

---

## Decision 9: errorHandler contract changes

**Unchanged**: `ZodError` → 400 `{error: "validation_error", issues: [...]}` — the
existing shape is preserved.

**Changed**: 500 path no longer echoes `err.message`. New shape:
`{error: "internal_error", requestId: "<uuid>"}` — where `requestId` comes from
`res.locals.requestId` set by the request-ID middleware.

**Changed**: `TetherError` path no longer returns upstream `body` or `status` to the
caller. New shape: `{error: "upstream_error", requestId: "<uuid>"}` with HTTP 502.
The full upstream body and status are logged server-side.

**Changed**: App-error 4xx path (errors with `statusCode >= 400 && < 500`) currently
echoes `err.message`. After V1: this echo is preserved for 4xx (it is a client error,
not an information leak) but a request ID is added: `{error: "request_error", message, requestId}`.

**Unchanged**: The `asyncHandler` wrapper is unchanged.
