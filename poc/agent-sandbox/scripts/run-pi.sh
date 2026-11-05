#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/pi-env.sh"
PROMPT="${1:?prompt required}"
LOG="${2:-$ROOT/sandbox/pi-run.log}"
cd "$ROOT/sandbox"
"$PI_BIN" --print --no-session --thinking off \
  -e "$PI_EXT" \
  --provider "$PI_PROVIDER" --model "$PI_MODEL" \
  --append-system-prompt "$ROOT/sandbox/SYSTEM.md" \
  "$PROMPT" >"$LOG" 2>&1
tail -n 40 "$LOG"
