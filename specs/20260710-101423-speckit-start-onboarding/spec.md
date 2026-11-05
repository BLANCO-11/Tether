# Feature Specification: `/speckit-start` Foundational-Standards Onboarding

**Feature Branch**: `20260710-101423-speckit-start-onboarding`

**Created**: 2026-07-10

**Status**: Draft

**Input**: User description: "Add a `/speckit-start` onboarding command to this template that interviews the user to establish four project-wide, enforceable foundational standards before any feature code exists: Constitution, Frameworks, Security, and (if UI) Design. Standards are hard-blocked on existence and conformance-checked via /speckit-comply. Add `/speckit-update-standards` to amend them with tracked history, and a git hook that reviews incoming diffs against the standards. Full confirmed intent in docs/intent/speckit-start.md."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Establish foundational standards for a new project (Priority: P1)

A person adopting this template runs a single onboarding command and is guided,
through structured interviews, to produce the project's foundational standards
before writing any feature. The command walks four steps in order —
**Constitution**, **Frameworks**, **Security**, and (only when the project has
a UI) **Design** — and ends with those standards saved as enforceable project
artifacts. From that point on, the project cannot progress to feature code
until the required standards exist.

**Why this priority**: This is the core value of the feature. Without the
onboarding flow producing the standards, none of the enforcement, amendment, or
continuous-compliance behavior has anything to act on. It is independently
useful: a project with agreed-upon constitution/security (+design) standards is
better off even if nothing else in this feature ships.

**Independent Test**: Run the onboarding command in a fresh project, answer the
interview prompts for all four steps, and confirm that the constitution,
frameworks record, security standard, and (if UI) design standard files are
created in the project's standards location and are recognized as "present" by
the existence gate.

**Acceptance Scenarios**:

1. **Given** a project with no foundational standards, **When** the user runs
   the onboarding command and completes all applicable steps, **Then** a
   constitution, a frameworks record, and a security standard exist, and a
   design standard exists if and only if the project was determined to have a
   UI.
2. **Given** the Frameworks step, **When** the user names their intended
   frameworks or asks the agent to recommend them, **Then** the flow records
   the chosen frameworks and determines whether the project has a UI (from the
   user's answer, or inferred from a UI-implying framework such as a
   web/desktop UI framework).
3. **Given** a project determined to have **no** UI, **When** the onboarding
   flow runs, **Then** the Design step is skipped and only constitution,
   frameworks, and security standards are required.
4. **Given** the onboarding flow is interrupted before completion, **When** the
   user re-runs the command, **Then** it resumes or clearly reports which
   standards are still missing rather than silently overwriting completed work.

---

### User Story 2 - Facilitated design workshop with visual approval (Priority: P2)

For a project with a UI, the design step runs as an interactive workshop. The
user chooses one of two modes: a **full facilitated workshop** (the agent
interviews the user on design choices in depth) or a **reference/vibe mode**
(the user gives a reference such as "make it look like a well-known music app"
or "clean modern UI" and the agent researches and proposes). In both modes the
agent produces **resizable static HTML/CSS mockups** the user opens in a browser
and resizes to verify the design holds on mobile as well as desktop. The user
gives feedback, the agent revises, and on approval the flow produces an
enforceable design standard plus — once frameworks are known — a real
framework-native component library carrying the approved design tokens.

**Why this priority**: Design is the most assumption-laden and iterative part
of agent-built work and the primary source of the user's pain (designs that
diverge from intent and break on mobile). It delivers standalone value: a
project that completes the design workshop has an approved, mobile-verified
design system even if the other steps were done manually.

**Independent Test**: For a UI project, run the design step in each mode, verify
that browser-openable mockups are produced and revised across at least one
feedback round, that approval yields a design standard file, and that a
component library reflecting the approved tokens is scaffolded for the chosen
framework.

**Acceptance Scenarios**:

1. **Given** a UI project at the design step, **When** the user selects the full
   workshop mode, **Then** the agent conducts a design interview and produces
   resizable HTML/CSS mockups before any framework component is written.
2. **Given** a UI project at the design step, **When** the user selects
   reference/vibe mode and names a reference, **Then** the agent produces
   proposed mockups derived from that reference for the user to approve or
   correct.
