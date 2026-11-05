# Specification Quality Checklist: Corporate CA trust for Docker builds

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-24
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

### Validation iteration 1 — one failure, fixed

**"No implementation details" initially FAILED.** The Overview named three specific
toolchains ("the package manager, the Python package index, or the plugin
registry"), which identifies *which* images fail and *how* rather than *what* is
broken. Rewritten to "each one retrieving a pinned dependency from an external
registry" — the fact that matters (every image makes a validating fetch) without
naming the tools that make it.

Re-validated after the fix: all items pass.

### Two deliberate retentions, recorded rather than silently kept

- **"Docker" and `docker compose up -d` are retained.** Container image building is
  the subject of this feature, not an implementation choice within it. A version of
  this spec that avoids naming it cannot state what is broken. The prohibition
  targets implementation decisions the spec should leave to `plan.md`; this is the
  problem domain.
- **Mechanism differences are described but not named.** The Edge Cases section
  records that one affected toolchain *adds* to a bundled trust set, one *replaces*
  it, and one ignores the environment entirely — because that asymmetry is a
  requirement-shaping fact (FR-002, FR-004, FR-011) rather than a design choice.
  Which toolchain is which, and the specific mechanism each needs, is left to
  `plan.md`.

### Requirements with no counterpart in the original request

Three were added from the repository's own standing constraints rather than from
the feature description, and are flagged here so a reviewer can challenge them:

- **FR-010** (a staged-but-unrequested certificate must not be trusted) — derived
  from the "explicit rather than detected" assumption. Without it, two developers'
  builds can differ by the contents of an untracked directory.
- **FR-012** (the verification must be demonstrated to fail when trust is absent) —
  the project's standing rule that a control which cannot fail is worse than none.
- **FR-014** (a rebuild reflects the material actually staged) — layer caching can
  otherwise make a restaged certificate a no-op, which presents as the fix not
  working.

### Open question deferred to planning, not blocking

Whether trust should additionally be verified for **outbound requests from running
containers** (as opposed to build-time fetches only) is asserted as an assumption
and covered by FR-002 and User Story 1 scenario 3. It is a free consequence of
adding trust to the image rather than to the build, so it is claimed — but it is
the one claim most likely to need a per-image caveat once the mechanisms are known.
