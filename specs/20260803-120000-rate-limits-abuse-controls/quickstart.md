# Quickstart: validating V3 (rate limits, request identity, abuse controls)

The order below is deliberate: **prove nothing broke before proving the limits
work.** V3's failure mode is not "the limit does not fire" — it is "the limit fires
at a real user", and that is an incident where the previous two slices' failures
were merely gaps.

Companion to [docs/v2-manual-test-checklist.md](../../docs/v2-manual-test-checklist.md).

## Prerequisites

```bash
cd foundry && pnpm install
```

New `.env` values (all have generous defaults; see research R10):

```
TRUST_PROXY=false
RATE_LIMIT_ENABLED=true
```

## 1. FR-021 first — nothing legitimate is refused

**This is the acceptance condition for the whole feature.** If any of these is
refused, stop and raise the limit; do not "tune around it" later.

```bash
cd foundry && pnpm --filter @foundry/server test && pnpm --filter @foundry/client test
```

Then, against a running stack:

- [ ] Sign in, open a workspace. The page load fires many requests at once — **none
      may be refused.** This is the single most likely false positive.
- [ ] Run a demo provision and a demo reset. The demo drives the stub tools hard.
- [ ] Start one generation and let it finish. Watch progress throughout.
- [ ] Execute a script.
- [ ] Let a webhook fire at its normal cadence.
- [ ] Leave the stack up for several minutes and confirm the container healthcheck
      never fails — **`/api/health` must never be rate limited** (FR-007). A
      limiter that can fail a liveness probe is an outage it caused itself.

```bash
for i in $(seq 1 500); do curl -s -o /dev/null -w '%{http_code} ' $B/api/health; done; echo
```

Expect 500 × `200`. **Any `429` here is a release blocker.**

## 2. Auth throttling (US1)

```bash
cd foundry && export K=$(grep '^PARENT_API_KEY' .env | cut -d= -f2-) B=http://127.0.0.1:4000
```

- [ ] A wrong key is refused **and logged** — before V3 it produced no trace at all:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "x-api-key: wrong" $B/api/workspaces
grep '\[auth\] failure' /tmp/foundry-dev.log | tail -1
```

- [ ] Repeated wrong keys start being throttled (`429`, not `401`):

```bash
for i in $(seq 1 15); do curl -s -o /dev/null -w '%{http_code} ' -H "x-api-key: wrong-$i" $B/api/workspaces; done; echo
```

Expect `401` several times, then `429`.

- [ ] **The oracle test — the one that matters.** While throttled, present the
      **correct** key:

```bash
curl -s -o /dev/null -w '%{http_code} (expect 429, NOT 200)\n' -H "x-api-key: $K" $B/api/workspaces
```

**Expect `429`.** A `200` here means the throttle tells an attacker their guess was
right — which makes it worse than having no throttle at all. This is the single
most important check in this section.

- [ ] Wait out the cooldown, confirm the correct key works again.
- [ ] No log line anywhere contains key material:

```bash
grep -c "$K" /tmp/foundry-dev.log   # expect 0
```

## 3. Route-class limits (US3)

- [ ] A public surface refuses a flood from one client:

```bash
for i in $(seq 1 200); do curl -s -o /dev/null -w '%{http_code} ' "$B/stub-api/hr/employees?limit=1"; done; echo
```

Expect `200`s then `429`s carrying `Retry-After` and `"limit":"public"`.

- [ ] **A refusal writes nothing to the database** (FR-009) — `/stub-api` writes a
      row per *served* call, so a limiter that also wrote one would amplify:

```bash
psql "$DATABASE_URL" -tAc "select count(*) from stub_call_log"   # before
# …flood again…
psql "$DATABASE_URL" -tAc "select count(*) from stub_call_log"   # must grow ONLY by the 200s
```

- [ ] Class isolation: while `public` is exhausted, an authenticated CRUD call
      still succeeds.
- [ ] Workspace isolation: while workspace A is at its generation limit, workspace
      B can still generate.

## 4. Concurrency ceilings (US2)

- [ ] Start `MAX_CONCURRENT_GENERATIONS + 1` generations at once. Expect the excess
      to get `429 {"error":"at_capacity","inUse":3,"max":3,…}` — note the code is
      **`at_capacity`**, distinct from `rate_limited`.
- [ ] In the UI, that rejection must read as **"busy, try again shortly"** — not a
      spinner, not a generic error (FR-029). Q2 chose reject over queue, and
      rejecting is only honest if the user is told.
- [ ] Let one finish; confirm a new generation is accepted (SC-004).
- [ ] Make one **fail**; confirm capacity returns anyway — the easy case to miss.
- [ ] Restart the server with rows still in `status='generating'`; confirm the
      count is recomputed and nothing is leaked (FR-014):

```bash
psql "$DATABASE_URL" -tAc "select count(*) from scripts where status='generating'"
```

## 5. Request identity (US4)

- [ ] A stub call records its request id:

```bash
RID=$(curl -s -D - -o /dev/null "$B/stub-api/hr/employees?limit=1" | grep -i '^x-request-id' | tr -d '\r' | cut -d' ' -f2)
psql "$DATABASE_URL" -tAc "select request_id, path, status_code from stub_call_log order by called_at desc limit 1"
```

The stored `request_id` must equal `$RID`.

- [ ] Older rows show `NULL` — expected and honest. Backfilling a synthetic id
      would put a fabricated value in an audit trail.
- [ ] Given one request id, an operator can find every trace of it (SC-007):

```bash
grep "$RID" /tmp/foundry-dev.log
psql "$DATABASE_URL" -tAc "select * from stub_call_log where request_id = '$RID'"
```

## 6. Sign-in throttle (US5)

- [ ] Five wrong passwords at :4002/login → further attempts refused for the
      cooldown.
- [ ] The correct password after **one** mistake still signs in immediately.
- [ ] `grep -i password /tmp/foundry-dev.log` finds no password value.

## 7. SC-009 — the tests must be able to fail

Delete each guard, confirm a test fails, revert. Both previous slices turned on
exactly this, and V2's audit found three guards whose tests had never been
written at all.

| Delete | Expect to fail |
|---|---|
| the cooldown check in `auth.middleware.ts` | the FR-004 oracle test |
| `timingSafeEqual`, back to `!==` | the timing test |
| the `rateLimit("public")` mount | the public flood test |
| the health exemption (add a limiter to `/api/health`) | the liveness test |
| the `finally` that releases an execution slot | the throw/timeout release tests |
| the `maxKeys` cap | the bounded-state test |

## What V3 still does **not** cover

- **Limits are per instance** (FR-027). Two instances enforce double every limit,
  and nothing in the code would notice — only the startup log line says so. Q1
  chose in-process deliberately; Redis is running and unused for when this matters.
- **Counters die with the process** (FR-026). An attacker who can induce a restart
  clears their own cooldown.
- **§9 R1 stays open** (FR-030). A single shared password still grants
  `superadmin` — the role that, since V2, authorises demo destruction. V3 throttles
  the guessing; it does not remove the account.
- **§9 R2 stays open.** No user identity, so no per-user limits — and all UI users
  share one CRUD bucket, because they share one API key.
- **§9 R11** — `.env.example`'s missing client-auth and `DEMO_*` sets, now 13
  variables more overdue.
- Surfaces B (prompt), C (verdict gating) and D (SSRF/egress) are V4–V6.