3. **Given** proposed mockups, **When** the user opens them in a browser and
   resizes to a mobile width, **Then** the layout remains usable (no overlap or
   loss of content) or the issue is caught and revised before approval.
4. **Given** the user approves the design and frameworks are known, **When** the
   design step completes, **Then** an enforceable design standard is saved and a
   framework-native component library carrying the approved design tokens is
   scaffolded.
5. **Given** the user has not explicitly approved the design, **When** the flow
   attempts to finalize, **Then** it does not produce the final design standard
   until an explicit approval is given.

---

### User Story 3 - Enforcement of standards during development (Priority: P1)

Once standards exist, they bind all subsequent work. The project's pre-write
guard refuses to let feature/source work proceed while a required standard is
missing: security is required for every project, and design is required only
when the project has a UI. The standards are loaded into the working context of
every session so agents build in line with them. Whether a given change
actually conforms to the standards (rather than merely whether the standard
exists) is verified through the existing compliance review, not by the guard.

**Why this priority**: Enforcement is what makes the standards "enforceable"
rather than advisory, and it is the reason the user wants this feature. It ties
directly into the template's existing "you must go through the process"
guarantees.

**Independent Test**: With required standards missing, attempt a source/feature
change and confirm it is blocked with a message naming the missing standard and
the command to produce it. With standards present, confirm the change is
allowed and the standards are visible in session context. Introduce a change
that violates a standard and confirm the compliance review flags it.

**Acceptance Scenarios**:

1. **Given** a project with no security standard, **When** any feature/source
   change is attempted, **Then** it is blocked with a message naming the missing
   standard and directing the user to the onboarding command.
2. **Given** a UI project with no design standard, **When** UI/source work is
   attempted, **Then** it is blocked; **and given** a non-UI project, the
   absence of a design standard does not block work.
3. **Given** all required standards exist, **When** a change is made, **Then**
   the standards are present in the session's working context and the change is
   not blocked on existence grounds.
4. **Given** a change that contradicts an existing standard, **When** the
   compliance review runs, **Then** the violation is reported as a finding
   (the guard itself does not attempt to parse or reject the change).

---

### User Story 4 - Amend standards mid-project with tracked history (Priority: P2)

Partway through a project the team decides to change a standard (tighten a
security requirement, revise a design token, adjust a principle). They run the
update-standards command, are interviewed about what they want to change, and
the relevant standard file(s) are updated with a recorded, reviewable history of
the change rather than a silent edit.

**Why this priority**: Standards drift or become wrong; a governed path to
change them keeps enforcement honest. Lower than P1 because a project can
operate on its initial standards for some time, but it is essential for the
feature to be usable long-term.

**Independent Test**: With standards present, run the update command, request a
specific change through the interview, and confirm the correct file is updated
and a history entry recording the change is added.

**Acceptance Scenarios**:

1. **Given** existing standards, **When** the user runs the update command and
   describes a desired change, **Then** the agent interviews for specifics and
   updates only the relevant standard file(s).
2. **Given** a standard is updated, **When** the update completes, **Then** a
   tracked history entry records what changed (and, ideally, why) so the change
   is auditable.
3. **Given** a requested change that would violate a non-negotiable principle
   (e.g. secrets hygiene), **When** the update is attempted, **Then** the flow
   surfaces the conflict rather than silently applying it.

---

### User Story 5 - Continuous compliance when pulling changes (Priority: P3)

When a developer pulls new changes into their working copy, a review runs over
the whole incoming diff and reports whether the incoming code complies with the
current standards. The review is informational (read-only) — it surfaces
findings but does not block the pull.

**Why this priority**: This protects a team over time, especially new
developers who join after standards are set. It is P3 because it is a safety net
layered on top of the primary enforcement (the existence gate and
`/speckit-comply`), and the project is still protected without it.

**Independent Test**: Simulate pulling a diff that violates a standard and
confirm the review runs automatically and reports the violation as findings
without preventing the pull from completing.

**Acceptance Scenarios**:

1. **Given** standards exist, **When** a developer pulls changes that introduce
   a standards violation, **Then** a review runs over the incoming diff and
   reports the violation as findings.
