# Implementation Plan: Rate limiting, request identity and abuse controls

**Branch**: `krt/guardrail_validation` | **Date**: 2026-08-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20260803-120000-rate-limits-abuse-controls/spec.md`

This is **V3** of the Validation & Guardrails programme. V1 (validation kernel) and
V2 (auth on the unguarded surfaces) are merged on this branch.

## Summary

Add per-route-class rate limits, concurrency ceilings on the two expensive
operations, auth-failure throttling with constant-time key comparison, and finish
threading request ids into the one place that cannot hold them.

Everything is **in-process** (Q1): a fixed-window counter over a `Map`, no new
dependency, no Redis. The two honest costs of that — counters die with the process,
and limits multiply by instance count — are requirements (FR-026, FR-027, FR-028)
rather than footnotes, with a startup log line so scaling out says something rather
than silently doubling every limit.

The design's one non-obvious decision: **generation's concurrency is derived from
`scripts.status='generating'`, not from an in-memory set.** Generation is
submit-then-poll — `start()` returns and the route answers `202` while the run
continues — so a `try/finally` around the request would count submissions, not
runs. Deriving from the database ties the slot to the run's lifecycle, and makes
FR-014 (no slots leaked across a restart) true for free.

Defaults are deliberately generous. FR-021 — no legitimate traffic starts being
refused — outranks tightness, and every threshold is configuration.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 22, ESM (`.js` import specifiers)

**Primary Dependencies**: Express 4.21, Drizzle ORM + Postgres, Zod 3,
`next-auth` v5 (client). **No new dependency** — see [research.md](research.md) R9.

**Storage**: Postgres. One migration: a nullable `request_id` on `stub_call_log`.
Limit counters are in memory only.

**Testing**: Vitest 2.1.9. Limits need injectable clocks and thresholds — a test
that sleeps a real 15-minute window is not a test.

**Target Platform**: Linux containers; parent API `:4000`, progress socket `:4001`,
bridge `:3015`, client `:4002`. **One server instance** (Q1's assumption).

**Project Type**: pnpm workspace monorepo — `server`, `client`, `mcp-bridge`.

**Performance Goals**: a limit check is a `Map` lookup and an integer compare. A
refusal must be cheaper than the request it replaces and must not touch the
database (FR-009) — pointed for `/stub-api`, where every served call currently
writes a row.

**Constraints**:
- **FR-021 is the acceptance condition.** UI page-load bursts, demo
  provision/reset, webhook cadence, a single generation, and container liveness
  probes must all be unaffected.
- **`/api/health` is never limited** (FR-007). A limiter that can fail a probe is
  an outage it caused itself.
- Generation is submit-then-poll, so its slot cannot be request-scoped (research R6).
- No user identity (§9 R2 deferred), so no per-user limits (FR-025).
- Client address must come from a configured `trust proxy`, not blind
  `X-Forwarded-For` (research R2) — the likeliest way this feature causes an
  outage, in either direction.

**Scale/Scope**: 2 packages touched, 1 migration, ~5 new modules, ~6 new test
suites, 13 environment variables.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates derived from `.specify/memory/constitution.md` v1.2.0.

**Process gates (Articles I-VIII)**

- [x] **II. Test-First** — every limit gets a negative test that fails when the
      limit is removed **and** a positive test proving legitimate traffic passes
      (SC-009). Thresholds and clocks are injectable so windows can be tested
      without sleeping.
- [x] **IV. Simplicity** — **no new dependency** (research R9).
      `express-rate-limit`, `rate-limit-redis` and `p-limit` were each considered
      and rejected with reasons. Fixed window, not sliding or token bucket, for
      reasons recorded in R1. No store abstraction: Q1 chose in-process, and an
      interface with one implementation is what this article warns against.
- [x] **V. Observability** — every refusal logs the class, the key it counted
      against, and the request id. Auth failures are logged for the first time at
      all; today a 401 leaves no trace whatsoever.
- [x] **VII. Documentation Currency** — `.env.example` placeholders, the roadmap
      entry and the quickstart ship here. The `security.md` amendment (§9 R10
      closes, R1 stays open) is a `/speckit-update-standards` run after merge.
- [x] **VIII. Secrets Hygiene (NON-NEGOTIABLE)** — no credential is logged
      (FR-002, FR-020) and the API key is bucketed by **digest, never value**
      (research R3), so it cannot sit in a map that might be dumped. 13 new
      non-secret variables, all with placeholders.

**Foundry gates (Articles IX-XV)**

- [x] **IX. Harness Boundary** — no change to `tether-client.service.ts`, no second
      HTTP path to Tether, no runtime code change. Generation limits are applied
      *before* the harness call, never inside it.
- [x] **X. Generated Code Is Untrusted (NON-NEGOTIABLE)** — n/a to the mechanism.
      Nothing here presents a signal as a gate; a rate limit is a limit, and
      FR-008 requires it to say which one was hit.
- [x] **XI. Least-Privilege Data Access (NON-NEGOTIABLE)** — n/a; no credential
      reaches generated code and no grant changes.
- [x] **XII. Workspace Isolation** — generation and execution limits are keyed by
      **workspace id**, so one workspace's burst cannot consume another's capacity.
      `request_id` on `stub_call_log` adds no tenant-owned data.
- [x] **XIII. Manifest Is the Contract** — n/a. No manifest, prompt-block or `-e`
      change.
- [x] **XIV. Synthetic Demo Data Only (NON-NEGOTIABLE)** — n/a to the mechanism.
      Relevant in one way: the demo drives the stub tools hard, so R4's public cap
      is set well above the demo's real rate, and SC-008 walks a demo reset to
      prove it.
- [x] **XV. No Silent Side Effects** — a refusal must state which limit was hit and
      when to retry (FR-008), and a concurrency rejection must be distinguishable
      from a failure and from a pending run (FR-029). A bare 429 the UI renders as
      an indefinite spinner is a side effect presented as nothing.

**Foundational standards**

- [x] **frameworks.md** — stays in the recorded stack: Express middleware,
      Drizzle-*generated* migration, Zod at the edge, Vitest. No addition, so no
      amendment.
- [x] **security.md** — closes §9 **R10**. **R1 stays open by decision** (Q3) and
      FR-030 requires it be recorded as open rather than reading as closed because
      a login throttle shipped. R2 and R11 untouched. New variables into the §4
      inventory by NAME only, at amendment time.
- [x] **design.md** — the only UI-facing obligation is FR-029: a concurrency
      rejection must be legible as "busy, retry" rather than a spinner. No new
      component; uses existing error surfaces and tokens.

**Gate result: PASS.** Nothing to justify in Complexity Tracking.

### Re-evaluation after Phase 1 design

Still PASS. Three things the design surfaced that the pre-Phase-0 pass had not:

1. **Article II vs. real clocks.** A 15-minute cooldown cannot be tested by
   waiting. Thresholds *and* a `now()` function are injected, so windows and
   cooldowns are tested deterministically. Without that decision the tests would
   have been written as sleeps and then deleted for being slow.
2. **FR-004's ordering is load-bearing and easy to invert.** The cooldown must be
   checked *before* the key comparison; the natural implementation ("count
   failures, but let a correct key through") turns the throttle into an oracle that
   confirms a correct guess, making it worse than no throttle. Recorded in research
   R5 and given its own contract test.
3. **The shared-key bucket is a real limitation, not a detail.** One
   `PARENT_API_KEY` for all UI users means they share one CRUD budget (research
   R3). R4's cap is set an order of magnitude above one user's burst to compensate,
   and this is now a stated argument for closing §9 R2 rather than something a
   reader has to infer.

## Project Structure

### Documentation (this feature)

```text
specs/20260803-120000-rate-limits-abuse-controls/
├── plan.md              # This file
├── spec.md              # Requirements + resolved decisions Q1-Q3
├── research.md          # Phase 0 — R1-R11
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1 — validation guide
├── checklists/requirements.md
├── contracts/
│   ├── rate-limit.contract.md
│   ├── auth-throttle.contract.md
│   └── concurrency.contract.md
└── tasks.md             # Phase 2 — /speckit-tasks, NOT created here
```

### Source Code (repository root)

```text
foundry/packages/server/src/
├── middleware/
│   ├── rate-limit.middleware.ts       # NEW route-class limiter middleware
│   ├── rate-limit.middleware.test.ts  # NEW injected clock; boundary cases
│   ├── auth.middleware.ts             # EDIT timingSafeEqual, logging, throttle
│   └── auth.middleware.test.ts        # NEW incl. the FR-004 oracle test
├── limits/
│   ├── fixed-window.ts                # NEW counter + sweep + key cap
│   ├── fixed-window.test.ts           # NEW incl. FR-022 bounded-state test
│   ├── auth-failures.ts               # NEW cooldown store
│   ├── auth-failures.test.ts          # NEW
│   ├── concurrency.ts                 # NEW execution counter; generation query
│   ├── concurrency.test.ts            # NEW incl. slot release on every exit
│   ├── announce.ts                    # NEW (unplanned) FR-027 statement, extracted
│   └── announce.test.ts               # NEW (unplanned) FR-027 coverage
├── config/index.ts                    # EDIT 14 new values + trust proxy
├── db/schema.ts                       # EDIT stub_call_log.request_id
├── drizzle/0011_*.sql                 # NEW Drizzle-generated
├── routes/
│   ├── scripts.ts                     # EDIT generation + execution guards
│   ├── stub-api.ts                    # EDIT populate request_id
│   ├── generate-concurrency.route.test.ts  # NEW (unplanned) generation guard WIRING
│   ├── execute-concurrency.route.test.ts   # NEW (unplanned) execution guard WIRING
│   └── stub-call-log-request-id.test.ts    # NEW (unplanned) SC-007 end to end
├── app.ts                             # EDIT trust proxy + mount per class
└── index.ts                           # EDIT call announceLimits() at listen

