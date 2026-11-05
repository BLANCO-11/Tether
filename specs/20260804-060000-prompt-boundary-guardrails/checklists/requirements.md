# Specification Quality Checklist: Prompt-Boundary Guardrails (Surface B)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
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

- **Q1 resolved 2026-08-04 — option C.** V4 scopes to the content that reaches
  the prompt today; collecting table/column comments becomes its own feature
  (OOS-005). Two obligations follow and must not be dropped: `security.md` §5 has
  to be *corrected*, not merely extended, because it currently claims a surface
  that does not exist; and the detector interface must be shaped in
  `/speckit-plan` so the follow-up registers a new field rather than rewriting the
  mechanism.

- Two decisions were resolved as documented assumptions rather than
  clarifications, because a defensible default exists for each. Both are worth a
  second look at `/speckit-plan`:
  1. **New audit finding severity** — assumed warning-level, not highest, so V5
     is not pre-committed to blocking enable/schedule on a heuristic finding.
  2. **Where framing lives** — assumed prompt composition, not the manifest XML,
     so no existing workspace takes a content-hash change and a spurious version
     bump.

- Named file paths and line references appear in the Context section by design.
  They identify the existing behaviour being corrected (`xmlEscape` prevents
  structural but not semantic injection) rather than prescribing an
  implementation, and the correction to `security.md` §5 cannot be stated
  accurately without them.
