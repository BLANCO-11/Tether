#!/usr/bin/env bash
# check-standards-compliance.sh - READ-ONLY standards compliance review.
#
# Reviews incoming changes against the project's established standards and
# REPORTS findings. It never blocks, reverts, or modifies anything. The cheap,
# decidable checks live here (are required standards present? does the diff touch
# security-/UI-relevant paths?); the subjective conformance judgment is deferred
# to the agent-driven /speckit-comply, which this report points to.
#
# Usage:
#   check-standards-compliance.sh range <old> <new>   # review a diff range (git hooks)
#   check-standards-compliance.sh comply              # review the working tree (/speckit-comply)
#
# Testability: set STANDARDS_REVIEW_FILES to a whitespace-separated file list to
# bypass git and review that list directly.
#
# Exit codes:
#   range mode: ALWAYS 0 (read-only; must never fail a pull).
#   comply mode: 0 if no findings, 1 if findings (signals /speckit-comply).
# See contracts/pull-review.contract.md.

set -uo pipefail

MODE="${1:-}"
OLD="${2:-}"
NEW="${3:-}"

# --- Locate repo root --------------------------------------------------------
ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -z "$ROOT" ] && ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$ROOT" ]; then
    d="$(pwd)"
    while [ "$d" != "/" ]; do
        [ -d "$d/.specify" ] && ROOT="$d" && break
        d="$(dirname "$d")"
    done
fi
[ -z "$ROOT" ] && exit 0

# --- Short-circuits (silent) -------------------------------------------------
[ "${SPECKIT_ENFORCE:-1}" = "0" ] && exit 0
[ -f "$ROOT/.speckit-template-dev" ] && exit 0

# shellcheck source=spec-policy.sh
. "$ROOT/ci/spec-policy.sh" 2>/dev/null || exit 0

# Only review projects that have completed onboarding.
standards_manifest_exists "$ROOT" || exit 0
[ "$(standards_status "$ROOT")" = "established" ] || exit 0

is_range=false
[ "$MODE" = "range" ] && is_range=true

# --- Gather the changed file list -------------------------------------------
changed=""
if [ -n "${STANDARDS_REVIEW_FILES:-}" ]; then
    changed="$STANDARDS_REVIEW_FILES"
elif [ "$MODE" = "range" ] && [ -n "$OLD" ] && [ -n "$NEW" ]; then
    changed="$(git -C "$ROOT" diff --name-only "$OLD" "$NEW" 2>/dev/null || true)"
elif [ "$MODE" = "comply" ]; then
    changed="$(git -C "$ROOT" diff --name-only HEAD 2>/dev/null || true)"
fi

# --- Report helpers ----------------------------------------------------------
FINDINGS=0
have_output=false
say() { have_output=true; printf '%s\n' "$1"; }
finding() { # <severity> <message>
    FINDINGS=$((FINDINGS + 1))
    have_output=true
    printf '[%s] %s\n' "$1" "$2"
}

# --- Check 1: required standards present -------------------------------------
miss="$(first_missing_required_standard "$ROOT")"
if [ -n "$miss" ]; then
    finding HIGH "Required project standard missing: $miss ($(standard_path "$ROOT" "$miss")). Run /speckit-start to establish it."
fi

# --- Check 2: does the diff touch standard-relevant paths? -------------------
sec_hits=""
ui_hits=""
SEC_RE='(auth|login|logout|password|passwd|secret|token|credential|session|crypto|jwt|oauth|permission|role|acl)'
UI_RE='(\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$|/components?/|/pages?/|/views?/|/ui/)'
has_ui="$(standards_has_ui "$ROOT")"

for f in $changed; do
    printf '%s' "$f" | grep -Eiq "$SEC_RE" && sec_hits="$sec_hits $f"
    if [ "$has_ui" = "true" ]; then
        printf '%s' "$f" | grep -Eiq "$UI_RE" && ui_hits="$ui_hits $f"
    fi
done

if [ -n "$sec_hits" ]; then
    finding MEDIUM "Security-relevant changes detected:$sec_hits"
    say "    ↳ verify against .specify/memory/security.md"
fi
if [ -n "$ui_hits" ]; then
    finding MEDIUM "UI changes detected:$ui_hits"
    say "    ↳ verify against .specify/memory/design.md (tokens, responsive rules)"
fi

# --- Summary -----------------------------------------------------------------
if [ "$FINDINGS" -gt 0 ]; then
    say ""
    say "Standards review: $FINDINGS item(s) to check. Run /speckit-comply for the full conformance review."
elif [ -n "$changed" ]; then
    say "Standards review: clean (no standard-relevant changes detected)."
else
    say "Standards review: clean (no incoming changes)."
fi

# --- Exit --------------------------------------------------------------------
# range mode (git hooks) must never fail the pull; comply mode signals findings.
if $is_range; then
    exit 0
fi
[ "$FINDINGS" -eq 0 ]
