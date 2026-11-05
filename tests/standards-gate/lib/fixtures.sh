#!/usr/bin/env bash
# fixtures.sh - helpers for building throwaway fixture repos for the
# standards-gate and pull-review tests. Sourced by the *_test.sh scripts.
#
# A fixture is a temp dir that looks enough like a spec-kit project for
# scripts/spec-gate-core.sh and ci/check-standards-compliance.sh to run
# against it: it has a .specify/ dir, a copy of ci/spec-policy.sh, and
# (optionally) a standards manifest + standard files.

set -uo pipefail

# Absolute path to the real repo root (where this test lib lives).
FIXTURES_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Create a fresh fixture repo. Echoes the fixture root path.
# Copies the real ci/spec-policy.sh and scripts/spec-gate-core.sh so the
# gate-under-test is exercised, not a stale copy.
new_fixture() {
    local root
    root="$(mktemp -d "${TMPDIR:-/tmp}/stdgate.XXXXXX")"
    mkdir -p "$root/.specify/memory" "$root/ci" "$root/scripts"
    cp "$FIXTURES_REPO_ROOT/ci/spec-policy.sh" "$root/ci/spec-policy.sh"
    cp "$FIXTURES_REPO_ROOT/scripts/spec-gate-core.sh" "$root/scripts/spec-gate-core.sh"
    # A minimal secrets checker stub is not needed for gate (write/shell) tests;
    # copy the real one if present so 'content' mode still works.
    [ -f "$FIXTURES_REPO_ROOT/ci/check-secrets.sh" ] && \
        cp "$FIXTURES_REPO_ROOT/ci/check-secrets.sh" "$root/ci/check-secrets.sh"
    [ -f "$FIXTURES_REPO_ROOT/ci/check-standards-compliance.sh" ] && \
        cp "$FIXTURES_REPO_ROOT/ci/check-standards-compliance.sh" "$root/ci/check-standards-compliance.sh"
    chmod +x "$root/scripts/spec-gate-core.sh" 2>/dev/null || true
    printf '%s\n' "$root"
}

# Write a standards manifest into a fixture.
#   write_manifest <root> <status> <has_ui: true|false|null> [design_required: true|false]
write_manifest() {
    local root="$1" status="$2" has_ui="$3" design_req="${4:-}"
    if [ -z "$design_req" ]; then
        case "$has_ui" in true) design_req=true ;; *) design_req=false ;; esac
    fi
    cat >"$root/.specify/memory/standards.json" <<JSON
{
  "schema_version": 1,
  "status": "$status",
  "has_ui": $has_ui,
  "standards": {
    "constitution": { "path": ".specify/memory/constitution.md", "required": true, "present": true },
    "frameworks":   { "path": ".specify/memory/frameworks.md",   "required": true, "present": true },
    "security":     { "path": ".specify/memory/security.md",     "required": true, "present": true },
    "design":       { "path": ".specify/memory/design.md",       "required": $design_req, "present": $design_req }
  },
  "revision": 1,
  "created": "2026-07-10"
}
JSON
}

# Create the standard files that a manifest references.
#   add_standard_files <root> <keys...>   e.g. add_standard_files "$r" constitution frameworks security design
add_standard_files() {
    local root="$1"; shift
    local k
    for k in "$@"; do
        case "$k" in
            constitution) echo "# Constitution" >"$root/.specify/memory/constitution.md" ;;
            frameworks)   echo "# Frameworks" >"$root/.specify/memory/frameworks.md" ;;
            security)     echo "# Security" >"$root/.specify/memory/security.md" ;;
            design)       echo "# Design" >"$root/.specify/memory/design.md" ;;
        esac
    done
}

# Create a COMPLETE spec-kit feature inside a fixture so the existing feature
# gate is satisfied. Echoes the repo-relative feature dir. This lets tests
# isolate the STANDARDS gate: with the feature gate satisfied, any deny must
# come from the standards gate (and any allow proves standards passed too).
add_valid_feature() {
    local root="$1" name="${2:-20260101-000000-fixture}"
    mkdir -p "$root/specs/$name"
    echo "# spec" >"$root/specs/$name/spec.md"
    echo "# plan" >"$root/specs/$name/plan.md"
    echo "# tasks" >"$root/specs/$name/tasks.md"
    printf 'specs/%s' "$name"
}

# Run the gate under test inside a fixture. Echoes combined stdout; returns exit code.
#   run_gate <root> <mode> <arg> [feature_rel]
# If feature_rel is given, SPECIFY_FEATURE_DIRECTORY is exported so the feature
# gate is satisfied and only the standards gate is under test.
run_gate() {
    local root="$1" mode="$2" arg="$3" feature_rel="${4:-}"
    ( cd "$root" \
        && CLAUDE_PROJECT_DIR="$root" SPECKIT_ENFORCE=1 \
           SPECIFY_FEATURE_DIRECTORY="$feature_rel" \
           bash "$root/scripts/spec-gate-core.sh" "$mode" "$arg" )
}

# --- Tiny assertion helpers -------------------------------------------------
TESTS_RUN=0
TESTS_FAILED=0

# assert_exit <expected_code> <actual_code> <message>
assert_exit() {
    TESTS_RUN=$((TESTS_RUN + 1))
    if [ "$1" != "$2" ]; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        printf '  FAIL: %s (expected exit %s, got %s)\n' "$3" "$1" "$2" >&2
        return 1
    fi
    printf '  ok: %s\n' "$3"
}

# assert_contains <haystack> <needle> <message>
assert_contains() {
    TESTS_RUN=$((TESTS_RUN + 1))
    case "$1" in
        *"$2"*) printf '  ok: %s\n' "$3" ;;
        *)
            TESTS_FAILED=$((TESTS_FAILED + 1))
            printf '  FAIL: %s (missing %q)\n' "$3" "$2" >&2
            return 1
            ;;
    esac
}

# Run the pull-time review script inside a fixture. Injects the changed-file
# list via STANDARDS_REVIEW_FILES so tests don't need real git commits.
#   run_review <root> <mode> [file ...]
run_review() {
    local root="$1" mode="$2"; shift 2
    local files="$*"
    ( cd "$root" \
        && CLAUDE_PROJECT_DIR="$root" SPECKIT_ENFORCE=1 \
           STANDARDS_REVIEW_FILES="$files" \
           bash "$root/ci/check-standards-compliance.sh" "$mode" X Y )
}

cleanup_fixture() { [ -n "${1:-}" ] && rm -rf "$1"; }
