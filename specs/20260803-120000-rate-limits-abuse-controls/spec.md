# Feature Specification: Rate limiting, request identity and abuse controls

**Feature Branch**: `krt/guardrail_validation`

**Created**: 2026-08-03

**Status**: Ready for `/speckit-plan` — all clarifications resolved 2026-08-03

**Input**: User description: "V3 of the Validation & Guardrails programme: rate limiting, request identity and abuse controls. Closes security.md §9 R10 and R1. (1) Auth-failure logging and throttling; requireApiKey logs nothing and compares with `!==`. (2) Rate limits sized per route class, not one global number; generation and execution also need concurrency limits. (3) Request ids threaded through logs, stub_call_log and error responses. (4) Decide and record the counter store — Redis is running and read by no code. Must not change behaviour for legitimate traffic."

This is **V3** of the Validation & Guardrails programme
([docs/validation-and-guardrails-roadmap.md](../../docs/validation-and-guardrails-roadmap.md)
section V3). V1 (validation kernel) and V2 (auth on the unguarded surfaces) are
merged on this branch.

## Audited current state (2026-08-03)

Verified against the working tree, not inferred from the roadmap.

| Fact | Evidence |
|---|---|
| **No rate limiting exists anywhere** in the stack | no rate-limit dependency in any `package.json`; no limiter in `app.ts` |
| `requireApiKey` compares with `!==` — not constant-time | `server/src/middleware/auth.middleware.ts:13` |
| `requireApiKey` logs **nothing** on failure | same file — a 401 leaves no trace at all |
| **Redis is running and read by NO code** | `infra/docker-compose.yml` publishes 6380 and the container is healthy; the only mention in `packages/**` is `config/index.ts:70` declaring `redisUrl`. Nothing imports a Redis client |
| Generation is a **480-second** model run | `services/script-generation.service.ts:19` — `MAX_WAIT_MS = 480_000` |
| `stub_call_log` **cannot hold a request id** | its columns are `id, tool_name, method, path, query, body, status_code, result_count, duration_ms, called_at, auth_presented, auth_ok, auth_via` — no `request_id` |
| Unauthenticated surfaces reachable today | `app.ts:37,40,42,46` — `/api` (health), `/api/triggers/:token/webhook`, `/api/stubs`, `/stub-api` |
| Local-admin `/login` has no attempt limiting and grants `superadmin` | `client/src/auth.ts:97-107` — `authorize()` does a bare password comparison and returns `roles: ["superadmin","admin"]` |

**What V1 and V2 already give us, to be reused rather than rebuilt**: request ids
on every response (`requestIdMiddleware`, UUID-gated), the non-leaking
`errorHandler` contract, and V2's workspace-scoped credential — which is the only
per-caller identity the server has.

**The ceiling on this slice**: §9 R2 stays deferred, so the parent API still has
**no user identity**. Limits can therefore be keyed only by client address, by API
key, or by V2 credential — **never per user**. Nothing in this feature may be
described as a per-user limit.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A brute-force attempt against the API key is slowed and visible (Priority: P1)

The parent API's only credential is a single shared key. Today an attacker can
guess it as fast as the network allows, and a failed attempt produces no log line
at all — so an in-progress attack is invisible in retrospect as well as in the
moment.

**Why this priority**: it is the cheapest attack on the whole stack, and the
Docker-socket context (`security.md` §10) makes parent-API compromise host
compromise. Detection is worth as much as the throttle.

**Independent Test**: drive repeated wrong keys from one client and confirm the
attempts are refused, then throttled, and that each one produced a log line
carrying a request id; confirm a correct key still works throughout.

**Acceptance Scenarios**:

1. **Given** an unauthenticated caller, **When** it presents a wrong API key,
   **Then** the attempt is logged with the request id, the client address and the
   fact it was an auth failure — and **not** the key material.
2. **Given** repeated wrong keys from one client, **When** a threshold is crossed,
   **Then** further attempts are refused with a distinct rate-limit response until
   a cooldown elapses.
3. **Given** a client that is being throttled for auth failures, **When** it then
   presents the **correct** key, **Then** it is still throttled — otherwise the
   throttle is a free oracle for "that guess was right".
4. **Given** a legitimate caller with the correct key, **When** it makes normal
   requests throughout an attack from another address, **Then** it is never
   refused.
5. **Given** any key comparison, **When** timing is measured across many attempts
   with keys sharing progressively longer prefixes, **Then** no prefix-length
   signal is observable.

