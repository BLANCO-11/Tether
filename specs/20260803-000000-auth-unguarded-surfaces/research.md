# Phase 0 Research: Authentication on the unguarded surfaces (V2)

All unknowns from Technical Context resolved. Every decision below was checked
against the working tree at 2026-08-03.

---

## R1 — How is a workspace-scoped credential stored?

**Decision**: store a **salted digest**, not ciphertext. `scrypt` from
`node:crypto`, compared with `crypto.timingSafeEqual`. The presented token is
`fdy_<keyId>.<secret>`; `keyId` is an indexed unique column, so verification is
one row fetch plus one hash — not a scan.

**Rationale**: the bridge and the ticket issuer only ever need to *verify* a
presented credential. They never need to recover it. Reversible storage would
mean that a leak of `CREDENTIAL_ENC_KEY` yields every live bridge credential in
plaintext; a digest yields nothing usable.

This is a deliberate refinement of the spec's Q3 note, which said "encrypted at
rest, as `tether_api_key` already is". That comparison does not hold on
inspection: `tether_api_key` **must** be reversible because the parent
*presents* it to Tether (`workspaces.tether_api_key`, `schema.ts:30`). A
credential we only check is a different requirement and gets the stronger
treatment. Recorded here so the difference is intentional rather than an
inconsistency someone later "fixes" in the wrong direction.

**Indexing note**: hashing per candidate row would make an unauthenticated
caller able to force N scrypt runs per request — a CPU amplification vector. The
`keyId` prefix makes it exactly one. Cost parameters stay at Node's defaults;
tuning them is not this feature's business.

**Alternatives considered**:
- AES-256-GCM via the existing `utils/encryptor.ts` — rejected per above.
- Bare SHA-256 — rejected: no salt, and fast enough to brute-force a
  low-entropy secret. The secret is generated (32 random bytes), so this is
  defence against a weak future issuer, not against today's.
- Argon2 — better KDF, but a new native dependency for no material gain here
  (Article IV). `scrypt` is in the standard library.

---

## R2 — How does the MCP bridge verify a credential when it is a separate package?

**Constraint discovered**: `packages/mcp-bridge` has its **own** `pg.Pool`
(`schema-store.ts:5-9`) and does not import from `packages/server`. Its
dependencies are `@modelcontextprotocol/sdk`, `express`, `pg`, `zod` — no
workspace-internal package.

**Decision**: the bridge verifies against the database directly, using a
verification routine kept in **one** file that both packages compile. Because
there is no shared package today and creating one is a build-system change well
beyond this feature, the routine lives in `packages/server/src/auth/` and the
bridge imports it by relative path through its own `tsconfig` path mapping —
**or**, if that proves awkward for the bridge's Docker build (it builds from the
repo root with its own Dockerfile), the routine is duplicated with a test in
each package asserting identical behaviour against the same fixtures.

**Flagged for `/speckit-tasks`**: prefer the single-source option; fall back to
duplication-with-a-shared-conformance-test only if the container build forces
it. Do **not** silently let the two drift — two verifiers that disagree is worse
than one duplicated on purpose.

**Alternatives considered**:
- Bridge calls a new parent endpoint to verify — rejected: adds a network hop
  and a failure mode on every tool call, and makes the bridge depend on the
  parent being up when it currently does not.
- Create a `packages/shared` — the right long-term answer, rejected as scope: it
  touches every package's build and belongs in its own feature.

---

## R3 — How does a browser authenticate a WebSocket upgrade?

**Constraint**: the browser `WebSocket` API cannot set request headers. So the
credential must travel in the URL, in `Sec-WebSocket-Protocol`, or not at all.
A long-lived credential in a URL lands in access logs and `Referer`.

**Decision**: a **single-use, short-TTL ticket**.

1. The UI makes an authenticated HTTP call for a ticket bound to
   `(workspaceId, scriptId)`. This goes through the existing proxy, so it is
   already behind the session check (US3) and `requireApiKey`.
