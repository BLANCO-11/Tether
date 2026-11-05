#!/usr/bin/env bash
# Full POC harness: context → (optional clarify demo) → control → optional Pi.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== build context (openredaction) =="
node scripts/build-context.mjs

echo "== clarify demo: simulate ask =="
node scripts/clarify.mjs simulate-ask
node scripts/clarify.mjs status || true
echo "== clarify demo: answer q1=customer_email =="
node scripts/clarify.mjs answer q1=customer_email
node scripts/clarify.mjs status

echo "== golden control =="
node scripts/run-control.mjs

if [[ "${SKIP_PI:-0}" == "1" ]]; then
  echo "== SKIP_PI=1 — not spawning Pi =="
  exit 0
fi

echo "== Pi spawn (see scripts/spawn-pi.sh) =="
bash scripts/spawn-pi.sh || true
