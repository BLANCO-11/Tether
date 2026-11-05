# Contract: route-class rate limiting (US3, FR-006…FR-010, FR-022)

Modules: `server/src/limits/fixed-window.ts`,
`server/src/middleware/rate-limit.middleware.ts`

## Surface

```ts
interface FixedWindowOptions {
  max: number;
  windowMs: number;
  maxKeys: number;
  /** Injected so windows are testable without sleeping. */
  now?: () => number;
}

interface Decision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window ends. */
  retryAfterSec: number;
}

function createFixedWindow(opts: FixedWindowOptions): {
  check(key: string): Decision;
  reset(): void;         // tests only
  size(): number;        // FR-022 assertions
};

type RouteClass = "public" | "api" | "generation" | "execution";

/** Express middleware for a class. Health is NOT a class — it is never limited. */
function rateLimit(cls: RouteClass): RequestHandler;
```

## Route classes

| Class | Applies to | Key | Default |
|---|---|---|---|
| *(none)* | `/api/health` | — | **never limited** (FR-007) |
| `public` | `/api/triggers/:token/webhook`, `/api/stubs`, `/stub-api` | client address | 120/min |
| `api` | all `requireApiKey` routers | API-key digest, else address | 600/min |
| `generation` | `POST /workspaces/:id/scripts` | workspace id | 10/5min |
| `execution` | `POST /workspaces/:id/scripts/:sid/execute` | workspace id | 60/min |

`/api/health` has **no** limiter mounted at all — not a high limit, none. A limit
high enough to be safe today is a limit someone lowers later, and the failure mode
is a container runtime killing a healthy service.

## Refusal (FR-008)

```
HTTP 429
Retry-After: <seconds>
RateLimit-Limit: <max>
RateLimit-Remaining: 0
RateLimit-Reset: <seconds>

{ "error": "rate_limited", "limit": "public", "retryAfterSec": 37, "requestId": "…" }
```

- Names **which** class was hit, so a caller can tell "you are polling too fast"
  from "your workspace is generating too much". A bare 429 is a side effect
  presented as nothing (Article XV).
- Carries the request id, per V1's error contract.
- Reveals **no** counter for any other key, and never any key material.
- Costs no database write (FR-009). This matters most for `/stub-api`, where every
  *served* call writes a row — a limiter that also wrote one would amplify rather
  than protect.

## Invariants

1. **Health is unreachable by the limiter.** Not "configured high" — absent.
2. **Refusal is cheaper than service.** Map lookup, integer compare, no I/O.
3. **Bounded state.** `size()` stays under `maxKeys` regardless of distinct keys
   presented; the oldest window is evicted on overflow.
4. **Class isolation.** Exhausting `public` never affects `api`, and vice versa.
5. **Workspace isolation** (Article XII). One workspace exhausting `generation`
   leaves another's capacity untouched.
6. **The key is a digest for API keys.** The raw key never enters the store.
7. **Bursts within a window are allowed.** A UI page load fires many requests at
   once and must pass — this is why fixed-window with a generous cap, not a token
   bucket that smooths (research R1).

## Tests

| Test | Asserts |
|---|---|
| under the cap, all allowed | FR-021 |
| one over the cap → 429 with `Retry-After` | the limit exists |
| window rolls over (injected clock) → allowed again | windows actually reset |
| exactly at the boundary | off-by-one in both directions |
| two keys, one floods | the other is unaffected (SC-005) |
| two classes, one exhausted | the other is unaffected |
| two workspaces, one floods generation | the other still generates (Art. XII) |
| `/api/health` under sustained flood | **never** refused (FR-007, SC-006) |
| refusal body | names the class, carries requestId, no other counters |
| refusal path | performs no database write (FR-009) |
| 10k distinct keys | `size()` bounded; oldest evicted (FR-022, SC-010) |
| sweep after window | expired entries dropped |
| API-key class | store contains no raw key material |
| **limiter deleted** | at least one test above fails (SC-009) |
