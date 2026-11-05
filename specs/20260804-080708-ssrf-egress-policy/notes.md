# V6 implementation notes — SSRF and Egress Policy

Measured on 2026-08-05 against the working tree at `krt/guardrail_validation`
(`510d827`, V5 merged). Where this contradicts `research.md`, the measurement
wins and the contradiction is stated.

---

## T001 — Pre-feature baseline (FR-021 / X2 is checked against this)

| Command | Result |
|---|---|
| `pnpm -r typecheck` | clean (client, mcp-bridge, server) |
| `pnpm --filter @foundry/server test` | **44 files, 731 passed, 23 skipped (754)** |
| `pnpm --filter @foundry/client test` | **12 files, 209 passed** |
| `pnpm --filter @foundry/mcp-bridge test` | **2 files, 49 passed** |

Node **v20.20.0**.

---

## T002 — What is actually in `triggers.config`

### Read by the code

Grepped `packages/server/src` excluding tests. Exactly two keys are ever read,
both in `services/trigger-scheduler.ts`:

| Key | Type | Site | Default when absent |
|---|---|---|---|
| `intervalMinutes` | number | schedule pass | — |
| `url` | string | poll pass, line 47 | skipped (`if (!cfg.url) continue`) |
| `intervalSeconds` | number | poll pass | `60` |

Nothing else in the codebase reads `triggers.config`.

### Present in the live database

```
type=webhook  key="Mailbox"  rows=1
```

One trigger row in total, `type=webhook`, `config = {"Mailbox": ...}`. All
`config` values are JSON objects (no scalars or arrays to accommodate).

### FINDING — this breaks D6 as written, and T002 exists to catch exactly this

`data-model.md` gives the webhook arm of the discriminated union **no fields**
("`webhook` and `manual` carry nothing the system reads"). That is true of what
the code *reads*, and false of what the database *holds*. A strict union would
reject this row on the next update of that trigger — a 400 on a trigger that
works today, which is precisely the FR-021 regression the survey is here to
prevent.

`Mailbox` is stored and never read. Note the capital M: it is almost certainly
operator- or integration-supplied, not ours, which makes it *more* likely there
are others in deployments this database does not represent — a single-row local
database is weak evidence about the field's real inhabitants.

**Resolution, to apply at T026**: only the `poll` arm is strict, because only the
`poll` arm feeds a dial. `schedule` validates `intervalMinutes`. `webhook` and
`manual` **passthrough** unknown keys rather than stripping or rejecting them.

The security argument for narrowing `config` is entirely about `config.url`
reaching `fetch()`. Rejecting unread bookkeeping keys on other trigger types buys
no security and costs a working integration. Narrow where the dial is; preserve
elsewhere.

---

## T003 — Does a custom `lookup` reach the socket per client?

**The design-critical unknown. Answer: yes, on all three paths. Research R1's
contingency (spec Q1 option A) applies nowhere, and no path needs to give up
dial-time checking.**

Probed empirically against the installed versions rather than read from docs:
a marker `lookup` that refuses every hostname, asserted to be called with the
host the driver intended to dial, and its error asserted to surface as the
connect failure.

| Client | Installed | Hook reached | Marker error surfaced |
|---|---|---|---|
| `node:https` | Node 20.20.0 | **yes** — `lookup` option on `request` | yes |
| `pg` | **8.22.0** | **yes** — via `stream` factory | yes |
| `mysql2` | 3.23.1 | **yes** — via `stream` factory | yes |

**`pg` is 8.22.0, not the 8.13.x `research.md` assumed.** The hook works; the
version note matters only so the next reader does not re-derive it.

### The two drivers' `stream` contracts are opposite, and this is a trap

| Client | Source | Contract |
|---|---|---|
| `pg` | `lib/connection.js:19-21,44` | factory returns a **disconnected** stream; pg then calls `stream.connect(port, host)` **positionally** |
| `mysql2` | `lib/base/connection.js:72-73` | factory returns an **already-connecting** stream; mysql2 never calls `connect` |

