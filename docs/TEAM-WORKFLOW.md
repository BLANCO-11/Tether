# Team Workflow: Enforced Spec-Driven Development

How multiple developers work on this repo with spec-kit and AI coding agents
(Claude Code, Codex CLI, Cursor, Gemini CLI).

## The rule

**Every source-code change is covered by a spec-kit feature**: a directory
`specs/<YYYYMMDD-HHMMSS-slug>/` containing `spec.md`, `plan.md` and `tasks.md`.
The constitution (`.specify/memory/constitution.md`) makes this NON-NEGOTIABLE;
three enforcement layers back it up (see below).

## First: establish the project's standards (once)

Before any feature work, a new project runs **`/speckit-start`** to establish
its foundational standards through a guided interview:

1. **Constitution** — governing principles
2. **Frameworks** — the stack, and whether the project has a UI
3. **Security** — the security posture (every project, even backend-only)
4. **Design** — the UI/UX design system (UI projects only; a mockup-driven
   workshop that also scaffolds a component library)

`setup.sh` arms the standards gate to `pending`, so **source writes are blocked
until `/speckit-start` establishes the required standards** (security always;
design when there's a UI). Change a standard later with
**`/speckit-update-standards`** (tracked history; never a silent edit). When you
pull new changes, `post-merge`/`post-checkout` run a read-only standards review.
Full details: [STANDARDS.md](STANDARDS.md).

## Daily loop (one feature)

```
git checkout main && git pull
<start your agent: claude / codex / cursor / gemini>
/speckit-specify  "Describe the feature"     # creates timestamp branch + specs dir
/speckit-clarify                             # optional but recommended
/speckit-plan     "Tech context, constraints"
/speckit-tasks
/speckit-analyze                             # artifact consistency (optional)
/speckit-implement                           # now source edits are allowed
/speckit-comply                              # code-vs-constitution check
git push -u origin <branch>                  # open PR to main
```

> Gemini CLI uses dot separators (`/speckit.specify`); Codex invokes skills as
> `$speckit-specify`.

The branch is created automatically by the spec-kit **git extension** during
`/speckit-specify` (hook `before_specify`). Don't create feature branches by
hand.

## Why multiple developers never collide

- Feature branches and spec directories use **timestamp numbering**
  (`20260710-153001-user-auth`), configured in `.specify/init-options.json`
  and `.specify/extensions/git/git-config.yml`. Two developers can start
  features at the same time with zero coordination - no `004-` collisions.
- Each feature adds its own directory under `specs/`, so merges to `main`
  never conflict there. A conflict inside one `specs/<feature>/` dir means two
  people edited the SAME feature - which is exactly when you should talk.
- `.specify/feature.json` (the local "active feature" pointer written by
  spec-kit) is **gitignored** - it is per-developer state and must never merge.
- Note: the branch timestamp and the spec-dir timestamp are generated
  independently and usually differ by a few seconds. That's expected; tooling
  resolves the feature from `feature.json` / the PR diff, not by name-matching
  the branch.

### Picking up a colleague's feature

```
git fetch && git checkout 20260710-153001-user-auth
export SPECIFY_FEATURE_DIRECTORY=specs/<their-spec-dir>   # once, or let the
                                                          # next spec-kit command
                                                          # rewrite feature.json
```

Then continue with `/speckit-implement` etc. as usual.

### Rebase and merge policy

- Rebase your feature branch on `main` before opening the PR:
  `git fetch && git rebase origin/main`. Spec dirs rebase cleanly by
  construction.
- PRs merge to `main` by **squash merge** (set in ADO branch policy) so
  `specs/` history stays linear.

## Enforcement layers (and their honest limits)

| Layer | Where | Blocks | Limits |
|-------|-------|--------|--------|
| 1. Agent hooks | Claude `PreToolUse`, Codex hooks, Cursor `beforeFileEdit`/`beforeShellExecution`, Gemini `BeforeTool` - all delegating to `scripts/spec-gate-core.sh` | Source writes and mutating shell commands when no complete feature is active | Guardrail for agents; a determined actor can escape shell heuristics. Cursor allow-list rules may override hook denies in some versions. |
| 2. Pre-commit | `.githooks/pre-commit` (via `git config core.hooksPath .githooks`, set by `setup.sh`) | Commits with uncovered source changes, wrong branch names, missing artifacts | Bypassable with `git commit --no-verify` (intended for hotfixes) |
| 3. CI gate | `ci/check-spec-compliance.sh` in `azure-pipelines.yml` | PR merge to `main` | Authoritative. Only `hotfix/*` / `revert/*` branches skip it (with a warning) |

All three layers read the same policy file, `ci/spec-policy.sh` (branch regex +
always-editable allowlist), so they can't drift apart.

`SPECKIT_ENFORCE=0` disables layers 1-2 for human emergencies. It is visible in
shell history and code review; agents are instructed never to set it.

Agents not in the list above (Copilot, others) are still covered by layers 2-3.

## Manual changes / no spec? Backfill.

If code was changed outside the workflow (human edit, emergency fix, pre-gate
history):

1. Run `/speckit-backfill` - it reverse-engineers `spec.md`, `plan.md` and
   `tasks.md` from the actual diff (tasks marked `[X]` retroactively, inferred
   intent flagged `[BACKFILLED - verify with author]`). It only writes under
   `specs/`, so it always runs even while the gates are blocking source edits.
2. Review the `[BACKFILLED]` markers.
3. Run `/speckit-analyze` (artifacts consistent?) and `/speckit-comply`
   (does the CODE honor the constitution? every file covered by a task? tests
   present?).
4. Commit the `specs/` updates in the same branch/PR as the code.

## Secrets protection

Constitution article VIII: credentials never enter the repo. Four layers:

| Layer | What it catches |
|-------|-----------------|
| Agent hooks (`spec-gate-core.sh content` via `ci/check-secrets.sh`) | An agent about to WRITE a hardcoded key into a tracked file - denied with instructions to use env vars. Writing real values into `.env` is allowed (that's where they belong). |
| `.githooks/pre-commit` | Staged `.env`/key files and secret-looking added lines. Runs on EVERY branch, including `hotfix/*`, and on allowlisted paths too. |
| `.githooks/pre-push` | Secrets in outgoing commits - catches `--no-verify` commits and pre-hook history. |
| CI secret-scan step (`azure-pipelines.yml`) | Authoritative. No hotfix exemption, no bypass. |

Ground rules:

- Code reads secrets from **environment variables** or **Azure Key Vault** -
  never literals.
- Local values live in `.env` (gitignored). Every variable gets a placeholder
  line in `.env.example` (committed).
- Blocked on a false positive? Reword the line (e.g. mark it `example`) or
  extend `is_placeholder_line` in `ci/secret-policy.sh` via a normal PR.
- **If a real credential was committed**: rotate it immediately (assume it is
  compromised), then purge it from history (`git commit --amend` /
  `git rebase -i` before pushing; `git filter-repo` + force-push coordination
  if it already reached the remote). Deleting the file in a new commit is NOT
  enough.
- Optional extra coverage: install [gitleaks](https://github.com/gitleaks/gitleaks)
  and run `gitleaks git` locally; the bundled bash scanner stays authoritative
  so CI never depends on an optional tool.

## Hotfixes

- Branch `hotfix/<short-desc>` from `main`, fix, PR. The CI gate passes with a
  warning; the pre-commit gate steps aside.
- Within **2 working days**, run `/speckit-backfill` on a follow-up branch to
  regularize the fix (constitution article VI).

## Onboarding a new developer

1. Install prerequisites:
   - `git`, `jq` (required by the gates): `sudo apt install jq` / `brew install jq`
   - [uv](https://docs.astral.sh/uv/): `curl -LsSf https://astral.sh/uv/install.sh | sh`
   - At least one agent CLI: Claude Code, Codex CLI, Cursor, or Gemini CLI
2. Clone the repo and run `./setup.sh` (installs the git hooks path, verifies
   tools, wires agent hook configs that live outside the repo).
3. Read `.specify/memory/constitution.md` and this file.
4. Start your agent and run your first `/speckit-specify`.

## Azure DevOps branch policy (admin, once per repo)

1. Pipelines → New pipeline → this repo → Existing YAML → `/azure-pipelines.yml`
   (PR validation for `main`; `trigger: none`, `pr: main`).
2. Repeat with `/azure-pipelines.prod.yml` — the production pipeline: fires on
   pushes to `prod` only (`batch: true`, `pr: none`), runs the secret/plugin
   gates plus install → typecheck → build → tests → compose validation, every
   step blocking (no `continueOnError`). It is inert until a `prod` branch
   exists. Staging is verified on a separate local VM and is wired to neither
   pipeline.
3. Project Settings → Repositories → *this repo* → Policies → Branch Policies
   on `main`:
   - **Build Validation**: add the pipeline, *Required*, trigger *Automatic*.
   - **Minimum number of reviewers**: 1 (constitution article III).
   - **Limit merge types**: Squash merge only.

## Upgrading spec-kit

Template-owned modifications are marked `TEMPLATE-PATCH` or live outside
`.specify/` (in `scripts/`, `ci/`, `.githooks/`). After
`specify integration upgrade` or extension updates, re-check:

- `.specify/init-options.json` → `"feature_numbering": "timestamp"`
- `.specify/extensions/git/git-config.yml` → `branch_numbering: timestamp`
- The custom skills (`speckit-backfill`, `speckit-comply`) still present in
  all four agent directories.
