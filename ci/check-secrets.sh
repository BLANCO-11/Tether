#!/usr/bin/env bash
# Secret scanner used by every enforcement layer.
#
# Usage:
#   check-secrets.sh staged                # staged files + added lines (pre-commit)
#   check-secrets.sh range <git-range>     # committed diff, e.g. abc123..HEAD (pre-push, CI)
#   check-secrets.sh stdin <path>          # content on stdin (agent pre-write hooks)
#
# Exit codes: 0 = clean, 1 = secrets found (details on stderr).
#
# High-signal regex scanner with zero dependencies beyond git+grep. For
# deeper coverage, gitleaks can be run IN ADDITION (see docs/TEAM-WORKFLOW.md);
# this scanner stays authoritative so CI never depends on an optional tool.

set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
. "$ROOT/ci/secret-policy.sh"

MODE="${1:-}"
FOUND=0

if [ -n "${TF_BUILD:-}" ]; then
    report() { echo "##vso[task.logissue type=error]$1"; FOUND=1; }
else
    report() { echo "SECRET-BLOCK: $1" >&2; FOUND=1; }
fi

# The 11 content patterns as ONE alternation, built once.
#
# ⚠ WHY THIS IS NOT A LOOP ANY MORE. This function used to be `scan_line`, which
# spawned `printf | grep` PER PATTERN, PER LINE — 2,915 processes for a 265-line
# diff. Measured on an EDR-hooked host (Cisco Secure Endpoint inspects every
# exec, so a spawn costs ~62ms instead of ~2ms): **363,684 ms**. The identical
# work as one pass: **159 ms**.
#
# That is not only a speed problem. A commit that prints nothing for six minutes
# looks broken; it was reported as "stuck", interrupted twice, and diagnosed as a
# block when it was not one. A gate people believe is hanging is a gate people
# bypass, so the slowness was itself eroding Article VIII.
ALL_PATTERNS="$(
    printf '%s|' "${SECRET_CONTENT_PATTERNS[@]}"
)"
ALL_PATTERNS="${ALL_PATTERNS%|}"

# Read `<path>\001<text>` candidate lines on stdin, report the ones that match a
# content pattern and are not placeholders.
#
# ⚠ \001 is the delimiter because it cannot appear in a path and is vanishingly
# unlikely in source. Only the prefix before the FIRST delimiter is the path, so
# a line whose own content carries \001 is still attributed correctly.
# ⚠ `grep -a` is DEFENSIVE AND CURRENTLY UNREACHABLE, and saying so is the point.
# Without it, a NUL byte in the stream makes grep treat it as binary and print
# nothing at all — the match is found and thrown away, which reads as a clean
# scan. But MEASURED 2026-08-28: neither path can deliver a NUL here. bash's
# `read` drops NULs before grep sees them, and `git diff` reports a NUL-carrying
# file as "Binary files ... differ" with no `+` lines. A `\001` on its own does
# NOT trigger grep's binary heuristic. So the flag is kept for a future caller
# that streams raw bytes, and a perturbation test removing it does NOT fail —
# do not write a test that claims otherwise.
#
# ⚠ A REAL BOUND FALLS OUT OF THAT: content inside a file git considers BINARY is
# never content-scanned, because git emits no added lines for it. The name rules
# still apply. Out of scope here; recorded so its absence is a known limit rather
# than an assumed capability.
# ⚠ TAKES THE MATCHES AS AN ARGUMENT rather than reading a pipe, so it runs in
# the CURRENT shell. `... | scan_candidates` puts it in a subshell, where
# `report`'s `FOUND=1` never reaches `exit "$FOUND"` - the scan finds the secret,
# prints SECRET-BLOCK, and exits 0. That was written for real during this change
# and only the planted-secret tests caught it. Never turn this back into a pipe.
scan_matches() { # $1 = matched `<path>\001<text>` lines, newline separated
    local m rel text
    [ -z "$1" ] && return 0
    while IFS= read -r m; do
        [ -z "$m" ] && continue
        rel="${m%%$'\001'*}"
        text="${m#*$'\001'}"
        is_placeholder_line "$text" && continue
        report "possible hardcoded secret in '$rel'. Use an environment variable or a secret store; local values belong in .env (gitignored), documented as a placeholder in .env.example."
    done <<< "$1"
}