Consequences for T036/T037:

- **`pg` cannot take a `lookup` through options at all.** Because it calls
  `connect(port, host)` positionally, the option form of `net.Socket.connect` —
  the only form that accepts `lookup` — is unreachable. It needs a `net.Socket`
  subclass whose `connect` override rewrites the positional call into the option
  form carrying the lookup.
- **`mysql2` needs the opposite**: the factory itself calls
  `connect({ port, host, lookup })`.

A single shared helper written for one driver silently does nothing on the other:
give mysql2 pg's disconnected socket and it hangs; give pg mysql2's connecting
socket and it dials before the policy is consulted, connecting to an unchecked
address while every test passes. **This is why T033 requires two tests rather
than one**, and the reason is now measured rather than suspected.

Probe kept at `scratchpad/probe-lookup.mjs`.

---

## T004 — The deployment's reserved-range dependencies (P3)

The permitted-internal default must be **derived** from these, not hardcoded
(research R3): a literal default that disagrees with a customised value blocks
the deployment's own services.

| Config | `config/index.ts` | Value / default | Needs permitting |
|---|---|---|---|
| Tether base | :124 | `TETHER_BASE_URL` ?? `http://127.0.0.1:6800` | `127.0.0.1:6800` |
| Stub public base | :131 | `STUB_PUBLIC_BASE` ?? `http://host.docker.internal:4000` | `host.docker.internal:4000` |
| Demo DB host | :147 | `DEMO_DB_HOST` ?? `host.docker.internal` | with the port below |
| Demo DB port | :148 | `DEMO_DB_PORT` ?? `5433` | `host.docker.internal:5433` |

All three are reserved-range by design (`demo/seed-hr-db.ts:62` gives containers
`--add-host=host.docker.internal:host-gateway` deliberately). Per D4 an entry
permits **host + port**, so permitting `host.docker.internal:4000` must not
permit `host.docker.internal:5432`; the demo database and the stub base are
separate entries on the same host.

Setting `EGRESS_PERMITTED_INTERNAL` **replaces** the derived default rather than
adding to it, per D4's "the production answer must be an explicit set". The cost
is that an operator who sets it must list their own services; the failure mode is
a refusal at connect time naming the host, which is the kind that gets fixed.

---

## FINDING 1 — the lookup never runs for an IP literal

**The most important thing found so far, and a lookup-only design does not close
the most direct attack.**

`agent.test.ts` opens real sockets to a loopback server the policy should have
refused. It connected. **Node does not resolve a host that is already an IP
literal**, so `connect("169.254.169.254")` never calls `lookup` at all — the
entire dial-time control is skipped for exactly the input an attacker would use
first (`http://169.254.169.254/latest/meta-data/`).

Every unit test in `egress/` passed against the broken version, because they all
exercise either the pure policy or the lookup in isolation. Only a test that
opens a socket to an address the policy should refuse can catch it.

**Fixed** in `agent.ts`: `decideLiteralHost()` settles a literal before dialling,
and `createConnection` returns an already-failed socket when it refuses. So every
dial is decided exactly once, by construction rather than by remembering — a
literal here, a hostname in the lookup, and neither path dials undecided.

Carry to slices 4 and 5: the driver paths need the same two-part treatment. A
connection string with a literal host (`postgres://u:p@10.0.0.1/db`) reaches the
socket the same way, and wiring only the lookup would leave it open.

## FINDING 2 — `keepAlive` would have reopened the rebinding window

Node 19 turned on `keepAlive` for the global HTTP agents. A pooled socket is
reused **without resolving anything**, so a second request to the same host would
reach the first request's address with no lookup in between — reinstating the
exact window `lookup.ts` exists to close, on the second request, which is the one
whose timing an attacker controls.

The V6 agents set `keepAlive: false`, and `agent.test.ts` counts connections at
the server to prove two requests open two sockets. Recorded because the natural
"optimisation" of turning pooling back on looks like a performance change and is
a security regression.