---

### User Story 2 - Expensive work cannot be triggered faster than it can be done (Priority: P1)

Generation is a 480-second model run. A rate limit alone does not stop ten
simultaneous runs, and nothing today stops any number of them.

**Why this priority**: this is the abuse path with real cost attached — model
spend and host resource exhaustion — and it is reachable by any key holder.

**Independent Test**: start more concurrent generations than the configured
ceiling and confirm the excess is handled per the Q2 decision; confirm one
generation at a time is completely unaffected.

**Acceptance Scenarios**:

1. **Given** the concurrency ceiling for generation, **When** more runs are
   requested at once, **Then** the excess is handled per the Q2 decision and the
   response says which limit was hit and when to retry.
2. **Given** a single generation, **When** it is requested, **Then** it behaves
   exactly as it does today — same latency, same progress reporting.
3. **Given** running generations, **When** one finishes or fails, **Then** a
   waiting or subsequently-retried request can proceed — the slot is released on
   **both** success and failure.
4. **Given** a generation that crashes the orchestrator mid-run, **When** the
   process recovers, **Then** its slot is not leaked permanently.
5. **Given** the execution path, **When** many executions are requested at once,
   **Then** the same protection applies, sized separately from generation.

---

### User Story 3 - Public surfaces cannot be used to exhaust the service (Priority: P1)

`/api/triggers/:token/webhook`, `/api/stubs`, `/stub-api` and `/api/health` are
unauthenticated by design. None is rate limited, and the stub endpoints write a
row to `stub_call_log` per call.

**Why this priority**: unauthenticated and unmetered is the definition of a free
amplifier — including an unbounded write amplifier into `stub_call_log`.

**Independent Test**: exceed each public surface's limit and confirm a rate-limit
response; confirm the demo flow and a legitimate webhook still work.

**Acceptance Scenarios**:

1. **Given** a public surface, **When** one client exceeds its limit, **Then**
   further requests are refused with a rate-limit response and a retry hint.
2. **Given** the HR demo running normally, **When** a user drives the UI and the
   demo scripts call the stub tools, **Then** nothing is refused.
3. **Given** a legitimate webhook firing at its normal cadence, **When** the
   limiter is active, **Then** it is never refused.
4. **Given** health checks from the container runtime, **When** they poll at their
   configured interval, **Then** they are never refused — a limiter that can fail
   a liveness probe takes the service down by itself.
5. **Given** a client exceeding a limit, **When** it is refused, **Then** the
   refusal is not more expensive to serve than the work it replaced.

---

### User Story 4 - A refused or failed request stays diagnosable (Priority: P2)

V1 made errors deliberately opaque to the caller. That is only safe if the
operator can still reconstruct what happened, which needs the request id present
everywhere the request left a trace. `stub_call_log` cannot currently hold one.

**Why this priority**: it is what keeps V1's opacity honest rather than merely
quiet, and it is the difference between "429" and "429, here is exactly which
limit and which caller".

**Independent Test**: make one request that is refused by each new limit, then
reconstruct each from its request id alone — across the log and `stub_call_log`.

**Acceptance Scenarios**:

1. **Given** any refusal introduced by this feature, **When** it is returned,
   **Then** it carries the request id, and a log line with the same id records
   which limit was hit and the key it was counted against.
2. **Given** a stub-tool call, **When** it is recorded, **Then** the stored row
   carries the request id of the call.
3. **Given** a request id from a response, **When** an operator searches the logs
   and the stub call log, **Then** every trace of that request is findable by it.
4. **Given** a rate-limit refusal, **When** the response is inspected, **Then** it
   reveals no limit internals beyond what a caller needs to retry correctly — no
   counter values for other callers, no key material.

---

### User Story 5 - The local-admin login cannot be brute-forced (Priority: P2)

The credentials provider compares a password with no attempt limiting and, on
success, mints `["superadmin","admin"]` — which after V2 is the role that gates
demo destruction.

**Why this priority**: §9 R1 rates it high, and V2 gave the role real authority,
so the account is now worth more than it was. Priority P2 only because it is a
different package and mechanism from the parent-API work above.

**Independent Test**: drive repeated wrong passwords and confirm attempts are
throttled and logged; confirm the correct password still signs in outside a
throttle window.

**Acceptance Scenarios**:

1. **Given** repeated failed sign-ins for an identity, **When** a threshold is
   crossed, **Then** further attempts are refused for a cooldown even if correct.
