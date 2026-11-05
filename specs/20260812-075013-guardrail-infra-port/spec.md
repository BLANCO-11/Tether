# Feature Specification: Guardrail Infrastructure Port (V1/V3/V6/V7 → v1-alpha)

**Feature Branch**: `20260812-075013-guardrail-infra-port`

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "Port the generic guardrail infrastructure from the krt/guardrail_validation branch into v1-alpha as new, additive capability: V1 structural request-validation kernel, V3 rate-limit and concurrency abuse controls, V6 egress/SSRF policy for outbound network calls, and V7's shared cross-package validation-rules package (@foundry/shared). This is a port/adaptation, not a copy: v1-alpha has a different top-level layout, a different package set, and its own existing auth/identity middleware that must not be broken or duplicated. Explicitly out of scope: V2 auth changes, and V4/V5/V8 (prompt-boundary, generation audit, request-policy), which are tied to a script-generation model v1-alpha doesn't have."

## Context

This repository has two independently-evolved lines of work with no shared git
history: `krt/guardrail_validation` built a "Validation & Guardrails" programme
(V1–V8) against an earlier product shape (standalone Python script generation
via a Tether-style harness). `v1-alpha` evolved separately into a different
product shape (a "flows" orchestration engine — `flow-chat`, `flow-generation-job`,
`flow-compiler`, `engine-plugins`, `kestra`, `sandbox`, `ops-api`) and never
received any of that guardrails work.

A pre-merge audit of `krt/guardrail_validation`'s V1–V8 established that its
guardrails were genuinely wired into production (not merely tested in
isolation) and found/fixed several gaps. When asked to bring that work into
`v1-alpha`, inspection showed `v1-alpha` has **none** of the following
infrastructure today: a structural request-validation kernel, rate/concurrency
limits, an egress/SSRF policy for outbound network calls, or a shared
cross-package validation-rules package. It does have its own
`auth.middleware.ts` / `identity.middleware.ts`, and its own `flow-validator.service.ts`
(which validates flow *definitions*, not raw HTTP request shape) — neither of
which duplicates what this feature adds.

This feature ports four of `krt/guardrail_validation`'s eight guardrail slices
— the four that are generic and not coupled to the script-generation model
`v1-alpha` doesn't have:

- **V1 — Validation kernel**: shared request-shape validation (path params,
  bodies) at the route boundary, plus a non-leaking error contract.
- **V3 — Rate limits & abuse controls**: per-route-class rate limits,
  concurrency ceilings on expensive operations, auth-failure throttling/logging,
  and a request-id threaded through logs and responses.
- **V6 — Egress/SSRF policy**: validation of any URL or connection string the
  server itself dials outbound (webhook/poll triggers, tool calls, datasource
  connections), checked at registration and re-checked at dial time against a
  private-address-range denylist.
- **V7 — Shared validation package**: a new `@foundry/shared`-equivalent
  package so client and server can validate the same rules from one source,
  instead of each re-implementing them.

