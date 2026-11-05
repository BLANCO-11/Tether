#!/usr/bin/env bash
# Gemini CLI BeforeTool hook adapter for scripts/spec-gate-core.sh.
#
# Wired in .gemini/settings.json (hooks -> BeforeTool). Protocol: tool-call
# JSON on stdin; exit 0 = allow, exit 2 = block (reason on stderr is shown
# to the model). Field names parsed defensively across Gemini CLI versions.

set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CORE="$ROOT/scripts/spec-gate-core.sh"
[ -x "$CORE" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

TOOL=$(jq -r '.tool_name // .toolName // .name // empty' <<<"$INPUT" 2>/dev/null)

CMD=$(jq -r '.tool_input.command // .toolInput.command // .args.command // empty' <<<"$INPUT" 2>/dev/null)
if [ -n "$CMD" ] && [ "$CMD" != "null" ]; then
    if ! REASON=$("$CORE" shell "$CMD"); then
        echo "$REASON" >&2
        exit 2
    fi
    exit 0
fi

case "$TOOL" in
write_file | replace | edit | WriteFile | Edit | "")
    TARGET=$(jq -r '.tool_input.file_path // .toolInput.file_path // .args.file_path // .tool_input.path // empty' <<<"$INPUT" 2>/dev/null)
    if [ -n "$TARGET" ] && [ "$TARGET" != "null" ]; then
        if ! REASON=$("$CORE" write "$TARGET"); then
            echo "$REASON" >&2
            exit 2
        fi
        CONTENT=$(jq -r '.tool_input.content // .toolInput.content // .args.content // .tool_input.new_string // empty' <<<"$INPUT" 2>/dev/null)
        if [ -n "$CONTENT" ] && [ "$CONTENT" != "null" ]; then
            if ! REASON=$(printf '%s' "$CONTENT" | "$CORE" content "$TARGET"); then
                echo "$REASON" >&2
                exit 2
            fi
        fi
    fi
    ;;
esac
exit 0
