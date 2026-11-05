# Contract: concurrency ceilings on generation and execution (US2, FR-011…FR-014, FR-029)

Module: `server/src/limits/concurrency.ts`; consumed by `routes/scripts.ts`

## Why a rate limit is not enough

Generation is a **480-second** run (`script-generation.service.ts:19`). Ten
requests spread across ten minutes pass any sane rate limit and still put ten
simultaneous model runs in flight. Rate limits bound *arrivals*; only a
concurrency ceiling bounds *work in progress*.

## The two are implemented differently, and that is deliberate

### Generation — derived from the database

```ts
async function generationSlotsInUse(workspaceId: string): Promise<number>;
// SELECT count(*) FROM scripts WHERE workspace_id = $1 AND status = 'generating'
```

Generation is **submit-then-poll**: `scriptGenerationService.start()` returns once
the run is submitted, the route answers `202`, and a poller tracks it to
completion. So a `try/finally` around the request would release the slot at
submission and the "concurrency limit" would count submissions — which is just a
worse rate limit.

Deriving the count from `scripts.status` ties the slot to the **run's** lifecycle
instead of the request's, and gets FR-014 for free: after a restart the count is
recomputed from the table, so no slot is leaked, and `recoverStuck()` already
reconciles runs orphaned by a restart.

There is deliberately **no** `concurrency_slots` table and no in-memory set.
`scripts.status` already is that state; a second source of truth would drift.

### Execution — an in-memory counter

```ts
function acquireExecutionSlot(): boolean;  // false when at max
function releaseExecutionSlot(): void;
function executionSlotsInUse(): number;
```

`executionService.execute()` **is** awaited by its route, so `try/finally` is
correct and simpler. Release must happen on every exit path — success, failure,
timeout, abandonment (FR-013).

## Refusal (FR-029)

```
HTTP 429
Retry-After: <seconds>

{
  "error": "at_capacity",
  "limit": "generation",
  "inUse": 3,
  "max": 3,
  "retryAfterSec": 60,
  "requestId": "…"
}
```

Distinct `error` code from the rate limiter's `rate_limited`. The UI must be able
to tell three states apart:

| State | UI must show |
|---|---|
| accepted, running | progress |
| **at capacity** | "busy — N of N running, try again shortly" |
| failed | an error |

Q2 chose reject over queue. Rejecting is only honest if the caller is *told* — a
429 rendered as an indefinite spinner is worse than queueing, because the user
cannot distinguish "busy" from "broken". `inUse`/`max` are included so the message
can be specific rather than vague.

These counts are the caller's **own workspace's** (Article XII); no other
workspace's activity is disclosed.

## Invariants

1. **A slot is released on every exit path**, including thrown errors and timeouts.
2. **Slots are not leaked across a restart** — generation because it is derived,
   execution because an in-memory counter starts at zero and nothing is genuinely
   in flight after a restart.
3. **Generation and execution have independent ceilings** (FR-011, FR-012).
4. **Ceilings are per workspace**, so one workspace cannot starve another.
5. **A single operation is never affected** — the common case must behave exactly
   as it does today (FR-021).
6. The check happens **before** the harness call, never inside it (Article IX).

## Tests

| Test | Asserts |
|---|---|
| one generation | unaffected; identical behaviour to today (FR-021) |
| max concurrent generations | all accepted |
| max + 1 | 429 `at_capacity` with `inUse`/`max`/`retryAfterSec` |
| a generation completes | capacity returns (SC-004) |
| a generation **fails** | capacity returns — the easy one to miss |
| generation status forced to `completed` mid-test | slot freed, since the count is derived |
| simulated restart with rows in `generating` | count recomputed, nothing leaked (FR-014) |
| two workspaces at the ceiling | independent (Article XII) |
| execution: acquire/release round trip | counter returns to zero |
| execution: handler **throws** | slot still released (FR-013) |
| execution: handler times out | slot still released |
| execution at max + 1 | 429 `at_capacity` |
| `at_capacity` vs `rate_limited` | distinct error codes (FR-029) |
| **ceiling removed** | at least the max+1 tests fail (SC-009) |
