---

description: "Task list for /speckit-start foundational-standards onboarding"
---

# Tasks: `/speckit-start` Foundational-Standards Onboarding

**Input**: Design documents from `specs/20260710-101423-speckit-start-onboarding/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included for the executable bash logic (the existence gate and the
pull-time review script) per Constitution Article II. Agent-instruction files
(`SKILL.md` / `.toml`) are validated via `quickstart.md` scenarios, not unit
tests.

**Organization**: Grouped by user story. Priority order: US1 (P1) → US3 (P1) →
US2 (P2) → US4 (P2) → US5 (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1..US5 (setup/foundational/polish carry no story label)
- All paths are repo-relative.

## Path Conventions

This is a tooling/template meta-repo. "Source" = enforcement machinery
(`scripts/`, `ci/`, `.githooks/`, `setup.sh`). "Always-editable" =
`.specify/**`, agent skill dirs, `docs/**`, `*.md`. Agent commands are
duplicated across four surfaces: `.claude/skills/`, `.agents/skills/`,
`.cursor/skills/` (as `SKILL.md`) and `.gemini/commands/` (as `.toml`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffolding needed before any standard or gate work.

- [X] T001 [P] Create the standards test harness skeleton: `tests/standards-gate/run.sh` (dispatches to `bats-core` if present, else runs `*_test.sh` plain-bash assertion scripts) plus `tests/standards-gate/lib/fixtures.sh` (helpers to build throwaway fixture repos in temp dirs)
- [X] T002 [P] Copy the manifest JSON Schema to a template: `.specify/templates/standards-manifest.schema.json` (from `specs/.../contracts/standards-manifest.schema.json`)
- [X] T003 [P] Add `docs/design/mockups/` to `.gitignore` note as a scratch/approval area (keep mockups out of enforced source paths)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The policy helpers, templates, and manifest contract that every
user story depends on.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete.

- [X] T004 Add standards policy helpers to `ci/spec-policy.sh` (single source of truth, definitions only, no side effects): `STANDARDS_MANIFEST` path const; `standards_status()` and `standards_has_ui()` (read `.specify/memory/standards.json` via `jq`, tolerate absent/malformed → empty); `standard_required <key>` resolver (security=always; design=has_ui; constitution/frameworks=always); `standard_path <key>`
- [X] T005 [P] Create the Security standard template `.specify/templates/security-template.md` with the minimum sections from data-model §4 (authn, authz, data protection, secrets management referencing env/secret-store, dependency posture, threat notes) — no real credentials
- [X] T006 [P] Create the Design standard template `.specify/templates/design-template.md` with sections from data-model §5 (tokens, breakpoints/responsive rules, layout, component inventory, accessibility baseline, chosen mode/reference)
- [X] T007 [P] Create the Frameworks record template `.specify/templates/frameworks-template.md` with chosen-frameworks list + explicit "Has UI: yes/no + how decided" statement (data-model §3)

**Checkpoint**: Policy helpers + templates ready — commands and gate can build.

---

## Phase 3: User Story 1 - Establish foundational standards (Priority: P1) 🎯 MVP

**Goal**: `/speckit-start` interviews the user through Constitution → Frameworks
→ Security → (UI?) and writes the standards + manifest; adopters are armed to
`pending` on setup so they must run it.

**Independent Test**: Run `/speckit-start` in a fixture project; confirm
constitution/frameworks/security (+design if UI) files and a `status:established`
manifest are produced; a non-UI run skips design. (quickstart Scenarios A, B.)

### Implementation for User Story 1

- [X] T008 [US1] Author `.claude/skills/speckit-start/SKILL.md`: frontmatter (`name: speckit-start`, user-invocable) + the four-step orchestration (Constitution, Frameworks incl. UI-determination heuristic + explicit-ask fallback, Security always, Design conditional on `has_ui`); write/refresh `.specify/memory/{constitution,frameworks,security,design}.md` from the Phase-2 templates; write/update `.specify/memory/standards.json` per the schema (set `status`, `has_ui`, per-standard records, `created`, `revision:1`); resume-safe re-run (report missing, never clobber); explicit-approval gate before finalizing design (design depth deferred to US2)
- [X] T009 [P] [US1] Mirror the skill to `.agents/skills/speckit-start/SKILL.md`
- [X] T010 [P] [US1] Mirror the skill to `.cursor/skills/speckit-start/SKILL.md`
- [X] T011 [P] [US1] Create the Gemini variant `.gemini/commands/speckit.start.toml` (dotted name, TOML prompt mirroring the SKILL.md flow)
- [X] T012 [US1] Update `setup.sh` to arm adopters: if `.specify/memory/standards.json` is absent AND `.speckit-template-dev` is absent, write a `status:pending` manifest (has_ui:null) via a heredoc/jq; MUST NOT overwrite an existing manifest; echo a note telling the user to run `/speckit-start`
- [X] T013 [US1] Wire session context-loading: reference the standards files from `AGENTS.md` (so `@AGENTS.md` in `CLAUDE.md` pulls them in) and add equivalent references in `GEMINI.md` and `.cursor/rules/team-rules.mdc`
- [X] T014 [P] [US1] Add `docs/STANDARDS.md` explaining the four standards, the manifest, the arming states, and the `/speckit-start` flow

**Checkpoint**: `/speckit-start` produces all standards + manifest; adopters are armed. MVP complete.

---

## Phase 4: User Story 3 - Enforcement of standards (Priority: P1)

**Goal**: The pre-write gate hard-blocks source writes on standards **existence**
(security always; design iff `has_ui`), independent of and prior to the feature
gate; conformance is deferred. Standards load into context (done in T013).

**Independent Test**: `tests/standards-gate/run.sh` passes the full arming
matrix; a fixture with `pending`/missing-standard blocks a source write and
names `/speckit-start`; always-editable paths and malformed manifest stay
allowed. (quickstart Scenario A, F; contract test assertions 1-10.)

### Tests for User Story 3 (write first, must fail before T016)

- [X] T015 [US3] Write `tests/standards-gate/gate_test.sh` covering the 10 assertions in `contracts/spec-gate-standards.contract.md` (absent→allow; pending→deny; established all-present→allow; security removed→deny; has_ui+design removed→deny; has_ui=false+no design→allow; always-editable bypass; malformed→fail-open; `.speckit-template-dev`→allow; feature-gate-only path unchanged)

### Implementation for User Story 3

- [X] T016 [US3] Extend `scripts/spec-gate-core.sh`: after the existing short-circuits and before/independent of the feature-gate decision, evaluate the standards existence gate for `write` and `shell` modes using the T004 helpers — respect all existing short-circuits (`SPECKIT_ENFORCE=0`, `.speckit-template-dev`, `is_always_editable`, absent manifest → inactive), deny with a single-line message naming the missing standard (or pending) + `/speckit-start`, and fail open on any internal error (missing jq / unreadable manifest)
- [X] T017 [US3] Run `tests/standards-gate/run.sh`; confirm all gate assertions pass; adjust helpers/gate until green

**Checkpoint**: Standards existence is enforced; template repo (no manifest) still builds.

---

## Phase 5: User Story 2 - Design workshop with visual approval (Priority: P2)

**Goal**: For UI projects, the Design step runs as a two-mode workshop producing
resizable HTML/CSS mockups, a feedback→revise loop, explicit approval, then
`design.md` + a framework-native component/token scaffold.

**Independent Test**: Run the design step in each mode on a UI fixture; mockups
appear under `docs/design/mockups/` and resize without overlap; ≥1 revise round;
approval yields `design.md` + tokens/components; withholding approval yields no
`design.md`. (quickstart Scenario C.)

### Implementation for User Story 2

- [X] T018 [US2] Expand the Design step in `.claude/skills/speckit-start/SKILL.md`: two modes (full workshop interview / reference-vibe), generation of standalone resizable HTML/CSS mockups into `docs/design/mockups/`, guidance to verify mobile widths (375/768/1280; use `browser-testing-with-devtools` when available), mandatory feedback→revise loop, explicit-approval gate, then emit `design.md` from the template with approved tokens and scaffold a framework-native token module + primitive components for the chosen framework (per research R4/R5)
- [X] T019 [P] [US2] Propagate the expanded Design step into `.agents/skills/speckit-start/SKILL.md` and `.cursor/skills/speckit-start/SKILL.md`
- [X] T020 [P] [US2] Propagate the expanded Design step into `.gemini/commands/speckit.start.toml`
- [X] T021 [P] [US2] Add `docs/design/README.md` documenting the mockup/approval convention and where scaffolded tokens/components land per framework

**Checkpoint**: UI projects get a mobile-verified, approved design system + component scaffold.

---

## Phase 6: User Story 4 - Amend standards with tracked history (Priority: P2)

**Goal**: `/speckit-update-standards` interviews for a change, updates only the
relevant standard file(s), records history, bumps the manifest revision, and
refuses non-negotiable violations.

**Independent Test**: Run the command on an established fixture; requested change
updates the right file, `standards-history.md` gains an entry, manifest
`revision`/`last_amended` update; a secrets-hardcoding request is refused.
(quickstart Scenario D.)

### Implementation for User Story 4

- [X] T022 [US4] Author `.claude/skills/speckit-update-standards/SKILL.md`: interview for the desired change; edit only the relevant `.specify/memory/*.md` standard(s); append a structured entry to `.specify/memory/standards-history.md` (date, standard(s), what, why, new revision); bump `revision` + set `last_amended` in `standards.json`; if `has_ui` changes, update `standards.design.required`; REFUSE/surface amendments conflicting with a non-negotiable principle (e.g. secrets hygiene, constitution art. VIII) per FR-023
- [X] T023 [P] [US4] Mirror to `.agents/skills/speckit-update-standards/SKILL.md`
- [X] T024 [P] [US4] Mirror to `.cursor/skills/speckit-update-standards/SKILL.md`
- [X] T025 [P] [US4] Create `.gemini/commands/speckit.update-standards.toml`

**Checkpoint**: Standards are amendable with an auditable trail and guardrails.

---

## Phase 7: User Story 5 - Pull-time compliance review (Priority: P3)

**Goal**: On pull/checkout, a read-only review reports whether incoming changes
comply with current standards; never blocks the pull. `/speckit-comply` gains a
standards-conformance pass.

**Independent Test**: `tests/standards-gate/run.sh` review assertions pass;
pulling a violating diff prints findings and exits 0; clean diff prints clean;
absent/pending manifest → silent. (quickstart Scenario E; pull-review contract.)

### Tests for User Story 5 (write first, must fail before T027)

- [X] T026 [US5] Write `tests/standards-gate/review_test.sh` covering the 5 assertions in `contracts/pull-review.contract.md` (established+violating diff→findings+exit0; clean→clean+exit0; absent/pending→silent exit0; missing required standard→HIGH finding; `.speckit-template-dev`→silent)

### Implementation for User Story 5

- [X] T027 [US5] Create `ci/check-standards-compliance.sh` (read-only) with `range <old> <new>` and `comply` modes: short-circuit unless manifest `status=established` (and honor `SPECKIT_ENFORCE=0`/`.speckit-template-dev`); confirm required standards exist (HIGH finding + `/speckit-start` advice if missing); flag security/UI-relevant touched paths; print severity-tagged findings + a prompt to run `/speckit-comply`; hooks path always exits 0 (reuse `ci/spec-policy.sh` helpers)
- [X] T028 [P] [US5] Create `.githooks/post-merge` — thin wrapper computing the merged range and calling `ci/check-standards-compliance.sh range …`, always exit 0
- [X] T029 [P] [US5] Create `.githooks/post-checkout` — thin wrapper over the checkout range calling the same script, always exit 0
- [X] T030 [US5] Update `setup.sh` chmod line to include the new `.githooks/*` and `ci/*.sh` (verify `core.hooksPath` already picks them up) and any new scripts are executable
- [X] T031 [US5] Extend `/speckit-comply` to run a standards-conformance pass (load `security.md`/`design.md` + diff, emit findings) across all four surfaces: `.claude/skills/speckit-comply/SKILL.md`, `.agents/…`, `.cursor/…`, `.gemini/commands/speckit.comply.toml`
- [X] T032 [US5] Run `tests/standards-gate/run.sh`; confirm review assertions pass

**Checkpoint**: New code arriving via pull/checkout is reviewed read-only; comply covers conformance.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T033 [P] Update `docs/TEAM-WORKFLOW.md`: add the onboarding/standards lifecycle (`/speckit-start`, `/speckit-update-standards`, pull-time review) and the arming states
- [X] T034 [P] Update `README.md` to mention the mandatory `/speckit-start` onboarding step for adopters
- [X] T035 [P] Update `AGENTS.md` (and mirror the summary in `CLAUDE.md` if needed) with a team rule: adopters MUST run `/speckit-start` before source work; standards changes go through `/speckit-update-standards`
- [X] T036 Run the full `quickstart.md` (Scenarios A–G + parity check) against a fixture; fix any gaps
- [X] T037 Run `/speckit-comply` for this feature and resolve any CRITICAL findings before completion

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; **blocks all user stories** (T004 helpers + templates are used everywhere).
- **US1 (Phase 3)**: depends on Foundational. MVP.
- **US3 (Phase 4)**: depends on Foundational (T004) and reads manifests produced by US1; gate tests use fixtures so US3 is testable independently, but land US1 first for a coherent MVP.
- **US2 (Phase 5)**: depends on US1 (extends the `speckit-start` skill's Design step) + T006 design template.
- **US4 (Phase 6)**: depends on Foundational + manifest shape (US1); independent of US2/US3/US5.
- **US5 (Phase 7)**: depends on Foundational (T004) + standards existing (US1); `/speckit-comply` update is additive.
- **Polish (Phase 8)**: after the desired stories.

### Within Each User Story

- Tests (US3, US5) written first and must fail before implementation.
- Policy helpers (T004) before the gate (T016) and the review (T027).
- The `.claude` skill is authored first, then mirrored to the other three surfaces.

### Parallel Opportunities

- Setup: T001, T002, T003 in parallel.
- Foundational: T005, T006, T007 in parallel (T004 is the one blocker).
- US1: after T008, the mirrors T009/T010/T011 run in parallel; T014 (docs) parallel.
- US2: T019, T020, T021 parallel after T018.
- US4: T023, T024, T025 parallel after T022.
- US5: T028, T029 parallel after T027; T031 surfaces parallelizable.
- Polish: T033, T034, T035 parallel.

---

## Parallel Example: User Story 1

```bash
# After T008 (the .claude SKILL.md) is written, mirror to the other surfaces together:
Task: "Mirror speckit-start to .agents/skills/speckit-start/SKILL.md"
Task: "Mirror speckit-start to .cursor/skills/speckit-start/SKILL.md"
Task: "Create .gemini/commands/speckit.start.toml"
Task: "Add docs/STANDARDS.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1.
4. **STOP & VALIDATE**: run quickstart Scenarios A + B (onboarding produces standards; adopter armed).
5. This is the demoable MVP: adopters are guided to establish standards.

### Incremental Delivery

1. Setup + Foundational → ready.
2. US1 → onboarding works → demo (MVP).
3. US3 → enforcement bites → demo.
4. US2 → design workshop → demo.
5. US4 → amendments → demo.
6. US5 → pull-time review + comply conformance → demo.

### Bootstrapping note

This template repo has **no `standards.json`**, so the standards gate stays
inactive during implementation (research R2) — no kill-switch file is needed and
none will be created. The feature's own spec+plan+tasks satisfy the existing
feature gate, authorizing edits to the enforcement source in `scripts/`, `ci/`,
`.githooks/`, and `setup.sh`.

---

## Notes

- [P] = different files, no incomplete-task dependency.
- Every source (executable) change to `scripts/`/`ci/`/`.githooks/`/`setup.sh`
  is covered by a shell test or a quickstart scenario (Article II).
- Standards files and manifests MUST NOT contain real credentials (Article VIII);
  the existing content scanner still runs on every write.
- Commit after each task or logical group.
