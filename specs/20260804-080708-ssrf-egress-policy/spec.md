# Feature Specification: SSRF and Egress Policy (Surface D)

**Feature Branch**: `krt/guardrail_validation`

**Created**: 2026-08-04

**Status**: Draft

**Input**: User description: "SSRF and egress policy (roadmap slice V6, surface D). Closes security.md §9 R8 (high), also touches R12 and R14. There is currently no allowlist and no private-range denylist on operator-supplied tool URLs or datasource connection strings, and execution containers get host.docker.internal. Validate and resolve URLs at registration — scheme, then DNS resolution checked against a private-range denylist — and re-check at dial time, because a registration-time-only check is defeated by DNS rebinding. R12: read-only enforcement is wired through demo/ only; a datasource registered through the API carries whatever credential the caller supplies, which weakens Article XI (NON-NEGOTIABLE) outside the demo path. R14: validate TETHER_BASE_URL's scheme. Branch: krt/guardrail_validation, no new worktree."

---

## What is actually exposed, measured 2026-08-04

The roadmap frames V6 around tool URLs. Reading the code, **the sharpest exposure
is somewhere else**, and this spec is written to what the code does rather than to
what the roadmap assumed.

### The parent process makes outbound requests to operator-controlled addresses

There are exactly two paths on which **the Foundry parent server itself** dials an
address that an API caller chose. Both are unguarded.

**1. Poll triggers — `trigger-scheduler.ts:47`**

```ts
const res = await fetch(cfg.url, { signal: AbortSignal.timeout(8000) });
```

`cfg` comes from `triggers.config`, which is `jsonb`, validated as
`config: z.record(z.any())` (`validation/schemas/trigger.schema.ts:7`). **There is
no validation of `config.url` at all** — not a scheme check, not a host check,
nothing. The scheduler ticks every 20 seconds and fetches it from the parent
process, with the parent's network position and the parent's credentials-adjacent
placement inside the deployment.

Three properties make this worse than a generic SSRF:

- It is **recurring and unattended**. Registration is a one-off act; the fetch
  repeats forever on a timer.
- The response is **hashed and compared to the previous hash**, and a *change*
  fires the trigger. That is a working blind-SSRF oracle: an attacker who cannot
  read the response can still learn when it changed.
- The obvious targets are reachable by construction — cloud instance metadata at
  `169.254.169.254`, anything on `localhost`, anything on the deployment's private
  network.

**2. Datasource introspection — `services/introspect/*.introspector.ts`**

`datasources.connectionString` is validated as
`z.string().min(1).max(8192)` (`validation/schemas/datasource.schema.ts:7`). No
scheme check, no host check. The introspector opens that connection **from the
parent process**. A connection string pointing at an internal database is dialled
with no objection.

Notably this is *weaker* than the tool-URL validation the roadmap complains
about: tool URLs at least get `^https?://` (`tool.schema.ts:54`).

### Tool URLs are dialled by generated code, not by the parent

Worth stating precisely, because it changes what the control has to be. The parent
never fetches a registered tool's URL. The generated script does, inside its
container. So for tool URLs:

- **registration-time validation** is still right — it gives the operator the
  error at the moment they can fix it, and it keeps a hostile address out of the
  manifest that reaches the model;
- but **"re-check at fetch time"**, as the roadmap phrases it, has no parent-side
  fetch to attach to. The equivalent control for the container path is egress
  policy on the container, which is a different mechanism.

Both are in scope. Conflating them would produce a "dial-time re-check" for tool
URLs that never runs.

### The constraint that will break this feature if it is not respected

**Foundry legitimately depends on private and loopback addresses.** A naive
private-range denylist breaks the product on day one:

| Address | Where | Why it is legitimate |
|---|---|---|
| `http://host.docker.internal:4000` | `config/index.ts:131` — `stubPublicBase` | dummy-tool stub endpoints that generated scripts must reach |
| `host.docker.internal:5433` | `config/index.ts:147` — demo database | the demo dataset (Article XIV) |
| `http://127.0.0.1:6800` | `config/index.ts:124` — `TETHER_BASE_URL` | the generation runtime |

