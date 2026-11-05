# Quickstart & Validation Guide: Validation Kernel

**Feature**: V1 Validation & Guardrails (`specs/20260730-120000-validation-kernel`)
**Date**: 2026-07-30

This guide describes how to verify the feature works end-to-end once implemented.

---

## Prerequisites

- Docker Compose stack running (`pnpm infra:up` from `foundry/infra/`)
- Parent API server running (`pnpm --filter @foundry/server dev`)
- `PARENT_API_KEY` available (default dev value: `dev-parent-key`)
- A workspace exists (create one via `POST /api/workspaces` or use the demo workspace)

Set a shell alias for convenience:
```bash
API="http://localhost:4000"
KEY="dev-parent-key"
```

---

## 1. Path-param validation (hole 1)

**Test**: Non-UUID path param → 400, not 500.

```bash
# Should return 400 {"error":"validation_error","issues":[...]}
# Before V1 this returned 500 with a Postgres driver error.
curl -s -X GET "$API/api/workspaces/not-a-uuid/scripts" \
  -H "x-api-key: $KEY" | jq .

# Should return 400 with path: ["params","scriptId"]
curl -s -X GET "$API/api/workspaces/$(uuidgen)/scripts/not-a-uuid" \
  -H "x-api-key: $KEY" | jq .
```

Expected shape:
```json
{
  "error": "validation_error",
  "issues": [
    { "path": ["params", "workspaceId"], "code": "invalid_string", "message": "Invalid uuid" }
  ]
}
```

---

## 2. Execute route body validation (hole 2)

**Test**: Invalid `network` value → 400.

```bash
WORKSPACE_ID="<your-workspace-uuid>"
SCRIPT_ID="<a-completed-script-uuid>"

# network: "host" is not in the enum → 400
curl -s -X POST "$API/api/workspaces/$WORKSPACE_ID/scripts/$SCRIPT_ID/execute" \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"network":"host"}' | jq .

# Expected: {"error":"validation_error","issues":[{"path":["body","network"],...}]}
```

**Test**: `event` is free-form — any JSON value is accepted.

```bash
# All of these should be accepted (not validated):
curl -s -X POST "$API/api/workspaces/$WORKSPACE_ID/scripts/$SCRIPT_ID/execute" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"network":"none","event":{"period":"2026-06"}}' | jq .status

curl -s -X POST "$API/api/workspaces/$WORKSPACE_ID/scripts/$SCRIPT_ID/execute" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"network":"bridge","event":42}' | jq .status
```

---

## 3. Webhook body-size limit (hole 2)

**Test**: Oversized webhook body → 413 before parsing.

```bash
TOKEN="<a-webhook-trigger-token>"

# Generate a 128KB payload (larger than the 64KB limit)
python3 -c "import json; print(json.dumps({'x': 'A'*131072}))" > /tmp/big_payload.json

curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/triggers/$TOKEN/webhook" \
  -H "content-type: application/json" \
  --data-binary @/tmp/big_payload.json
# Expected: 413
```

---

## 4. Error handler — opaque 500 (hole 6)

**Test**: Trigger a 500 and confirm no internals leak.

One way to trigger a 500: disconnect the database or cause a DB query to fail.
Alternatively, the error-middleware unit test provides confidence without needing
to induce a live failure.

Expected 500 response shape (see `contracts/error-response.md`):
```json
{
  "error": "internal_error",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

**Check**: response MUST NOT contain `message`, stack trace text, or upstream body.

**Check**: `X-Request-Id` header MUST be present and equal the `requestId` in the body.

```bash
curl -s -D - -X GET "$API/api/workspaces/$(uuidgen)/scripts" -H "x-api-key: $KEY" | head -20
# Look for: X-Request-Id: <uuid>
```

---

## 5. Stub-api Zod validators (replacement of hand-rolled)

**Test**: Invalid `limit` parameter → 400 (not an unhandled exception).

```bash
# limit must be 1–500; 0 and 501 should fail
curl -s "$API/stub-api/employees?limit=0" | jq .
curl -s "$API/stub-api/employees?limit=999" | jq .
# Expected: {"error":"validation_error","issues":[...]}

# Valid limit — should succeed
curl -s "$API/stub-api/employees?limit=10" | jq '.employees | length'
```

---

## 6. DB CHECK constraints (hole 8)

**Test**: Attempt to insert an invalid status directly.

```bash
# Requires direct DB access (e.g., via psql or a test fixture)
# This is primarily verified by the migration smoke test in the test suite.

psql "$DATABASE_URL" -c \
  "INSERT INTO execution_results (id, script_id, status, started_at) \
   VALUES (gen_random_uuid(), gen_random_uuid(), 'invalid_status', now());"
# Expected: ERROR:  new row for relation "execution_results" violates check constraint
```

---

## 7. Run the full test suite

```bash
cd foundry
pnpm --filter @foundry/server test
```

Expected: all tests pass. Key new tests:
- `src/validation/primitives.test.ts` — each primitive, including false-positive cases
- `src/validation/middleware.test.ts` — validate() factory
- `src/middleware/error.middleware.test.ts` — shape and non-leakage assertions
- `src/routes/params.test.ts` — table-driven: every UUID path param returns 400 on non-UUID

---

## 8. Typecheck

```bash
pnpm --filter @foundry/server typecheck
# Should exit 0 with no errors
```

---

## 9. Verify valid requests are unchanged

Run the existing end-to-end smoke test:

```bash
cd foundry
pnpm e2e
# Should still show 10/10 passing
```
