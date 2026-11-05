# Phase 1 Data Model: Rate limits and abuse controls (V3)

Almost nothing here is persisted. That is the point of Q1: counters live in
memory, so the only schema change is one nullable column.

---

## Persisted — `stub_call_log.request_id`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `request_id` | uuid | **NULL** allowed | The id of the request that produced the row |

**Nullable, deliberately.** Rows written before V3 have no id, and backfilling a
synthetic one would put a fabricated value in an audit trail. `NULL` reads as
"before V3" and is honest.

No index. The column is for reconstructing a single request an operator already
has an id for; it is not a query dimension, and `stub_call_log` is append-heavy —
an index would cost every write to speed up a rare lookup. Add one if the lookup
ever becomes routine.

Populated at `routes/stub-api.ts:175`, the only insert site. `routes/demo.ts`
reads the table (`:104-105`) and needs no change.

---

## Persisted — nothing else

Generation concurrency is **derived**, not stored:

```sql
SELECT count(*) FROM scripts
 WHERE workspace_id = $1 AND status = 'generating'
```

There is deliberately no `concurrency_slots` table. `scripts.status` already *is*
that state, `recoverStuck()` already reconciles it after a restart, and a second
source of truth for "is this running?" would drift from the first. See research R6.

---

## In-memory — `FixedWindowCounter`

```ts
interface WindowEntry {
  count: number;
  windowStartMs: number;
}
// key -> entry
type Store = Map<string, WindowEntry>;
```

**Key composition**: `"<class>:<identity>"`, e.g. `"public:203.0.113.9"`,
`"api:sha256-prefix"`, `"generation:<workspaceId>"`. The class prefix keeps
independent limits from colliding on the same identity.

**The API-key identity is a truncated SHA-256 digest, never the key itself**
(research R3). A raw key sitting in a long-lived map is one heap dump or one
careless log line from disclosure.

### Bounded state (FR-022)

| Mechanism | Purpose |
|---|---|
| Sweep on a timer, each window length | Drop entries whose window has passed |
| Hard cap on `Store.size` | Backstop when arrivals outpace the sweep |
| Evict oldest `windowStartMs` on overflow | Bounded memory under an address-cycling flood |

Without these, the limiter is itself a memory-exhaustion vector, with the attacker
choosing how fast it grows.

### Lifetime (FR-026)

Entries are lost on restart. **Documented at the module, not in a spec someone
will not read**: an attacker who can induce a restart clears their own cooldown.
Accepted — inducing a restart is a larger problem than the throttle — but it must
be a recorded limitation rather than a surprise.

---

## In-memory — `AuthFailureStore`

```ts
interface AuthFailureEntry {
  failures: number;
  firstFailureMs: number;
  cooldownUntilMs: number | null;
}
```

Kept **separate from the request counter** on purpose. They answer different
questions: one is fairness, the other is a security signal with a different
threshold, a different window and a different consequence. Merging them would mean
a client that trips the rate limit looks identical to one guessing credentials.

### The ordering that matters (FR-004)

```
check cooldown  ──► in cooldown?  ──► refuse (SAME response as a wrong key)
       │                                       ▲
       ▼                                       │
compare credential (constant time) ── wrong ───┘
       │
     correct ──► clear failures ──► proceed
```

The cooldown is checked **before** the comparison. Implemented the other way round
— "count failures, but let a correct key through" — a throttled attacker learns
their guess was right from the difference in behaviour, which makes the throttle
*worse than none*: it adds a signal that did not previously exist.

---

## In-memory — `ConcurrencyCounter` (execution only)

```ts
interface ConcurrencyCounter {
  active: number;
  max: number;
}
```

Execution is awaited by its route, so `try/finally` around the awaited call is
correct and sufficient. Release must happen on **success, failure, timeout and
abandonment** (FR-013) — with a 480-second neighbour operation, a leaked slot is
not a small bug: `max` leaks disable the capability permanently.

Generation does **not** use this. See "Persisted — nothing else".

---

## Configuration (not data, but the tunable surface)

Thirteen values, all from the environment, all with `.env.example` placeholders,
all with generous defaults (research R4, R10). None is a secret.

The one that changes behaviour most is `TRUST_PROXY`, defaulting to `false`. It
decides where `req.ip` comes from, and it is the likeliest way this feature causes
an outage in either direction: trust a forwarded header blindly and every limit is
forgeable; fail to trust it behind a real proxy and every request shares one key,
so one flood throttles everybody.