So the rule cannot be "deny private ranges". It has to be **deny private ranges
except a configured, explicit set of expected internal destinations**. Any design
that omits the exception list is a design that gets switched off within a week,
and a guardrail that gets switched off is worse than one that was never built,
because the switch stays off.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The parent refuses to dial an internal address on someone else's behalf (Priority: P1)

An operator registers a poll trigger whose URL points at cloud instance metadata,
or a datasource whose connection string points at an internal host. The parent
does not connect.

**Why this priority**: This is the live vulnerability. The other stories harden
paths that are guarded by deployment topology; this one is exploitable through the
API as it stands, on a repeating timer, from the parent's own network position.

**Independent Test**: Register a poll trigger for `http://169.254.169.254/`, let
the scheduler tick, and observe that no request is made and the refusal is logged
and visible. Same for a datasource pointed at a loopback port.

**Acceptance Scenarios**:

1. **Given** a poll trigger whose `config.url` resolves to a private, loopback,
   link-local or otherwise reserved address, **When** the scheduler ticks,
   **Then** no request is made, and the refusal is recorded diagnosably.
2. **Given** a poll trigger URL whose scheme is not `http`/`https`, **When** it is
   registered, **Then** registration is refused.
3. **Given** a datasource whose connection string host resolves to a reserved
   address, **When** introspection runs, **Then** no connection is opened.
4. **Given** a destination on the configured internal-exceptions list — the stub
   base, the demo database, the runtime — **When** it is dialled, **Then** it
   succeeds. The demo must still work.
5. **Given** a host that resolves to a public address at registration and a
   reserved one at dial time (DNS rebinding), **When** it is dialled, **Then** it
   is refused at dial time. Registration-time validation alone does not satisfy
   this story.
6. **Given** a permitted host that redirects to a reserved address, **When** it is
   fetched, **Then** the redirect is not followed to the reserved target.

---

### User Story 2 - The operator finds out at registration, not in a log at 3am (Priority: P1)

A rejected address is rejected when it is submitted, with a message that says what
was wrong and what is allowed.

**Why this priority**: US1 without US2 is a feature that silently stops working.
The scheduler swallows poll failures into `console.warn` today; a refusal there
would be indistinguishable from a network blip. Equal priority to US1 because
shipping the enforcement without the feedback produces a support burden that
motivates turning the enforcement off.

**Independent Test**: Submit each of a bad scheme, a literal reserved IP, and a
hostname resolving to a reserved address; each is refused at the API with a
distinct, actionable message.

**Acceptance Scenarios**:

1. **Given** a poll trigger with a reserved-address URL, **When** it is created or
   updated, **Then** it is refused with a message naming the reason.
2. **Given** a datasource with a reserved-address connection string, **When** it
   is created or updated, **Then** it is refused likewise.
3. **Given** a tool with a reserved-address URL, **When** it is registered,
   **Then** it is refused — even though the parent never dials it, because it
   reaches the model in the manifest and is dialled by generated code.
4. **Given** any refusal, **When** the operator reads the message, **Then** they
   can tell the four cases apart: bad scheme, reserved literal, resolves-to-
   reserved, and unresolvable.
5. **Given** a refusal, **When** it is logged, **Then** the log does not contain
   the credential portion of a connection string.

---

### User Story 3 - A datasource registered through the API cannot silently be read-write (Priority: P2)

Read-only enforcement exists only in `demo/hr-roles.ts`. A datasource registered
through the public API carries whatever credential the caller supplied, and
nothing checks whether it can write.

**Why this priority**: this is `security.md` §9 **R12**, and it weakens
**Article XI (NON-NEGOTIABLE)** on the non-demo path. It is P2 only because it is
not remotely exploitable in the way US1 is — it requires an operator to register a
privileged credential — and because the honest fix has a fork in it (see Q2).

**Independent Test**: Register a datasource with a credential that can write, and
observe that the system detects and states it rather than proceeding silently.

**Acceptance Scenarios**:

1. **Given** a datasource credential with write privileges, **When** it is
   registered or introspected, **Then** the system determines that it can write
   and records that determination.
2. **Given** such a datasource, **When** an operator views it, **Then** the
   read-write condition is visible and stated plainly.
