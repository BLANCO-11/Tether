# Feature Specification: Authentication and authorization on the unguarded surfaces

**Feature Branch**: `krt/guardrail_validation`

**Created**: 2026-08-03

**Status**: Ready for `/speckit-plan` — all clarifications resolved 2026-08-03

**Input**: User description: "Authentication and authorization on the four unguarded surfaces of the Foundry parent API. One feature because all four share the identity design. (1) MCP bridge /mcp: require a key and scope workspaceId to that key. (2) Progress WebSocket: authenticate the upgrade, check Origin, verify entitlement to scriptId. (3) Next proxy route: an explicit in-route session check plus an upstream-path allowlist. (4) The `roles` claim: pick exactly one enforcement point and use it, or stop minting it. Decide explicitly whether this feature closes §9 R2 (unverified `backendToken`) or defers it. Closes roadmap holes 3, 4, 5; addresses security.md §9 R2 and R3. Rate limiting is V3 and out of scope."

This is **V2** of the Validation & Guardrails programme
([docs/validation-and-guardrails-roadmap.md](../../docs/validation-and-guardrails-roadmap.md)
section V2). V1 (validation kernel + request boundary) is merged on this branch.

## Audited current state (2026-08-03)

Every claim below was verified against the working tree, not inferred from the
roadmap. Two findings diverge from the roadmap's description and change the
shape of the work — see US2 and the Assumptions.

| Surface | Today | Evidence |
|---|---|---|
| MCP bridge | `POST /mcp` has **no authentication of any kind**; all four tools take `workspaceId: z.string()` straight from the caller | `packages/mcp-bridge/src/index.ts:22,28,38,47,63` |
| Progress WS | No auth, no `Origin` check, no entitlement check; serves any `scriptId` to anyone | `packages/server/src/ws/progress-server.ts:13-21` |
| Next proxy | No `auth()` call inside the route; protected only by the middleware matcher. Path forwarded verbatim — no allowlist | `packages/client/src/app/api/foundry/[...path]/route.ts:16-18,54-58`; `packages/client/src/middleware.ts:23` |
| `roles` | Minted for both providers, exported on the session, **read by nothing** | `packages/client/src/auth.ts:106,141,146,168`; no other consumer in `packages/` |
| `backendToken` | Minted HS256 by the client, **never verified** by the server; the server's only credential check is a shared key | `packages/client/src/auth.ts:151-159`; `packages/server/src/middleware/auth.middleware.ts:13` |

**Both unauthenticated listeners are published to the host**, not merely to the
compose network: `infra/docker-compose.yml` maps `3015:3015` and `4001:4001`.
So neither is protected by network placement today.

**Sharpening context** (`security.md` §10): the server mounts the host Docker
socket, so parent-API compromise is host compromise. And `requireApiKey` gates
every `/api/workspaces/**` route with **one shared key** — so any key holder
already has every workspace. That is the ceiling on what V2 can achieve without
closing R2, which is why R2 is the feature's central decision.

### Finding A — the progress WebSocket has no consumers

`.env.example:9` labels `WS_PORT` "**(legacy) progress WebSocket; UI now polls
/progress**". Confirmed: no client code opens a WebSocket. The only match in
`packages/client` is a comment in `dashboard/page.tsx:4` describing a mock
stream "which the real WebSocket replaces later". The UI uses
`GET /api/workspaces/:workspaceId/scripts/:scriptId/progress`, which **is**
behind `requireApiKey`. `NEXT_PUBLIC_WS_URL` is still set in compose but read by
nothing.

So the roadmap's instruction to "authenticate the upgrade" adds an auth
mechanism, an entitlement lookup and their negative tests to a listener with
**zero consumers**. Removal was raised as the cheaper alternative (Q2) and
**declined**: the capability is being kept for a future UI. The finding still
binds the work — it is why FR-022 requires an automated test client, since there
is no product path that would ever exercise this guard.

### Finding B — the middleware matcher does cover the proxy today