**Explicitly deferred to a later feature** (not attempted here): V2 (auth
changes — `v1-alpha`'s auth/identity middleware is untouched), and V4/V5/V8
(prompt-boundary, generation audit, request-policy) — those three are built
specifically around evaluating and auditing a generated script's task prompt,
and `v1-alpha`'s equivalent generation surface (`flow-chat`/`flow-generation-job`)
needs its own design pass before any of those concepts can be adapted to it.
That design pass is out of scope for this feature.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Malformed requests are rejected before they reach a service or the database (Priority: P1)

A caller sends a request with an invalid path parameter (e.g. a non-UUID
workspace id) or a malformed body to any mounted route. Today, in `v1-alpha`,
that can reach a service call or the database driver and surface as an
unhandled 500 with internal detail in the body. After this feature, it returns
a structured 400 that names the invalid field, and no internal detail (stack
trace, driver error text, upstream error body) ever reaches the response.

**Why this priority**: This is the foundation the other three slices build on
(request ids, for instance, are needed to make rate-limit and egress denials
diagnosable). It is also the most visible class of defect if left unfixed —
an information-leaking 500 is a textbook security-review finding.

**Independent Test**: Send a request with an invalid path parameter or body
shape to any mounted route in `v1-alpha` and confirm a structured 400 (not a
500), with no internal error text in the response body. Send a request that
induces an unexpected server error and confirm the response contains only an
opaque error code and a request id, with the real error logged server-side.

**Acceptance Scenarios**:

1. **Given** a mounted `v1-alpha` route with a path parameter expected to be a
   UUID, **When** a caller supplies a non-UUID value, **Then** the response is
   `400` naming the invalid field, and no database driver error text appears
   in the response.
2. **Given** any validated route, **When** a well-formed, previously-valid
   request is sent, **Then** the response is identical to today's — no
   behavior change for valid requests.
3. **Given** an unexpected internal error (e.g. a downstream failure), **When**
   the error handler responds, **Then** the body contains only an opaque error
   code and a request id; the full error and stack are logged server-side
   against that same request id.

---

### User Story 2 - Expensive or abusable operations are rate-limited and capacity-bounded (Priority: P1)

An operator or automated caller repeatedly hits an expensive route (flow
generation, flow execution, or authentication itself) faster than the system
can safely absorb. Today, in `v1-alpha`, there is no rate limiting anywhere in
the stack and no logging of repeated authentication failures. After this
feature, each route class has its own limit sized to its actual cost, expensive
in-flight operations are capped by a concurrency ceiling (refused, not queued,
when at capacity), and repeated authentication failures are logged and
throttled.

**Why this priority**: Without this, a single caller (malicious or just
buggy) can exhaust a shared, expensive resource (LLM generation capacity,
sandbox execution slots) for every other tenant. This must not change
behavior for legitimate traffic volumes.

**Independent Test**: Send requests to a rate-limited route faster than its
configured limit and confirm a `429` with a `Retry-After` header once the
limit is exceeded, and that legitimate, properly-paced traffic is unaffected.
Start more concurrent expensive operations (e.g. flow generation runs) than
the configured ceiling and confirm the excess is refused immediately (not
queued) with no resource consumed.

**Acceptance Scenarios**:

1. **Given** a rate-limited route class, **When** a caller exceeds the
   configured limit within the configured window, **Then** the response is
   `429` with a `Retry-After` header, and no side effect (no service call, no
   resource consumed) occurs for the refused request.
2. **Given** an expensive operation with a concurrency ceiling, **When** the
   number of in-flight operations for that class is already at the ceiling,
   **Then** a new request is refused immediately (not queued) and nothing is
   started.
3. **Given** repeated failed authentication attempts from the same caller,
   **When** the failure count crosses a threshold, **Then** further attempts
   from that caller are throttled and every failure is logged with enough
   context to investigate after the fact.
4. **Given** any request, **When** it is rate-limited, refused for capacity,
   or fails, **Then** the response and the corresponding server log entry
   share the same request id.

---

### User Story 3 - The server never dials an operator-supplied address without checking it first (Priority: P1)

`v1-alpha`'s own server process makes outbound network calls to addresses an
API caller controls or influences (webhook/poll trigger URLs, tool endpoint
URLs, datasource connection strings). Today none of these are checked against
private/internal address ranges before the server dials them — the same class
of exposure V6 closed on `krt/guardrail_validation`. After this feature, every
such outbound call is validated (scheme, then DNS resolution against a
private-range denylist) both when the address is registered and again at the
moment of dialing, so a DNS-rebinding attack between registration and dial
time cannot bypass the check.

**Why this priority**: This is the server's own network position being used
against it — the most severe class of guardrail gap, and it is currently
completely unguarded in `v1-alpha`.

**Independent Test**: Register a webhook/poll trigger URL, a tool endpoint, or
a datasource connection string that resolves to a private or loopback address
and confirm registration is rejected. Confirm that an address which resolves
to a public address at registration time but is re-pointed to a private
address before the server actually dials it is still rejected at dial time.

**Acceptance Scenarios**:

1. **Given** a URL or connection string being registered (trigger, tool,
   datasource), **When** it resolves to a private, loopback, or otherwise
   internal address, **Then** registration is rejected.
2. **Given** a previously-registered address, **When** the server is about to
   actually dial it, **Then** the address is re-resolved and re-checked against
   the same denylist immediately before the connection is made — a stale or
   rebound resolution does not bypass the check.
3. **Given** a legitimate, public-address registration, **When** it is
   registered and later dialed, **Then** behavior is unchanged from today.

---

### User Story 4 - Client and server validate requests against the exact same rules (Priority: P2)

`v1-alpha`'s client and server currently have no shared source of truth for
validation rules that apply on both sides (e.g. field shape checks a form
should enforce client-side for fast feedback, and the server must enforce
regardless since the client is untrusted). After this feature, a new
dependency-free shared package holds those rules once, and both sides import
it, so the two can never silently drift apart.

**Why this priority**: Lower urgency than the other three (nothing is
insecure without it — the server already independently re-validates
everything), but it's the foundation that makes P2/P3 client-side UX work
(instant feedback on invalid input) safe to add without creating a second,
divergent copy of the rules.

**Independent Test**: Pick a validation rule enforced on both client and
server (once one exists) and confirm an equivalence test proves both sides
produce the same accept/reject decision for the same input, sourced from one
shared implementation, not two.

**Acceptance Scenarios**:

1. **Given** the new shared package, **When** a validation rule is defined in
   it, **Then** both the relevant client code and the relevant server code
   import that same rule rather than each defining their own copy.
2. **Given** a shared rule, **When** the same input is evaluated on the client
   and on the server, **Then** both produce the identical accept/reject
   decision — proven by an equivalence test, not merely asserted.
3. **Given** the client is bypassed entirely (a direct API call), **When** an
   invalid request reaches the server, **Then** the server independently
   rejects it — client-side validation is never the only enforcement point.

---

### Edge Cases

- What happens when a route needs a very small or very large body-size limit
  relative to the global default? Per-route overrides must be possible, not
  just one global limit (mirrors V1's per-route body-size limits).
- What happens when the concurrency ceiling for an operation class is reached
  by requests that are all legitimate (no abuse), just a genuine traffic
  spike? They are refused with a capacity response distinguishable from a
  generic failure, so the caller/UI can tell "busy, retry" from "broken."
- What happens when an address passes the registration-time egress check but
  its DNS record changes before the server dials it? Covered by User Story
  3's re-check-at-dial-time requirement — this is exactly the scenario it
  exists to close.
- What happens to a route or flow that is already correctly using
  `v1-alpha`'s own `auth.middleware.ts`/`identity.middleware.ts`? Unaffected —
  this feature does not modify authentication or identity attestation.
- What happens if the shared validation package needs a rule that only makes
  sense server-side (e.g. a check requiring database access)? It stays
  server-only; the shared package holds only rules that are meaningful and
  safely evaluable on both sides.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a shared validation-primitives module
  (adapted from `krt/guardrail_validation`'s `src/validation/`) and a
  declarative `validate({params, query, body})` middleware, applied to every
  mounted `v1-alpha` route that accepts path parameters, a query, or a body.
- **FR-002**: A validation failure MUST produce a structured `400` response
  naming the invalid field(s), and MUST NOT proceed to any service call,
  database access, or side effect.
- **FR-003**: The system MUST assign a request id to every inbound request,
  surfaced in the response (e.g. an `X-Request-Id` header) and in every
  server-side log line for that request's processing.
- **FR-004**: The error-handling contract MUST NOT echo raw internal error
  messages, stack traces, or upstream error bodies in any response. Opaque
  error codes plus the request id are returned instead; full detail is logged
  server-side against that request id.
- **FR-005**: The system MUST apply rate limits sized per route class (not one
  global number), covering at minimum: authentication attempts, flow
  generation, and flow/script execution starts.
- **FR-006**: The system MUST enforce a concurrency ceiling on expensive
  in-flight operations (at minimum: flow generation, execution). A request
  that would exceed the ceiling MUST be refused immediately, not queued, and
  MUST NOT consume any resource.
- **FR-007**: Repeated authentication failures from the same caller MUST be
  logged with enough context to investigate after the fact, and MUST be
  throttled once a threshold is crossed.
- **FR-008**: Every outbound network call the server itself makes to an
  address supplied or influenced by an API caller (webhook/poll trigger URLs,
  tool endpoint URLs, datasource connection strings) MUST be validated
  (scheme check, then DNS resolution checked against a private/internal
  address-range denylist) both at registration time and again immediately
  before the server dials the address.
- **FR-009**: The private-address-range denylist MUST cover, at minimum,
  loopback, link-local, and RFC 1918 private ranges, and any documented
  internal-only exception MUST be an explicit, reviewed allowlist entry, not
  an absence of a check.
- **FR-010**: The system MUST introduce a new, dependency-free shared package
  holding validation rules usable from both `v1-alpha`'s client and server
  packages, following the existing monorepo's package conventions.
- **FR-011**: For every validation rule defined in the shared package, an
  equivalence test MUST prove the client-side and server-side consumers
  produce identical accept/reject decisions for the same input.
- **FR-012**: This feature MUST NOT modify `v1-alpha`'s existing
  `auth.middleware.ts`, `identity.middleware.ts`, `revision-provenance.middleware.ts`,
  `run-requester.middleware.ts`, `step-token.middleware.ts`, `flow-validator.service.ts`,
  or any generation/audit/request-policy concept — those are unchanged by this
  feature (V2 and V4/V5/V8 concerns, respectively).
- **FR-013**: No behavior change MUST occur for any request that was valid,
  within limits, and directed at a public address before this feature — this
  feature only adds new rejection paths for requests that were already
  invalid, abusive, or unsafe.

### Key Entities *(include if feature involves data)*

- **Request id**: a per-request identifier threaded through the response and
  every server log line for that request, reused from FR-003 by the rate-limit
  and egress-policy denial paths so a denial is diagnosable end-to-end.
- **Rate-limit/concurrency state**: per-route-class counters and in-flight
  operation counts; storage mechanism (in-memory vs. a shared store) is a
  planning decision, not fixed here.
- **Egress decision**: the record of a scheme/DNS-resolution check against the
  private-range denylist, applicable to any operator-supplied outbound
  address, produced at both registration and dial time.
- **Shared validation package**: a new package, parallel in role to
  `krt/guardrail_validation`'s `@foundry/shared`, holding rules consumable by
  both `v1-alpha`'s client and server.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every mounted route with a path parameter returns a structured
  400 (never an unhandled 500) when that parameter is malformed.
- **SC-002**: No error response of any kind contains a database driver error
  string, a stack trace, or an unredacted upstream error body.
- **SC-003**: A caller exceeding a route class's configured rate limit
  receives a 429 with a retry hint, and the refusal consumes no downstream
  resource.
- **SC-004**: A caller attempting to exceed a concurrency ceiling on an
  expensive operation is refused immediately, with the refusal distinguishable
  from a generic failure.
- **SC-005**: An address that resolves to a private/internal range is rejected
  both at registration and at dial time, including when the address is
  re-pointed to a private range after registration but before first dial.
- **SC-006**: For every rule the shared validation package defines, an
  automated equivalence test proves identical client/server behavior for the
  same input.
- **SC-007**: Every existing `v1-alpha` integration path that was working
  before this feature continues to pass its existing test suite unchanged
  after this feature — verified by running `v1-alpha`'s full test suite before
  and after and diffing the results.
- **SC-008**: A new engineer can determine, from `tasks.md` and `plan.md`
  alone, exactly which `v1-alpha` file each ported guardrail concept landed
  in, and which `krt/guardrail_validation` file it was adapted from.

---

## Assumptions

- `v1-alpha`'s package manager, test runner, and monorepo conventions (pnpm
  workspace, Vitest, TypeScript, Express on the server, Next.js on the client)
  match what was audited during reconnaissance; the planning phase re-confirms
  this against the actual `v1-alpha` codebase before any code is written.
- The counter/state store for rate limits and concurrency ceilings (in-memory
  per-process vs. a shared store such as Redis, if `v1-alpha` has one running)
  is a planning-phase decision, made by auditing what's actually available in
  `v1-alpha`'s infrastructure — not assumed here.
- `v1-alpha`'s existing `auth.middleware.ts`/`identity.middleware.ts` already
  provide the per-caller identity this feature's rate limits key on; this
  feature does not need to add a new identity concept, only consume the
  existing one.
- The exact list of routes needing egress-policy checks (webhook triggers,
  poll triggers, tool calls, datasource connections) is confirmed by auditing
  `v1-alpha`'s actual routes/services during planning — the User Story 3
  description above names the categories the `krt/guardrail_validation`
  precedent covered, not a v1-alpha-specific file list, since that audit
  happens in `/speckit-plan`.
- This feature does not change any client-visible behavior for legitimate use
  beyond what SC-007 already guarantees (unchanged behavior for existing
  passing tests) — no UI changes are anticipated, only new rejection paths
  and a new shared package.

## Out of Scope

- V2 (auth/identity changes) — `v1-alpha`'s existing auth/identity middleware
  is unmodified.
- V4 (prompt-boundary), V5 (generation audit), V8 (request-policy /
  clone-detection) — all three are coupled to evaluating and auditing a
  generated script's task prompt, a model `v1-alpha` doesn't have in the same
  shape. Adapting these to `flow-chat`/`flow-generation-job` is a distinct,
  future feature requiring its own design pass.
- Any change to `v1-alpha`'s "flows" domain logic (flow compilation,
  execution, approval, chat) beyond the generic guardrails this feature adds
  around routes and outbound network calls.
- Redesigning or replacing any of `v1-alpha`'s existing validation
  (`flow-validator.service.ts`) — this feature adds request-boundary
  validation, which is a different layer, not a replacement.

## Dependencies

- `v1-alpha`'s existing Express app structure and route-mounting pattern, as
  the integration point for the new validation middleware and rate limiters.
- `v1-alpha`'s existing `auth.middleware.ts`/`identity.middleware.ts`, as the
  identity source rate limits key on.
- Whatever infrastructure `v1-alpha` already has running (confirmed during
  planning) as the candidate rate-limit/concurrency state store.