3. **Given** a read-only credential, **When** the same check runs, **Then** it
   passes, and the check does not require the credential to be able to write in
   order to prove it cannot.

---

### User Story 4 - The runtime is not reachable over plaintext by accident (Priority: P3)

`TETHER_BASE_URL` is read with no scheme validation and defaults to
`http://127.0.0.1:6800`. A remote runtime configured over plain `http` would carry
generation prompts and code over the wire in the clear, and nothing says so.

**Why this priority**: `security.md` §9 **R14**, and small. Loopback `http` is
fine and must stay fine; a *remote* `http` runtime is not.

**Independent Test**: Start the server with `TETHER_BASE_URL` set to a remote
plaintext URL and observe the refusal or the explicit warning; with loopback,
observe neither.

**Acceptance Scenarios**:

1. **Given** `TETHER_BASE_URL` with a non-loopback host and scheme `http`,
   **When** the server starts, **Then** the condition is surfaced at startup.
2. **Given** a loopback `http` value, **When** the server starts, **Then** nothing
   is raised — the local development path is unaffected.
3. **Given** a scheme that is neither `http` nor `https`, **When** the server
   starts, **Then** it refuses to start.

---

### Edge Cases

- **A hostname with several A records**, some public and some reserved. Every
  resolved address must be checked; permitting on the first acceptable one is a
  bypass in one DNS record.
- **IPv6, and IPv4-mapped IPv6** (`::ffff:169.254.169.254`). A denylist written
  for dotted-quad IPv4 does not cover these, and the mapped form is the classic
  way past one.
- **Decimal, octal and hex IP literals** (`http://2130706433/`). Node's URL parser
  and the OS resolver do not agree about these; the check must operate on what
  will actually be dialled.
- **DNS that resolves differently between the check and the connection.** This is
  the rebinding case in US1 scenario 5, and it is why a resolve-then-fetch
  implementation is not sufficient on its own — see Q1.
- **Redirects.** A permitted host that 302s to `http://169.254.169.254/` defeats
  a destination-only check.
- **An unresolvable host.** Refused at registration as unresolvable, distinctly
  from refused as reserved (US2 scenario 4) — the operator's next action differs.
- **The demo provisioner.** It registers a datasource on `host.docker.internal`
  by design. It must keep working, via the exceptions list rather than by
  bypassing the check.
- **A trigger registered before this feature** whose URL is now refused. It is
  refused at dial time and the condition is made visible; it is **not** silently
  disabled (Article XV — the same reasoning V5 applies to armed triggers).

---

## Requirements *(mandatory)*

### The egress rule

- **FR-001**: The system MUST define one egress policy — a scheme allowlist, a
  reserved-address denylist, and an explicit list of permitted internal
  destinations — in a single module, used by every path that dials an
  operator-supplied address.
- **FR-002**: The denylist MUST cover, at minimum: loopback, private IPv4 ranges,
  link-local including `169.254.0.0/16`, carrier-grade NAT, IPv6 unique-local and
  link-local, IPv4-mapped IPv6, and the unspecified address.
- **FR-003**: The permitted-internal list MUST be configuration, not a code
  constant, and MUST be documented in `.env.example`.
- **FR-004**: Every resolved address for a hostname MUST be checked. A hostname
  with any reserved resolved address MUST be refused.
- **FR-005**: The policy MUST be applied at **dial time** on every parent-side
  outbound path, not only at registration, so that DNS rebinding does not defeat
  it.
- **FR-006**: Redirects MUST NOT be followed to a destination the policy refuses.
- **FR-007**: The check MUST operate on the address that will actually be
  connected to, not on a re-parse of the string.

### Where it applies

- **FR-008**: Poll-trigger URLs MUST be validated at registration and enforced at
  dial time in the scheduler.
- **FR-009**: Datasource connection strings MUST have their host validated at
  registration and enforced when the introspector connects.
- **FR-010**: Tool URLs MUST be validated at registration. (The parent never
  dials them; see Context.)
- **FR-011**: `triggers.config` MUST stop being `z.record(z.any())` for the
  fields the system actually reads. At minimum `config.url` and the interval
  fields MUST be typed and validated per trigger type.

### Diagnosability