The roadmap says "one matcher edit silently opens the whole parent API". The
matcher `/((?!api/auth|_next/static|_next/image|favicon.ico).*)` does currently
match `/api/foundry/**`, so an unauthenticated request is redirected to
`/login`. The live exposure is therefore **not** anonymous access; it is that
(a) the protection is one regex away from vanishing with no test to catch it,
and (b) **any** signed-in user can reach **any** parent-API path with the
server's key — including `/api/demo/reset` and every workspace's secrets. FR-009
and FR-010 address those two distinct problems.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A datasource schema is not readable by strangers (Priority: P1)

An operator has connected a production datasource to a workspace. Its table
names, column names, foreign keys and column comments describe the business.
Today anyone who can reach the bridge port can enumerate all of it for any
workspace by guessing or listing workspace identifiers, without credentials.

**Why this priority**: It is the only surface that is both completely
unauthenticated and published to the host, and schema enumeration is
reconnaissance that makes every later attack cheaper. Highest exposure, lowest
cost to close.

**Independent Test**: Call each bridge tool with no credential and confirm it is
refused; call with a valid credential for workspace A and confirm a request
naming workspace B is refused, not merely empty.

**Acceptance Scenarios**:

1. **Given** the bridge is running, **When** a caller invokes any tool without a
   credential, **Then** the request is refused and no schema information appears
   in the response.
2. **Given** a caller holds a credential scoped to workspace A, **When** it
   invokes a tool naming workspace B, **Then** the request is refused.
3. **Given** a caller holds a credential scoped to workspace A, **When** it
   invokes a tool for workspace A, **Then** the response is byte-identical to
   today's response for the same call.
4. ~~**Given** a caller holds a valid credential, **When** it invokes a tool for a
   workspace that does not exist, **Then** the refusal is indistinguishable from
   the refusal for a workspace it is not entitled to.~~
   **Resolved by design, not by test (recorded 2026-08-03).** This scenario became
   *unreachable* when `workspaceId` was removed from every tool's input schema
   (FR-002): a caller has no way to name a workspace at all, so "a workspace that
   does not exist" cannot be expressed. The property it was protecting is covered
   instead by the bridge's byte-identical-refusal test, which asserts that missing,
   malformed and unknown credentials produce the same response. Left visible rather
   than deleted so a reader does not record it as an untested scenario.

---

### User Story 2 - Generation activity is streamed only to entitled callers (Priority: P1)

The progress WebSocket on :4001 streams live generation events for any script
identifier to any client that asks, with no credential and no `Origin` check.
Generation events carry stage names and status for a caller's scripts.

**Decision (Q2)**: the listener is **retained and authenticated**, not removed.
It has no consumer today (Finding A), so this slice is building a guard ahead of
the UI that will use it. Two consequences the plan must honour:

- The guard must be **verified without a UI consumer** — by a test client, not
  by clicking through the app. A guard whose only exercise is manual is the
  failure mode V1's audit was created by.
- The listener must not be left half-guarded. If the entitlement lookup cannot
  be implemented as specified, the correct fallback is to stop publishing the
  port, not to ship authentication without entitlement.

**Why this priority**: Same class of exposure as US1 — an unauthenticated,
host-published listener carrying workspace-derived activity.

**Independent Test**: Drive the socket with a test client: no credential,
wrong-workspace credential, disallowed `Origin`, and a `scriptId` outside the
credential's workspace must each be refused; a correct combination must receive
the same event stream the bus publishes today.

**Acceptance Scenarios**:

1. **Given** the listener is running, **When** a client attempts an upgrade
   without a valid credential, **Then** the upgrade is refused and no event is
   ever sent.
2. **Given** a client presents a valid credential, **When** its `Origin` is not
   on the allowlist, **Then** the upgrade is refused.
3. **Given** a client holds a credential for workspace A, **When** it subscribes
   to a script belonging to workspace B, **Then** the subscription is refused,
   and the refusal does not reveal whether that script exists.
4. **Given** a client holds a credential for workspace A, **When** it subscribes
   to a script in workspace A, **Then** it receives that script's event stream
   unchanged from today's payload shape.
5. **Given** a subscription is live, **When** the credential would no longer
   authorise it, **Then** the entitlement is re-checked rather than trusted for
   the life of the connection.

---

