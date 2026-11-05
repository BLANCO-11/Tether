# Quickstart — verifying V6

Contract IDs (C1…, S1…, D1…, P1…, L1…, R1…, X1…) refer to
[contracts/egress-policy.md](contracts/egress-policy.md).

## Prerequisites

```bash
cd foundry
pnpm install
```

A running Postgres and MySQL are needed for the introspector and R12 checks. The
policy module and lookup tests need neither — they are pure or use a stubbed
resolver, by design.

## §0 — Baseline

```bash
pnpm -r typecheck
```

```bash
pnpm --filter @foundry/server test
```

Record the counts in `notes.md`. Then record the current state of what this
feature narrows:

```sql
SELECT DISTINCT jsonb_object_keys(config) FROM triggers WHERE config IS NOT NULL;
```

That key list is what D6's discriminated union must not break (research R6,
FR-021). A key that is stored and read must survive.

## §1 — Policy module (slice 1)

Pure unit tests, no network. **C1–C9.** Write the classification table from
research R4 as a data-driven test, including every encoding case — IPv4-mapped
IPv6 (**C7**) is the one a dotted-quad implementation silently passes, so it gets
its own named test rather than a row in a loop.

**P2** — permitting `host:4000` does not permit `host:5432`. Assert this early;
it is the invariant that keeps the exception list from becoming a bypass.

**P3** — with a customised `stubPublicBase`, the derived default permitted set
follows it.

## §2 — Validating lookup (slice 2)

Against a **stubbed resolver**, so the tests are deterministic and need no DNS:

- **D2** — a hostname resolving to one public and one reserved address is refused.
- a hostname resolving only to public addresses passes the address through.
- **D1** — the resolver returns public on the first call and reserved on the
  second; the second connect attempt is refused. This is the rebinding test and it
  is the single most important test in the feature.

## §3 — Poll path (slice 3) — the live exposure

Server tests:

- **S1–S4** — register a poll trigger with, in turn: `file:///etc/passwd`,
  `http://169.254.169.254/`, a hostname resolving to `127.0.0.1`, and an
  unresolvable hostname. Four refusals, four distinct reasons (**S8**).
- **D5** — drive the scheduler tick with a trigger whose URL is refused; assert no
  socket is opened. Assert at the scheduler, not at the policy module — a tested
  policy with an unwired call site is the exact defect the last four slices each
  shipped once.
- **D4** — a permitted host that 302s to `http://169.254.169.254/` does not reach
  it. With `https.request` (D2) redirects are not followed at all, so this test
  documents a property rather than exercising a branch; keep it, because the
  property would silently disappear if someone reinstated `fetch`.
- **D6** — a policy refusal logs distinctly from a timeout. Assert on the log
  shape; an operator debugging a stopped trigger must not chase a network problem
  that does not exist.
- **X3** — a pre-existing trigger with a now-refused URL stays `enabled` and the
  condition is visible. Nothing auto-disables.
- **FR-021** — every trigger config key found in §0 still round-trips.

## §4 — Datasource path (slice 4)

- **S6** — registration with a reserved-host connection string is refused.
- **D5** — the Postgres and MySQL introspectors each enforce the policy. Two
  tests, one per driver: they use different clients and only one of them being
  wired is a plausible outcome.
- **D3** — verify per driver that the hook actually reaches the socket. If a
  driver required the research R1 contingency (resolve-check-connect rather than
  `lookup`), **record that in `notes.md`** and do not claim rebinding is closed for
  that path.
- **X1** — trigger a refusal with a DSN containing a password; assert the password
  appears in no log line and no response body. Grep the captured output for the
  literal, rather than eyeballing it.
- **P4** — run the demo provisioning path end to end with the policy active. This
  is the check that decides whether the feature is usable:

```bash
pnpm --filter @foundry/server demo:seed
```

## §5 — Tool URLs and R14 (slice 5)

- **S7** — a tool registered with a reserved-address URL is refused.
- **P5** — dummy-tool stub URLs still resolve and remain reachable from a
  container. The stub base is reserved-range by design, so this is the test that
  catches an exception list that was written for the database but not the stubs.
- **R1** — `TETHER_BASE_URL=ftp://x` refuses startup.
- **R2** — `TETHER_BASE_URL=http://example.com:6800` surfaces the condition.
- **R3** — `TETHER_BASE_URL=http://127.0.0.1:6800` raises nothing. The default
  must stay silent or every developer sees a warning they learn to ignore.

## §6 — R12 and hardening (slice 6)

- **L1** — the writability determination runs against a live database and performs
  **no write**. Prove it: run it against a read-only credential and assert it
  returns a determination rather than an error, then run it against a writable one
  and assert the table row count is unchanged.
- **L6** — a Postgres role with `default_transaction_read_only = on` but real write
  grants is determined **writable**. This is the test that stops a session default
  being mistaken for a privilege.
- **L3** — an unchecked datasource surfaces as "not checked", never as read-only.
- **L4/L5** — a new registration with a writable credential is refused; an existing
  one is surfaced and left working.

Migration:

```bash
pnpm --filter @foundry/server exec drizzle-kit migrate
```

Confirm existing rows are `null`, not backfilled.

### Deletion pass (X4)

Delete each, run the full suite, record CAUGHT/SURVIVED in `notes.md`, revert:

1. the policy call in the scheduler
2. the lookup on the Postgres introspector
3. the lookup on the MySQL introspector
4. the reserved-literal check in the trigger schema
5. the reserved check in the datasource schema
6. the reserved check in the tool schema
7. the permitted-internal exception (should break the demo test, not the unit tests)
8. the multi-address loop in the lookup (leave it checking only the first address)
9. the `TETHER_BASE_URL` startup check
10. the R12 refusal for new registrations

Point 8 is the one to watch: a lookup that checks only the first resolved address
passes every single-address test, and D2 is the only thing that catches it.
Point 7 is the inverse — if nothing fails when the exception list is removed, then
nothing is testing that the demo still works, and the feature's biggest usability
risk is unguarded.

### Regression

Re-run §0 and compare. The only new failures permitted are tests that deliberately
encode a new refusal (**X2**).
