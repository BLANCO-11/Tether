# Phase 0 Research: Rate limits, request identity and abuse controls (V3)

All unknowns resolved. Checked against the working tree at 2026-08-03.

---

## R1 — Hand-rolled limiter, or `express-rate-limit`?

**Decision**: hand-rolled **fixed-window counter** in
`packages/server/src/middleware/rate-limit.middleware.ts`. **No new dependency.**

**Rationale**: Q1 chose in-process counters, which removes the main reason to
take a library — `express-rate-limit`'s value is largely its store adapters
(Redis, Memcached) and the edge cases they bring. With a single in-process map,
the whole mechanism is a counter, a window stamp and a sweep. Article IV says
nothing added "for later", and a store abstraction with one in-memory
implementation is exactly that.

**What we give up, honestly**: `express-rate-limit` gets the `RateLimit-*`
standard headers, `draft-7` semantics and a lot of battle-testing for free. We
reimplement `Retry-After` and the headers ourselves and must get them right. That
is a small, well-understood surface, and FR-008 needs specific wording anyway.

**Fixed window, not sliding or token bucket** — deliberately:
- A **sliding window** needs per-request timestamps, so memory grows with request
  volume, not just with distinct keys. That collides with FR-022.
- A **token bucket** is the right shape for smoothing bursts, but FR-021 wants
  bursts *allowed* (a UI page load fires many requests at once). A fixed window
  with a generous cap does that naturally.
- Fixed window's known flaw is the boundary: up to 2× the cap across two adjacent
  windows. With caps set generously (R4) that is irrelevant to the threat — we are
  stopping floods and brute force, not enforcing billing fairness.

**Alternatives considered**: `express-rate-limit` + `rate-limit-redis` (rejected
with Q1); `p-limit` for the concurrency half (rejected — it queues, and Q2 chose
reject, so its core behaviour is wrong for us; a counter is ~15 lines).

---

## R2 — Where does the client address come from?

**Decision**: `app.set("trust proxy", …)` driven by a new `TRUST_PROXY`
environment variable, defaulting to **`false`** (i.e. use the socket address).
`req.ip` is then the key.

**Rationale**: this is the single most likely way this feature causes an outage,
in either direction:
- Trusting `X-Forwarded-For` blindly means **any caller can forge its own key** by
  setting the header, which makes every limit decorative.
- Not trusting it when there *is* a proxy means **every request appears to come
  from the proxy**, so one flood throttles all users at once — a self-inflicted
  denial of service.

Express's `trust proxy` is the supported mechanism and already understands hop
counts and subnet lists. Defaulting to `false` fails toward "limits work, keyed on
the real socket peer" for the current single-container deployment, and an operator
who puts a proxy in front sets the variable.

**Verified**: Express `^4.21.2` supports `trust proxy` and `req.ip` derivation.
There is no proxy in `infra/docker-compose.yml` today — the server's port is
published directly — so `false` is correct for the deployment as it stands.

**Alternatives considered**: always trust the first hop (rejected — forgeable);
key on API key instead of address (rejected for the unauthenticated classes, which
have no key; used *in addition* for the auth classes, see R3).

---

## R3 — What is each class keyed on?

**Decision**: the most specific identity available, falling back to address.

| Class | Key | Why |
|---|---|---|
| health / liveness | *(not limited at all)* | FR-007 — a limiter that can fail a probe is an outage |
| public unauthenticated | client address | nothing else exists |
| authenticated CRUD | API key digest, else address | a shared key means one bucket for all UI users, which is fine at these caps |
| generation / execution | workspace id | cost attributes to a workspace, and it is the unit an operator reasons about |
| auth failures | client address | the credential is by definition not trusted here |

**The API key is keyed by digest, never by value** — the key must not sit in a map
that could be logged or dumped. A truncated SHA-256 is enough to bucket by.

**Note on the shared-key consequence**: because there is one `PARENT_API_KEY` for
every UI user (§9 R2 deferred), the CRUD bucket is shared across all of them. Two
users working simultaneously consume one budget. That is why R4's CRUD cap is set
well above what one user can generate, and it is a real argument for closing R2 —
recorded rather than hidden.

---

## R4 — What are the default limits?

**Decision**: generous. FR-021 outranks tightness; these are configuration
(FR-010) and should be lowered with evidence, not guessed tight now.

| Class | Default | Reasoning |
|---|---|---|
| Public unauthenticated | 120 req / min / address | A demo run drives the stub tools hard; 2/sec sustained per address is far above that and still stops a flood |
| Authenticated CRUD | 600 req / min / key | A workspace page load fires tens of requests at once; 10/sec sustained leaves an order of magnitude of headroom |
| Generation (rate) | 10 req / 5 min / workspace | Each is a 480s run; more than 10 starts in 5 minutes is not a human |
| Execution (rate) | 60 req / min / workspace | Executions are short but real work |
| Health | **unlimited** | FR-007 |
| Auth failures | 10 failures / 15 min / address, then 15 min cooldown | Enough for a fat-fingered operator, far too few to brute-force a key |
| Sign-in failures | 5 / 15 min / identity, then 15 min cooldown | Tighter: it is a password, and a human types it |

**Concurrency, separately from rate**:

| Operation | Default | Reasoning |
|---|---|---|
| Generation | 3 simultaneous | 480s each; three is already 24 minutes of model time in flight |
| Execution | 10 simultaneous | Each spawns a container; the host is the constraint |

**The most important number here is that none of them is small.** A first
iteration that is too loose is recoverable; one that refuses real traffic is an
incident. SC-008's scripted walk is what proves we did not overshoot.

---

## R5 — How is the auth-failure throttle not an oracle? (FR-004)