- **FR-012**: A refusal MUST distinguish bad scheme, reserved literal,
  resolves-to-reserved, and unresolvable. All four surfacing as one message is the
  failure Article V exists to prevent.
- **FR-013**: A dial-time refusal MUST be logged distinctly from a network
  failure. The scheduler currently swallows poll errors into one `console.warn`;
  a policy refusal must not be mistakeable for a timeout.
- **FR-014**: No log line MAY contain the credential portion of a connection
  string.

### Least privilege (R12)

- **FR-015**: The system MUST determine whether a registered datasource's
  credential can write, without needing to perform a write to find out.
- **FR-016**: The determination MUST be recorded and visible to the operator.
- **FR-017**: Whether a writable credential is refused or merely surfaced is
  resolved in Q2.

### Runtime URL (R14)

- **FR-018**: `TETHER_BASE_URL` MUST be validated at startup: scheme `http` or
  `https` only, and a non-loopback host with `http` MUST be surfaced.
- **FR-019**: A loopback `http` value MUST remain acceptable and silent.

### Behaviour preservation

- **FR-020**: The demo provisioning path and the dummy-tool stub path MUST
  continue to work unchanged, via the permitted-internal list.
- **FR-021**: No request that succeeds today MUST fail after this feature, except
  ones that dial an address the policy refuses.

---

## Clarifications

### Q1: How is the dial-time check actually enforced?

**Context**: FR-005 requires the policy to apply at dial time, not just at
registration, because resolve-then-`fetch` leaves a window in which DNS can change
its answer. The two paths have different mechanics: `fetch` (poll triggers) and a
database driver socket (introspection).

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Resolve, check, then connect **to the checked IP** with the original hostname preserved for TLS/Host. | Closes the rebinding window properly — the address that was checked is the address that is dialled. Requires per-path work: a custom agent for `fetch`, and the driver's socket-creation hook for the database. |
| B | Validate at the socket layer, using the connection hook each client offers (`undici` agent `connect` / driver `lookup` option), so the check runs on the address the OS actually resolved. | The most robust and the most idiomatic — the check is where the connection is. Requires understanding each client's hook, and the hooks differ. |
| C | Resolve, check, then `fetch`/connect by hostname. | Simplest. **Does not satisfy FR-005** — it is exactly the resolve-then-connect race. Acceptable only if FR-005 is dropped, which would leave the roadmap's stated defeat condition open. |

**Resolution**: **B where the client offers a hook, A as the fallback**, and never
C. Recorded as a decision for `/speckit-plan` to make concrete per path, since it
turns on library specifics that belong in research rather than in the spec. What
the spec fixes is the requirement: **the address checked must be the address
dialled.**

### Q2: Does a writable datasource credential get refused, or surfaced?

**Context**: FR-015–FR-017. Article XI is NON-NEGOTIABLE, which argues for
refusal. But refusing outright would break every existing datasource registered
with an over-privileged credential, at upgrade time, with no migration path.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Detect and surface prominently; do not refuse. Refusal becomes its own follow-up once the fleet is clean. | Ships the visibility now and breaks nothing. Honest about being a half-measure. Risk: "surfaced" becomes permanent, and Article XI stays weakened on the live path with a warning next to it. |
| B | Refuse at registration for new datasources; surface for existing ones. | New registrations are correct from now on; the existing ones are visible and can be fixed deliberately. No upgrade breakage. Two behaviours to explain, which is a real cost. |
| C | Refuse everywhere. | Article XI satisfied in the strongest sense. Breaks existing deployments on upgrade with no migration, which will produce a rollback rather than a fix. |

**Resolution**: **B**, proposed. It is the only option that makes the live path
correct going forward without an upgrade-time outage. The asymmetry (strict for
new, visible for old) is defensible precisely because it is stated: existing
datasources are grandfathered *visibly*, not silently, and the visibility is what
makes the follow-up possible.