2. **Given** a failed sign-in, **When** it happens, **Then** it is logged with the
   attempted identity and the client address, and **never** the password.
3. **Given** a legitimate operator, **When** they mistype once and then type
   correctly, **Then** they sign in without waiting.

### Edge Cases

- Every request arrives from the same address because the app is behind a proxy
  or in compose — a limiter keyed on a spoofable or uniform address either
  throttles everyone at once or nobody.
- `X-Forwarded-For` is present but not trustworthy.
- The process restarts mid-cooldown, or mid-generation with slots held.
- Two instances run behind a load balancer (the Q1 assumption).
- The counter store is unreachable — does the limiter fail open or closed?
- A single legitimate burst: the UI opening a workspace fires many requests at
  once on page load.
- A generation slot is held by a run whose orchestrator died.
- Clock skew or a long GC pause spans a window boundary.
- The limiter itself becomes the memory leak — unbounded key growth from
  distinct attacker addresses.

## Requirements *(mandatory)*

### Functional Requirements

**Auth-failure handling**

- **FR-001**: API-key comparison MUST be constant-time with respect to the key's
  content, so no prefix-length signal is observable.
- **FR-002**: Every authentication failure MUST be logged with the request id, the
  client address, the surface, and the reason — and MUST NOT log the presented
  credential or any part of it.
- **FR-003**: Repeated authentication failures from one client MUST be throttled
  after a threshold, for a cooldown period.
- **FR-004**: While a client is throttled for auth failures, a **correct**
  credential MUST also be refused for the remainder of the cooldown, so the
  throttle cannot be used as a "that guess was right" oracle.
- **FR-005**: Auth-failure throttling MUST NOT be able to lock out a legitimate
  caller by way of another client's failures.

**Rate limits per route class**

- **FR-006**: Limits MUST be configured per route class, with at least these
  classes distinguished: unauthenticated public surfaces, health/liveness,
  authenticated CRUD, generation, and execution.
- **FR-007**: Health and liveness endpoints MUST NOT be refused at any rate a
  container runtime would poll them. A limiter that can fail a liveness probe is
  an outage.
- **FR-008**: A refusal MUST tell the caller which limit was hit and when to
  retry, and MUST NOT expose other callers' counters or any key material.
- **FR-009**: Serving a refusal MUST be cheaper than serving the request it
  replaces, and MUST NOT require a database write.
- **FR-010**: Limit thresholds MUST come from configuration with documented
  defaults, so an operator can raise one without a code change.

**Concurrency limits**

- **FR-011**: Generation MUST have a maximum number of simultaneous runs,
  configured independently of its rate limit.
- **FR-012**: Execution MUST have its own maximum, configured independently of
  generation's.
- **FR-013**: A concurrency slot MUST be released on success, on failure, on
  timeout, and on abandonment — a leaked slot degrades to a permanent outage of
  that capability.
- **FR-014**: Slots held at process death MUST NOT be leaked permanently across a
  restart.

**Request identity**

- **FR-015**: `stub_call_log` MUST record the request id of the call that produced
  each row.
- **FR-016**: Every log line this feature adds MUST carry the request id.
- **FR-017**: Every refusal this feature introduces MUST carry the request id in
  its response, per V1's error contract.
- **FR-018**: An operator holding one request id MUST be able to find every trace
  of that request across the application log and `stub_call_log`.

**Client sign-in**

- **FR-019**: Failed local-admin sign-in attempts MUST be throttled per identity
  after a threshold, for a cooldown.
- **FR-020**: Failed sign-ins MUST be logged with the attempted identity and
  client address, and never the password.

**Cross-cutting**

- **FR-021**: No legitimate traffic pattern may begin to be refused. Specifically:
  a normal UI session including a page load that fires many requests at once, a
  demo provision or reset, a webhook at its normal cadence, and a single
  generation must all behave exactly as they do today. This is the acceptance
  condition for the whole feature.
- **FR-022**: The limiter's own state MUST be bounded — it must not grow without
  limit as distinct clients appear.
- **FR-023**: The behaviour when the counter store is unavailable MUST be an
  explicit, documented decision, and MUST be tested.
- **FR-024**: Every new configuration value MUST be read from the environment and
  MUST have a placeholder in `.env.example` (Article VIII).
- **FR-025**: Limits MUST be keyed only by client address, API key, or V2
  workspace credential. There is no user identity (§9 R2 deferred), and nothing
  here may be documented as a per-user limit.

**From the resolved decisions**

