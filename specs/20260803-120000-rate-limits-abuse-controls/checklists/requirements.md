# Specification Quality Checklist: Rate limiting, request identity and abuse controls

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-03
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — Q1–Q3 resolved 2026-08-03 (A/A/A)
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

Two validation iterations. Changes made:

1. **Technology names removed from success criteria.** SC-001/SC-003 initially
   named Redis and `express-rate-limit`; restated as outcomes ("repeated
   credential guessing is refused after a bounded number of attempts").
2. **FR-004 added** — the oracle problem. A throttle that lets a *correct*
   credential through during a cooldown tells an attacker their last guess was
   right, which makes the throttle worse than none. This was not in the roadmap
   and is easy to implement backwards.
3. **FR-007 / SC-006 added** — liveness probes. A rate limiter that can refuse a
   container healthcheck takes the service down by itself. The roadmap's "rate
   limits sized per route class" implies this but does not say it, and health is
   the class most likely to be forgotten because it looks trivial.
4. **FR-013 / FR-014 / SC-004 added** — slot release on every exit path. With a
   480-second operation, a leaked concurrency slot is not a small bug: N leaks
   permanently disable generation. This is the failure mode a concurrency limit
   introduces that a rate limit cannot.
5. **FR-009 added** — a refusal must be cheaper than the work it replaces and must
   not write to the database. Otherwise the limiter is itself an amplifier, which
   is especially pointed for `/stub-api`, where every call currently writes a row.
6. **FR-022 / SC-010 added** — bounded limiter state. An in-process counter keyed
   by client address is an unbounded map by default, i.e. a memory leak with an
   attacker holding the pen.
7. **Edge cases expanded** for proxied client addresses. Behind compose or a
   proxy, every request can appear to come from one address; a limiter keyed on
   that either throttles everyone at once or nobody. Getting this wrong is the
   most likely way this feature causes an outage.

### Decisions deliberately taken to the requester

- **Q1 (counter store)** determines whether a new dependency and a new failure
  mode enter the system, and whether the limits are correct under scale-out.
- **Q2 (reject vs queue)** is directly user-visible on a 480-second operation and
  changes the amount of machinery by a large factor.
- **Q3 (how far to act on §9 R1)** is a security-vs-availability trade that is not
  ours to make: option B genuinely closes R1 but can lock people out, in a slice
  whose headline promise is "no behaviour change".

**Resolved A/A/A on 2026-08-03**: in-process counters, reject at the ceiling,
throttle-and-log only.

Choosing A on all three keeps V3 small, and the honest cost is that two gaps stay
open rather than being papered over. Both are now requirements rather than
footnotes:

- **In-process means counters die with the process** (FR-026) and **limits
  multiply by instance count** (FR-027/FR-028). The second is the dangerous one,
  because nothing in the code would notice; a startup log line is the cheapest
  thing that makes it visible to whoever scales out.
- **§9 R1 stays open** (FR-030). A single shared password still grants
  `superadmin`, which since V2 gates demo destruction. This must not read as closed
  just because a login throttle shipped.
- **Rejecting at the ceiling puts an obligation on the UI** (FR-029): a 429 shown
  as an indefinite spinner is worse than queueing, because the user cannot tell
  "busy" from "broken".

### Standards conformance

- **Article II (test-first)**: SC-009 requires, per limit, a negative test that
  fails when the limit is removed *and* a positive test proving legitimate traffic
  is unaffected. Both prior slices' audits turned on exactly this.
- **Article IV**: the dependency question is explicit (Q1), not assumed.
- **Article V (observability)**: FR-002, FR-016, FR-018 — a refusal nobody can see
  is not a control, and V1's opacity is only honest if the operator can still
  reconstruct the request.
- **Article VIII (secrets)**: FR-002 and FR-020 forbid logging credentials;
  FR-024 requires `.env.example` placeholders.
- **Article XV (no silent side effects)**: FR-008 — a refusal must say which limit
  was hit. A 429 with no explanation is a signal presented as a gate.
- **§9 R10**: the feature's main purpose. **§9 R1**: Q3.
- **§9 R2**: stays deferred, and FR-025 forbids describing any limit as per-user —
  the same discipline V2 established.