2. **Given** the review runs, **When** it finds violations, **Then** it reports
   them without blocking or reverting the pull (read-only).
3. **Given** a pull with no standards violations, **When** the review runs,
   **Then** it reports a clean result.

---

### Edge Cases

- **Standards partially present**: only some required standards exist (e.g.
  security but not design on a UI project). The existence gate must block on the
  specific missing standard and name it.
- **UI determination is wrong**: the flow infers "no UI" but the project turns
  out to need one (or vice versa). The user must be able to correct the UI
  determination and trigger/skip the design step accordingly.
- **Design approval never given**: the user abandons the design workshop. No
  final design standard is produced, so the design gate keeps UI work blocked
  until approval happens.
- **Amendment conflicts with a non-negotiable principle**: e.g. a requested
  change that would hardcode a secret or remove secrets hygiene must be refused
  or surfaced, never silently applied.
- **Re-running onboarding on a project that already has standards**: must not
  destroy existing standards or their history; the update path is the preferred
  route for changes.
- **Mockups reveal a mobile failure only at a specific width**: the workshop
  must treat a layout that overlaps/loses content at mobile widths as not yet
  approvable.
- **A framework with no clear UI signal**: the flow must ask rather than assume
  when it cannot confidently infer whether there is a UI.

## Requirements *(mandatory)*

### Functional Requirements

#### Onboarding flow

- **FR-001**: The system MUST provide an onboarding command that guides the user
  through establishing foundational standards in four ordered steps:
  Constitution, Frameworks, Security, and (conditionally) Design.
- **FR-002**: The Constitution step MUST interview the user and produce or
  update the project's constitution of principles.
- **FR-003**: The Frameworks step MUST let the user propose intended frameworks
  or request agent recommendations, and MUST record the resulting framework
  choices as a project standard.
- **FR-004**: The Frameworks step MUST determine whether the project has a UI,
  using the user's explicit answer when given and otherwise inferring from the
  chosen frameworks; when it cannot confidently infer, it MUST ask.
- **FR-005**: The Security step MUST run for every project (including
  UI-less/backend-only projects) and MUST interview the user across security
  concerns (at minimum authentication, authorization, data protection, and
  secrets handling) and produce a security standard.
- **FR-006**: The Design step MUST run if and only if the project is determined
  to have a UI.
- **FR-007**: Each step MUST give the user's answers full attention; the flow
  MUST NOT auto-fill a standard without user input for that step (design being
  the most iterative).
- **FR-008**: The onboarding command MUST be safe to re-run: it MUST NOT destroy
  already-established standards or their history, and MUST report which required
  standards are still missing.

#### Design workshop

- **FR-009**: The Design step MUST offer two modes: a full facilitated design
  workshop, and a reference/vibe mode driven by a user-supplied reference or
  descriptive phrase.
- **FR-010**: In both design modes the system MUST produce static HTML/CSS
  mockups that the user can open in a browser and resize.
- **FR-011**: The mockups MUST be usable to evaluate responsive behavior across
  at least desktop and mobile widths, so mobile layout failures are caught
  before approval.
- **FR-012**: The design workshop MUST support at least one feedback-and-revise
  round before finalization.
- **FR-013**: The system MUST require explicit user approval of the design
  before producing the final enforceable design standard.
- **FR-014**: On approval, the system MUST produce an enforceable design
  standard and, once frameworks are known, MUST scaffold a framework-native
  component library that carries the approved design tokens.

#### Standards artifacts & enforcement

- **FR-015**: The system MUST store the foundational standards as project-level
  artifacts in the project's standards location so they persist beyond a single
  session.
- **FR-016**: The system MUST load the established standards into each session's
  working context so agents build in line with them.
- **FR-017**: The system MUST block feature/source work when a required standard
  is missing (existence gate): security is required for all projects; design is
  required only for UI projects.
- **FR-018**: When work is blocked for a missing standard, the system MUST report
  which standard is missing and which command to run to produce it.
- **FR-019**: The existence gate MUST decide only whether a required standard is
  present; it MUST NOT attempt to parse code or judge whether a change conforms
  to a standard's content.
- **FR-020**: Conformance of a change to the standards' content MUST be verified
  through the existing compliance review, which reports findings.

#### Amendment

