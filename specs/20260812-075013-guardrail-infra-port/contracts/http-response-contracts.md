# Contract: New/changed HTTP response shapes

Every shape below is additive or a leak-fix — no existing 2xx response body
changes (FR-013). This is the contract `packages/client` and any external
caller can rely on.

## Every response, on every route (new)

Header `X-Request-Id: <uuid>` is present on every response, success or
failure, from every mounted route. Server logs for that request's processing
are tagged with the same id.

## 400 — validation failure (new middleware; existing inline-zod routes unchanged)

```json
{
  "error": "validation_error",
  "issues": [
    { "field": "params.workspaceId", "message": "Invalid uuid", "code": "validation_error" }
  ]
}
```

Identical field names to the pre-existing `ZodError` branch in
`error.middleware.ts` — a route migrated onto the new `validate()` middleware
and a route still validating inline both produce this shape.

## 429 — auth-failure throttle exceeded (new — the only new rate-limit response this feature adds)

Headers: `Retry-After: <seconds>`.

```json
{ "error": "rate_limited", "retryAfterSeconds": 12 }
```

Applies only to repeated `requireApiKey`/`resolveIdentity` failures from one
IP (FR-007). No side effect occurred beyond the auth check itself.

## 429 — concurrency ceilings on flow generation and execution (PRE-EXISTING — not changed by this feature)

Three call sites already return 429 for this, and none of them are touched:
`flow-chat.service.ts` (`MAX_CONCURRENT_CHAT_TURNS` per workspace, plus a 409
for a second turn on the same thread), `flow-generation-job.service.ts`
(`MAX_CONCURRENT_GENERATIONS = 3` per workspace), and `routes/executions.ts` +
`tenant-budget.service.ts` (`maxConcurrentExecutions`, the "M3" budget).
SC-004 is satisfied by this existing, already-tested behavior — see
`research.md` Decision 5 for why this feature does not add a fourth
mechanism alongside them.

## 400/403 — egress rejection at registration (new call sites only: triggers, tools, ops-proxy LLM baseUrl; datasource registration's existing response shape is unchanged)

```json
{ "error": "egress_rejected", "reason": "rfc1918" }
```

`reason` is one of `"loopback" | "rfc1918" | "link-local"` — never the
resolved IP address or hostname (that detail is server-log-only, per FR-004's
non-leaking-error-contract applying equally to egress denials).

## 5xx fallback (changed — was leaking `err.message`; §5 of research.md)

Before this feature, `error.middleware.ts`'s `statusCode >= 500` branch and
untyped fallback branch returned the thrown error's raw `.message` verbatim.
After this feature:

```json
{ "error": "internal_error", "requestId": "<uuid>" }
```

The real message and stack are logged server-side, tagged with the same
`requestId`, via `console.error`. This is the one behavior change to an
*existing* response shape this feature makes — justified because the prior
shape was a genuine information-leak gap (§5), and the change is a strict
narrowing (removes a field) that cannot break a client that was reading
`.message` for anything other than display-only debugging, since no product
code in `packages/client` parses `.message` out of a 5xx body (confirmed
during `/speckit-tasks`'s file-level pass before implementation).

## `@foundry/shared` public API contract

See `data-model.md`'s "Shared package public surface" section — that
signature list *is* the contract for this package. Any consumer
(`packages/server`, `packages/client`) imports only from it; no internal
module path (`@foundry/shared/src/...`) is a supported import, matching
`@foundry/redact`'s existing `exports` map convention (only `.` is exported).
