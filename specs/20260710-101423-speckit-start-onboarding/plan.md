# Implementation Plan: `/speckit-start` Foundational-Standards Onboarding

**Branch**: `20260710-101423-speckit-start-onboarding` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260710-101423-speckit-start-onboarding/spec.md`

## Summary

Add a `/speckit-start` onboarding command that interviews the adopter to
establish four project-level standards — **Constitution**, **Frameworks**,
**Security**, and (only when there is a UI) **Design** — before feature code is
written, plus a `/speckit-update-standards` amendment command and a read-only
pull-time compliance review. Enforcement reuses the template's existing model:
the pre-write gate (`scripts/spec-gate-core.sh` + `ci/spec-policy.sh`) is
extended to hard-block source writes on standards **existence**; **conformance**
stays with context-loading and `/speckit-comply`. A machine-readable manifest
(`.specify/memory/standards.json`) is the decidable source of truth for the gate
(is-UI, established/pending, standard file paths). Delivered as new agent
skills (across all four agent surfaces), standards templates, gate/policy
edits, git hooks, and documentation.

## Technical Context

**Language/Version**: Bash (POSIX-leaning, targeting bash 4+); Markdown for
skills/templates/docs; JSON for the standards manifest; YAML for extension
config. No compiled runtime.

**Primary Dependencies**: `git`, `jq` (already required by `setup.sh` and the
existing hooks), coreutils/grep/sed. Agent runtimes (Claude Code, Codex,
Cursor, Gemini) that already consume the `speckit-*` skills.

**Storage**: Files under `.specify/memory/` (standards + manifest) and
`.specify/templates/` (standards templates). No database.

**Testing**: Shell-based tests using `bats-core` if available, with a plain-bash
fallback harness (`tests/standards-gate/*.sh`) that exercises
`spec-gate-core.sh` and `ci/check-standards-compliance.sh` against fixture
repos. (Resolved in research — the repo currently has no test framework.)

**Target Platform**: Developer workstations and CI (Linux/macOS); PowerShell
parity for the git extension is provided by mirroring any new bash helper in
the existing `.specify/extensions/git/scripts/powershell/` only where a
corresponding bash helper is added there. New gate logic lives in the
agent-neutral bash core, matching current design.

**Project Type**: Tooling / template meta-repo (single project; no
app frontend/backend split of its own — the "UI" it manages belongs to
*adopting* projects).

**Performance Goals**: Gate evaluation adds negligible latency to each agent
tool call (target < ~50ms overhead: a few file-existence checks + one small
`jq` read). Pull-time review completes in seconds on a normal diff.

**Constraints**: Must not weaken existing guarantees (spec-first workflow,
secrets hygiene). The pre-write gate must remain *fail-open* on its own errors
(never brick the agent) and must perform **only decidable existence checks** —
no code parsing. Must not self-block template development (bootstrapping — see
Constitution Check + research).

**Scale/Scope**: 2 new commands × 4 agent surfaces (Claude/Codex/Cursor as
`SKILL.md`, Gemini as `.toml`) = 8 command files; ~4 standards templates; gate +
policy edits in 2 files; 2 git hooks + 1 review script; `/speckit-comply`
update; `setup.sh` update; docs. Bounded, no open-ended growth.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Spec-First (NON-NEGOTIABLE)**: PASS — this change is going through
  `/speckit-specify → plan → tasks → implement` on a timestamp branch.
- **II. Test-First**: PASS with plan — new gate logic and the standards-review
  script get shell tests (fixtures for: manifest absent/pending/established;
  security missing; design missing when has_ui; always-editable bypass). Skill
  markdown (agent instructions) is not unit-testable; it is validated via the
  `quickstart.md` manual scenarios. Any source file shipped without an
  automated test (the skill `.md`/`.toml` files) is justified here as
  non-executable agent instructions.
- **III. Code Review + `/speckit-comply`**: PASS — `/speckit-comply` will be run
  before completion; CRITICAL findings resolved first.
- **IV. Simplicity (YAGNI)**: PASS with justification — the one non-trivial
  addition is the `standards.json` manifest + tri-state arming. Justified in
  Complexity Tracking: the gate must be *decidable* in bash without parsing
  markdown, and it must distinguish "template not yet onboarded" from "onboarded,
  standard missing." No new abstraction layers beyond that.
- **V. Observability**: PASS — every deny path prints a single actionable line
  naming the missing standard and the exact command to run (mirrors existing
  gate messages). The pull-time review prints a clear findings report.
- **VI. Branch/Delivery Discipline**: PASS — single timestamp branch = single
  `specs/` dir.
- **VII. Documentation Currency**: PASS with plan — AGENTS.md, CLAUDE.md,
  GEMINI.md, `.cursor/rules/team-rules.mdc`, `docs/TEAM-WORKFLOW.md`, and README
  are updated in this same feature.
- **VIII. Secrets Hygiene (NON-NEGOTIABLE)**: PASS — the Security step and
  `security.md` describe posture and reference env/secret-store variables only;
  they MUST NOT contain real credentials. Existing content scanner still
  applies to every write. `/speckit-update-standards` explicitly refuses
  amendments that would violate this article (FR-023).

**Result**: PASS (no unjustified violations). One justified complexity item
(manifest) recorded below.

## Project Structure

### Documentation (this feature)

```text
specs/20260710-101423-speckit-start-onboarding/
├── plan.md              # This file
├── research.md          # Phase 0 output — decisions & rationale
├── data-model.md        # Phase 1 — manifest schema + standards entities
├── quickstart.md        # Phase 1 — manual validation scenarios
├── contracts/           # Phase 1 — gate contract, manifest schema, hook contract
│   ├── standards-manifest.schema.json
│   ├── spec-gate-standards.contract.md
│   └── pull-review.contract.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
# New agent commands (always-editable skill dirs) — one per agent surface
.claude/skills/speckit-start/SKILL.md
.claude/skills/speckit-update-standards/SKILL.md
.agents/skills/speckit-start/SKILL.md
.agents/skills/speckit-update-standards/SKILL.md
.cursor/skills/speckit-start/SKILL.md
.cursor/skills/speckit-update-standards/SKILL.md
.gemini/commands/speckit.start.toml
.gemini/commands/speckit.update-standards.toml

# Standards templates + schema (always-editable .specify/)
.specify/templates/security-template.md
.specify/templates/design-template.md
.specify/templates/frameworks-template.md
.specify/templates/standards-manifest.schema.json

# Standards artifacts live here at runtime (created by /speckit-start in adopters)
#   .specify/memory/constitution.md   (already exists)
#   .specify/memory/security.md       (created by /speckit-start)
#   .specify/memory/design.md         (created by /speckit-start when has_ui)
#   .specify/memory/frameworks.md     (created by /speckit-start)
#   .specify/memory/standards.json    (manifest; arms the gate)

# Enforcement machinery (SOURCE — requires this feature to edit)
ci/spec-policy.sh                     # + standards-policy helpers (single source of truth)
scripts/spec-gate-core.sh            # + standards existence gate branch
ci/check-standards-compliance.sh     # NEW — read-only conformance review (used by hook + comply)
.githooks/post-merge                 # NEW — runs pull-time standards review
.githooks/post-checkout              # NEW — runs pull-time standards review
setup.sh                             # arm adopter manifest (pending) + chmod new hooks
.claude/skills/speckit-comply/SKILL.md   # + standards conformance section (×4 surfaces)

# Context-loading + docs
AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules/team-rules.mdc  # reference standards
docs/TEAM-WORKFLOW.md, README.md, docs/STANDARDS.md (NEW)

# Tests
tests/standards-gate/*.sh            # NEW — fixtures + assertions for the gate & review
```

**Structure Decision**: Single meta-repo, no new top-level source tree. New
capabilities are added into the existing enforcement layers and agent-skill
surfaces. The only genuinely new runtime data artifact is the standards
manifest under `.specify/memory/`. The four-surface duplication of skills
follows the repo's established convention (every `speckit-*` command already
exists in `.claude/`, `.agents/`, `.cursor/`, and `.gemini/`).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| `standards.json` manifest + tri-state arming (absent / pending / established) | The gate must be **decidable in bash without parsing markdown**, must know `has_ui`, and must distinguish "template not yet onboarded" (do not block template dev) from "onboarded but standard missing" (block). | Pure file-existence-only (no manifest) can't encode `has_ui` or the pending-vs-established distinction, so it would either fail to gate design or would self-block template development. Parsing markdown for a `has_ui:` line is non-decidable/brittle and violates the "no parsing in the gate" constraint. |
| Two git hooks (`post-merge` + `post-checkout`) rather than one | `git pull` (fast-forward and merge) fires `post-merge`; branch switches / clones fire `post-checkout`. Covering "new code arrives in the working copy" needs both. | A single `post-merge` misses branch-switch/checkout arrivals the user explicitly asked to catch. Both are thin wrappers over one shared review script, so duplication is minimal. |
