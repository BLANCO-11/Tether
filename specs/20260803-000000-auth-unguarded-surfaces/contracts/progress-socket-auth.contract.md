# Contract: progress WebSocket authentication (US2, FR-007/008/021/022)

Surface: `ws://<host>:4001/ws/generation` (`packages/server/src/ws/progress-server.ts`).

**Q2 decision: retained and authenticated.** It has **no consumer today** — the
UI polls `GET …/scripts/:id/progress`, and `.env.example:9` calls `WS_PORT`
legacy. So this contract builds a guard ahead of its consumer, which is why
FR-022 makes an automated test client the acceptance condition rather than a
nice-to-have.

## Before

`new WebSocketServer({ port, path })`. On connection it reads `scriptId` from the
query string and subscribes. No credential, no `Origin` check, no entitlement
check. Published to the host as `4001:4001`.

## After

### Ticket flow (research R3)

The browser `WebSocket` API cannot set request headers, so the credential
travels in the URL — which makes a long-lived credential unacceptable there.

```
1. UI    ──►  POST /api/workspaces/:workspaceId/scripts/:scriptId/progress-ticket
              (through the proxy, so behind the session check and requireApiKey)
2. server ─►  201 { ticket: "fdy_<keyId>.<secret>", expiresAt }
              audience=ws_progress, script_id=:scriptId, single_use, TTL 30s
3. UI    ──►  ws://host:4001/ws/generation?ticket=<ticket>&scriptId=<id>
4. server ─►  verify → consume → Origin check → subscribe
```

The ticket is minted only after the server has confirmed the script belongs to
the named workspace. That confirmation is the entitlement decision; the socket
then re-verifies rather than trusting it.

### Upgrade handling

Change from `{ port, path }` to `{ noServer: true }` plus an explicit `http`
server and an `upgrade` listener, so a refusal can be an HTTP response before
any WebSocket handshake completes. `ws` documents `verifyClient` as discouraged
and it gives less control over the refusal.

A refused upgrade is answered with a plain HTTP `401` and the socket destroyed.
No WebSocket frame is ever sent — in particular, the current behaviour of
sending `{"type":"error"}` **over an established socket** is removed. Accepting
a connection in order to tell it that it is not allowed is itself a disclosure,
and it makes "was it refused?" indistinguishable from "did it connect and get
nothing?" for the test client.

### Order of checks

Fixed, and tested in this order:

1. `ticket` and `scriptId` present and well-formed → else 401.
2. `Origin` present and in `WS_ALLOWED_ORIGINS` → else 403.
3. `verify({token, audience:"ws_progress", scriptId})` → else 401.
4. Ticket consumed atomically → else 401.
5. Subscribe.

`Origin` is checked **before** the credential so that a cross-site attempt
cannot consume a ticket it stole; a stolen ticket burned by an attacker's failed
attempt would deny the legitimate client its one use.

### Origin allowlist

`WS_ALLOWED_ORIGINS`, comma-separated, exact-match — no wildcards, no suffix
matching (`evil-foundry.com` must not match `foundry.com`). Empty or unset means
**no origin is allowed**, which fails closed; the startup log says so plainly
rather than leaving an operator to wonder why every connection is refused.

A missing `Origin` header (a non-browser client) is refused. If a server-to-
server consumer is ever needed it gets a long-lived `mcp`-style credential over
HTTP, not an exemption here.

### Lifetime re-checking (FR-021)

While a subscription is open, the underlying **workspace** credential is
re-checked every 60 seconds. If the workspace is deleted or the credential
revoked, the socket closes with `1008` (policy violation). Without this, a
revoked credential keeps receiving events for as long as the client holds the
socket open, and "revoked" would mean "revoked for new connections only".

Note honestly what this does and does not do: the *ticket* is consumed at
upgrade and is not re-checked (it no longer exists as a usable credential). What
is re-checked is the workspace's continued right to the stream.

### Entitlement is workspace-level, not per-user

Q1 defers §9 R2, so there is no user identity at the server. "Entitled" means:
*a valid ticket bound to this script, whose workspace owns this script.* Any two
users of the same workspace are indistinguishable here. **No test, comment or
document may describe this as per-user authorization** — that is the Article XV
defect this feature removes, and reintroducing it under a new name would be
worse than leaving it.

## Fallback (from the spec's US2)

Authentication without the entitlement lookup is **not** an acceptable partial
outcome. If step 3's script-to-workspace check cannot be implemented as
specified, the correct move is to stop publishing `:4001` and revisit Q2 — not
to ship a socket that authenticates the caller but serves any script.

## Tests — the FR-022 test client

No UI exercises this, so these tests *are* the acceptance condition. Driven by a
Node `ws` client against a real listener on an ephemeral port.

| Test | Asserts |
|---|---|
| no ticket | 401 at upgrade; **no socket established** |
| malformed ticket | 401; no DB write |
| `Origin` absent | 403 |
| `Origin` not in allowlist | 403 |
| `Origin` is a suffix (`evil-foundry.com` vs `foundry.com`) | 403 — no suffix matching |
| bad `Origin` with a valid ticket | 403, **and the ticket is still unconsumed** |
| ticket for script in workspace B, `scriptId` in A | 401, no event ever sent |
| ticket reused | second upgrade 401 |
| two concurrent upgrades, same ticket | exactly one succeeds |
| expired ticket (TTL elapsed) | 401 |
| `mcp` credential presented as a ticket | 401 (audience isolation) |
| valid ticket | subscribed; payload shape identical to today's `{type:"progress",…}` |
| credential revoked mid-subscription | socket closes 1008 within one re-check period |
| `WS_ALLOWED_ORIGINS` unset | every connection refused (fail-closed) |
| ticket-minting endpoint without `requireApiKey` | 401 |
| ticket-minting endpoint, script not in named workspace | refused, existence not revealed |
