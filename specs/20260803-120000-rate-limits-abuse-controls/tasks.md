---
description: "Task list for V3 — rate limiting, request identity and abuse controls"
---

# Tasks: Rate limiting, request identity and abuse controls (V3)

**Input**: Design documents from `/specs/20260803-120000-rate-limits-abuse-controls/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: **REQUIRED, written first.** Article II is binding and SC-009 requires,
per limit, a negative test that fails when the limit is removed *and* a positive
test proving legitimate traffic is unaffected.

Two lessons this list is shaped by:
- V1 shipped 49 green checkboxes over a live mass-assignment hole.
- V2's own `/speckit-comply` found **three tasks marked `[X]` whose tests were
  never written**. Do not bulk-mark. Mark a task `[X]` only after running the thing
  it describes.

**Organization**: grouped by user story, in the plan's slice order. US3 (route
classes) lands after the primitive is trusted because it carries the most FR-021
risk — the risk here is not "the limit fails to fire", it is "the limit fires at a
real user".

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1 (auth throttle), US2 (concurrency), US3 (route limits),
  US4 (request identity), US5 (sign-in throttle)

## Path Conventions

pnpm workspace monorepo, paths relative to `/home/kriti/foundry`:

- Server: `foundry/packages/server/src/`
- Client: `foundry/packages/client/src/`

Branch `krt/guardrail_validation`, main checkout, no worktree.

---

## Phase 1: Setup

- [X] T001 [P] Add the 13 new variables with explanatory comments to `foundry/.env.example` per [research.md](research.md) R10 (`TRUST_PROXY`, `RATE_LIMIT_ENABLED`, the four `RATE_LIMIT_*`, the three `AUTH_FAIL_*`, the two `MAX_CONCURRENT_*`, the two `LOGIN_FAIL_*`) — Article VIII
- [X] T002 [P] Add the same variables to your local `foundry/.env` (gitignored) with the research R4 defaults
- [X] T003 [P] Pass the server-side variables through to the `server` service, and the `LOGIN_FAIL_*` pair to the `web` service, in `foundry/infra/docker-compose.yml`
- [X] T004 Read all 13 in `foundry/packages/server/src/config/index.ts` (and the client pair in the client) with the research R4 defaults — no `process.env` at call sites, matching how `wsAllowedOrigins` was added in V2

**Checkpoint**: `pnpm --filter @foundry/server typecheck` clean; existing suites unchanged.

---

## Phase 2: Foundational — the counting primitive

**⚠️ BLOCKS US1, US2 and US3.**

**Contract**: [rate-limit.contract.md](contracts/rate-limit.contract.md)

### Tests first

- [X] T005 Write `foundry/packages/server/src/limits/fixed-window.test.ts` with an **injected clock** — a test that sleeps a real 15-minute window is not a test. Cover: under cap allowed, one over → refused, window rollover, and the exact boundary in both directions
- [X] T006 [P] Add the isolation cases to that suite: two keys where one floods leaves the other untouched (SC-005), and two classes where one is exhausted leaves the other untouched
- [X] T007 [P] Add the **FR-022 bounded-state** cases: present 10 000 distinct keys and assert `size()` stays under `maxKeys` and the oldest window is evicted (SC-010). Without this the limiter is itself a memory-exhaustion vector with the attacker setting the pace
- [X] T008 [P] Add a sweep test: entries whose window has passed are dropped on the timer

### Implementation

- [X] T009 Implement `foundry/packages/server/src/limits/fixed-window.ts` per the contract: `createFixedWindow({max, windowMs, maxKeys, now})` returning `check(key) -> {allowed, remaining, retryAfterSec}`, plus `reset()` and `size()` for tests
- [X] T010 Implement the sweep timer and the `maxKeys` cap with oldest-window eviction (FR-022)
- [X] T011 Add the **FR-026 restart-loss note** as a comment at the module: counters die with the process, so an attacker who can induce a restart clears their own cooldown. Accepted, but recorded where the code is — not only in a spec nobody re-reads
- [X] T012 Set `app.set("trust proxy", config.trustProxy)` in `foundry/packages/server/src/app.ts`, defaulting to `false` (research R2). This decides where `req.ip` comes from and is the likeliest way this feature causes an outage in either direction
- [X] T013 Add the **FR-027 startup statement** to `foundry/packages/server/src/index.ts`: log that limits are enforced per instance and are correct only for a single instance, so scaling out produces a visible statement rather than a silent doubling of every limit

**Checkpoint**: `pnpm --filter @foundry/server test src/limits/` green; nothing else changed.

---

## Phase 3: User Story 1 — Brute force is slowed and visible (P1)

**Goal**: constant-time key comparison, auth-failure logging (there is none today
at all), and a throttle that is not an oracle.

**Independent test**: drive repeated wrong keys, confirm refusal → throttle → log
lines; confirm a **correct** key during cooldown is still refused.

**Contract**: [auth-throttle.contract.md](contracts/auth-throttle.contract.md)

### Tests first

- [X] T014 [US1] Write `foundry/packages/server/src/limits/auth-failures.test.ts` with an injected clock: N failures start a cooldown, the cooldown expires, and a success clears the counter
- [X] T015 [US1] Write `foundry/packages/server/src/middleware/auth.middleware.test.ts`: correct key → 200, wrong key → 401 **and a log line** (today a 401 leaves no trace whatsoever), repeated wrong keys → 429
- [X] T016 [US1] Add **the FR-004 oracle test** — the most important test in this feature. While throttled, present the **correct** key and assert it is still refused with the same response as a wrong one. If a correct key succeeds during cooldown, the throttle tells an attacker their guess was right and is worse than having no throttle
- [X] T017 [P] [US1] Add the FR-005 test: a throttled address and a second, well-behaved address in parallel — the second is never refused
- [X] T018 [P] [US1] Add the SC-002 timing test: many comparisons against keys sharing progressively longer correct prefixes, asserting no usable signal (compare timing classes, not absolute values, so it is not flaky)
- [X] T019 [P] [US1] Add a log-hygiene test: no log line on any path contains the key, a prefix of it, or its length

### Implementation

- [X] T020 [US1] Implement `foundry/packages/server/src/limits/auth-failures.ts`: `{failures, firstFailureMs, cooldownUntilMs}` per key, kept **separate** from the request counter because it answers a different question with a different threshold and consequence
- [X] T021 [US1] Replace `!==` in `foundry/packages/server/src/middleware/auth.middleware.ts` with `timingSafeEqual` over SHA-256 digests of both sides. **Digest first** — `timingSafeEqual` throws on length mismatch, and catching that reintroduces the length oracle being removed (research R8)
- [X] T022 [US1] Wire the throttle in the contract's order: **cooldown check BEFORE the credential comparison**. Building it the natural way round ("count failures, but let a correct key through") is what T016 exists to catch
- [X] T023 [US1] Add auth-failure logging — `[auth] failure surface=… reason=… ip=… requestId=…` — the first auth logging this codebase has ever had. Never the credential, never a prefix, never its length

**Checkpoint**: T016 passes; deleting the cooldown check makes it fail.

---

## Phase 4: User Story 3 — Public surfaces cannot exhaust the service (P1)

**Goal**: per-class limits mounted, with health deliberately exempt.

**Ordered here, after US1**, because it carries the most FR-021 risk and should
land on a primitive already trusted.

**Independent test**: flood each public surface and confirm refusal; run the demo
and a UI session and confirm nothing is refused.

### Tests first

- [X] T024 [US3] Write `foundry/packages/server/src/middleware/rate-limit.middleware.test.ts`: a class refuses one over its cap with 429, `Retry-After`, and a body naming **which** class (FR-008)
- [X] T025 [US3] Add the **FR-007 / SC-006 health test**: sustained requests to `/api/health` at a probe-like rate are **never** refused. A limiter that can fail a liveness probe is an outage it caused itself
- [X] T026 [P] [US3] Add the FR-009 test: a refusal performs **no database write**. This matters most for `/stub-api`, where every *served* call writes a row — a limiter that also wrote one would amplify rather than protect
- [X] T027 [P] [US3] Add the Article XII test: two workspaces, one at its generation cap, the other unaffected
- [X] T028 [P] [US3] Add the FR-021 positive test: a burst the size of a workspace page load passes cleanly under the CRUD cap

### Implementation

- [X] T029 [US3] Implement `foundry/packages/server/src/middleware/rate-limit.middleware.ts` exposing `rateLimit(cls)` for `"public" | "api" | "generation" | "execution"`, keyed per [research.md](research.md) R3 — API keys bucketed by **digest, never value**, so no raw key sits in a long-lived map
- [X] T030 [US3] Mount `rateLimit("public")` on the webhook, `/api/stubs` and `/stub-api` routers in `foundry/packages/server/src/app.ts`
- [X] T031 [US3] Mount `rateLimit("api")` on the `requireApiKey` routers in `app.ts`
- [X] T032 [US3] **Do not mount any limiter on `/api/health`** — not a high limit, none. A limit high enough to be safe today is one somebody lowers later, and the failure mode is a container runtime killing a healthy service. Leave a comment saying so, so nobody "fixes" the omission
- [X] T033 [US3] Implement the refusal body and headers per the contract: `429`, `Retry-After`, `RateLimit-*`, `{error:"rate_limited", limit, retryAfterSec, requestId}` — no other caller's counters, no key material
- [X] T034 [US3] Honour `RATE_LIMIT_ENABLED=false` as an operational escape hatch for diagnosing a suspected false positive. Unlike V2's rejected `MCP_BRIDGE_REQUIRE_AUTH`, this flag **can** mean something — the system is fully functional without limits, which is exactly the pre-V3 state — so it is not the same mistake

**Checkpoint**: health survives a flood; a scripted demo run is refused nothing.

---

## Phase 5: User Story 2 — Expensive work is bounded (P1)

**Goal**: concurrency ceilings, separate from rate limits.

**Contract**: [concurrency.contract.md](contracts/concurrency.contract.md)

### Tests first

- [X] T035 [US2] Write `foundry/packages/server/src/limits/concurrency.test.ts`: execution acquire/release round trip returns the counter to zero; at max+1 the acquire fails
- [X] T036 [P] [US2] Add the FR-013 release tests: the slot is released when the handler **throws** and when it **times out**. With a 480-second neighbour operation a leaked slot is not a small bug — `max` leaks disable the capability permanently
- [X] T037 [P] [US2] Add the generation tests against the derived count: rows in `status='generating'` are what the ceiling counts; forcing a row to `completed` frees a slot; a **failed** generation frees a slot (the case that is easy to miss)
- [X] T038 [P] [US2] Add the FR-014 test: with rows left in `generating`, a fresh count is recomputed from the database — nothing is leaked across a restart
- [X] T039 [P] [US2] Add the FR-029 test: the rejection body uses `at_capacity`, **distinct** from `rate_limited`, and carries `inUse`/`max`/`retryAfterSec`
- [X] T040 [P] [US2] Add the FR-021 test: a single generation is completely unaffected

### Implementation

- [X] T041 [US2] Implement `foundry/packages/server/src/limits/concurrency.ts` with **two different mechanisms on purpose**: an in-memory counter for execution (its route awaits the call, so `try/finally` is correct) and a `SELECT count(*) … WHERE status='generating'` for generation
- [X] T042 [US2] Document at that module why generation is derived rather than held: generation is submit-then-poll — `start()` returns and the route answers `202` while the run continues — so a request-scoped slot would count **submissions**, not runs, which is just a worse rate limit
- [X] T043 [US2] Guard `POST /workspaces/:id/scripts` in `foundry/packages/server/src/routes/scripts.ts` with the generation ceiling, checked **before** the harness call (Article IX)
- [X] T044 [US2] Guard `POST /workspaces/:id/scripts/:sid/execute` with the execution ceiling, releasing in a `finally` around the awaited call
- [X] T045 [US2] Return `429 {error:"at_capacity", limit, inUse, max, retryAfterSec, requestId}` — counts are the caller's **own** workspace's, never another's (Article XII)
- [X] T046 [US2] Surface the rejection in the UI so it reads as "busy — N of N running, try again shortly", distinguishable from a failure and from a pending run (FR-029). Q2 chose reject over queue, and rejecting is only honest if the user is told; a 429 rendered as an indefinite spinner is worse than queueing

**Checkpoint**: max+1 refused; capacity returns after success **and** after failure.

---

## Phase 6: User Story 4 — Refusals stay diagnosable (P2)

**Goal**: `stub_call_log` can finally hold a request id.

- [X] T047 [US4] Add a nullable `requestId` uuid column to `stubCallLog` in `foundry/packages/server/src/db/schema.ts`. **Nullable deliberately** — pre-V3 rows have no id and backfilling a synthetic one would put a fabricated value in an audit trail
- [X] T048 [US4] Generate the migration with `pnpm --filter @foundry/server db:generate` (**generated, never hand-written**) and apply it with `db:migrate`
- [X] T049 [US4] Populate `requestId` at the single insert site, `foundry/packages/server/src/routes/stub-api.ts:175`, from `res.locals.requestId`
- [X] T050 [P] [US4] Write the SC-007 test: given only a request id from a response header, the matching `stub_call_log` row is findable and its `request_id` equals it
- [X] T051 [P] [US4] Add a test that pre-existing rows with `NULL` request ids are untouched and still readable by `routes/demo.ts` (which only reads the table)

**Checkpoint**: one request id resolves across the log and the table.

---

## Phase 7: User Story 5 — Sign-in cannot be brute-forced (P2)

**Goal**: throttle the credentials provider. Different package, different key.

- [X] T052 [US5] Write `foundry/packages/client/src/lib/login-throttle.test.ts` with an injected clock: N failures throttle, the cooldown expires, one mistake followed by the correct password signs in immediately
- [X] T053 [P] [US5] Add a log-hygiene test: no line contains the password
- [X] T054 [US5] Implement `foundry/packages/client/src/lib/login-throttle.ts`, keyed by **attempted identity** rather than address — the identity is what an attacker iterates passwords against, and the address is less reliable inside Next's routing
- [X] T055 [US5] Wire it into `authorize()` in `foundry/packages/client/src/auth.ts`, checking the cooldown **before** the password comparison, for the same oracle reason as T022
- [X] T056 [US5] Log `[auth] sign-in failure identity=… ip=…` alongside the existing `[audit] sign-in` event — never the password
- [X] T057 [US5] Add the **FR-028 per-instance caveat** as a comment: this store is in-process and the client may run more than one worker even in a single container, so the effective threshold is per worker

**Checkpoint**: five wrong passwords throttle; one mistake then correct still signs in.

---

## Phase 8: Polish & Cross-Cutting

- [X] T058 **Run the SC-009 deletion pass by hand** — DONE, and it FOUND TWO REAL GAPS: (a) all three `rateLimit("public")` mounts could be deleted from `app.ts` with the suite green, and (b) the execution `finally` could be removed from `scripts.ts` with the suite green. Both middleware were tested; their WIRING was not. Closed by `rate-limit.middleware.test.ts` "the REAL app actually mounts it" and the new `routes/execute-concurrency.route.test.ts`. Probes re-run after: each now fails. Also confirmed failing on removal: the `maxKeys` cap (2 tests), the cooldown-before-compare ordering (3, incl. the oracle test), `timingSafeEqual`→`===` (1, the timing test), a limiter added to `/api/health` (1), and the `stub_call_log` `requestId` insert (3). Original text:, reverting after each: remove the cooldown check (expect the oracle test to fail), `timingSafeEqual` → `!==` (timing test), the `rateLimit("public")` mount (flood test), add a limiter to `/api/health` (liveness test), the execution `finally` (throw/timeout tests), the `maxKeys` cap (bounded-state test). **A guard whose deletion leaves the suite green is untested**, however many other tests pass
- [X] T059 Run all three suites and all three typechecks; confirm V1's and V2's tests pass **unmodified** (SC-008). If one needed editing, investigate — it means legitimate behaviour changed
- [X] T060 PARTIAL — live probes against the running dev stack passed: 500× `/api/health` → 0 refusals; 60× authenticated CRUD → 0; 60× public → 0; 300× public → 240 refusals with the correct body; 10 wrong keys then the CORRECT key → 429 (the oracle holds live); one request id correlated from response header into `stub_call_log`. **NOT covered: the UI walk-through, demo provision/reset, and a real generation/execution run** — those need a browser and Tether, so they stay for the human pass. Original text: — UI page load, demo provision + reset, one generation, one execution, webhook cadence, and 500 health checks. **Any 429 here is a release blocker**, not a tuning note
- [X] T061 [P] Confirm `grep -c "$PARENT_API_KEY" /tmp/foundry-dev.log` is `0` after the auth tests
- [X] T062 [P] Confirm limiter memory is stable under a flood from many distinct addresses (SC-010)
- [X] T063 Update `docs/validation-and-guardrails-roadmap.md`: V3 done; record that §9 R1 and R2 remain deliberately open so the next reader does not assume identity or the local-admin account are solved
- [ ] T064 Run `/speckit-comply` and resolve findings before opening a PR. **Verify each `[X]` above individually** — V2's comply found three tasks marked complete whose tests were never written
- [ ] T065 Commit each plan slice separately on `krt/guardrail_validation`, only when green
- [ ] T066 **After merge**, run `/speckit-update-standards`: §9 **R10 closes**; **R1 stays open** (FR-030) — it must not read as closed because a login throttle shipped; the 13 new variables go into the §4 inventory by NAME only

---

## Dependencies & Story Completion Order

```
Phase 1 (Setup)
      │
