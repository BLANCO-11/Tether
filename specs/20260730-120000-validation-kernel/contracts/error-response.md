# Contract: Error Response Shapes

**Module**: `packages/server/src/middleware/error.middleware.ts`

This document defines the stable, machine-readable error contract for the parent API.
Client code and tests must match these shapes exactly.

---

## 400 — Validation Error (unchanged)

Triggered by a `ZodError` reaching the error handler.

```json
{
  "error": "validation_error",
  "issues": [
    {
      "path": ["params", "workspaceId"],
      "code": "invalid_string",
      "message": "Invalid uuid"
    }
  ]
}
```

- `error`: always `"validation_error"`.
- `issues`: the ZodError's `issues` array, re-serialised as-is.
- No `requestId` field (the client can fix a 400 without server-side correlation).

---

## 4xx — Application Error (message preserved, requestId added)

Triggered by thrown errors with a `statusCode >= 400 && < 500`.

```json
{
  "error": "request_error",
  "message": "script not found",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

- `error`: always `"request_error"`.
- `message`: the error's own message (caller-supplied errors at this tier are not sensitive).
- `requestId`: the UUID assigned by the request-ID middleware.

---

## 500 — Internal Error (opaque; no leakage)

Triggered by any unhandled error not covered by the above cases.

```json
{
  "error": "internal_error",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

- `error`: always `"internal_error"`.
- `requestId`: correlate with the server log to find the full error context.
- **No `message` field** — server internals (stack traces, DB error strings) never reach callers.
- The full error (message + stack) is logged server-side tagged with the request ID.

---

## 502 — Upstream Error (opaque; no leakage)

Triggered by a `TetherError` (the runtime returned an error response).

```json
{
  "error": "upstream_error",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

- `error`: always `"upstream_error"`.
- `requestId`: correlate with the server log to find the upstream status and body.
- **No upstream body, no upstream status** exposed to callers.
- The upstream status and body are logged server-side tagged with the request ID.

---

## `X-Request-Id` Header

Every response (success and error) carries the `X-Request-Id` header:

```
X-Request-Id: f47ac10b-58cc-4372-a567-0e02b2c3d479
```

This is the same UUID that appears in error response bodies and in the server log.

---

## 413 — Payload Too Large

Triggered by Express's built-in body-size limit before the route handler runs.
This is Express's native response — not shaped by `errorHandler`. Callers should
handle 413 and not attempt to parse it as a JSON error envelope.

---

## Invariants (testable)

1. A 500 response body MUST NOT contain `err.message`, a Postgres error string,
   a stack trace, or a `TetherError` upstream body.
2. A 500 response body MUST contain a `requestId` field parseable as a UUID.
3. A 400 `validation_error` body MUST contain an `issues` array with at least one entry.
4. Every response MUST carry an `X-Request-Id` header whose value is a UUID.
