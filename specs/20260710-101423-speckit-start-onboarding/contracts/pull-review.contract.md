# Contract: Pull-Time Standards Compliance Review

Behavioral contract for `ci/check-standards-compliance.sh` and its git-hook
wrappers `.githooks/post-merge` and `.githooks/post-checkout`. **Read-only** —
it reports findings and never blocks or reverts (FR-025).

## Components

- `ci/check-standards-compliance.sh` — shared review script. Modes:
  - `range <old> <new>` — review the diff between two commits (hook use).
  - `comply` — review the working tree / feature diff (invoked by `/speckit-comply`).
- `.githooks/post-merge` — fires after `git pull` / `git merge`. Computes the
  merged range and calls the script in `range` mode.
- `.githooks/post-checkout` — fires after `git checkout` / clone with a
  branch change. Calls the script in `range` mode over the checkout range.

## Preconditions / short-circuits

1. Not a spec-kit project, or `.specify/memory/standards.json` absent, or
   `status != established` → **exit 0 silently** (nothing to review against).
2. `SPECKIT_ENFORCE=0` or `.speckit-template-dev` present → exit 0.
3. Empty diff range (no incoming changes) → print "clean" and exit 0.

## Behavior (bash layer — fast, decidable)

For the incoming diff the script:

1. Confirms required standards exist (security always; design if `has_ui`);
   if a required standard is **missing**, prints a HIGH finding advising
   `/speckit-start`.
2. Flags whether the diff touches security-relevant or UI-relevant paths (so the
   developer knows a conformance review is warranted).
3. Prints a summary and, when changes warrant judgment, a prompt to run
   `/speckit-comply` for the full agent-driven conformance review (R7).

The bash layer performs **no content conformance judgment** — that is the
agent's job via `/speckit-comply`.

## Output

- Human-readable report to stdout. In CI (`TF_BUILD` set) it MAY emit Azure
  DevOps log annotations like the existing scripts, but the pull-time hook path
  is informational.
- **Always exits 0** from the hook wrappers (read-only; a non-zero from the
  script must never fail the pull). The `comply` mode MAY return non-zero to
  signal findings to `/speckit-comply`, but hooks call it such that the pull is
  never aborted.

## Findings format (shared with `/speckit-comply`)

```text
[SEVERITY] <standard>:<section> — <file>:<loc>
    <description>
    ↳ remediation: <suggestion>
```

Severities: CRITICAL, HIGH, MEDIUM, LOW.

## Non-goals

- MUST NOT block, revert, reset, or modify the working tree.
- MUST NOT require network access.
- MUST NOT run for projects that have not completed onboarding
  (`status != established`).

## Test assertions (see tests/standards-gate/)

1. established manifest + incoming diff violating security posture → review runs,
   prints findings, exits 0 (pull not blocked).
2. established manifest + clean diff → prints "clean", exits 0.
3. manifest absent / pending → hook exits 0 silently (no review).
4. required standard missing → HIGH finding advising `/speckit-start`, exit 0.
5. `.speckit-template-dev` present → exit 0 silently.