### User Story 3 - A signed-in user cannot reach parent-API paths the UI never uses (Priority: P1)

The proxy forwards any path under `/api/foundry/**` to the parent API with the
server's shared key attached. A signed-in user — or any page-level bug, or a
future matcher regression — therefore commands the entire parent API surface,
including demo reset and every workspace's secrets.

**Why this priority**: This is the privilege-escalation path with the widest
blast radius, and it is reachable today by anyone with a valid session.

**Independent Test**: Drive the proxy with a valid session and confirm that an
upstream path the UI never calls is refused; drive it with no session and
confirm it is refused by the route itself, with the middleware matcher
temporarily widened to prove the route does not depend on it.

**Acceptance Scenarios**:

1. **Given** no session, **When** a request reaches the proxy route directly,
   **Then** the route refuses it on its own, without relying on the middleware
   matcher.
2. **Given** a valid session, **When** the request targets an upstream path that
   is not on the allowlist, **Then** it is refused and no request is made to the
   parent API.
3. **Given** a valid session, **When** the request targets an allowlisted path,
   **Then** the response is byte-identical to today's, including status, body,
   content type and content disposition.
4. **Given** the middleware matcher is edited to exclude the proxy path,
   **When** an unauthenticated request is made, **Then** it is still refused.

---

### User Story 4 - The `roles` claim either means something or is gone (Priority: P2)

`roles` is populated on every session — the local admin is minted
`["superadmin","admin"]` — and enforced nowhere. A reviewer reading `auth.ts`
reasonably concludes a role check exists somewhere. `security.md` §9 R3 names
this explicitly: "Do not assume a role check exists."

**Why this priority**: It closes no exposure by itself; its value is that it
makes the US3 allowlist expressible in terms of who may do what, and it removes
a standing invitation to misread the code. Depends on US3 landing first.

**Independent Test**: Pick a privileged operation, confirm a session without the
required role is refused and one with it is allowed — or, if the claim is
removed instead, confirm no code path reads it and the session no longer carries
it.

**Acceptance Scenarios**:

1. **Given** the claim is enforced, **When** a session lacking the required role
   attempts a privileged operation, **Then** it is refused.
2. **Given** the claim is enforced, **When** a session holding the role attempts
   the same operation, **Then** it succeeds.
3. **Given** the claim is removed instead, **When** the codebase is searched for
   readers of it, **Then** there are none, and no session field suggests a check
   that does not exist.

### Edge Cases

- A tool call omits `workspaceId` entirely, or sends it as an array, an object,
  or an empty string.
- A credential is valid but its workspace has been deleted since it was issued.
- The proxy is asked for a path that is allowlisted by prefix but escapes it via
  `..` segments, encoded separators, or a scheme-relative value.
- The proxy receives a method the allowlist permits for one path but not another.
- A request arrives at the proxy with a session cookie that is well-formed but
  expired.
- Two workspaces exist and a credential valid for both names a third.
- The parent API is unreachable — the existing 502 envelope must not start
  leaking internals, per V1's error contract.
- An operator upgrades with `NEXT_PUBLIC_WS_URL` still set in their environment.

## Requirements *(mandatory)*

### Functional Requirements

**MCP bridge**

- **FR-001**: The bridge MUST refuse every tool invocation that does not carry a
  valid credential, and MUST NOT include any schema information in the refusal.
- **FR-002**: The bridge MUST derive the workspace a request may read from the
  presented credential, and MUST NOT accept the workspace identifier as a
  caller-supplied value that it trusts.
- **FR-003**: The bridge MUST refuse a request whose named workspace does not
  match the credential's workspace, and the refusal MUST be indistinguishable
  from the response for a workspace that does not exist, so the bridge cannot be
  used to enumerate which workspaces exist.
- **FR-004**: The bridge MUST validate each tool's inputs using the shared
  validation primitives introduced in V1, not a locally re-declared shape, and
  the workspace identifier MUST be constrained to the identifier format the rest
  of the system uses rather than an unconstrained string.
- **FR-005**: The bridge MUST log every refused invocation with the request
  identifier and the reason, and MUST NOT log the presented credential.