## FINDING 3 — the derived permitted-internal default was missing the parent's own database

Slice 4 wired the policy into the introspectors and the suite immediately failed:

```
EgressRefusedError: localhost resolves to 127.0.0.1, a reserved address
(loopback), and is not on the permitted-internal list
```

The policy had refused **the introspector's own test database**. Research R3
listed three things to derive the default from — the stub base, the demo DB host,
the Tether base — and that list is incomplete. `dbHostForScripts` is how a
*container* reaches the demo database (`host.docker.internal:5433`); the parent
reaches its database as `DATABASE_URL` (`localhost:5433`), and **the parent is
what introspects**.

Fixed by deriving `DATABASE_URL`'s host and port into the default too.

Worth stating plainly: this is FR-020 doing its job. A guardrail that breaks the
demo is a guardrail that gets switched off in week two, and the failure surfaced
in the suite rather than in someone's afternoon only because the introspector has
live-database tests.

---

## T038 — D3 per driver: is the address checked the address connected to?

**Yes, on both, with no fallback used.** The guarantee is structural rather than
observational: the policy runs *inside* the lookup the socket uses, so there is no
second resolution that could disagree with the first.

| Path | Mechanism | Contingency needed |
|---|---|---|
| poll (`http`/`https`) | `Agent.createConnection` → `lookup` + literal check | no |
| `pg` | `stream` factory → `Socket.connect` override → `lookup` + literal check | no |
| `mysql2` | `stream` factory dials with `lookup` + literal check | no |

`postgres.egress.test.ts` pins the mechanism by patching `net.Socket.prototype.connect`
and asserting a `lookup` was carried — so a refactor to "resolve, then check, then
connect" fails there rather than silently reopening the rebinding window.

**The standards amendment (T065) may therefore claim dial-time enforcement for all
three parent-side paths without qualification.** Container egress remains
unaddressed and is the named follow-up.

---

## T039 — P4: the demo works with the policy active

`pnpm --filter @foundry/server demo:seed` completes:

```
✓ workspace … — 14 tools, 7 tables / 44 columns introspected, manifest v4
✓ oracle: 11 below threshold, 2 excluded, 1 unmailable, 1 bouncing
✓ read-only role foundry_ro: SELECT on 7 table(s), no write privileges
```

The 7 tables were introspected *through* the new dial path, so this exercises the
policy rather than bypassing it.

---

## T057 — Deletion pass (X4)

Each point deleted individually, full suite run, reverted before moving to the next.