2. The server mints a ticket, stores its digest with a TTL of 30 seconds and a
   single-use flag, and returns the plaintext once.
3. The browser opens `ws://…/ws/generation?ticket=<t>`.
4. The upgrade handler verifies the ticket, marks it consumed, checks `Origin`
   against an allowlist, and only then subscribes.

**Why this satisfies FR-008's "no second identity model"**: both the bridge
credential and the ticket are *workspace-scoped bearer credentials verified
server-side by digest*, sharing one table, one verification routine and one
refusal shape. They differ only in lifetime and in being single-use. That is one
primitive with two lifetimes, not two mechanisms — which is what FR-008 is
protecting against.

**Why a ticket rather than the long-lived credential**: a 30-second single-use
value in a query string is a materially different exposure from a long-lived
one. It also gives FR-021 (re-check for the life of the subscription) a natural
implementation: the socket re-validates the underlying workspace credential
periodically, and a revoked credential closes the socket.

**`ws` library mechanics**: the current server is
`new WebSocketServer({ port, path })` (`progress-server.ts:11`), which handles
the upgrade internally. Rejecting an upgrade needs either `verifyClient` (async
form: `verifyClient(info, cb)`, where `cb(false, 401)` refuses with a status) or
`{ noServer: true }` plus an explicit `upgrade` listener. **Chosen**:
`noServer: true` with an explicit `http` server, because `verifyClient` is
documented by `ws` itself as discouraged and gives less control over the refusal
response. No new dependency either way.

**Alternatives considered**:
- `Sec-WebSocket-Protocol` carrying the token — works and keeps it out of the
  URL, but overloads a content-negotiation header, and some proxies rewrite it.
- Cookie-based auth on the upgrade — the WS is on a different port (`:4001`),
  so the cookie would have to be host-wide; and with R2 deferred the server
  cannot verify a session cookie anyway.
- Leave it unauthenticated behind loopback — declined in Q2.

---

## R4 — Where is the `roles` claim enforced, given R2 is deferred?

**The problem**: R2 is deferred, so the parent API has **no user identity** — it
sees only the shared `PARENT_API_KEY`. A role check is therefore impossible in
`packages/server`. Enforcing it only in React components would be a UI
affordance, not a guard, and calling it enforcement is precisely the Article XV
defect this feature exists to remove.

**Decision**: enforce in the **Next proxy route** — the one place that has both
a verified session (`await auth()`, US3) and control over what reaches the
parent API. The proxy's allowlist becomes **role-aware**: each allowlisted
`(method, path pattern)` entry carries the role required to use it.

This is a genuine server-side enforcement point, and it is *one* point, which is
what FR-014 demands.

**What it concretely gates**: the UI calls `/demo/provision` and `/demo/reset`
through the proxy (`foundry-client.ts:389-390`). `demoReset` destroys demo data.
Requiring `admin`/`superadmin` for those two, and leaving ordinary CRUD open to
any signed-in user, gives the role gate real work on day one rather than a
placeholder.

**Honest limits, to be stated in the plan and in `security.md` at amendment
time**: this constrains what the *browser* can reach through the proxy. It does
**not** constrain a caller who holds `PARENT_API_KEY` and talks to `:4000`
directly — that is R2's job. The role gate must not be described anywhere as
protecting the parent API.