foundry/packages/client/src/
├── auth.ts                            # EDIT sign-in throttle + failure logging
├── lib/login-throttle.ts              # NEW in-process, per identity
├── lib/login-throttle.test.ts         # NEW the store
├── lib/auth-authorize.test.ts         # NEW (unplanned) the authorize() WIRING
├── lib/foundry-client.ts              # EDIT (unplanned) FR-029 readable refusals
├── lib/refusal-message.test.ts        # NEW (unplanned) FR-029 coverage
└── app/(app)/automations/new/page.tsx  # EDIT (unplanned) FR-029 busy ≠ broken

foundry/
├── .env.example                        # EDIT 13 placeholders
└── infra/docker-compose.yml            # EDIT pass the new variables
```

**The seven files marked `(unplanned)`** were added during implementation and are
recorded here rather than folded in silently, because the pattern in them is the
lesson of this feature. Six of the seven exist for one reason: **this plan sized the
work by module and the risk was in the wiring.** `/speckit-comply` found that the
generation ceiling, the client `authorize()` throttle and the three
`rateLimit("public")` mounts could each be deleted with the whole suite green — every
one of them had a thoroughly-tested module behind an unexercised connection. The
`(unplanned)` client files are FR-029's real cost: making a rejection legible reaches
further into the UI than "surface the rejection" suggested, including stopping
`faFallback` from degrading a refusal into a fabricated passing build.

**Structure Decision**: a new `src/limits/` directory holds the counting
primitives, kept separate from `src/middleware/` which holds the Express wiring.
The split matters because the concurrency limiter is **not** middleware — it is
consulted by a route handler and, for generation, backed by a database query.
Putting it in `middleware/` would imply a request-scoped lifetime, which is exactly
the wrong mental model (research R6).

## Sequencing

| # | Slice | Delivers | Gate |
|---|---|---|---|
| 1 | Fixed-window primitive + config + trust proxy | the counter, tested in isolation | boundary and bounded-state tests pass |
| 2 | Auth hardening: `timingSafeEqual`, logging, throttle | US1 | the FR-004 oracle test passes |
| 3 | Route-class limits mounted in `app.ts` | US3 | health unlimited; demo walk refused nothing |
| 4 | Concurrency ceilings | US2 | slot released on every exit path |
| 5 | `request_id` into `stub_call_log` | US4 | one id findable across log and table |
| 6 | Client sign-in throttle | US5 | wrong-password throttle; correct password still works |

Slice 1 blocks 2, 3 and 4. Slice 5 is independent. Slice 6 is a different package
and independent of everything else.

Slice 3 carries the most FR-021 risk, so it lands *after* the primitive is trusted
and is gated on the scripted legitimate-traffic walk, not on unit tests alone.

## Complexity Tracking

> No Constitution Check violations. Nothing to justify.

Two decisions worth recording even though neither is a violation:

| Decision | Why | Alternative rejected because |
|---|---|---|
| Hand-rolled fixed-window limiter instead of `express-rate-limit` | Q1 chose in-process, which removes most of the library's value (its store adapters). The mechanism is a counter, a window stamp and a sweep | Taking the dependency would also mean adopting its store abstraction — an interface with one implementation, which Article IV names directly |
| Generation concurrency derived from `scripts.status='generating'` rather than an in-memory set | Generation is submit-then-poll: the route answers `202` and the run continues, so a request-scoped slot would count submissions, not runs | An in-memory set leaks on crash and needs its own reconciliation; `scripts.status` already *is* that state, and `recoverStuck()` already reconciles it |

## Deferred, with reasons

- **§9 R2** — `backendToken` still unverified, so no user identity and no per-user
  limits (FR-025). It is also why all UI users share one CRUD bucket (research R3).
- **§9 R1** — a single shared password still grants `superadmin`. V3 throttles and
  logs the attempts; disabling the account where Entra is available was offered and
  declined (Q3). FR-030 keeps it visibly open.
- **§9 R11** — `.env.example`'s missing client-auth and `DEMO_*` sets. Its own
  small feature, and now 13 variables more overdue.
- **Multi-instance correctness** — the in-process choice is single-instance-only by
  construction (FR-027). Moving to Redis is a later feature, and the container is
  already running and unused for when someone wants it.
- **`security.md` amendment** — run `/speckit-update-standards` after merge, not
  now.
