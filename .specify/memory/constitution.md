# Project Constitution

<!-- Starter constitution shipped with the team spec-kit template.
     Rename the title to your project on first run of /speckit-constitution.
     Amend via the governance procedure below - never by silent edit. -->

## Core Principles

### I. Spec-First Development (NON-NEGOTIABLE)

No source code changes without a spec-kit feature. Every change to source files
MUST be covered by a feature directory under `specs/` containing `spec.md`,
`plan.md` and `tasks.md`, produced by the spec-kit workflow
(`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`).
Manual or uncovered changes MUST be regularized with `/speckit-backfill` and
verified with `/speckit-comply` before merge. Enforced by agent hooks, the
pre-commit gate, and the CI compliance pipeline.

### II. Test-First

Every behavior change ships with tests. Changed source files without a
corresponding new or updated test MUST be justified in the feature's `plan.md`.
Acceptance scenarios in `spec.md` define what the tests must prove. Tests are
written before or alongside implementation, never deferred to a follow-up.

### III. Code Review

Every PR is reviewed by at least one human. `/speckit-comply` MUST be run
before requesting review, and CRITICAL findings resolved. The reviewer checks
the diff against the feature's spec and tasks, not just the code in isolation.

### IV. Simplicity

Start simple; YAGNI. New dependencies, new abstractions, and new architectural
layers require explicit justification in the feature's `plan.md` (Technical
Context). Prefer deleting code over adding it. Three similar lines beat one
premature abstraction.

### V. Observability

New failure paths MUST log actionable context (what failed, with what inputs,
what the user can do). User-facing errors MUST be diagnosable from logs alone.
Silent catch-and-continue is prohibited.

### VI. Branch and Delivery Discipline

One feature = one timestamp branch (`YYYYMMDD-HHMMSS-slug`) = one `specs/`
directory. Timestamp numbering is mandatory (prevents multi-developer
collisions). Emergency fixes use `hotfix/*` branches and MUST be followed by a
`/speckit-backfill` PR within 2 working days. PRs merge to `main` by squash
merge after the CI compliance gate passes.

### VII. Documentation Currency

`specs/` artifacts, `docs/`, and agent context files (AGENTS.md, CLAUDE.md,
GEMINI.md) are updated in the same PR as the behavior they describe. A merged
PR whose docs lag its code violates this constitution.

### VIII. Secrets Hygiene (NON-NEGOTIABLE)

Credentials never enter the repository. No hardcoded API keys, tokens,
passwords, connection strings or private keys in source, config, specs or
docs. Code reads secrets from environment variables or a secret store (e.g.
Azure Key Vault). Local values live in `.env` (gitignored); every variable is
documented as a placeholder in `.env.example` (committed). `.env` files, key
material (`*.pem`, `id_rsa`, ...) and state files containing secrets are never
committed - not even on `hotfix/*` branches. A leaked credential MUST be
rotated immediately and purged from git history before the branch is pushed
or merged. Enforced by agent content-scanning hooks, the pre-commit and
pre-push scanners, and the CI secret-scan step (which has no bypass).

## Enforcement

Three layers enforce Article I, in increasing authority:

1. **Agent hooks** (Claude Code, Codex, Cursor, Gemini CLI) deny source writes
   without an active, complete feature, and deny writing hardcoded secrets
   into tracked files (Article VIII). Guardrail only.
2. **Pre-commit gate** (`.githooks/pre-commit`) blocks non-compliant commits
   and staged secrets for any agent or human; **pre-push**
   (`.githooks/pre-push`) re-scans outgoing commits for secrets. Bypassable
   with `--no-verify` for hotfixes (spec gates only - never rely on this for
   secrets).
3. **CI compliance pipeline** (`ci/check-spec-compliance.sh` +
   `ci/check-secrets.sh`) blocks PR merge. Authoritative; the hotfix branch
   policy relaxes the spec gate but NOT the secret scan.

`SPECKIT_ENFORCE=0` disables layers 1-2 for human emergencies only. AI agents
MUST NOT set it or suggest setting it.

## Governance

This constitution supersedes all other development practices. Amendments are
made via `/speckit-constitution` in a normal spec-kit feature PR, reviewed like
any change. Versioning is semantic: MAJOR = principle removed or redefined,
MINOR = principle added or materially expanded, PATCH = wording clarification.
Compliance is verified per-PR by `/speckit-comply` and the CI gate.

**Version**: 1.1.0 | **Ratified**: 2026-07-10 | **Last Amended**: 2026-07-10