| # | Point | Result |
|---|---|---|
| 1 | policy call in the scheduler | CAUGHT — poll-trigger egress tests fail |
| 2 | lookup on the Postgres introspector | **SURVIVED on first attempt** — see below |
| 3 | lookup on the MySQL introspector | CAUGHT (after fixing point 2's gap first) |
| 4 | reserved-literal check in the trigger schema | CAUGHT |
| 5 | reserved check in the datasource schema | CAUGHT |
| 6 | reserved check in the tool schema | CAUGHT |
| 7 | permitted-internal exception | CAUGHT — `demo:seed` fails, unit suite stays green (expected: this is the point that specifically checks the *demo*, not the unit tests) |
| 8 | multi-address loop in the lookup (first address only) | CAUGHT — D2's two-record case fails |
| 9 | `TETHER_BASE_URL` startup check | **partially open** — see below |
| 10 | R12 refusal for new registrations | CAUGHT |

### Point 2 — SURVIVED, then fixed

`postgres.egress.test.ts` drove `pgStreamFactory` directly and never went through
`postgresIntrospector.testConnection()`'s actual call site. Deleting the lookup
there left the whole targeted file green — a real "last four slices" pattern
repeat. Fixed by adding an end-to-end `testConnection()` wiring test against
`169.254.169.254`; re-deleting the wiring now CAUGHT (the test times out trying
an unchecked dial). Point 3's MySQL equivalent was added proactively before
testing and CAUGHT on the first attempt, applying the point-2 lesson.

### Point 9 — honestly partial

`index.ts`'s `main()` self-invokes at module scope, so no test file can import it
without starting a real server. The check itself was extracted into
`enforceTetherBaseUrlAtStartup()` in `config/index.ts`, which IS unit-tested (3
cases: fatal→exit(1), non-fatal→warn, loopback→silent). But deleting the actual
call site inside `main()` and re-running the full suite still leaves it green —
nothing verifies that `main()` calls the function it was extracted for. This is
recorded as a known, accepted gap rather than claimed as closed: the *logic* is
tested, the *wiring* at this one call site is not, and cannot be without a
different testing strategy for `index.ts` (e.g. a smoke test that boots the
process). Out of scope for this slice.

---

## T058 — Regression (X2)

Final run, all ten deletion-pass points reverted:

```
pnpm -r typecheck                              → clean, all packages
pnpm --filter @foundry/server test             → 56 files, 900 passed | 23 skipped (923)
pnpm --filter @foundry/client test              → 13 files, 212 passed
pnpm --filter @foundry/mcp-bridge test          → 2 files, 49 passed
```

No failures beyond the deliberate new-refusal tests added by this feature — compare
against T001's baseline. `workspace-credential.test.ts` flaked once under full
parallel execution (894/895) and passed clean in isolation and on immediate re-run;
pre-existing test-isolation flakiness, unrelated to this feature, consistent with
flakes noted in V1-V5.

---

## T061 — Dial-time checking vs. R1 contingency (reconfirmed after slice 6)

Unchanged from T038: all three parent-side dial paths (poll `fetch`, `pg`, `mysql2`)
achieve true dial-time checking via the `lookup` hook; research R1's
resolve-then-check-then-connect contingency is used nowhere. Slice 6 added no new
dial path — R12's writability check reuses the existing `pgStreamFactory` /
`mysqlStreamFactory` from `egress/drivers.ts`, so it is covered by the same
guarantee, not a new one. The standards amendment (T065) may still claim dial-time
enforcement for all three parent-side paths without qualification.

---

## T063/T067 — `/speckit-comply` found one HIGH, now fixed

**Finding:** `updateTriggerSchema`'s `withTypedConfig` refinement selects the
validation arm via `configFor(type)`, reading `type` from the *request body*. A
normal PATCH that changes only `config.url` on an existing poll trigger — the
usual partial-update shape — never resends `type`, so the refinement fell through
to `passthroughConfig` and never ran `zPollUrl`'s `decideUrl` check. `trigger.schema.ts`
already exported `parseConfigForType(type, config)` for exactly this, with a
comment claiming "the route supplies the stored type via `updateTriggerConfigSchema`
below" — but no such wiring existed anywhere in `trigger.service.ts` or
`routes/triggers.ts`. T026/T027 were marked `[X]` on the strength of tests that only
ever exercised the schema with `type` present in the body, never the real omitted-
`type` PATCH path — the same "tested the unit, not the wiring" pattern the deletion
pass (T057) exists to catch, just missed by comply this time instead.

**Not a live SSRF hole**: the dial-time `lookup` policy (D1/D2) still refuses the
actual connection when the scheduler ticks, regardless of what registration-time
validation let through. This closed a registration-time UX/defense-in-depth gap,
not the control that actually stops the dial.

**Fix (T067):** `trigger.service.ts:update()` now loads the current trigger and
calls `parseConfigForType(current.type, input.config)` whenever `input.config` is
present and `input.type` is not, throwing a 400 on failure before `triggerRepo.update`
runs. Two tests added to `trigger-egress-surface.test.ts` (using its existing
stored-poll-trigger fixture): a `config.url`-only PATCH to a reserved address is
refused, and the same shape with an ordinary public URL still succeeds. Full suite:
902 passed | 23 skipped (up from 900 — the two new tests), typecheck clean.
