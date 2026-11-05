# Contract — the egress policy

Invariants, written so each reads as a test name. `tasks.md` references them by ID.

## C — Classification (pure, no I/O)

- **C1** — Loopback (`127.0.0.0/8`, `::1`) classifies as reserved.
- **C2** — Private IPv4 (`10/8`, `172.16/12`, `192.168/16`) classifies as reserved.
- **C3** — Link-local (`169.254.0.0/16`, `fe80::/10`) classifies as reserved.
- **C4** — Carrier-grade NAT (`100.64.0.0/10`) classifies as reserved.
- **C5** — IPv6 unique-local (`fc00::/7`) classifies as reserved.
- **C6** — The unspecified address (`0.0.0.0`, `::`) classifies as reserved.
- **C7** — **IPv4-mapped IPv6** (`::ffff:169.254.169.254`) classifies as reserved.
  A dotted-quad-only denylist passes this, which is why it has its own invariant.
- **C8** — A public address classifies as public.
- **C9** — Classification is a pure function: no DNS, no sockets, no clock.

## S — Scheme and registration

- **S1** — A poll-trigger URL with a scheme other than `http`/`https` is refused
  at registration.
- **S2** — A URL whose host is a reserved *literal* is refused at registration,
  with reason `reserved_literal`.
- **S3** — A URL whose host *resolves* to a reserved address is refused at
  registration, with reason `resolves_to_reserved`.
- **S4** — An unresolvable host is refused with reason `unresolvable`, distinctly
  from `resolves_to_reserved`.
- **S5** — Decimal, octal and hex IP literals are classified by what they denote,
  not by their spelling.
- **S6** — A datasource connection string whose host is reserved is refused at
  registration.
- **S7** — A tool URL whose host is reserved is refused at registration, even
  though the parent never dials it.
- **S8** — All four refusal reasons are distinguishable in the API response.

## D — Dial time (the part that matters)

- **D1** — A host that resolves to a **public** address at registration and a
  **reserved** one at dial time is refused at dial time. *This is the invariant
  that separates this feature from a check that looks right and is not.*
- **D2** — Every resolved address is checked. A hostname with one public and one
  reserved A record is refused.
- **D3** — The address that was checked is the address that is connected to.
- **D4** — A permitted host that redirects to a reserved address does not reach
  the reserved address.
- **D5** — The poll path, the Postgres introspector and the MySQL introspector all
  enforce the policy. Each is asserted at its own call site, not via the module.
- **D6** — A dial-time refusal is logged distinctly from a timeout or a connection
  failure.

## P — Permitted internal

- **P1** — A `host:port` on the permitted-internal list connects successfully even
  though its address is reserved.
- **P2** — Permitting `host:4000` does **not** permit `host:5432`. The exception is
  host *and* port.
- **P3** — The default permitted set is derived from the deployment's own
  configured service addresses, so a customised `stubPublicBase` or Tether base is
  covered without editing a second setting.
- **P4** — The demo provisioning path completes with the policy active.
- **P5** — Dummy-tool stub URLs remain reachable from execution containers.

## L — Least privilege (R12)

- **L1** — The writability of a datasource credential is determined **without
  performing a write**.
- **L2** — The determination is recorded with the time it was made.
- **L3** — An undetermined credential is `null` and is never rendered as
  read-only.
- **L4** — A new datasource registration with a writable credential is refused
  (spec Q2 resolution B).
- **L5** — An existing datasource with a writable credential is surfaced, not
  disabled.
- **L6** — Postgres session `default_transaction_read_only` is **not** treated as
  evidence of a privilege — it is a session default and one statement defeats it
  (`demo/hr-roles.ts:119`).

## R — Runtime URL (R14)

- **R1** — `TETHER_BASE_URL` with a scheme other than `http`/`https` refuses
  startup.
- **R2** — A non-loopback host with `http` is surfaced at startup.
- **R3** — A loopback `http` value raises nothing.

## X — Secrets and regression

- **X1** — No log line or API response produced by this feature contains the
  credential portion of a connection string.
- **X2** — Every request that succeeds today still succeeds, except those dialling
  an address the policy refuses.
- **X3** — A trigger registered before this feature whose URL is now refused is
  **not** auto-disabled; it is refused at dial and the condition is surfaced.
- **X4** — Each new wiring point, deleted individually, makes the suite fail.