- **FR-021**: The system MUST provide an update-standards command that
  interviews the user about the desired change and updates only the relevant
  standard file(s).
- **FR-022**: Every standards amendment MUST record a tracked, auditable history
  entry describing what changed.
- **FR-023**: An amendment that would conflict with a non-negotiable principle
  (e.g. secrets hygiene) MUST be surfaced/refused rather than silently applied.

#### Continuous compliance on pull

- **FR-024**: The system MUST provide a mechanism that, when a developer pulls
  new changes, reviews the whole incoming diff against the current standards.
- **FR-025**: The pull-time review MUST be read-only: it reports findings and
  MUST NOT block or revert the pull.

#### Consistency with the template

- **FR-026**: The feature MUST fit the template's existing enforcement model
  (existence gating in the pre-write guard; conformance via context loading and
  the compliance review) and MUST NOT weaken existing guarantees (spec-first
  workflow, secrets hygiene).

### Key Entities *(include if feature involves data)*

- **Constitution standard**: the project's governing principles; the enforceable
  record produced/updated by the Constitution step.
- **Frameworks record**: the chosen technology frameworks and the derived
  determination of whether the project has a UI.
- **Security standard**: the project's security posture across authentication,
  authorization, data protection, and secrets handling; required for every
  project.
- **Design standard**: the enforceable UI/UX design system (design tokens,
  responsive rules, component conventions); exists only for UI projects.
- **Component library**: framework-native components carrying the approved design
  tokens, scaffolded on design approval.
- **Design mockup**: a resizable static HTML/CSS artifact used to obtain visual
  approval, including at mobile widths.
- **Standards-change history entry**: an auditable record of a standards
  amendment (what changed, and ideally why).
- **Compliance finding**: a reported instance where a change does or does not
  conform to a standard.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Starting from a project with no standards, a user can complete the
  onboarding flow and end with all required standards present (constitution,
  frameworks, security, and design when there is a UI) in a single guided
  session.
- **SC-002**: In 100% of cases where a required standard is missing, an attempt
  to make feature/source changes is blocked with a message naming the missing
  standard and the command to produce it.
- **SC-003**: For a UI project, the design step yields mockups the user can open
  and resize, and at least one recorded feedback-and-revise round occurs before
  approval; no final design standard is produced without explicit approval.
- **SC-004**: After design approval, a framework-native component library
  carrying the approved design tokens exists for the chosen framework, and a
  new UI feature can be built by composing from it rather than re-deriving
  styling.
- **SC-005**: 100% of standards amendments produce a tracked history entry, and
  no amendment silently violates a non-negotiable principle.
- **SC-006**: When incoming changes that violate a standard are pulled, the
  review reports the violation as findings in 100% of cases without blocking the
  pull.
- **SC-007**: A design approved in the workshop remains usable at mobile widths
  (no content overlap or loss) when re-checked, demonstrating the mobile-failure
  class of problems is caught before code.

## Assumptions

- The four standards are **project-level** artifacts established once by the
  onboarding command (and amended via the update command), distinct from the
  per-feature `spec.md`/`plan.md`/`tasks.md` cycle.
- Standards live alongside the existing constitution under the project's
  standards/memory location and are loaded into agent context each session.
- The existence gate is enforced by the template's existing pre-write guard,
  which performs decidable presence checks only; conformance judgment stays with
  the compliance review — consistent with the current architecture.
- The pull-time compliance review is delivered via a git hook (post-merge /
  post-checkout); non-git CI integration for this review is out of scope.
- "Determining whether there is a UI" is a heuristic based on the chosen
  frameworks plus an explicit user answer; the user can always override it.
- Producing mockups and evaluating responsiveness is done by generating static
  HTML/CSS the user opens in a real browser; pixel-perfect visual-regression
  testing is out of scope.
- The confirmed intent of record for this feature is `docs/intent/speckit-start.md`.

### Out of Scope

- Pixel-perfect visual-regression testing of designs.
- Enforcing standard **conformance** inside the pre-write guard (conformance
  stays with context loading + the compliance review).
- Non-git CI integration for the pull-time compliance review.
- Building the actual production UI/features of the adopting project (beyond the
  design-approval mockups and the initial component-library scaffold).
