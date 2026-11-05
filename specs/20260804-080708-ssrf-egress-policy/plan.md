# Implementation Plan: SSRF and Egress Policy (Surface D)

**Branch**: `krt/guardrail_validation` | **Date**: 2026-08-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20260804-080708-ssrf-egress-policy/spec.md`

## Summary

One policy module, four call sites, and a deliberate omission.

1. **`egress/` — one policy, one decision function.** Scheme allowlist, reserved
   -address denylist, configured permitted-internal list. Every path that dials an
   operator-supplied address consults it. A second copy of this logic is the way
   the two copies disagree.
2. **A validating DNS `lookup`.** This is the load-bearing idea and the reason the
   feature is not just a regex. Node's socket layer takes a `lookup` function; if
   the policy check lives *inside* it, then the address that was checked is by
   construction the address that gets dialled, and DNS rebinding has no window to
   open in. Registration-time validation becomes a UX affordance rather than the
   security control.
3. **Registration-time schemas** so the operator is told at submit time.
4. **R12 detection and R14 startup validation**, both small and both bolted to the
   same policy module.

**Deliberately not in this feature**: the `network` boolean→enum migration the
roadmap lists under V6. It is a breaking API change to the execute route, and a
breaking API change must not ride along with validation infrastructure — it needs
its own PR where the contract change is the headline. `routes/scripts.ts:166`
already preserves the boolean semantics with a comment saying so. This is recorded
in spec.md's Out of Scope and again here because it is the single most likely
thing for an implementer to "helpfully" add.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥20, ESM

**Primary Dependencies**: **none added** — see D2. The poll path moves from global
`fetch` to `node:https`/`node:http`, which is what makes the no-new-dependency
answer possible and, separately, gives redirect control for free.

**Storage**: one nullable column on `datasources` for the R12 determination. No
new table.

**Testing**: vitest. The policy module is pure and gets exhaustive unit tests
including the encoding cases (IPv4-mapped IPv6, decimal literals). The call sites
get their own tests, because a tested policy with an unwired call site is the
exact defect the last four slices each shipped once.

**Target Platform**: Linux container, single parent API instance.

**Performance Goals**: one DNS resolution per dial, which is what the runtime does
anyway. The poll path already runs on a 20-second tick with an 8-second timeout;
the added cost is noise against that.

**Constraints**:

- **The demo must keep working** (FR-020). `host.docker.internal:4000`,
  `host.docker.internal:5433` and `127.0.0.1:6800` are all legitimate and all
  reserved-range. A policy without the exceptions list breaks the product, and a
  broken guardrail gets disabled. This is the first constraint, not the last.
- **The address checked must be the address dialled** (FR-005, FR-007). This rules
  out resolve-then-connect-by-hostname.
- **No credential in any log** (FR-014). Connection strings carry passwords, and
  the natural "refused to connect to X" log line is where one leaks.
- **Article XV** — a pre-existing trigger whose URL is now refused is *not*
  silently disabled. Refused at dial, surfaced, left enabled (spec Q3).

**Scale/Scope**: one new module, four call sites (scheduler, postgres
introspector, mysql introspector, startup), three registration schemas, one
column, one migration.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I. Spec-First** — spec written and validated first.
- [x] **II. Test-First** — every behaviour named in [quickstart.md](quickstart.md)
      before implementation. The negative tests matter unusually much here: a
      denylist with no test that the *permitted* internal destinations still work
      is a denylist that will be found broken by the demo, not by the suite.
- [x] **IV. Simplicity** — **no new dependency** (D2). One new module. One
      nullable column.
- [x] **V. Observability** — four distinguishable refusal reasons (FR-012), and a
      policy refusal logged distinctly from a network failure (FR-013). The
      scheduler's current `console.warn` swallowing everything into one line is
      precisely the Article V failure this fixes.
- [x] **VII. Documentation Currency** — `.env.example` gains the permitted-internal
      variable (FR-003); `security.md` R8/R12/R14 amended after merge.
- [x] **VIII. Secrets Hygiene (NON-NEGOTIABLE)** — FR-014, and the new env var gets
      a placeholder in `.env.example` in the same slice that reads it.
- [x] **IX. Harness Boundary** — untouched.
- [x] **XI. Least-Privilege (NON-NEGOTIABLE)** — US3 is a direct improvement here,
      and the plan is explicit that it is **partial**: detection plus refusal for
      new registrations (spec Q2 resolution B), not closure. Claiming R12 closed
      would be the unearned signal Article XV forbids.
- [x] **XII. Workspace Isolation** — the policy is global; nothing crosses a
      workspace boundary that did not before.
- [x] **XIV. Synthetic Demo Data (NON-NEGOTIABLE)** — the demo path must keep
      working, and that is a first-class constraint above, not an afterthought.
- [x] **XV. No Silent Side Effects (NON-NEGOTIABLE)** — nothing auto-disables.

**No violations. No Complexity Tracking entries required.**

## Decisions

### D1 — The check lives inside a DNS `lookup` function

Node's `net.connect` / `tls.connect` accept a `lookup` option with the same
signature as `dns.lookup`. Supply one that resolves, evaluates every returned
address against the policy, and either passes the address through or calls back
with an error.

Why this and not resolve-then-connect:

- **It closes the rebinding window by construction.** There is no gap between the
  check and the connection because they are the same step. Any design with a gap
  has to argue the gap is small; this one has none to argue about.
- **It is one function reused by every client**, rather than a per-client
  reimplementation of "resolve, check, then dial the IP while preserving the Host
  header" — which is fiddly, easy to get subtly wrong, and breaks TLS SNI if done
  carelessly.
- **Multiple A records are handled naturally** (FR-004) — the lookup sees all of
  them.

**Rejected**: resolve-then-`fetch(hostname)`. Spec Q1 option C. It is the
implementation that looks correct in review and loses the race.

### D2 — The poll path moves from `fetch` to `node:https` / `node:http`, and no dependency is added

The natural way to attach a `lookup` to global `fetch` is an `undici` `Agent` —
but `undici` is not a dependency of `@foundry/server` (checked: `package.json`
lists `dotenv`, `drizzle-orm`, `express`, `mysql2`, `pg`, `ws`, `zod`). Adding it
for one call site needs an Article IV justification, and there is a better answer.

The scheduler's poll fetch is a bare GET whose body is read as text and hashed. It
does not need `fetch`. `https.request` with an `Agent` whose `createConnection`
uses the validating `lookup`:

- adds nothing to `package.json`;
- gives full socket control, which is the whole point of D1;
- **does not follow redirects at all**, which turns FR-006 from a thing to
  implement into a thing that cannot happen. That is the rare case where the
  lower-level API is the safer one.

**Rejected**: adding `undici`. **Rejected**: keeping `fetch` and accepting the
rebinding window.

### D3 — The database drivers get the same `lookup`

`pg.Client` and `mysql2.createConnection` both accept socket-level configuration
that can carry a custom `lookup` or a caller-supplied stream. **The exact option
name and shape for each must be verified against the installed versions before
implementation** — `pg` 8.x and `mysql2` 3.x — and the task list has a
verification task ahead of the implementation task rather than an assumption baked
into it. If a driver turns out not to expose the hook, the fallback for that
driver is spec Q1 option A: resolve, check, connect to the checked address with
the host preserved. That fallback is worse and is not the plan; it is the stated
contingency so that discovering it mid-implementation does not become an improvised
decision.

### D4 — The permitted-internal list is configuration, and the policy fails closed without it

One env var, parsed into `host:port` entries, documented in `.env.example`
(FR-003). The default value must cover the local development topology so that a
fresh checkout works — but the *production* answer must be an explicit set, not
the default.

**An entry permits a specific host and port**, not a range. `host.docker.internal:4000`
being permitted must not permit `host.docker.internal:5432`. A range-shaped
exception is how an exception list becomes a bypass.

### D5 — The R12 determination is read-only and does not require a write

FR-015 requires determining whether a credential can write **without writing**.
Both engines can answer this by interrogation rather than by experiment —
Postgres via privilege introspection functions, MySQL via its grants view. The
research task nails the specific query per engine.

**A write-probe is explicitly rejected**, even against a scratch table: a
guardrail that proves a credential can write *by writing* has performed the exact
act it exists to prevent, and against a real customer database. It also fails
Article XIV's spirit — the first thing it would do on a misconfigured production
datasource is write to it.

The determination is stored as a nullable column: `null` means "not yet
determined", which is honestly different from "determined to be read-only", and a
schema that cannot express the difference will end up asserting the second when it
means the first.

### D6 — `triggers.config` becomes typed per trigger type

`config: z.record(z.any())` (FR-011) is how an unvalidated URL got into a
`fetch()` call. A discriminated union on `type` — `poll` carries a validated
`url` and `intervalSeconds`, `schedule` carries `intervalMinutes`, `webhook` and
`manual` carry nothing the system reads.

This is a **behaviour-narrowing change to an existing endpoint**, so FR-021 needs
care: any config key currently accepted and stored must either remain accepted or
be shown to be unused. The task list has a survey task before the schema task,
because "nothing uses that field" asserted from memory is how a working
integration breaks.

## Sequencing

Six slices. The order puts the exploitable path first and the visible-but-not-
remotely-exploitable ones after.

| # | Slice | Contents | Why here |
|---|---|---|---|
| 1 | Policy module | `egress/policy.ts`, address classification, permitted-internal parsing, `.env.example` | Pure, exhaustively testable, nothing wired. |
| 2 | Validating lookup | the `lookup` function, unit-tested against a stubbed resolver | The mechanism, still unwired. |
| 3 | Poll path | scheduler moves to `https.request` + agent; distinct refusal logging; `triggers.config` typed | **The live exposure.** Ships first among the wirings. |
| 4 | Datasource path | introspector clients get the lookup; registration-time host validation | The second parent-side dial. |
| 5 | Tool URLs + R14 | registration validation for tool URLs; `TETHER_BASE_URL` startup check | Small, independent, no dial-time component. |
| 6 | R12 + hardening | privilege determination, column, migration, surface; deletion pass; regression | Last because it is the only slice with a migration and the only one with a grandfathering rule. |

Slice 3 is the one that matters most and it is third rather than first, because
shipping it before the policy and the lookup exist would mean shipping it twice.

## Structure

```
foundry/packages/server/src/
  egress/
    policy.ts              # NEW — classification + decision. Pure, no I/O.
    lookup.ts              # NEW — the validating dns lookup (D1)
    agent.ts               # NEW — https/http Agent built on lookup (D2)
  services/
    trigger-scheduler.ts   # fetch → https.request; distinct refusal logging
    introspect/
      postgres.introspector.ts   # + lookup
      mysql.introspector.ts      # + lookup
    datasource.service.ts  # + host validation, + privilege determination
  validation/schemas/
    trigger.schema.ts      # config: discriminated union per type (D6)
    datasource.schema.ts   # + connection-string host validation
    tool.schema.ts         # + reserved-address refusal
  config/index.ts          # + permitted-internal list, + TETHER_BASE_URL check
  db/schema.ts             # + datasources privilege column
  drizzle/00NN_*.sql       # NEW migration
```

`policy.ts` holds **no I/O**. Classification of an address is a pure function and
keeping it that way is what makes the encoding edge cases (IPv4-mapped IPv6,
decimal literals, multiple A records) exhaustively testable without a resolver.
`lookup.ts` is the only file that touches DNS.

## Phase 0 / Phase 1 artifacts

- [research.md](research.md) — the measured exposure, the driver-hook question,
  the privilege queries, and what the permitted-internal defaults must be
- [data-model.md](data-model.md) — the policy inputs, the decision shape, the
  privilege column
- [contracts/egress-policy.md](contracts/egress-policy.md) — invariants, readable
  as test names
- [quickstart.md](quickstart.md) — per-slice verification
