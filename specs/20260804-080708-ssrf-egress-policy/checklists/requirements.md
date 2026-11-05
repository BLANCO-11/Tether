# Specification Quality Checklist: SSRF and Egress Policy

**Purpose**: Validate specification completeness and quality before planning
**Created**: 2026-08-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details in the Requirements section
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

**Note.** The Context section names specific files and line numbers. That is
deliberate: the roadmap frames this slice around tool URLs, and the code shows the
sharpest exposure is a poll-trigger `fetch` the roadmap never mentions. A spec
that stayed abstract would have specified the wrong control.

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain — Q1, Q2 and Q3 carry resolutions
      with rationale, open to reversal before implementation
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] Success criteria are technology-agnostic
- [X] All acceptance scenarios are defined
- [X] Edge cases are identified (research R4 enumerates the encoding cases)
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [X] Feature meets measurable outcomes defined in Success Criteria

## Constitution-specific checks

- [X] **Article XI (NON-NEGOTIABLE)** — US3 improves it and the spec is explicit
      that R12 **does not close**. Claiming closure would be the unearned signal
      Article XV forbids.
- [X] **Article XIV (NON-NEGOTIABLE)** — the demo path is a first-class constraint
      (FR-020, P4), not an afterthought. A denylist that breaks the demo is a
      denylist that gets switched off.
- [X] **Article XV** — pre-existing triggers with now-refused URLs are surfaced,
      never auto-disabled (Q3).
- [X] **Article VIII (NON-NEGOTIABLE)** — FR-014 forbids credentials in logs, and
      the new env var is owed a `.env.example` placeholder in the slice that reads
      it.
- [X] **Article V** — four distinguishable refusal reasons, and a policy refusal
      logged distinctly from a timeout.

## Scope discipline

- [X] The `network` boolean→enum change is **excluded** and the exclusion is
      stated in three places (spec Out of Scope, plan Summary, tasks header). It is
      a breaking API change and must not ride along with validation
      infrastructure — it needs its own PR where the contract change is the
      headline. T066 schedules it rather than dropping it.

## Notes

- **SC-002 is the criterion that matters.** A resolve-then-connect implementation
  passes every other test in this feature and fails that one. The design (plan D1
  — check inside the DNS `lookup`) exists specifically to satisfy it.
- **T003 is a genuine unknown**, not a formality: whether `pg` and `mysql2` expose
  a socket hook that carries a custom `lookup` decides whether the design holds for
  those paths. The contingency is written down (research R1) so hitting it is a
  known fallback rather than an improvised decision, and T061 requires recording
  which paths actually achieved dial-time checking so the standards amendment
  cannot over-claim.