**Alternatives considered**:
- Remove the claim (FR-014's other branch) — defensible and cheaper, but the
  local admin is minted `["superadmin","admin"]` and the demo-reset gate is a
  real need, so enforcing is the better trade here.
- Enforce in `packages/server` — impossible without R2.
- Enforce in `middleware.ts` — it does not know which upstream path is being
  requested in a way that survives the proxy's rewriting, and duplicating the
  allowlist there would give two places to keep in sync.

---

## R5 — What goes on the proxy allowlist?

**Method**: enumerated from `packages/client/src/lib/foundry-client.ts`, which
is the only module that calls the proxy (`PROXY = "/api/foundry"`, line 6; all
calls funnel through `req()` at line 235). `adapters.ts:246` builds a URL from
the same base.

Observed call set (method + path shape):

| Method | Path | Role |
|---|---|---|
| GET | `/health` | any |
| GET, POST | `/workspaces` | any |
| GET, PATCH, DELETE | `/workspaces/:wsId` | any |
| GET, POST | `/workspaces/:wsId/tools` | any |
| PATCH, DELETE | `/workspaces/:wsId/tools/:toolId` | any |
| GET, POST | `/workspaces/:wsId/datasources` | any |
| PATCH, DELETE | `/workspaces/:wsId/datasources/:dsId` | any |
| POST | `/workspaces/:wsId/datasources/:dsId/*` (introspect etc.) | any |
| GET, POST | `/workspaces/:wsId/secrets` | any |
| GET, POST | `/workspaces/:wsId/scripts` | any |
| GET | `/workspaces/:wsId/scripts/:id` | any |
| GET | `/workspaces/:wsId/scripts/:id/progress` | any |
| POST | `/workspaces/:wsId/scripts/:id/execute` | any |
| GET, POST, PATCH, DELETE | `/workspaces/:wsId/scripts/:id/triggers[/:tid]` | any |
| POST | `/demo/provision` | **admin** |
| POST | `/demo/reset` | **admin** |

**FR-011 mechanism**: a test imports the allowlist and asserts every path
template used by `foundry-client.ts` is covered. The enumeration above must not
be trusted as final — the task list includes deriving it mechanically so the
test, not this table, is the source of truth. An allowlist assembled by hand
from a grep will silently starve the product on the next UI change.

**Path normalisation (FR-010)**: match on the already-split `path[]` segments
Next gives the route, after rejecting any segment that is `.`, `..`, empty, or
contains an encoded separator (`%2f`, `%5c`) — rather than matching a rejoined
string. Matching a rejoined path is how allowlists get escaped.

---

## R6 — Does anything here need a new dependency? (Article IV)

**No.** Everything uses the standard library or what is already installed:

- `node:crypto` — `randomBytes`, `scrypt`, `timingSafeEqual`.
- `ws` — already a server dependency; `noServer` is a config change.
- `zod` — already in both `server` and `mcp-bridge`.
- V1's `src/validation/` primitives and `validate()` middleware.
- `next-auth`'s `auth()` — already used by `middleware.ts`.

No entry needed in Complexity Tracking on dependency grounds.

---

## R7 — New environment variables (Article VIII)

| Variable | Purpose | Placeholder needed |
|---|---|---|
| `WS_ALLOWED_ORIGINS` | comma-separated `Origin` allowlist for the progress socket | yes |
| `MCP_BRIDGE_REQUIRE_AUTH` | fail-closed switch; defaults to on, present so a local dev run can be diagnosed without guessing | yes |

No new secret is introduced: bridge credentials are generated at issuance and
stored as digests, so there is no static key to put in the environment. The
existing `CREDENTIAL_ENC_KEY` is untouched.

**Note on §9 R11**: `.env.example` is already missing the whole client-auth and
`DEMO_*` set. This feature adds placeholders for its own two variables only
(FR-018) and does not backfill that gap — it stays its own small feature, as the
roadmap advises.

---

## R8 — Refusal shape

Every refusal reuses V1's error contract: `errorHandler`, opaque body, request
id. The bridge does not currently mount `errorHandler`
(`mcp-bridge/src/index.ts:73-76` hand-rolls a 500) — this feature mounts V1's
handler and the request-id middleware there too, which is a small consistency
win and is required by FR-017.

**Indistinguishable refusals (FR-003, SC-003)**: "wrong workspace" and "no such
workspace" must return the same status, same body and same timing class.
Simplest way to get this right is a single code path that never branches on
existence before authorization — authorize first, then look up.
