#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="$ROOT/sandbox"
RESULTS="$ROOT/RESULTS.md"
PI_BIN="${PI_BIN:-}"
# shellcheck disable=SC1091
source "$ROOT/scripts/load-llm-env.sh"

if [[ -z "$PI_BIN" ]]; then
  if command -v pi >/dev/null 2>&1; then
    PI_BIN="$(command -v pi)"
  elif [[ -x /Users/himanshu/.local/node/bin/pi ]]; then
    PI_BIN=/Users/himanshu/.local/node/bin/pi
  else
    echo "pi not found; set PI_BIN" >&2
    exit 1
  fi
fi

if [[ -z "${LITELLM_API_KEY:-}" || -z "${LITELLM_BASE_URL:-}" ]]; then
  echo "LITELLM_API_KEY and LITELLM_BASE_URL must be set (mapped from LLM_* in load-llm-env.sh)" >&2
  exit 1
fi

MODEL="${PI_MODEL:-gpt-6-luna}"
MODEL_ID="${MODEL##*/}"
export LITELLM_OFFLINE="${LITELLM_OFFLINE:-1}"

echo "Using PI_BIN=$PI_BIN"
echo "Using provider=litellm model=$MODEL_ID"
echo "LITELLM_BASE_URL host: $(printf '%s' "$LITELLM_BASE_URL" | sed -E 's#(https?://[^/]+).*#\1#')"

node "$ROOT/scripts/build-context.mjs"
printf '%s\n' '{"status":"idle","questions":[]}' > "$SANDBOX/questions.json"

START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT_FILE="$SANDBOX/pi-last-run.log"
set +e
(
  cd "$SANDBOX"
  "$PI_BIN" --print --no-session --thinking off \
    --provider litellm \
    --model "$MODEL_ID" \
    --append-system-prompt "$SANDBOX/SYSTEM.md" \
    "Read GOAL.md and context/README.md and context/schema.json. The goal is ambiguous about customer_email vs billing_email. Write questions.json with status open asking which column to use for notification to (choices: customer_email, billing_email). Do not invent. STOP after writing questions.json — do not edit workflow yet."
) >"$OUT_FILE" 2>&1
CODE=$?
set -e
END_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

{
  echo ""
  echo "## Pi spawn — $START_TS"
  echo ""
  echo "- PI_BIN: \`$PI_BIN\`"
  echo "- provider: litellm / model: $MODEL_ID"
  echo "- env: LLM_* → LITELLM_* via load-llm-env.sh; pi-provider-litellm; LITELLM_OFFLINE=$LITELLM_OFFLINE"
  echo "- note: gpt-6-luna needs reasoning_effort=none with tools on chat/completions (plugin hook forces it)"
  echo "- started: $START_TS / ended: $END_TS"
  echo "- exit: $CODE"
  echo "- log: sandbox/pi-last-run.log"
  echo "- tail: $(tail -n 5 "$OUT_FILE" | tr '\n' ' | ')"
  echo ""
} >> "$RESULTS"

echo "Pi exit=$CODE"
tail -n 30 "$OUT_FILE" || true
echo "--- questions.json ---"
cat "$SANDBOX/questions.json"
exit "$CODE"
