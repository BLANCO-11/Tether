# Quickstart: validating the guardrail infrastructure port

Prerequisites: `v1-alpha` server running locally (`pnpm --filter @foundry/server dev`),
a workspace id and a valid `x-api-key` for it (see `packages/server/.env.example`).

## User Story 1 — malformed requests rejected before reaching a service

```bash
# Non-UUID workspace id against a route this feature adds validation to
curl -i -H "x-api-key: $PARENT_API_KEY" \
  http://localhost:4000/api/workspaces/not-a-uuid/catalogue
# Expect: 400, { "error": "validation_error", ... }, an X-Request-Id header,
# and NO database driver error text anywhere in the body.
```

Confirms SC-001/SC-002. Repeat against a well-formed UUID for an existing
workspace and confirm the response is identical to pre-feature behavior
(SC-007) — the route still returns the same 200 body it always did.

## User Story 2 — auth-failure throttling (the concurrency ceilings already exist)

`research.md` Decision 5: flow-generation and execution-start concurrency
ceilings are pre-existing, already-tested code
(`flow-chat.service.ts`/`flow-generation-job.service.ts`/`tenant-budget.service.ts`)
that this feature does not modify. SC-004 is already satisfied — verify it
with the existing suites, not a new script:

```bash
pnpm --filter @foundry/server test -- flow-chat.service
pnpm --filter @foundry/server test -- flow-generation-job.service
pnpm --filter @foundry/server test -- executions
```

What this feature actually adds is auth-failure throttling (FR-007):

```bash
# Repeat a bad API key past the configured threshold from one source
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}\n" -H "x-api-key: wrong-key" \
    http://localhost:4000/api/workspaces
done
# Expect: 401 for early attempts; once the threshold is crossed, 429 with a
# Retry-After header, and a server log line per failure with enough context
# to investigate (IP, path, timestamp — never the presented key value).
```

Confirms SC-003 (as narrowed to the auth-failure path — see Decision 5).

## User Story 3 — egress/SSRF policy

```bash
# Register a poll trigger pointed at a private address
curl -i -H "x-api-key: $PARENT_API_KEY" -H "content-type: application/json" \
  -X POST http://localhost:4000/api/workspaces/$WS/flows/$FLOW/triggers \
  -d '{"kind":"poll","config":{"url":"http://169.254.169.254/latest/meta-data"}}'
# Expect: 400/403 { "error": "egress_rejected", "reason": "link-local" }
```

```bash
# Register the same trigger against a normal public URL — unaffected
curl -i -H "x-api-key: $PARENT_API_KEY" -H "content-type: application/json" \
  -X POST http://localhost:4000/api/workspaces/$WS/flows/$FLOW/triggers \
  -d '{"kind":"poll","config":{"url":"https://example.com/webhook"}}'
# Expect: 200/201, unchanged from pre-feature behavior.
```

Confirms SC-005. The dial-time re-check (DNS rebinding) is exercised only by
the automated test in `services/trigger-scheduler.test.ts` (mocking a DNS
response that changes between registration and dial) — not reproducible by
hand in this quickstart.

## User Story 4 — shared validation equivalence

```bash
pnpm --filter @foundry/shared test    # unit tests for validation/rate-limit/egress/rules
pnpm --filter @foundry/server test    # confirms server-side consumers still pass
pnpm --filter @foundry/client test    # confirms client-side consumers still pass
```

The equivalence test itself (SC-006) lives in `packages/shared/src/rules/*.test.ts`
— it imports the same exported rule and asserts identical accept/reject output
for a fixed input set; there is nothing to run by hand beyond the test suite.

## Full regression check (SC-007)

```bash
git stash                                    # or check out the pre-feature commit
pnpm -r test > /tmp/before.txt
git stash pop                                # or check out this feature's branch
pnpm -r test > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt          # only new test files/cases should differ
```
