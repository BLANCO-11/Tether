#!/usr/bin/env bash
# gate_test.sh - assertions for the standards EXISTENCE gate in
# scripts/spec-gate-core.sh. Covers the 10 cases in
# contracts/spec-gate-standards.contract.md.
#
# Run directly (bash tests/standards-gate/gate_test.sh) or via run.sh.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/fixtures.sh
. "$HERE/lib/fixtures.sh"

SRC="src/app.ts"   # a non-always-editable "source" path

# 1. absent manifest + valid feature -> allow
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 0 "$rc" "A1 absent manifest + valid feature -> allow"
cleanup_fixture "$r"

# 2. absent manifest + NO feature -> feature gate denies (unchanged)
r="$(new_fixture)"
out="$(run_gate "$r" write "$r/$SRC")"; rc=$?
assert_exit 2 "$rc" "A2 absent manifest + no feature -> feature gate denies"
assert_contains "$out" "spec-kit feature" "A2 message is the feature-gate reason"
cleanup_fixture "$r"

# 3. pending manifest + valid feature -> deny (standards), mentions /speckit-start
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
write_manifest "$r" pending null
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 2 "$rc" "A3 pending + valid feature -> deny"
assert_contains "$out" "/speckit-start" "A3 message names /speckit-start"
cleanup_fixture "$r"

# 4. established, all required present, has_ui=true + valid feature -> allow
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
write_manifest "$r" established true
add_standard_files "$r" constitution frameworks security design
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 0 "$rc" "A4 established all-present -> allow"
cleanup_fixture "$r"

# 5. established + security file removed -> deny naming security
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
write_manifest "$r" established true
add_standard_files "$r" constitution frameworks design   # no security
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 2 "$rc" "A5 established, security missing -> deny"
assert_contains "$out" "security" "A5 message names security"
cleanup_fixture "$r"

# 6. established + has_ui=true + design removed -> deny naming design
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
write_manifest "$r" established true
add_standard_files "$r" constitution frameworks security   # no design
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 2 "$rc" "A6 established, has_ui + design missing -> deny"
assert_contains "$out" "design" "A6 message names design"
cleanup_fixture "$r"

# 7. established + has_ui=false + design absent -> allow (design not required)
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
write_manifest "$r" established false
add_standard_files "$r" constitution frameworks security   # no design, not needed
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 0 "$rc" "A7 established, has_ui=false, no design -> allow"
cleanup_fixture "$r"

# 8. established + security missing BUT path always-editable -> allow
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
write_manifest "$r" established false
add_standard_files "$r" constitution frameworks   # security missing
out="$(run_gate "$r" write "$r/.specify/memory/notes.md" "$f")"; rc=$?
assert_exit 0 "$rc" "A8 always-editable path bypasses standards gate"
cleanup_fixture "$r"

# 9. malformed manifest + valid feature -> allow (fail-open)
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
printf '{ this is not json' >"$r/.specify/memory/standards.json"
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 0 "$rc" "A9 malformed manifest -> fail-open allow"
cleanup_fixture "$r"

# 10. .speckit-template-dev present + pending manifest -> allow (escape hatch)
r="$(new_fixture)"; f="$(add_valid_feature "$r")"
write_manifest "$r" pending null
touch "$r/.speckit-template-dev"
out="$(run_gate "$r" write "$r/$SRC" "$f")"; rc=$?
assert_exit 0 "$rc" "A10 .speckit-template-dev overrides -> allow"
cleanup_fixture "$r"

# --- summary ---
echo "gate_test: $TESTS_RUN checks, $TESTS_FAILED failed"
[ "$TESTS_FAILED" -eq 0 ]
