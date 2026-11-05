# Specification Quality Checklist: Feature-level RBAC — permission catalogue, custom roles, platform tier

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-10
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

## Validation Notes

### Iteration 1 — issues found and fixed

1. **Implementation detail leak (Content Quality)** — the first draft named concrete
   database tables (`workspace_members`, `workspace_member_capabilities`), the
   environment variable `SUPER_ADMIN_EMAILS`, middleware function names
   (`requireWorkspaceRole`, `requireDeploymentAdmin`) and HTTP status codes throughout
   the requirements. Rewritten in domain language: "workspace membership store",
   "member capability list", "the environment allowlist", "the request boundary",
   "refused". The concrete names survive only in Context and Dependencies, where they
   describe the existing system a stakeholder is being told about rather than
   prescribing a design.

2. **Untestable requirement** — an early FR read "the permission model should be
   robust". Replaced by FR-002/FR-003 (a completeness check that fails on omission and
   is proven able to detect one) and **FR-039** (perturbation proof per control), both of
   which name a failing condition. ⚠ *This note said FR-035, which is the audit-immutability
   requirement. Corrected 2026-09-12.*

3. **Success criteria were technology-specific** — an early SC read "every route file
   imports the permission middleware". Replaced by SC-001 and SC-002, which state an
   observable outcome (no endpoint reachable without a grant; no endpoint without a
   declared permission) rather than a code shape.

4. **Unbounded scope** — the first draft implied every unguarded route would be gated.
   ⚠ **Sixteen routes** are correctly unguarded and gating them would break the engine — the
   original note said "four", counting modules. Now enumerated as out of scope in Context
   and pinned by FR-005 as *decided exemptions*, so the completeness check cannot later be
   satisfied by quietly re-adding them.

### Iteration 2 — the 2026-09-12 re-baseline

The spec passed this checklist on 2026-09-10 and three of its ticks were **true of the
document and false of the codebase**. That is the failure mode a quality checklist is worst
at catching: every item is about internal consistency, and none of them re-reads the system.

| Item | What it missed |
| :--- | :--- |
| *Requirements are testable and unambiguous* | FR-006 required presets reproducing today's roles "exactly". There are **two** role maps in the codebase and they disagree, so no set satisfies it. Resolved as D-4. |
| *Requirements are testable and unambiguous* | `contracts/api.md` and `plan.md` gave the members route an **AND** and an **OR** of the same two guards. Both documents passed; neither agreed. Resolved in api.md §D. |
| *Dependencies and assumptions identified* | The client's own authorisation map was in neither. It is a dependency and a conflict, and FR-031 was written as a rule already followed when it was not. Resolved as D-6. |
| *Scope is clearly bounded* | Bounded in routes, unbounded in consequence: with zero grants on the deployment, the bounded change makes every workspace unusable. Resolved as D-5. |

**The lesson worth keeping**: these artefacts are checked for agreeing with each other, and
were. Nothing checked them against the thing they describe. The route map is now
**generated** for exactly that reason.

### Iteration 2 — clarifications resolved

Three [NEEDS CLARIFICATION] markers were raised rather than defaulted, because both
readings were defensible and led to materially different work. All three were put to the
requester on 2026-09-10 and answered. The spec's **Resolved Decisions** section records
each with the option not taken and its cost.

| # | Question | Answer | Recorded in |
| :-- | :--- | :--- | :--- |
| D-1 | Does the workspace list become membership-filtered? | Yes — you see only your workspaces | FR-015, FR-016; Story 1 scenarios 6–7; two Assumptions covering the harness and the visible change |
| D-2 | Where are deployment-wide access decisions recorded? | A separate deployment-level record; the workspace audit store is untouched | FR-036, FR-037; two Key Entities; Dependencies |
| D-3 | Can a per-member override deny, or only add? | Grant-only; narrowing is done by composing a custom role | FR-010, FR-011; Key Entities; two Edge Cases |

Consequential edits made in the same pass: FR-011 changed from "a stated resolution
order" to "a union, therefore order-independent" (D-3 removes the possibility of
disagreement, so an ordering requirement would have described a case that cannot arise);
three success criteria added (SC-012 to SC-014); the edge case about a role and an
override disagreeing rewritten to state that they cannot, plus new edge cases for the
person with no grants and for a grant revoked while signed in.

### Verification of this iteration

- `NEEDS CLARIFICATION` markers: **0**
- Functional requirements: **40**, ids contiguous FR-001…FR-040, no duplicates
- Success criteria: **14**, no duplicates
- Every `FR-nnn` referenced in prose resolves to a defined requirement — no dangling
  cross-references after renumbering
- The phrases "separation of duties" and "authenticated user" appear **once**, in Out of
  Scope, explicitly stating that this feature is *not* the former

## Notes

- **All checklist items pass as of iteration 2. The spec is ready for `/speckit-plan`.**
  `/speckit-clarify` is not required — the three questions it would have asked were
  asked and answered during specification.
- The spec deliberately avoids the phrases "separation of duties" and "authenticated
  user", per the constraint recorded in the repository's agent context file: anything
  holding the identity signing secret can produce any identity, so only the bounded
  claim is available.