**Decision**: the cooldown is checked **before** the credential is compared, and a
correct credential during a cooldown is refused with the same rate-limit response
as an incorrect one.

**Rationale**: this is easy to build backwards. The natural implementation —
"count failures, and if the key is right, let it through" — tells an attacker that
their last guess was correct, because a correct guess behaves differently from an
incorrect one even while throttled. That makes the throttle *worse than none*: it
adds a signal. Checking the cooldown first means a throttled client learns nothing
from any guess.

**Consequence to accept**: a legitimate operator who fat-fingers the key ten times
waits out the cooldown even after finding the right key. At 10 failures that is a
deliberate trade, and the log line tells them why.

---

## R6 — How is a concurrency slot guaranteed to be released? (FR-013/FR-014)

**Decision**: acquire in the route, release in a `finally` around the **whole**
downstream call; plus a **generation reconciliation on startup**.

The subtlety is that generation is not a single awaited call —
`scriptGenerationService.start()` returns after **submitting** the run
(`scripts.ts` responds `202`), and a poller tracks it to completion. So a
`try/finally` around `start()` would release the slot immediately and the limit
would count submissions, not runs.

**Therefore**: the generation slot is tied to the run's **lifecycle**, not the
request's. Slots are derived from the database — the count of scripts in
`status='generating'` for that workspace — rather than held in a separate
in-memory set.

That single choice satisfies FR-014 for free: after a restart the count is
recomputed from `scripts.status`, so nothing is leaked, and it reuses the
`recoverStuck()` machinery that already exists in
`script-generation.service.ts` for orphaned runs.

**Execution is different**: `executionService.execute()` *is* awaited by its route,
so an in-memory counter with `try/finally` is correct and simpler there.

**Alternatives considered**: an in-memory set of active generation ids (rejected —
leaks on crash, needs its own reconciliation); a database `concurrency_slots`
table (rejected — `scripts.status` already *is* that table).

---

## R7 — Threading the request id into `stub_call_log`

**Decision**: add a nullable `request_id` column (Drizzle-generated migration) and
populate it at the single insert site, `routes/stub-api.ts:175`.

**Nullable, not `NOT NULL`**: existing rows have no id and backfilling a fake one
would be a lie in the audit trail. Nullable says "before V3" honestly.

`routes/demo.ts` only **reads** the table (`:104-105`), so it needs no change.

---

## R8 — Constant-time key comparison (FR-001)

**Decision**: `crypto.timingSafeEqual` over SHA-256 digests of the two keys.

**Why digest first**: `timingSafeEqual` throws when its inputs differ in length,
and catching that reintroduces a length oracle. Hashing both sides to a fixed 32
bytes makes lengths always equal, so the comparison is genuinely constant-time
across all inputs — the same shape V2's credential verifier already uses.

---

## R9 — Does anything here need a new dependency? (Article IV)

**No.** `node:crypto` for the digest comparison, Express's own `trust proxy`, a
`Map` for counters, and V1/V2's existing middleware. `p-limit`,
`express-rate-limit` and a Redis client were all considered and rejected above.

---

## R10 — New environment variables (Article VIII)

| Variable | Purpose | Default |
|---|---|---|
| `TRUST_PROXY` | Express `trust proxy` value | `false` |
| `RATE_LIMIT_ENABLED` | Master switch, for diagnosing a suspected false positive | `true` |
| `RATE_LIMIT_MAX_KEYS` | Cap on distinct keys held per limiter (R11 / FR-022) | `10000` |
| `RATE_LIMIT_PUBLIC_PER_MIN` | Public surfaces | `120` |
| `RATE_LIMIT_API_PER_MIN` | Authenticated CRUD | `600` |
| `RATE_LIMIT_GENERATION_PER_5MIN` | Generation starts | `10` |
| `RATE_LIMIT_EXECUTION_PER_MIN` | Execution starts | `60` |
| `AUTH_FAIL_MAX` / `AUTH_FAIL_WINDOW_MIN` / `AUTH_FAIL_COOLDOWN_MIN` | Auth-failure throttle | `10` / `15` / `15` |
| `MAX_CONCURRENT_GENERATIONS` | Concurrency ceiling | `3` |
| `MAX_CONCURRENT_EXECUTIONS` | Concurrency ceiling | `10` |
| `LOGIN_FAIL_MAX` / `LOGIN_FAIL_COOLDOWN_MIN` | Client sign-in throttle | `5` / `15` |

All get `.env.example` placeholders. None is a secret.

**`RATE_LIMIT_MAX_KEYS` was added during implementation**, not at plan time — R11
called for a key cap without giving it a name, so the code grew a fourteenth
variable that this table did not list and `.env.example` did not carry.
`/speckit-comply` caught it as an FR-024 violation. Recorded here rather than
quietly folded in: the lesson is that a requirement phrased as a mechanism ("cap the
map") still needs its configuration surface named, or it arrives undocumented.

**On `RATE_LIMIT_ENABLED`**: unlike V2's rejected `MCP_BRIDGE_REQUIRE_AUTH`, this
flag *can* mean something — the system is fully functional without limits, which
is exactly the state before V3. It is an operational escape hatch for "is the
limiter refusing legitimate traffic?", and it defaults on. It is **not** a
security gate whose absence is unsafe, so it does not repeat that mistake.

---

## R11 — Bounded limiter state (FR-022)

**Decision**: sweep expired windows on a timer (every window length), and cap the
map at a configured maximum number of keys; on overflow, evict the oldest.

Without this, an attacker cycling source addresses grows the map without limit —
the limiter becomes the resource exhaustion it was added to prevent. The cap is
the backstop for the case where arrivals outpace the sweep.