- **FR-026**: The loss of all counters and cooldowns on process restart MUST be
  documented at the code that owns them. An attacker able to induce a restart
  resets their own throttle; that is accepted, but it must be a recorded
  limitation rather than a surprise.
- **FR-027**: The server MUST log, at startup, that limits are enforced per
  instance and are therefore only correct for a single instance. So that scaling
  out produces a visible statement rather than a silent doubling of every limit.
- **FR-028**: The sign-in throttle MUST carry the same per-instance caveat, since
  the client may run more than one worker even in a single container.
- **FR-029**: A concurrency rejection MUST be distinguishable by the UI from a
  failure and from a pending run, and MUST carry a retry hint. Rejecting is only
  honest if the caller is told; a 429 rendered as an indefinite spinner is worse
  than queueing, because the user cannot tell "busy" from "broken".
- **FR-030**: §9 R1 MUST be recorded as still open when `security.md` is amended.
  V3 reduces its brute-force exposure but leaves a single shared password granting
  `superadmin` — the role that, since V2, authorises demo destruction. It must not
  read as closed because the login throttle shipped.

### Key Entities

- **Route class**: a named group of endpoints sharing a limit, with its own
  threshold, window and identity key.
- **Limit counter**: how many requests a given key has made in the current window
  for a class. Ephemeral.
- **Auth-failure counter**: consecutive failures for a key, and the cooldown
  expiry — deliberately separate from the request counter, because it is a
  security signal rather than a fairness one.
- **Concurrency slot**: a token held for the duration of an expensive operation
  and returned on every exit path.
- **Request id**: already minted by V1; this feature extends its reach to
  `stub_call_log`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Repeated credential guessing from one client is refused after a
  bounded number of attempts, and every attempt appears in the log.
- **SC-002**: Timing measurements across many credential comparisons with
  progressively longer correct prefixes reveal no usable signal.
- **SC-003**: The number of simultaneous expensive operations never exceeds the
  configured ceiling, measured under a deliberate burst.
- **SC-004**: After a burst of expensive operations completes or fails, capacity
  returns to full — no slot is lost.
- **SC-005**: Every public surface refuses a sustained flood from one client while
  continuing to serve a second, well-behaved client.
- **SC-006**: Liveness probing at the runtime's configured interval is never
  refused, over a sustained period.
- **SC-007**: Given only a request id from a refused response, an operator can
  find which limit was hit, the key it counted against, and any stub-call row the
  request produced.
- **SC-008**: The complete existing test suite passes unchanged, and a scripted
  walk of a normal UI session, a demo reset and one generation is refused nothing
  (FR-021).
