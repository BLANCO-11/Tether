# Research — V6 SSRF and Egress Policy

Read out of the code on 2026-08-04. Where this contradicts the roadmap, the code
wins and the contradiction is stated.

## F1 — The parent process dials operator-supplied addresses on exactly two paths

Found by grepping for outbound calls in `packages/server/src` (excluding tests):

| Site | Call | Address source | Guard today |
|---|---|---|---|
| `services/trigger-scheduler.ts:47` | `fetch(cfg.url)` | `triggers.config.url`, jsonb | **none** |
| `services/introspect/postgres.introspector.ts:45,62` | `new pg.Client({ connectionString })` | `datasources.connection_string` | **none** |
| `services/introspect/mysql.introspector.ts:34,45` | `mysql.createConnection(connectionString)` | same | **none** |
| `services/tether-client.service.ts:74,188,219` | `fetch(this.baseUrl + …)` | `TETHER_BASE_URL`, operator config | scheme unvalidated (R14) |

`tether-client` is deployment configuration rather than API input, so it is R14's
small problem, not an SSRF. The first three are the feature.

## F2 — `triggers.config` is entirely unvalidated

`validation/schemas/trigger.schema.ts:7`:

```ts
config: z.record(z.any()).optional(),
```

So `config.url` — the value passed to `fetch` every scheduler tick — has no
scheme check, no host check, no length check. V1's validation kernel validated the
*envelope* and stopped at the jsonb boundary.

This is worth being precise about, because it is the difference between "we lack
an allowlist" (the roadmap's framing) and "this field has no validation
whatsoever". The datasource connection string at least has a length bound
(`max(8192)`); tool URLs at least have `^https?://` (`tool.schema.ts:54`).
`config.url` has neither.

**The poll loop's shape makes it a blind-SSRF oracle**, not merely a request
forger: the body is hashed, the hash compared to the previous one, and a *change*
fires the trigger. An attacker who cannot read the response can still learn that
it changed, on a 20-second cadence, forever.

## F3 — Foundry legitimately depends on reserved-range addresses

This is the constraint that decides whether the feature is usable.

| Value | Source | Purpose |
|---|---|---|
| `http://host.docker.internal:4000` | `config/index.ts:131` `stubPublicBase` | dummy-tool stubs, reached from containers |
| `host.docker.internal` (port 5433) | `config/index.ts:147` `dbHostForScripts` | the demo database |
| `http://127.0.0.1:6800` | `config/index.ts:124` Tether base | the generation runtime |

Plus `demo/seed-hr-db.ts:62`, which documents that containers are given
`--add-host=host.docker.internal:host-gateway` deliberately.

**Consequence**: a plain private-range denylist breaks the demo, the stub tools
and local development simultaneously. FR-003's configured permitted-internal list
is not a nicety — it is the difference between a control that ships and a control
that gets commented out. D4 makes entries host+port rather than host, so
permitting the stub port does not permit the database port on the same host.

## F4 — The demo's own read-only enforcement is not considered airtight by its author

`demo/hr-roles.ts:119-123`:

> Defence in depth ONLY. A script can issue `SET transaction_read_only = off`…

followed by `ALTER ROLE … SET default_transaction_read_only = on`.

Two consequences for US3:

- It is a *session default*, not a privilege. It is defeated by one statement.
  The real control would be table-level grants.
- This is the *only* place read-only is enforced at all. A datasource registered
  through the API gets nothing — not even this. That is `security.md` §9 R12, and
  it is why R12 is described as weakening **Article XI (NON-NEGOTIABLE)** on the
  live path.

It also argues *for* Q2's detection-and-surface answer being worth real points
rather than a consolation prize: the existing enforcement is weak enough that
knowing which credentials can write is a genuine improvement over the status quo.

## R1 — Does the `lookup` hook actually reach the socket for each client?

**Must be verified against the installed versions before implementation** — `pg`
8.13.x, `mysql2` 3.23.x, and Node ≥20's `net`/`tls`. The task list has this as a
verification task ahead of the implementation task, deliberately, because the
whole design (D1) rests on it.

What to establish for each:

- **`node:https` / `node:http`** — `Agent` with a `createConnection` that passes
  `lookup` through to `net.connect`/`tls.connect`. This is the documented path and
  is the least likely to surprise.
- **`pg`** — `pg.Client` config: whether a socket-level option (`stream`, or
  connection options forwarded to `net.connect`) can carry `lookup`. `pg` parses
  the connection string itself, so the host it dials must be the host the policy
  saw.