Phase 2 (Foundational — fixed window + trust proxy)   ← blocks US1, US2, US3
      ├──► Phase 3  US1  auth throttle
      ├──► Phase 4  US3  route-class limits   (after US1: highest FR-021 risk)
      └──► Phase 5  US2  concurrency ceilings
Phase 6  US4  request identity      ← independent of everything
Phase 7  US5  sign-in throttle      ← different package, independent
      │
Phase 8 (Polish)
```

- **US4** touches only the schema and one insert site — fully independent.
- **US5** is in the client package — fully independent.
- **US1, US2, US3** all need Phase 2's counter.

## Parallel Opportunities

- **Phase 1**: T001, T002, T003 are separate files.
- **Phase 2**: T006, T007, T008 are independent test cases.
- **Phase 3**: T017, T018, T019 alongside each other.
- **Phase 4**: T026, T027, T028 likewise.
- **Phase 5**: T036–T040 likewise.
- **Phases 6 and 7 can run entirely in parallel with 3/4/5** — different files,
  different packages. That is the largest parallelisation win here.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1).** That closes the cheapest attack on
the stack — unlimited, unlogged credential guessing against a shared key, on a
service that mounts the host Docker socket — and is independently shippable.

Then Phase 4 (US3), then Phase 5 (US2). Phases 6 and 7 can land any time.

**Non-negotiable at every increment**: FR-021. No legitimate traffic starts being
refused. A first iteration that is too loose is recoverable; one that refuses real
traffic is an incident, and T060 is what proves which one shipped.

---

## Phase 9: `/speckit-comply` remediation (2026-08-03)

The comply run returned **FAIL — 4 HIGH, 0 CRITICAL**. Three of the four are the
same shape, and it is the shape this programme keeps producing: **the module is
tested, the wiring is not.** T058's deletion pass caught it twice — but the pass was
only ever run against *server* code, so the client `authorize()` wiring and the
generation route guard survived it untouched.

- [X] T067 [A1] Add `RATE_LIMIT_MAX_KEYS` to `foundry/.env.example` and to the local
      `foundry/.env`, and add it to [research.md](research.md) R10's table. It is read
      by `config/index.ts` but appears in **no** artifact — a 14th variable invented
      during implementation while T001 says "the 13 new variables". FR-024 names this
      exact clause of Article VIII
- [X] T068 [D1] In `foundry/packages/client/src/app/(app)/automations/new/page.tsx`,
      persist the draft on the `at_capacity` branch before returning. `runBuild` saves
      `phase:"testing"` before the try, so returning without updating it leaves
      `automations/page.tsx:78` rendering an in-progress `StatusPill` for a build that
      never started — Article XV ("a label states what actually happened"), and it
      reintroduces the exact indefinite-spinner failure FR-029 exists to prevent, one
      layer down via draft restore
- [X] T069 [B2] Mount `rateLimit("generation")` **after** `validate()` in
      `foundry/packages/server/src/routes/scripts.ts`. Running before it keys the
      bucket on an *unvalidated* path segment, so cycling arbitrary `:workspaceId`
      strings yields a fresh generation budget each time
- [X] T070 [C2] Write `foundry/packages/server/src/routes/generate-concurrency.route.test.ts`:
      the generation ceiling as the ROUTE applies it — at max → `429 at_capacity`, a
      single generation unaffected (FR-021), the guard sitting before the harness call
      (Article IX), and the bucket keying by the VALIDATED workspace id (proves T069)
- [X] T071 [C1] Write `foundry/packages/client/src/lib/auth-authorize.test.ts`: the
      `authorize()` **wiring**, not the store. The cooldown must be checked before the
      password, so a throttled identity presenting the CORRECT password is still
      refused. Nothing imports `client/src/auth.ts` in any test today, so this whole
      property is currently unverified
- [X] T072 [B1] Cover the FR-027 startup statement with a test — it is a stated
      requirement verified only by reading a live log
- [X] T073 [C1] DONE — and it produced a finding about MY OWN work, not the code: probe A (remove the `isThrottled()` call) fails 4 tests as intended, but probe B (move it AFTER the password comparison) leaves the suite GREEN. That is not a test gap. On the client every refusal path returns `null` and NextAuth renders them all as one generic `CredentialsSignin`, so the ordering is NOT the oracle property it is on the server, where 401 vs 429 are visibly different. The rationale I had written into `auth.ts` and the test file was false; both are corrected to state the real (smaller) reasons for the order. Original text: **Re-run the T058 deletion pass across the CLIENT package**, which was
      never done: remove the `loginThrottle.isThrottled()` call from `authorize()`, and
      separately move it after the password comparison. Both must turn the suite red
- [X] T074 [C2/B2] Re-run the deletion pass for the two newly-covered server guards:
      remove the generation `if (inUse >= max)` block, and revert T069's ordering
- [X] T075 [A2] Update [plan.md](plan.md)'s Project Structure to list the five files
      the implementation added that it never anticipated: `client/src/lib/foundry-client.ts`,
      `client/src/app/(app)/automations/new/page.tsx`, `client/src/lib/refusal-message.test.ts`,
      `server/src/routes/execute-concurrency.route.test.ts`,
      `server/src/routes/stub-call-log-request-id.test.ts`
- [X] T076 Re-run all three suites and all three typechecks, then re-run
      `/speckit-comply` and confirm the four HIGH findings are closed

**Not fixed here — both are decisions for the human, not defects to patch:**

- **E1** — `krt/guardrail_validation` has no merge base with `origin/main`, so the
  pull-time standards review evaluates nothing. Carried unresolved from V2.
- **E2** — `specs/` and `docs/` are gitignored, so a reviewer receives the diff but
  not the spec Article III asks them to check it against.