- **FR-006**: Successful invocations MUST return exactly what they return today.

**Progress WebSocket** *(Q2: retained and authenticated)*

- **FR-007**: The listener MUST authenticate the upgrade, reject upgrades whose
  `Origin` is not on an allowlist, and refuse a subscription to a script the
  caller is not entitled to. The entitlement check MUST be a server-side lookup
  against the script's owning workspace, never a caller assertion (Article X).
- **FR-008**: The listener MUST reuse the same workspace-scoped credential
  concept as the MCP bridge (FR-002). It MUST NOT introduce a second, parallel
  identity mechanism — that is the outcome §9 R3 warns against, and this feature
  exists partly to remove one such ambiguity, not to add another.
- **FR-021**: Entitlement MUST be re-evaluated for the life of a subscription,
  not only at upgrade time, so a revoked credential stops receiving events.
- **FR-022**: The listener MUST be exercised by an automated test client
  covering each refusal path in US2, since no UI consumer exists to exercise it.
  This is the acceptance condition for retaining the listener at all.

**Next proxy**

- **FR-009**: The proxy route MUST verify the session inside the route handler
  and refuse the request itself when there is none. This check MUST be
  independent of the middleware matcher, and a test MUST demonstrate that
  widening the matcher does not open the route.
- **FR-010**: The proxy MUST forward only upstream paths on an explicit
  allowlist, matched per method, and MUST refuse anything else without
  contacting the parent API. Path matching MUST be performed on a normalised
  path so that traversal segments and encoded separators cannot escape the
  allowlist.
- **FR-011**: The allowlist MUST be derived from the paths the UI actually
  calls, and a test MUST fail if the UI gains a call the allowlist does not
  cover, so the allowlist cannot silently starve the product.
- **FR-012**: For allowlisted requests the proxy's response MUST be unchanged
  from today, including status, body bytes, content type and content
  disposition.
- **FR-013**: The proxy MUST NOT expose the parent API key, or any upstream
  error detail beyond what V1's error contract permits, in any response.

**Roles**

- **FR-014**: Exactly one enforcement point for the `roles` claim MUST be chosen
  and implemented, or the claim MUST be removed from the session and the token.
  A populated-but-unenforced claim MUST NOT remain.
- **FR-015**: If enforced, the set of roles and the operations each gates MUST
  be written down in the plan, and each gate MUST have a negative test.

**Cross-cutting**

- **FR-016**: No already-valid authenticated request may change behaviour. This
  is the acceptance condition for the whole feature.
- **FR-017**: Every refusal introduced here MUST use V1's non-leaking error
  contract and carry a request identifier.
- **FR-018**: Every new credential or configuration value MUST be read from the
  environment, MUST have a placeholder in `.env.example`, and MUST NOT appear in
  any tracked file (Article VIII).
- **FR-019**: Credential comparison MUST NOT be vulnerable to timing analysis.
  *(Note: `requireApiKey`'s existing `!==` comparison is V3's to fix; this
  requirement binds only credentials introduced by this feature, so V2 does not
  create a second instance of the same defect.)*
- **FR-020**: The spec's R2 decision (Q1) MUST be recorded in the plan with its
  consequences for per-user authorization and audit attribution, whether it is
  closed or deferred.

### Key Entities

- **Bridge credential**: what a caller presents to the MCP bridge. Determines
  which single workspace that caller may read schema for. Issued and revoked
  outside the bridge.
- **Upstream path allowlist**: the enumerated set of parent-API path patterns,
  per method, the proxy will forward. Anything absent is refused.
- **Role claim**: the set of role names carried on a session, and the mapping
  from each role to the operations it permits.
- **Script entitlement**: the server-side fact that a given caller may observe a
  given script's activity. Never a caller assertion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero unauthenticated listeners remain published to the host across
  the stack — verified by connecting to every published port without a
  credential and getting no product data from any of them.
- **SC-002**: An unauthenticated caller can obtain no schema information about
  any workspace from any surface.
- **SC-003**: A caller credentialed for one workspace can obtain no information
  about any other workspace, and cannot determine whether another workspace
  exists.
