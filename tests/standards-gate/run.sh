#!/usr/bin/env bash
# run.sh - runner for the standards-gate test suite.
#
# Prefers bats-core if installed; otherwise runs the plain-bash *_test.sh
# assertion scripts directly. Exit non-zero if any assertion fails.
#
# Usage: bash tests/standards-gate/run.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v bats >/dev/null 2>&1 && ls "$HERE"/*.bats >/dev/null 2>&1; then
    exec bats "$HERE"/*.bats
fi

# Plain-bash fallback: each *_test.sh prints its own results and exits non-zero
# on failure. Aggregate.
rc=0
shopt -s nullglob
for t in "$HERE"/*_test.sh; do
    echo "=== ${t##*/} ==="
    if bash "$t"; then
        echo "--- ${t##*/}: PASS"
    else
        echo "--- ${t##*/}: FAIL"
        rc=1
    fi
    echo
done

if [ "$rc" -eq 0 ]; then
    echo "ALL STANDARDS-GATE TESTS PASSED"
else
    echo "SOME STANDARDS-GATE TESTS FAILED" >&2
fi
exit "$rc"
