#!/usr/bin/env bash
# review_test.sh - assertions for the read-only pull-time review script
# ci/check-standards-compliance.sh. Covers the 5 cases in
# contracts/pull-review.contract.md.
#
# Run directly (bash tests/standards-gate/review_test.sh) or via run.sh.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/fixtures.sh
. "$HERE/lib/fixtures.sh"

# 1. established + security-relevant incoming change -> findings/note, exit 0
r="$(new_fixture)"
write_manifest "$r" established true
add_standard_files "$r" constitution frameworks security design
out="$(run_review "$r" range "src/auth/login.ts")"; rc=$?
assert_exit 0 "$rc" "R1 established + security-relevant diff -> exit 0 (never blocks)"
assert_contains "$out" "speckit-comply" "R1 advises running /speckit-comply"
cleanup_fixture "$r"

# 2. established + clean (non-relevant) change -> 'clean', exit 0
r="$(new_fixture)"
write_manifest "$r" established false
add_standard_files "$r" constitution frameworks security
out="$(run_review "$r" range "docs/notes.md")"; rc=$?
assert_exit 0 "$rc" "R2 established + clean diff -> exit 0"
assert_contains "$out" "clean" "R2 reports clean"
cleanup_fixture "$r"

# 3a. manifest absent -> silent exit 0
r="$(new_fixture)"
out="$(run_review "$r" range "src/auth/login.ts")"; rc=$?
assert_exit 0 "$rc" "R3a absent manifest -> exit 0"
assert_contains "${out:-<empty>}" "" "R3a produces no findings"
[ -z "$out" ] && echo "  ok: R3a silent (no output)" || { echo "  FAIL: R3a expected silence, got: $out" >&2; TESTS_FAILED=$((TESTS_FAILED+1)); }
TESTS_RUN=$((TESTS_RUN+1))
cleanup_fixture "$r"

# 3b. pending manifest -> silent exit 0
r="$(new_fixture)"
write_manifest "$r" pending null
out="$(run_review "$r" range "src/auth/login.ts")"; rc=$?
assert_exit 0 "$rc" "R3b pending manifest -> exit 0"
[ -z "$out" ] && echo "  ok: R3b silent (no output)" || { echo "  FAIL: R3b expected silence, got: $out" >&2; TESTS_FAILED=$((TESTS_FAILED+1)); }
TESTS_RUN=$((TESTS_RUN+1))
cleanup_fixture "$r"

# 4. established but a required standard missing -> HIGH finding + /speckit-start
r="$(new_fixture)"
write_manifest "$r" established true
add_standard_files "$r" constitution frameworks design   # security missing
out="$(run_review "$r" range "src/x.ts")"; rc=$?
assert_exit 0 "$rc" "R4 missing required standard -> exit 0"
assert_contains "$out" "HIGH" "R4 emits a HIGH finding"
assert_contains "$out" "/speckit-start" "R4 advises /speckit-start"
cleanup_fixture "$r"

# 5. .speckit-template-dev present -> silent exit 0
r="$(new_fixture)"
write_manifest "$r" established true
add_standard_files "$r" constitution frameworks security design
touch "$r/.speckit-template-dev"
out="$(run_review "$r" range "src/auth/login.ts")"; rc=$?
assert_exit 0 "$rc" "R5 template-dev -> exit 0"
[ -z "$out" ] && echo "  ok: R5 silent (no output)" || { echo "  FAIL: R5 expected silence, got: $out" >&2; TESTS_FAILED=$((TESTS_FAILED+1)); }
TESTS_RUN=$((TESTS_RUN+1))
cleanup_fixture "$r"

echo "review_test: $TESTS_RUN checks, $TESTS_FAILED failed"
[ "$TESTS_FAILED" -eq 0 ]
