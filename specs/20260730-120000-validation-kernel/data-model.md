# Data Model: Validation Kernel & Request Boundary Hardening

**Feature**: V1 Validation & Guardrails (`specs/20260730-120000-validation-kernel`)
**Date**: 2026-07-30

This feature adds no new database tables. It:
1. Adds CHECK constraints to four existing columns.
2. Introduces `src/validation/` as a new source module (no DB interaction).
3. Adds a request-ID concept (in-memory per request, no persistence).

---

## New Source Module: `src/validation/`

The validation kernel is a pure TypeScript module — no DB, no network, no side
effects. It exports shared primitives, the `validate()` middleware factory, and
all route-level schemas.

### Primitives (`src/validation/primitives.ts`)

| Export | Zod type | Constraint | Replaces |
|--------|----------|------------|----------|
| `zUuid` | `z.string().uuid()` | RFC 4122 UUID | Inline `z.string().uuid()` in schemas |
| `zEnvVarName` | `z.string().regex(...)` | `^[A-Za-z_][A-Za-z0-9_]*$`, max 255 | Same regex in `tool.service.ts`, `workspace-secret.service.ts` |
| `zIdentifier` | `z.string().regex(...)` | Same as env-var name; used for tool names | Same regex in `tool.service.ts:createToolSchema` |
| `zHttpUrl` | `z.string().url().regex(...)` | `http(s)://` prefix required | Inline regex in `tool.service.ts:createToolSchema` |
| `zPositiveInt` | `z.number().int().positive()` | Positive integer | `intParam` in `stub-api.ts` |
| `zIsoDate` | `z.string().regex(...)` | `YYYY-MM` or `YYYY-MM-DD` format | Date regexes in `stub-api.ts` |
| `zNetworkMode` | `z.enum(["none", "bridge"])` | Allowed Docker network modes | No equivalent today; `network` is boolean |

### Middleware factory (`src/validation/middleware.ts`)

**Inputs**: `ValidateOptions { params?, query?, body? }` — each is an optional Zod schema.

**Behaviour**: Parses each provided segment against the corresponding `req.*` object using `.parse()`. A ZodError propagates as a synchronous throw, which Express catches and forwards to the error middleware. The middleware replaces the parsed value on the request object (so downstream handlers receive the Zod-coerced type, not the raw string).

**State**: Stateless. Safe to call per-route.

### Route schemas (`src/validation/schemas/`)

One file per route group, named `<group>.schema.ts`:

| File | Schemas exported | Moved from |
|------|------------------|------------|
| `workspace.schema.ts` | `createWorkspaceSchema`, `updateWorkspaceSchema`, `workspaceParamsSchema` | `workspace.service.ts` |
| `datasource.schema.ts` | `createDatasourceSchema`, `updateDatasourceSchema`, `schemaAllowlistSchema`, `createDatasourceInputSchema`, `datasourceParamsSchema` | `datasource.service.ts` |
| `tool.schema.ts` | `createToolSchema`, `updateToolSchema`, `generateDummySchema`, `toolParamsSchema` | `tool.service.ts` |
| `trigger.schema.ts` | `createTriggerSchema`, `updateTriggerSchema`, `triggerParamsSchema`, `fireBodySchema` | `trigger.service.ts` |
| `secret.schema.ts` | `createSecretSchema`, `updateSecretSchema`, `secretParamsSchema` | `workspace-secret.service.ts` |
| `script.schema.ts` | `generateScriptSchema`, `scriptParamsSchema`, `executeBodySchema` | `script-generation.service.ts` |
| `stub.schema.ts` | Zod equivalents of `intParam`, `enumParam`, date validators, caps | `stub-api.ts` (hand-rolled) |

**Params schemas** (new — these did not exist before):

```
workspaceParamsSchema     = z.object({ workspaceId: zUuid })
scriptParamsSchema        = z.object({ workspaceId: zUuid, scriptId: zUuid })
datasourceParamsSchema    = z.object({ workspaceId: zUuid, dsId: zUuid })
toolParamsSchema          = z.object({ workspaceId: zUuid, id: zUuid })
triggerParamsSchema       = z.object({ workspaceId: zUuid, scriptId: zUuid, tid: zUuid })
secretParamsSchema        = z.object({ workspaceId: zUuid, id: zUuid })
```

**New body schemas** (route-specific, not previously in any service):

```
executeBodySchema = z.object({
  network: zNetworkMode.optional(),   // "none" | "bridge"; omitted → "bridge"
  event: z.unknown().optional(),       // intentionally free-form (see research.md §D3)
})

fireBodySchema = z.object({
  payload: z.unknown().optional(),    // intentionally free-form (trigger event)
})
```

---

## DB Schema Changes

### Added CHECK constraints

Four constraints on existing varchar columns. No new columns, no new tables, no
data migration. Rows that would violate the constraint do not exist in practice
(the application only writes valid values), so the migration is safe on a live
database.

#### `scripts.status`

```sql
ALTER TABLE scripts
  ADD CONSTRAINT scripts_status_check
  CHECK (status IN ('draft', 'generating', 'completed', 'archived'));
```

Allowed values match `schema.ts` comment and `script-generation.service.ts` usage.

#### `triggers.type`

```sql
ALTER TABLE triggers
  ADD CONSTRAINT triggers_type_check
  CHECK (type IN ('manual', 'schedule', 'poll', 'webhook'));
```

Allowed values match `trigger.service.ts:createTriggerSchema` enum.

#### `execution_results.status`

```sql
ALTER TABLE execution_results
  ADD CONSTRAINT execution_results_status_check
  CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out', 'error'));
```

Allowed values from `execution.service.ts` + `schema.ts` comment.

#### `test_results.audit_verdict`

```sql
ALTER TABLE test_results
  ADD CONSTRAINT test_results_audit_verdict_check
  CHECK (audit_verdict IN ('clean', 'warn', 'fail') OR audit_verdict IS NULL);
```

`IS NULL` is allowed because `audit_verdict` is nullable (not all test results have an
audit verdict). The constraint only fires when a non-null value is supplied.

---

## Request-ID Concept

A per-request UUID is generated by the `requestId` middleware and stored in
`res.locals.requestId`. It is:
- Emitted as the `X-Request-Id` response header on every response.
- Included in the server-side log at the start of request processing.
- Referenced in 500-class error response bodies.
- NOT persisted to the database in V1 (V3 will add it to `stub_call_log`).

**Lifecycle**: request arrives → middleware generates UUID → UUID stored in `res.locals`
→ route handler runs → response sent with `X-Request-Id` header → if error, `requestId`
included in response body.

---

## State Transitions (unchanged by V1)

`scripts.status`:
```
draft → generating → completed
              ↑          (archived: manual action, future)
        (revert: orphan cleanup)
```

`execution_results.status`:
```
running → succeeded | failed | timed_out | error
```

`test_results.audit_verdict`:
```
(null) → clean | warn | fail
```

`triggers.type`: static at creation, not a state machine.