- **SC-004**: 100% of parent-API paths reachable through the proxy are on the
  allowlist, and the count of reachable paths drops from "every path the parent
  API serves" to only those the UI uses.
- **SC-005**: Removing the session check from the proxy route, or widening the
  middleware matcher, each causes at least one test to fail.
- **SC-006**: A search of the codebase finds zero populated-but-unenforced
  authorization claims.
- **SC-007**: Every requirement above has at least one negative test, and every
  negative test fails when its guard is removed. (A guard whose test still
  passes when the guard is deleted is not a guard — this is the discipline V1's
  audit was created by the absence of.)
- **SC-008**: The full existing test suite passes unchanged, demonstrating
  FR-016.

## Assumptions

- **Bridge callers are services, not people.** Its credential is a service
  credential configured out of band, not an interactive login.
- **Correction (found during implementation, 2026-08-03): nothing registers the
  bridge today either.** `infra/docker-compose.yml:111-116` and
  `packages/client/src/lib/run-prompt.ts:12` both state it plainly — the
  generation prompt now tells the agent to connect to datasources directly
  ("there is NO dataplane"), and the web-side bootstrap that used to seed the
  connector was dead code and has been removed. The bridge is kept running
  because the read-only schema tools may be rewired later.

  Two consequences, neither of which changes the decision to authenticate it:
  1. **The breaking tool-contract change is free.** There is no Tether
     registration to update in step, so removing `workspaceId` from the tool
     schemas breaks no live caller.
  2. **The exposure is still real and still the worst one here** — port 3015 is
     published to the host, unauthenticated, and reads every workspace's schema.
     A surface with no consumer is not a surface with no risk.

  Recorded because the spec asserted the opposite, and because it means *both*
  P1 surfaces (US1 and US2) are guards built ahead of their consumers. The
  "remove it instead?" question that Q2 asked about the WebSocket applies
  equally to the bridge; it is not re-asked here, since the same requester
  answered "authenticate" on the identical question and the bridge is the
  higher-exposure of the two.
- **One workspace per credential** (Q3, decided). A credential maps to exactly
  one workspace, and the same primitive serves both the bridge and the
  WebSocket. If a single Tether registration must later serve several
  workspaces, FR-002/FR-003/FR-008 need revisiting.
- **Entitlement is workspace-level, not user-level**, because Q1 defers R2. See
  "How Q1 and Q2 interact" — this bounds what US2 and US4 can honestly claim.
- **The UI's set of parent-API calls is discoverable statically**, so FR-011's
  allowlist can be derived and kept honest by a test.
- **`requireApiKey` and its shared key remain as they are.** V2 does not change
  the parent API's own credential model; that is what closing R2 would mean, and
  it is Q1.
- **Rate limiting, auth-failure logging and throttling, and the `/login`
  attempt limit are V3** and deliberately absent here. The roadmap's ordering
  argument holds: rate-limiting a surface that should not be reachable is the
  wrong order.
- **`.env.example`'s missing client-auth and `DEMO_*` sets (§9 R11) are not
  fixed here.** The roadmap suggests doing that before V2 adds more variables.
  This feature adds its own placeholders (FR-018) but does not backfill the
  existing gap, which stays its own small feature.
- **No new runtime dependency is assumed.** If the chosen designs need one,
  Article IV requires its justification in `plan.md`.
- **The audit above reflects the working tree at 2026-08-03** on
  `krt/guardrail_validation`, with V1 merged.

## Resolved Decisions

Three decisions materially changed the shape of the work. All were settled with
the requester on 2026-08-03 and are binding on `/speckit-plan`.

| # | Decision | Chosen |
|---|---|---|
| Q1 | §9 R2 (unverified `backendToken`) | **Deferred** to its own feature |
| Q2 | Progress WebSocket | **Retained and authenticated** |
| Q3 | MCP bridge credential scope | **One credential per workspace** |

### How Q1 and Q2 interact — read before planning

Q1 defers R2, so **the server has no user identity**. Q2 nevertheless requires
an entitlement check on the WebSocket. With no user identity available, the
strongest honest meaning of "entitled to this script" is:

