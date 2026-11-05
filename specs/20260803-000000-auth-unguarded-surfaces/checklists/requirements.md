# Specification Quality Checklist: Authentication and authorization on the unguarded surfaces

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-03
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — Q1–Q3 resolved 2026-08-03
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

Two iterations were run. Changes made during validation:

1. **Technology leakage removed from success criteria.** SC-002/SC-003 initially
   named the bridge and its tools; restated as outcomes ("can obtain no schema
   information about any workspace from any surface").
2. **FR-019 narrowed.** It first read as "credential comparison must be
   timing-safe", which would have pulled `requireApiKey`'s `!==` into V2 —
   that belongs to V3. Now bound only to credentials this feature introduces,
   so V2 does not create a second instance of the defect while leaving the
   existing one to its own slice.
3. **US2 rewritten around Finding A.** The roadmap assumed the progress
   WebSocket needed authenticating; the audit found it has no consumers. The
   story now carries both outcomes and defers the choice to Q2 rather than
   quietly deleting a capability.
4. **FR-011 added.** An allowlist with no test tying it to the UI's actual
   calls will silently break the product on the next UI change. This is the
   same failure mode as V1's — a guard whose test cannot fail.
5. **Edge cases expanded** for path normalisation (traversal, encoded
   separators), because an allowlist matched on a raw path is not an allowlist.

### Decisions taken to the requester rather than guessed

Q1 (does V2 close §9 R2?), Q2 (authenticate or remove the progress
WebSocket?) and Q3 (how a bridge credential is scoped) each change what gets
built, not merely how. Q1 changes the feature's size by roughly a factor of
two; Q2 is the difference between adding a subsystem and deleting one; Q3
determines whether SC-003 is achievable at all. The roadmap itself directs
that the R2 decision be made explicitly in this spec.

Resolved 2026-08-03: **Q1 defer R2, Q2 authenticate the WebSocket, Q3 one
credential per workspace.**

Q2 did not take the recommended option, which is fine but has consequences the
spec now carries explicitly rather than leaving to the plan:

- The listener has **no consumer**, so its guard cannot be validated by using
  the product. FR-022 makes an automated test client the acceptance condition
  for keeping it. Without that, this is a guard nobody has ever seen work.
- Q1 defers R2, so there is **no user identity at the server**. Entitlement can
  therefore only be workspace-level. The spec now states this outright and
  forbids wording any test as proof of per-user authorization, because a guard
  described as stronger than it is *is* the R3 defect (Article XV).
- Authentication without the entitlement lookup is explicitly **not** an
  acceptable partial outcome; the stated fallback is to unpublish the port.

### Standards conformance

Checked against the binding standards for this session:

- **Article II (test-first)**: SC-007 requires a negative test per requirement
  and that each fails when its guard is removed.
- **Article IV (no undeclared dependency)**: recorded as an assumption; any
  dependency must be justified in `plan.md`.
- **Article VIII (secrets)**: FR-018.
- **Article X (generated code untrusted)**: FR-007's entitlement check must be a
  server-side lookup, never a caller assertion.
- **Article XI (least privilege, NON-NEGOTIABLE)**: FR-002, FR-010, and Q3's
  one-credential-per-workspace decision.
- **Article XII (workspace isolation)**: FR-003, SC-003.
- **Article XV (no silent side effects; do not present a signal as a gate)**:
  FR-014 — this is exactly what an unenforced `roles` claim is.
- **§9 R2/R3**: Q1 and FR-014/FR-015.
- **§9 R10, R11**: explicitly out of scope, recorded in Assumptions.