Note also, from `demo/hr-roles.ts:119`, that the demo's own read-only enforcement
carries this comment: *"Defence in depth ONLY. A script can issue `SET
transaction_read_only = off`."* So even the path that has enforcement does not
consider it airtight. That is an argument for detection-and-visibility being
worth real points, not a consolation prize.

### Q3: What happens to poll triggers registered before this feature whose URLs are now refused?

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Refuse at dial time, log distinctly, surface the condition on the trigger; leave it enabled. | Consistent with V5's treatment of already-armed triggers and with Article XV. Nothing changes state on its own; the operator sees the problem and decides. |
| B | Disable them automatically at startup. | Feels safer and is a silent side effect — an automation that stopped for an invisible reason. Article XV names this class. |

**Resolution**: **A**, proposed. Same reasoning as V5's R2, and worth keeping the
two features consistent so the product has one answer to "why did my trigger stop"
rather than two.

---

## Key Entities

- **Egress policy** — the scheme allowlist, reserved-address denylist and
  permitted-internal list, plus the decision function over them. One module, no
  second copy.
- **Egress decision** — permitted, or refused with a distinguishable reason (bad
  scheme, reserved literal, resolves-to-reserved, unresolvable).
- **Datasource privilege determination** — whether a registered credential can
  write, how it was determined, and when.

---

## Success Criteria *(mandatory)*

- **SC-001**: No parent-side outbound request reaches a reserved address that is
  not on the permitted-internal list — across every path, verified by testing the
  policy module and each call site, not the module alone.
- **SC-002**: A host that resolves to a public address at registration and a
  reserved one at dial time is refused. This single test is what separates this
  feature from a check that looks right and is not.
- **SC-003**: The demo provisioning path completes unchanged after this feature.
- **SC-004**: All four refusal reasons are distinguishable in the API response and
  in the log.
- **SC-005**: No log line produced by this feature contains a credential.
- **SC-006**: Every registered datasource has a recorded determination of whether
  its credential can write.
- **SC-007**: `triggers.config.url` cannot be set to a value the egress policy
  would refuse, through any route.
- **SC-008**: Each new wiring point survives a deletion pass. Every slice in this
  programme so far has shipped at least one that did not.

---

## Assumptions

- The scheduler stays in-process and on its current tick. This feature adds a
  check to what it dials, not a redesign of how it dials.
- DNS resolution is available to the parent process; an unresolvable host is a
  refusal, not a fallback to permitted.
- The permitted-internal list is small and operator-set. No UI for editing it.
- The container-level egress policy for generated code (the `network` parameter)
  is **not** part of this feature — see Out of Scope.

---

## Out of Scope

- **Changing the `network` execution parameter from boolean to an enum.** The
  roadmap lists this under V6. It is deliberately excluded: it is a **breaking API
  change**, and breaking API changes must not ride along with validation
  infrastructure — they belong in their own PR where the contract change is the
  headline and can be reviewed as such. `routes/scripts.ts:166` already carries a
  comment preserving the boolean semantics on purpose. **This should become its
  own feature after V6 ships.**
- **Container-level network policy** for execution containers, beyond what already
  exists (`--network=none` / `--network=bridge`). Same reasoning: it is coupled to
  the enum change above.
- **Removing `host.docker.internal` from execution containers.** It is how the
  dummy-tool stubs are reachable; removing it is a topology change, not a
  validation change.
- **An outbound proxy** through which all egress is forced. A stronger design and
  a much larger one; this feature does not preclude it.
- **Rotating or scoping existing datasource credentials.** US3 detects and
  surfaces; it does not manage credentials.
- **§9 R7 (CSP), R9 (dependency scanning), R13 (secret injection at generation).**
  Named in the roadmap's non-goals as belonging to their own features.

---

## Dependencies

- V1's validation kernel and zod primitives, for the registration-time schemas.
- The existing config module, for the permitted-internal list and
  `TETHER_BASE_URL` validation.
- No dependency on V5.

---

## Standards impact

After shipping, `/speckit-update-standards` amends `security.md`:

- **§9 R8** — closes, with the scope stated: parent-side egress is guarded;
  container egress is not yet, and is named as the follow-up.
- **§9 R12** — moves from "nothing forces read-only" to "detected and surfaced;
  refused for new registrations" per Q2 resolution B. **It does not close.**
- **§9 R14** — closes.
- **§5** — the claim that tool registration is a trusted-admin action and the
  "hard blocker for self-service" note should be revisited in light of what is now
  enforced. It does not become false; it becomes narrower.