> the caller presents a valid credential scoped to workspace W, and the
> requested script belongs to workspace W.

That is **workspace-level**, not user-level, entitlement. The plan must not
describe it as per-user, and no test may be named or worded as if it proves
per-user authorization — doing so would recreate exactly the R3 defect this
feature is removing (a guard that reads stronger than it is, Article XV).
Per-user entitlement becomes possible only once R2 is closed.

This is also why Q3's answer is load-bearing beyond the bridge: the
per-workspace credential is the **single** identity primitive both the bridge
(FR-002) and the WebSocket (FR-008) are built on. One concept, two consumers.

### Q1 — Does V2 close §9 R2, or explicitly defer it?

**Decision: A — defer.**

**Context**: `backendToken` is minted by the client (`auth.ts:151`) and verified
by nothing. The parent API's only credential is a shared key, so it cannot
attribute a request to a user. Until that changes, "authorization" at the parent
API means "holds the one key" — and per-user authorization and audit attribution
are both impossible. The Docker-socket context makes this the highest-value
change available.

| Option | Answer | Implications |
|---|---|---|
| A | **Defer R2** to its own feature; V2 closes only holes 3/4/5 *(recommended)* | Keeps V2 shippable and reviewable. Every guard here stays coarse — the proxy allowlist limits *what* can be called, never *who*. R2 must then be its own feature before any per-user rule is credible. |
| B | **Close R2 in V2**: the server verifies the token and derives identity from it | Makes real per-user authorization and audit attribution possible, and US4 becomes meaningful rather than cosmetic. Substantially larger: key management, rotation, expiry, clock skew, and a migration path for every existing caller of the shared key. |
| C | Close R2 for **new** surfaces only; leave `requireApiKey` untouched | Two coexisting identity models — the outcome §9 R3 warns about. Not recommended. |

### Q2 — Authenticate the progress WebSocket, or remove it?

**Decision: B — authenticate it.** The capability is being kept for a future UI.
Consequences recorded in US2, FR-007, FR-008, FR-021 and FR-022: because no
consumer exists, the guard must be proven by an automated test client, and
authentication without entitlement is not an acceptable partial outcome.

**Context**: Finding A above — `.env.example` calls it legacy, the UI polls
`/progress` instead, and no client code opens a WebSocket.

| Option | Answer | Implications |
|---|---|---|
| A | **Remove it** — stop starting it, unpublish :4001, drop `WS_PORT` and `NEXT_PUBLIC_WS_URL` *(recommended)* | Closes the exposure with strictly less code. Least privilege (Article XI). If live push is wanted later it is specified deliberately, with auth from the start. FR-008 applies. |
| B | **Authenticate it** as the roadmap describes | Keeps the capability for a future UI. Costs an upgrade-time credential, an `Origin` allowlist, an entitlement lookup and their negative tests — maintained for a listener with no consumer. FR-007 applies. |
| C | Keep it but bind it to loopback only | Cheapest, but leaves an unauthenticated listener reachable by anything on the host, including a compromised sibling container. Not recommended. |

### Q3 — How is a bridge credential scoped to a workspace?

**Decision: A — one credential per workspace**, issued when a datasource is
connected. The plan must cover issuance, storage (encrypted at rest, as
`tether_api_key` already is), revocation, and how Tether is registered per
workspace. This credential is also the WebSocket's identity primitive (FR-008).

**Context**: FR-002 requires the workspace to come from the credential. How that
mapping exists is a design choice with different operational costs.

| Option | Answer | Implications |
|---|---|---|
| A | **One credential per workspace**, issued when a datasource is connected *(recommended)* | Truest least privilege; a leaked credential exposes one workspace. Needs issuance, storage and revocation, and Tether must be registered per workspace. |
| B | One shared bridge key + the workspace derived from a server-side registration of the calling Tether instance | Simpler to deploy; no per-workspace issuance. A leaked key exposes every workspace the registration covers, so it is only as good as that registration. |
| C | One shared bridge key, `workspaceId` still caller-supplied but required to exist | Authenticates the caller but does **not** close FR-003 — any key holder still enumerates every workspace. Does not meet SC-003. |