- **SC-009**: Every new limit has a negative test that fails when the limit is
  removed, and a positive test proving legitimate traffic is unaffected. (A limit
  whose test still passes when the limit is deleted is not a limit — this is the
  discipline both prior slices' audits turned on.)
- **SC-010**: The limiter's memory footprint is stable under a flood from many
  distinct client addresses.

## Assumptions

- **Single instance unless Q1 says otherwise.** The stack runs as one server
  container in `infra/docker-compose.yml` today.
- **Client address is the only identity for unauthenticated surfaces**, so it must
  be derived from a trustworthy source. Behind a proxy that means a configured
  trusted-proxy setting rather than blind `X-Forwarded-For` trust; getting this
  wrong makes limits either useless or a self-inflicted outage.
- **Defaults are chosen to be generous.** FR-021 outranks tightness: a first
  iteration that is too loose is recoverable, one that refuses real traffic is an
  incident. Thresholds are configuration (FR-010) so they can be tightened with
  evidence.
- **The webhook token stays the webhook's credential.** V3 rate-limits that
  endpoint but does not add authentication to it — that remains by design.
- **`/api/health` stays unauthenticated**, per V1 and V2.
- **§9 R2 remains deferred**, so no per-user limits (FR-025).
- **§9 R11 (`.env.example` gaps) is still not this feature's job**; V3 adds
  placeholders for its own variables only.
- **Redis being unused today is an opportunity, not a requirement** — Q1 decides
  whether this feature is what starts using it.
- **`security.md` §9 R10 and R1 rows change once this merges**, via
  `/speckit-update-standards` after the fact.

## Resolved Decisions

Settled with the requester on 2026-08-03. Binding on `/speckit-plan`.

| # | Decision | Chosen |
|---|---|---|
| Q1 | Counter store | **In-process**, single-instance assumption stated loudly |
| Q2 | At the concurrency ceiling | **Reject** with a retry hint |
| Q3 | §9 R1 | **Throttle and log only**; local admin stays enabled |

### Consequences the plan must carry

**Q1 → FR-023 collapses, but a new weakness appears.** With no external store
there is nothing to be unavailable, so "fail open or closed" is moot. In exchange:

- **All counters and cooldowns are lost on restart.** An attacker who can induce a
  process restart resets their own auth-failure cooldown. Accepted — inducing a
  restart is a bigger problem than the throttle — but it MUST be written down, not
  discovered. FR-026 records it.
- **Limits silently multiply by the instance count.** Two instances each enforce
  the full threshold, so the effective limit doubles with nothing in the code
  noticing. FR-027 requires a startup log line stating the assumption, so the
  failure is at least visible to whoever scales out.
- The same applies to US5's sign-in throttle, which lives in the Next client — and
  Next may run more than one worker in production even in a single container.
  FR-028 covers it.

**Q2 → the UI must not appear to hang.** Rejecting is only honest if the caller is
told. A 429 that the UI renders as an indefinite spinner is worse than a queue,
because the user cannot tell the difference between "busy" and "broken". FR-029.

**Q3 → R1 stays open by decision.** V3 closes R10 and reduces R1's brute-force
exposure, but a single shared password still grants `superadmin`, which after V2 is
the role gating demo destruction. FR-030 requires this be recorded in
`security.md` at amendment time rather than left to look closed because "V3 did
the login throttle".

### Q1 — Where do the counters live?

**Decision: A — in-process.**

**Context**: Redis is running, healthy, published on 6380, and read by **no code
at all**. In-process counters are simpler and have no failure mode of their own;
they are also silently wrong the moment a second instance exists, because each
instance would enforce its own fraction of the limit.

| Option | Answer | Implications |
|---|---|---|
| A | **In-process**, with the single-instance assumption stated loudly in code and docs *(recommended)* | Simplest, no new dependency, no new failure mode, and FR-023 becomes trivial. Cost: limits silently multiply by the instance count if anyone scales out, and nothing in the code would notice. Mitigation: a startup log line stating the assumption. |
| B | **Redis**, using the container that already exists | Correct under scale-out and finally makes the running Redis do something. Costs a client dependency, a connection to manage, and a real answer to FR-023 (fail open and lose the limit, or fail closed and lose the service). |
| C | In-process now behind an interface, Redis-ready later | Sounds prudent, but it is an abstraction with one implementation — the thing Article IV warns against — and the interface will be wrong in ways only the second implementation reveals. |

### Q2 — When the concurrency ceiling is reached, reject or queue?

**Decision: A — reject with a retry hint.** See FR-029 for the UI obligation.

**Context**: generation takes 480 seconds. The choice is directly user-visible.

| Option | Answer | Implications |
|---|---|---|
| A | **Reject** with a retry hint *(recommended)* | Honest and simple; the caller knows immediately. The UI must show "busy, try again shortly" rather than appearing to hang. No queue state to leak or lose on restart. |
| B | **Queue** with a bounded wait | Nicer when contention is brief. But a queued 480s job means a request that waits minutes with nothing to show, needs a queue depth limit, a timeout, and a story for what a restart does to queued work — materially more machinery. |
| C | Reject, but tell the caller when a slot is expected free | A is the honest core; the estimate is a guess that will be wrong and will be believed. |

### Q3 — Does V3 act on §9 R1 beyond throttling?

**Decision: A — throttle and log only.** R1 stays open, explicitly (FR-030).

**Context**: R1's recorded mitigation is "disable local-admin login wherever Entra
SSO is available". Both are configured in this deployment. Throttling reduces the
brute-force risk; it leaves a single shared password granting `superadmin` — which
after V2 is the role that authorises demo destruction.

| Option | Answer | Implications |
|---|---|---|
| A | **Throttle and log only**; leave the account enabled *(recommended)* | Closes R10's part of the gap without risking anyone's ability to sign in. R1 stays open, explicitly, with the reason recorded. Keeps V3 to one concern. |
| B | Throttle, **and** refuse to enable local admin when Entra is configured | Actually closes R1. But it can lock out whoever relies on local admin — including local development and possibly the demo path — so it needs a deliberate rollout, and it is a behaviour change for a slice whose headline promise is "no behaviour change". |
| C | Throttle, and stop minting `superadmin` for the local account | Narrows the blast radius without removing access. Would break the V2 role gate for that account, which is currently the only way to reach demo reset from the UI. |
