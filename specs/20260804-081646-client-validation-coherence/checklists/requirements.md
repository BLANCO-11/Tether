# Specification Quality Checklist: Client-Side Validation Coherence

**Purpose**: Validate specification completeness and quality before planning
**Created**: 2026-08-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details in the Requirements section
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain — Q1, Q2, Q3 carry resolutions with
      rationale
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] All acceptance scenarios are defined
- [X] Edge cases identified — including the one nobody looks for (the client being
      *stricter* than the server, which produces no error report)
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [X] Feature meets measurable outcomes defined in Success Criteria

## Constitution-specific checks

- [X] **The client is never the guardrail.** FR-006 requires every client rule to
      exist server-side; SC-004 verifies it rule by rule; plan.md addresses head-on
      why adding bypassable client validation is not a violation.
- [X] **Article IV** — no new runtime dependency in the client (SC-008); the new
      workspace package is justified in plan D1.
- [X] **Article XV** — FR-011 forbids silently invalidating recorded verdicts.
- [X] **No standards amendment.** `security.md` must not record client validation
      as a control.

## Corrections to the roadmap this spec records

- [X] **`manifest-form.ts` does not validate.** It carries `required`, `min`,
      `max` and `integer` onto `FormField` and nothing checks a value against them.
      The roadmap's "adopt the existing declarative seam" is therefore work, not
      adoption. Recorded so the plan does not budget for a rename when it needs a
      checker.
- [X] **The client has no zod and no dependency on the server**, so "share the
      primitives from V1" needs a mechanism that does not exist yet. Q1 supplies
      one.
- [X] **`lib/validation.ts` is a go-live gate in browser storage**, not only a
      misnamed file. Since V5 adds a real server-side arming gate, two gates that
      can disagree is worse than either alone — US4 exists for that and the roadmap
      does not mention it.

## Notes

- **SC-002 is the criterion most likely to be skipped**, because a client stricter
  than the server generates no error report — the operator just cannot do something
  and assumes they are wrong. The case table's `accepted` half exists solely for
  it, and quickstart §6's deletion point 3 checks that the half is actually load-
  bearing.
- **T030's audit has two acceptable outcomes and one unacceptable one.** A
  client-only rule is either derived from a server rule or recorded as a finding.
  Adding a server rule here is not on the list — it is a behaviour change with its
  own regression risk, in a feature whose whole premise is that the client is not
  the enforcement.
