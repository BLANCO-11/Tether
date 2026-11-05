# Contract: auth-failure throttling and constant-time comparison (US1, US5)

Modules: `server/src/limits/auth-failures.ts`,
`server/src/middleware/auth.middleware.ts`, `client/src/lib/login-throttle.ts`

## Before

```ts
if (!provided || provided !== config.parentApiKey) {
  return res.status(401).json({ error: "unauthorized", message: "Missing or invalid API key" });
}
```

Three problems in three lines: `!==` short-circuits on the first differing byte
(a prefix-length oracle); nothing is logged, so a brute-force attempt leaves **no
trace at all**; and there is no throttle, so guessing runs at network speed.

## After — order of operations (FR-004)

**This ordering is the contract.** Getting it backwards is the likely mistake and
makes the throttle worse than none.

```
1. cooldown active for this address?  ──yes──►  429, SAME body as any other refusal
2. extract credential                 ──none──►  401 + log(missing_credential)
3. constant-time compare
     wrong   ──► record failure; maybe start cooldown; 401 + log(bad_credential)
     correct ──► clear failures; proceed
```

Step 1 precedes step 3. Implemented the natural way — count failures, but let a
correct key through — a throttled attacker learns their last guess was right,
because a correct guess would behave differently from an incorrect one. That is a
signal the system did not previously leak, so the "throttle" would make things
worse.

**Accepted cost**: an operator who mistypes the key ten times waits out the
cooldown even after finding the right one. The log line says why.

## Constant-time comparison (FR-001)

```ts
const a = sha256(provided);
const b = sha256(config.parentApiKey);
crypto.timingSafeEqual(a, b);   // both always 32 bytes
```

Digest first, because `timingSafeEqual` **throws** on length mismatch and catching
that reintroduces exactly the length oracle we are removing. Hashing makes both
sides fixed-width so the comparison is genuinely uniform. Same shape as V2's
credential verifier.

## Logging (FR-002) — the first auth logging that has ever existed here

```
[auth] failure surface=parent-api reason=bad_credential ip=203.0.113.9 requestId=<uuid>
[auth] throttled surface=parent-api ip=203.0.113.9 until=2026-08-03T12:15:00Z requestId=<uuid>
```

Never the credential, never a prefix of it, never its length. `ip` is
`req.ip` as resolved by the configured `trust proxy` (research R2).

## Client sign-in (US5, FR-019/FR-020)

Same shape, keyed by **attempted identity** rather than address: the credentials
provider is reached through Next's own routing and the address is less reliable
there, while the identity is exactly what an attacker iterates passwords against.
Tighter defaults (5 / 15 min) because it is a human-typed password.

Logged as `[auth] sign-in failure identity=<email> ip=<addr>` — **never** the
password. Sits alongside the existing `[audit] sign-in` event in `auth.ts`.

**Per-instance caveat (FR-028)**: this store is in-process, and the client may run
more than one worker even in a single container, so the effective threshold is
per worker. Documented at the module.

## Invariants

1. **A correct credential during a cooldown is refused**, identically to a wrong
   one. (FR-004 — the whole point.)
2. **Refusal bodies are indistinguishable** across missing / wrong / throttled,
   apart from status: 401 vs 429. The *reason* goes only to the log.
3. **No credential material is ever logged**, at any level, including truncated.
4. **One client's failures cannot lock out another** (FR-005) — keys are per
   address, and a shared-address deployment is exactly what `TRUST_PROXY` exists
   to fix.
5. **Success clears the counter**, so an operator who eventually gets it right is
   not penalised on their next request.

## Tests

| Test | Asserts |
|---|---|
| correct key → 200 | FR-021 baseline |
| wrong key → 401 **and a log line** | FR-002; today there is none |
| N wrong keys → throttled | FR-003 |
| **correct key during cooldown → still refused** | **FR-004 — the oracle test** |
| throttled and non-throttled address in parallel | FR-005 |
| success clears the counter | no lingering penalty |
| timing over many prefix-length variants | no usable signal (SC-002) |
| `timingSafeEqual` receives equal-length inputs always | no length oracle via throw |
| log lines across every path | contain no key material |
| cooldown expiry (injected clock) | access restored |
| sign-in: N wrong passwords → throttled | FR-019 |
| sign-in: correct password after one mistake | not throttled |
| sign-in logs | contain the identity, never the password |
| **throttle removed** | at least the oracle test fails (SC-009) |
