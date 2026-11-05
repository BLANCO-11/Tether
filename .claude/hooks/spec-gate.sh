#!/usr/bin/env bash
# Claude Code PreToolUse adapter for scripts/spec-gate-core.sh.
# Wired in .claude/settings.json for Edit|Write|NotebookEdit|Bash.
#
# Protocol: stdin JSON {tool_name, tool_input:{file_path|notebook_path|command}}.
# Deny = exit 2 with the reason on stderr (fed back to the model), which is
# more reliable than the JSON permissionDecision form across tool types.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CORE="$ROOT/scripts/spec-gate-core.sh"
[ -x "$CORE" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0   # fail open; setup.sh requires jq

INPUT=$(cat)
TOOL=$(jq -r '.tool_name // empty' <<<"$INPUT")

case "$TOOL" in
Edit | Write | NotebookEdit)
    TARGET=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$INPUT")
    [ -z "$TARGET" ] && exit 0
    if ! REASON=$("$CORE" write "$TARGET"); then
        echo "$REASON" >&2
        exit 2
    fi
    CONTENT=$(jq -r '.tool_input.content // .tool_input.new_string // .tool_input.new_source // empty' <<<"$INPUT")
    if [ -n "$CONTENT" ]; then
        if ! REASON=$(printf '%s' "$CONTENT" | "$CORE" content "$TARGET"); then
            echo "$REASON" >&2
            exit 2
        fi
    fi
    ;;
Bash)
    CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")
    [ -z "$CMD" ] && exit 0
    if ! REASON=$("$CORE" shell "$CMD"); then
        echo "$REASON" >&2
        exit 2
    fi
    ;;
esac
exit 0
