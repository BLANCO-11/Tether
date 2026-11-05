# Specification Quality Checklist: Audit Verdict as an Asymmetric Gate

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs)
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

**Note on the first item.** The spec names existing code (`enableReadiness()`,
`buildVerdictFromTests`, the four CHECK constraints) in its Context and
Clarifications sections. That is deliberate and is not leaked implementation:
this feature's scope is defined by *what already exists*, and the roadmap's V5
section is wrong about two of those things. A spec that stayed abstract would
have re-specified the CHECK constraints V1 already shipped. The Requirements
section itself stays behavioural.

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain — Q1, Q2 and Q3 carry proposed
      resolutions with stated rationale, open to reversal before `/speckit-plan`
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] Success criteria are technology-agnostic
- [X] All acceptance scenarios are defined
- [X] Edge cases are identified
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [X] Feature meets measurable outcomes defined in Success Criteria
- [X] No implementation details leak into the Requirements section

## Constitution-specific checks for this feature

- [X] **Article XV** — the spec states which signals are evidence and which are
      gates, and forbids presenting `clean` as a pass (FR-017, SC-005)
- [X] **Article X** — the gate reads the independent audit, never the agent's
      self-report; FR-020 requires the two stay distinguishable
- [X] **Article XV (no silent side effects)** — auto-disabling on regeneration is
      explicitly out of scope; the condition is surfaced instead
- [X] **Asymmetry** — SC-002 tests it by deletion, not by assertion

## Notes

- Q1's resolution is the one most worth a second opinion: it decides whether the
  override trail names a person. It records only verifiable facts today, and says
  what should change when `security.md` §9 R2 is fixed.
- SC-007 (deletion pass) is carried forward because the previous four slices each
  shipped at least one wiring point that no test covered.