# Emit `<path>\001<text>` for every ADDED line in a diff, using only builtins.
#
# ⚠ THIS IS A TOP-LEVEL FUNCTION AND MUST STAY ONE. macOS ships bash 3.2.57,
# which CANNOT PARSE a `case` statement inside `<( )` or `$( )` - it dies with
# "syntax error near unexpected token ';;'". Inlining this loop into a
# substitution at the call site is therefore not a refactor, it is a syntax
# error on the platform this repository is developed on.
#
# ⚠ TWO PATH-PARSING BUGS ARE FIXED HERE, BOTH FOUND BY A TEST RATHER THAN BY
# READING. Each silently skipped content, which is the one failure mode a secret
# scanner must not have:
#
#  1. GIT APPENDS A TRAILING TAB to `+++ b/<path>` when the path contains a
#     space. The old parser kept it, so `odd dir/.env.local.example` arrived as
#     `...example<TAB>`, stopped matching `*.example`, was classified FORBIDDEN,
#     and forbidden files are content-exempt - so a planted key was never
#     scanned. Strip at the first tab.
#  2. GIT QUOTES paths containing non-ASCII bytes (`+++ "b/pa\303\251th"`), which
#     does not match `+++ b/*` at all, so every line of such a file was skipped.
#     `-c core.quotePath=false` turns that off.
#
# ⚠ The exemption check is per-HEADER, not per-line: same answer, one call per
# file. It must stay BEFORE the candidate is emitted, or exempt files reach the
# matcher.
emit_diff_candidates() { # $@ = git diff args
    local file="" line
    while IFS= read -r line; do
        case "$line" in
        +++\ b/*)
            file="${line#+++ b/}"
            file="${file%%$'\t'*}"
            is_secret_scan_exempt "$file" && file=""
            ;;
        +++*) file="" ;;
        +*)
            [ -n "$file" ] || continue
            printf '%s\001%s\n' "$file" "${line#+}"
            ;;
        esac
    done < <(git -C "$ROOT" -c core.quotePath=false diff --no-color -U0 --diff-filter=ACMR "$@")
}

# Same, for a single labelled blob on stdin.
emit_stdin_candidates() { # $1 = label
    local line
    # `|| [ -n "$line" ]` keeps the final line when stdin lacks a trailing newline
    while IFS= read -r line || [ -n "$line" ]; do
        printf '%s\001%s\n' "$1" "$line"
    done
}

check_names() { # $@ = git diff args for --name-only
    local f
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if is_forbidden_secret_file "$f"; then
            report "forbidden secret file '$f' must never be committed. Keep it local (.gitignore already covers it) and provide a placeholder in .env.example instead."
        fi
    done < <(git -C "$ROOT" diff --name-only --diff-filter=ACMR "$@")
}

check_diff() { # $@ = git diff args; scans only ADDED lines, tracking the file
    scan_matches "$(emit_diff_candidates "$@" | grep -a -E "$ALL_PATTERNS")"
}

case "$MODE" in
staged)
    check_names --cached
    check_diff --cached
    ;;
range)
    RANGE="${2:?usage: check-secrets.sh range <git-range>}"
    check_names "$RANGE"
    check_diff "$RANGE"
    ;;
stdin)
    LABEL="${2:-unknown}"
    case "$LABEL" in "$ROOT"/*) LABEL="${LABEL#"$ROOT"/}" ;; esac
    # Writing secrets to .env & friends locally is the CORRECT pattern; the
    # commit/push/CI layers keep those files out of git.
    is_secret_scan_exempt "$LABEL" && exit 0
    # Same single pass as check_diff. This mode runs on EVERY agent file write via
    # scripts/spec-gate-core.sh, so the old per-line loop taxed each one.
    scan_matches "$(emit_stdin_candidates "$LABEL" | grep -a -E "$ALL_PATTERNS")"
    ;;
*)
    echo "usage: check-secrets.sh staged | range <git-range> | stdin <path>" >&2
    exit 64
    ;;
esac

exit "$FOUND"
