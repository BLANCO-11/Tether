# Quickstart: validating V2 (auth on the unguarded surfaces)

How to prove this feature works, and how to prove it is not fooling you. The
automated suites are the contract; the manual probes below exist because V1
shipped 49 green checkboxes over a mass-assignment hole, and the lesson recorded
from that is that a passing suite is evidence about the tests, not about the API.

Companion to [docs/validation-v1-manual-test-guide.md](../../docs/validation-v1-manual-test-guide.md).

## Prerequisites

```bash
cd foundry && pnpm install
```

Postgres up (`infra/docker-compose.yml`), migrations applied. New variables in
`.env`:

```
WS_ALLOWED_ORIGINS=http://localhost:4002
MCP_BRIDGE_REQUIRE_AUTH=true
```

## 1. Automated suites

```bash
cd foundry && pnpm --filter @foundry/server test && pnpm --filter @foundry/server typecheck
```

```bash
cd foundry && pnpm --filter @foundry/mcp-bridge test
```

```bash
cd foundry && pnpm --filter @foundry/client test
```

**Expected**: all green, and the pre-existing 194 server tests still pass
untouched — that is FR-016 / SC-008. If any V1 test needed editing to
accommodate V2, that is a signal V2 changed valid-request behaviour, and it
should be investigated rather than accommodated.

### The tests that must fail on purpose

A guard whose test still passes when the guard is deleted is not a guard
(SC-007). Verify by hand at least once, reverting after each:

| Delete this | Expect this to fail |
|---|---|
| `await auth()` in the proxy route | proxy session tests, **and** the matcher-widening test |
| the `Origin` check in the upgrade handler | four socket origin tests |
| the ticket `script_id` comparison | cross-workspace subscription test |
| the audience check in `verify` | audience-isolation tests on both surfaces |
| the `workspace_id` filter in the bridge closure | the Article XI over-grant test |

If any of these deletions leaves the suite green, that guard is untested no
matter how many other tests pass.

## 2. MCP bridge (US1)

```bash
cd foundry && export B=http://127.0.0.1:3015
```

Unauthenticated call — the headline fix:

```bash
curl -s -w '\n%{http_code}\n' -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tables","arguments":{}}}' \
  $B/mcp
```

**Expect** `401 {"error":"unauthorized","requestId":"…"}`. **Fail** if the body
contains any table or column name, or if it returns `200`.

Issue a credential for one workspace, then confirm it cannot read another. Take
`$WS_A` and `$WS_B` from your database; the plaintext is returned only once:

```bash
TOKEN=$(curl -s -X POST -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"audience":"mcp","label":"quickstart"}' \
  http://127.0.0.1:4000/api/workspaces/$WS_A/credentials | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).token))")

curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tables","arguments":{}}}' \
  $B/mcp
```

**Expect** workspace A's tables. There is no way to ask for B's — `workspaceId`
is no longer part of any tool's input. **Fail** if a tool still accepts a
`workspaceId` argument at all; that means the parameter was kept and merely
compared, which leaves the next tool author a hole to fall into.

Fail-closed check:

```bash
cd foundry && MCP_BRIDGE_REQUIRE_AUTH= pnpm --filter @foundry/mcp-bridge dev
```

**Expect** auth still required, and a startup warning only if it is explicitly
`false`.

## 3. Progress socket (US2)

No UI exercises this, so use the test client:

```bash
cd foundry && pnpm --filter @foundry/server test src/ws/progress-server.test.ts
```

By hand, the two that matter most. Mint a ticket:

```bash
TICKET=$(curl -s -X POST -H "x-api-key: $K" \
  http://127.0.0.1:4000/api/workspaces/$WS_A/scripts/$SCRIPT_A/progress-ticket \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).ticket))")
```

No ticket at all — must be refused **before** a socket exists:

```bash
curl -s -o /dev/null -w '%{http_code} (expect 401)\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://localhost:4002' \
  "http://127.0.0.1:4001/ws/generation?scriptId=$SCRIPT_A"
```

**Expect** `401`. **Fail** if you get `101` — an established socket that then
sends an error frame is the old behaviour and is a disclosure.

Reuse — the second attempt with the same ticket must fail:

```bash
for i in 1 2; do
  curl -s -o /dev/null -w "attempt $i -> %{http_code}\n" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Origin: http://localhost:4002' \
    "http://127.0.0.1:4001/ws/generation?scriptId=$SCRIPT_A&ticket=$TICKET"
done
```

**Expect** `101` then `401`.

Suffix-matching probe — the classic allowlist bug:

```bash
curl -s -o /dev/null -w '%{http_code} (expect 403)\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://evil-localhost:4002' \
  "http://127.0.0.1:4001/ws/generation?scriptId=$SCRIPT_A&ticket=$TICKET"
```

**Expect** `403`, and the ticket still unconsumed (origin is checked first).

## 4. Proxy and role gate (US3, US4)

With the client running on `:4002` and a signed-in browser session, from the
browser console:

```js
await fetch("/api/foundry/workspaces").then(r => r.status)          // 200
await fetch("/api/foundry/demo/reset", {method:"POST"}).then(r => r.status)
```

**Expect** `403` for `demo/reset` as a non-admin, `200`/`202` as the local admin
(minted `["superadmin","admin"]`). **Fail** if a non-admin can reset demo data.

A path the UI never calls must be refused:

```js
await fetch("/api/foundry/workspaces/does-not-matter/../../health").then(r => r.status)  // 403
```

**Expect** `403`, and **no** entry in the parent API's log for that request — the
proxy must not have forwarded it.

The defence-in-depth check, which needs a code edit: widen
`middleware.ts`'s matcher to exclude `api/foundry`, sign out, then request
`/api/foundry/workspaces`. **Expect** `401` from the route itself. Revert.

## 5. Regression: valid requests unchanged (FR-016)

The whole feature is unacceptable if this fails.

```bash
cd foundry && pnpm --filter @foundry/server test
```

Then walk the UI: list workspaces, open one, add a tool, generate a script,
watch progress, run it. Nothing may behave differently from before V2 — the
guards are all on paths the UI does not take.

## What V2 still does not cover

- **§9 R2** — `backendToken` is still unverified, so the parent API has no user
  identity. Everything above is **workspace-level**, never per-user. Q1.
- **§9 R10** — no rate limiting anywhere; `requireApiKey` still compares with
  `!==`; V2 logs auth failures but does not throttle them. **V3.**
- **§9 R11** — `.env.example` still missing the client-auth and `DEMO_*` sets.
- A holder of `PARENT_API_KEY` still has every workspace on `:4000` directly.
  The role gate does not touch that path.
- Surfaces B (prompt), C (generated code) and D (egress) are V4–V6.
