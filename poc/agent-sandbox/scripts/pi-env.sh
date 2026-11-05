# shellcheck shell=bash
# Source from other scripts after load-llm-env.sh
ROOT_PI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_PI/scripts/load-llm-env.sh"
PI_BIN="${PI_BIN:-}"
if [[ -z "$PI_BIN" ]]; then
  if command -v pi >/dev/null 2>&1; then PI_BIN="$(command -v pi)"
  elif [[ -x /Users/himanshu/.local/node/bin/pi ]]; then PI_BIN=/Users/himanshu/.local/node/bin/pi
  else echo "pi not found" >&2; return 1 2>/dev/null || exit 1
  fi
fi
export PI_BIN
export PI_PROVIDER="${PI_PROVIDER:-litellm}"
export PI_MODEL="${PI_MODEL:-gpt-6-luna}"
export PI_EXT="$ROOT_PI/pi-extensions/luna-tools-compat.js"
