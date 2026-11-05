# Quickstart / Validation Guide: `/speckit-start` Onboarding

Runnable scenarios that prove the feature works end-to-end. These are the manual
+ scripted checks a reviewer runs before `/speckit-comply`. They reference the
[contracts](./contracts/) and [data-model](./data-model.md) rather than
duplicating them.

## Prerequisites

- Repo cloned; `bash setup.sh` run once (arms the adopter manifest to `pending`,
  installs git hooks via `core.hooksPath`).
- `git`, `jq` available (already required by the template).
- An agent surface (Claude Code / Codex / Cursor / Gemini) that loads the
  `speckit-*` skills.

## Scenario A — Fresh adopter is forced through onboarding (US1, US3)

1. In a freshly set-up adopter clone, confirm the manifest arms the gate:
   ```bash
   jq -r '.status' .specify/memory/standards.json   # → pending
   ```
2. Ask the agent to edit any source file (e.g. `src/app.ts`). **Expected**: the
   pre-write gate denies with a message naming `/speckit-start` (see
   [spec-gate-standards.contract.md](./contracts/spec-gate-standards.contract.md),
   pending row).
3. Run `/speckit-start`. Complete the four steps (see Scenario B/C).
4. Confirm:
   ```bash
   jq -r '.status, .has_ui' .specify/memory/standards.json   # → established, true|false
   ls .specify/memory/security.md                            # exists
   ```
5. Retry the source edit. **Expected**: allowed (existence satisfied).

**Pass**: step 2 blocks, step 5 allows.

## Scenario B — Onboarding a non-UI (backend) project (US1)

1. Run `/speckit-start`. In the Frameworks step, choose a non-UI framework
   (e.g. a CLI or API framework) or answer "no UI".
2. **Expected**: Constitution, Frameworks, Security steps run; Design step is
   **skipped**.
3. Confirm:
   ```bash
   jq -r '.has_ui' .specify/memory/standards.json     # → false
   test ! -e .specify/memory/design.md && echo "no design (correct)"
   jq -r '.standards.design.required' .specify/memory/standards.json  # → false
   ```
4. Editing source with `security.md` present is allowed; deleting `security.md`
   then editing source is **denied** naming `security`.

**Pass**: design skipped, security required and enforced.

## Scenario C — Design workshop for a UI project (US2)

1. Run `/speckit-start`; in Frameworks choose a UI framework (e.g. Next.js) or
   answer "yes UI". **Expected**: `has_ui` resolves to `true`.
2. At the Design step, pick a mode:
   - **Workshop mode**: answer the design interview.
   - **Reference mode**: give a reference ("clean modern", or a named app).
3. **Expected**: the agent produces static HTML/CSS mockups under
   `docs/design/mockups/`. Open them in a browser:
   ```bash
   ls docs/design/mockups/*.html
   ```
   Resize the window to a mobile width (~375px). **Expected**: no overlap / no
   lost content — otherwise the agent revises before asking for approval.
4. Provide at least one round of feedback; confirm the mockups are revised.
5. Approve explicitly. **Expected**: `design.md` is written and a
   framework-native component library + tokens are scaffolded for the chosen
   framework.
6. Confirm no `design.md` is produced if approval is withheld (try declining in
   a separate run).

**Pass**: mockups viewable + resizable, ≥1 revise round, approval gates
`design.md` + component scaffold (see [data-model](./data-model.md) entities 5-7).

## Scenario D — Amending standards with tracked history (US4)

1. With standards established, run `/speckit-update-standards` and request a
   change (e.g. "require MFA for admin logins").
2. **Expected**: the agent interviews for specifics, updates **only**
   `security.md`, and records history:
   ```bash
   jq -r '.revision, .last_amended' .specify/memory/standards.json  # revision bumped
   tail -n 20 .specify/memory/standards-history.md                   # new entry w/ what + why
   ```
3. Request a change that would violate a non-negotiable principle (e.g.
   "hardcode the API key in config"). **Expected**: refused/surfaced, not applied
   (constitution art. VIII; FR-023).

**Pass**: correct file updated, history entry added, violating change refused.

## Scenario E — Pull-time compliance review (US5)

1. On a branch, introduce a change that violates a standard, commit it.
2. From another checkout, `git pull` (or `git checkout` that branch).
   **Expected**: `post-merge` / `post-checkout` runs
   `ci/check-standards-compliance.sh`, prints findings, and the pull **completes**
   (exit 0) — see [pull-review.contract.md](./contracts/pull-review.contract.md).
3. Pull a clean change. **Expected**: prints "clean", exits 0.

**Pass**: violation reported without blocking; clean pull reports clean.

## Scenario F — Automated gate tests

```bash
bash tests/standards-gate/run.sh
```

**Expected**: all assertions pass — the arming matrix from
[spec-gate-standards.contract.md](./contracts/spec-gate-standards.contract.md)
(§ Test assertions) and the pull-review assertions from
[pull-review.contract.md](./contracts/pull-review.contract.md).

## Scenario G — Template development is not self-blocked (bootstrapping)

In this template repo (no `standards.json`):

```bash
test ! -e .specify/memory/standards.json && echo "manifest absent → gate inactive"
```

**Expected**: standards gate is inactive; only the normal spec gate applies, so
this very feature can be implemented without a kill-switch file (research R2).

## Multi-agent parity check

Confirm both commands exist on every surface:

```bash
ls .claude/skills/speckit-start/SKILL.md .agents/skills/speckit-start/SKILL.md \
   .cursor/skills/speckit-start/SKILL.md .gemini/commands/speckit.start.toml
ls .claude/skills/speckit-update-standards/SKILL.md .gemini/commands/speckit.update-standards.toml
```

**Pass**: all files present (research R9).