- **`mysql2`** — `createConnection` accepts a `stream` option; establish whether a
  caller-provided socket is honoured for both TCP and TLS paths.

**Contingency if a driver does not expose the hook** (spec Q1 option A): resolve,
check, then connect to the checked address with the hostname preserved for TLS.
It is worse — it reintroduces a small window — and it is written down here so that
hitting it mid-implementation is a known fallback rather than an improvised
decision. If it is used, say so in `notes.md` and in the standards amendment; do
not let "we closed rebinding" be claimed for a path where it was not.

## R2 — How is "can this credential write?" determined without writing?

**Decision**: interrogate privileges; never probe by writing.

**Rationale**: a check that proves a credential can write *by writing* has
performed the act it exists to prevent, against a real customer database. It is
also unfixable if it goes wrong — the row is written.

**To establish per engine** (task-listed, not assumed here):

- **Postgres** — privilege introspection over the tables the datasource's schema
  allowlist covers, via the standard privilege functions, plus the role's
  attributes. Note that `default_transaction_read_only` (F4) is a *session
  default* and is not evidence of a privilege; the check must not treat it as one.
- **MySQL** — the grants available to the current user.

**The nullable third state matters.** `null` = not yet determined is honestly
different from "determined read-only". A boolean column cannot express the
difference and will end up asserting the second when it means the first — which is
exactly the unearned signal Article XV forbids.

## R3 — What must the permitted-internal default contain?

The default has to make a fresh checkout work, or the first thing every developer
does is disable the policy. From F3, the local topology needs:

- the stub base host and port
- the demo database host and port
- the Tether base host and port

**But the default must be derived from the existing config values rather than
duplicated as literals** — `stubPublicBase`, `dbHostForScripts` and the Tether
base URL are already configurable, and a hardcoded default that disagrees with a
customised value produces a policy that blocks the deployment's own services.
Deriving it also means the permitted set automatically follows the deployment.

Anything beyond those three is operator-set, and production deployments should set
it explicitly.

## R4 — Address classification: the cases a naive implementation misses

The policy module is pure and these are all unit-testable without a resolver.
Enumerated here so the test list is not written from imagination:

| Case | Example | Why it is missed |
|---|---|---|
| IPv4-mapped IPv6 | `::ffff:169.254.169.254` | a dotted-quad denylist does not match it |
| IPv6 unique-local | `fc00::/7` | often forgotten entirely |
| IPv6 link-local | `fe80::/10` | same |
| Decimal literal | `http://2130706433/` | the URL parser and the resolver disagree about the string |
| Octal / hex literals | `http://0177.0.0.1/`, `http://0x7f.1/` | same |
| Carrier-grade NAT | `100.64.0.0/10` | reserved and routable-looking |
| Unspecified | `0.0.0.0`, `::` | binds to everything locally |
| Multiple A records | one public, one reserved | permitting on the first acceptable one is a one-record bypass |
| Redirect to reserved | `302 → http://169.254.169.254/` | destination-only checks miss it |

The last one is why D2's move to `https.request` is a security decision and not
only a dependency decision: it does not follow redirects at all, so the case
cannot arise on that path.

**Note on the literal encodings**: FR-007 says the check operates on the address
that will actually be connected to. Because D1 puts the check inside `lookup`, the
encodings above stop mattering for the *dial-time* control — whatever the string
was, the resolver hands back a real address and that is what is classified. They
still matter for the *registration-time* message, which is why the classification
function needs them and why they are listed.

## R5 — Refusal reasons must be four, not one

FR-012. The four cases and the operator's different next action:

| Reason | Next action |
|---|---|
| bad scheme | fix the URL |
| reserved literal | use a public address, or ask for an exception entry |
| resolves to reserved | fix DNS, or ask for an exception entry |
| unresolvable | fix the hostname, or check the network |

`trigger-scheduler.ts` currently collapses every poll failure into one
`console.warn`. After this feature a policy refusal must be distinguishable from a
timeout in the log (FR-013), or an operator debugging a stopped trigger will chase
a network problem that does not exist.

## R6 — What currently gets stored in `triggers.config`?

**Task, not a finding.** D6 narrows `config` from `z.record(z.any())` to a
discriminated union, which is a behaviour-narrowing change to an existing
endpoint. Before writing that schema, survey what keys are actually present in the
live `triggers.config` rows and what the code reads (`intervalMinutes`,
`intervalSeconds`, `url` are the three found by grep). Any key that is stored and
read must survive; any key that is stored and unread should be shown to be unread
rather than assumed so. FR-021 is the requirement this protects.
