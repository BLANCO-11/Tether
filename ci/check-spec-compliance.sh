#!/usr/bin/env bash
# Layer-3 spec-compliance gate: the authoritative PR check.
# Run by azure-pipelines.yml on every PR targeting main; also runnable
# locally:  SOURCE_BRANCH=<branch> TARGET_BRANCH=main bash ci/check-spec-compliance.sh
#
# Gates:
#   0. hotfix/* and revert/* branches pass with a warning (backfill follow-up required)
#   1. branch name matches the spec-kit timestamp feature pattern
#   2. the PR touches (or the tree contains) a specs/<feature>/ dir with
#      spec.md + plan.md + tasks.md
#   3. every changed source file is referenced by a covering tasks.md

set -uo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
. "$ROOT/ci/spec-policy.sh"

BRANCH="${SOURCE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
BRANCH="${BRANCH#refs/heads/}"
TARGET="${TARGET_BRANCH:-$DEFAULT_BRANCH}"
TARGET="${TARGET#refs/heads/}"

FAILED=0
# Azure DevOps log annotations when running in a pipeline; plain text locally.
if [ -n "${TF_BUILD:-}" ]; then
    err()  { echo "##vso[task.logissue type=error]$1"; FAILED=1; }
    warn() { echo "##vso[task.logissue type=warning]$1"; }
else
    err()  { echo "ERROR: $1" >&2; FAILED=1; }
    warn() { echo "WARNING: $1" >&2; }
fi

# --- Gate 0: hotfix escape hatch ---------------------------------------------
if printf '%s' "$BRANCH" | grep -Eq "$HOTFIX_BRANCH_REGEX"; then
    warn "Hotfix/revert branch '$BRANCH': spec gate skipped. A follow-up /speckit-backfill PR is required within 2 working days (constitution article VI)."
    echo "Spec compliance: SKIPPED (hotfix)"
    exit 0
fi

# --- Gate 1: branch naming ----------------------------------------------------
if ! printf '%s' "$BRANCH" | grep -Eq "$FEATURE_BRANCH_REGEX"; then
    err "Branch '$BRANCH' does not match the feature pattern YYYYMMDD-HHMMSS-name. Create features with /speckit-specify (the git extension names the branch), or use hotfix/* for emergencies."
    exit 1
fi

# --- Compute the change set vs the merge base ----------------------------------
if ! git rev-parse --verify -q "origin/$TARGET" >/dev/null; then
    git fetch origin "$TARGET" >/dev/null 2>&1 || true
fi
BASE=$(git merge-base "origin/$TARGET" HEAD 2>/dev/null || git merge-base "$TARGET" HEAD 2>/dev/null || echo "")
if [ -z "$BASE" ]; then
    err "Cannot determine merge base with '$TARGET' (shallow clone? set fetchDepth: 0)."
    exit 1
fi
CHANGED=$(git diff --name-only --diff-filter=ACMRD "$BASE"..HEAD)

# --- Gate 2: feature dir(s) with complete artifacts ----------------------------
# The branch timestamp and the spec-dir timestamp are generated independently
# (seconds apart), so resolve feature dirs from the DIFF, not the branch name.
FEATURE_DIRS=$(printf '%s\n' "$CHANGED" | grep -E '^specs/[^/]+/' | cut -d/ -f1-2 | sort -u)
if [ -z "$FEATURE_DIRS" ]; then
    # Spec untouched in this PR - acceptable only if nothing outside the
    # allowlist changed (docs-only PRs).
    HAS_SOURCE=false
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        is_always_editable "$f" || { HAS_SOURCE=true; break; }
    done <<<"$CHANGED"
    if $HAS_SOURCE; then
        err "PR changes source files but touches nothing under specs/. Run /speckit-backfill to create/refresh the feature's spec, plan and tasks, and commit them in this PR."
        exit 1
    fi
    echo "Spec compliance: PASS (docs-only change)"
    exit 0
fi

for d in $FEATURE_DIRS; do
    for a in spec.md plan.md tasks.md; do
        [ -f "$d/$a" ] || err "Missing $d/$a - complete the spec-kit workflow (/speckit-specify, /speckit-plan, /speckit-tasks) before merging."
    done
done
[ "$FAILED" = "1" ] && exit 1

# --- Gate 3: source-file coverage in tasks.md -----------------------------------
ALL_TASKS=$(for d in $FEATURE_DIRS; do [ -f "$d/tasks.md" ] && cat "$d/tasks.md"; done)
UNCOVERED=0
while IFS= read -r f; do
    [ -z "$f" ] && continue
    is_always_editable "$f" && continue
    printf '%s' "$ALL_TASKS" | grep -qF "$f" && continue
    printf '%s' "$ALL_TASKS" | grep -qF "$(basename "$f")" && continue
    err "Changed file '$f' is not referenced by any covering tasks.md ($(echo "$FEATURE_DIRS" | tr '\n' ' ')). Run /speckit-backfill and commit the updated tasks."
    UNCOVERED=$((UNCOVERED + 1))
done <<<"$CHANGED"

if [ "$FAILED" = "1" ]; then
    echo "Spec compliance: FAIL ($UNCOVERED uncovered file(s))"
    exit 1
fi
echo "Spec compliance: PASS"
exit 0
