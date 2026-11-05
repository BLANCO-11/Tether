#!/usr/bin/env bash
# Cursor hook adapter for scripts/spec-gate-core.sh.
#
# Wired in .cursor/hooks.json for beforeFileEdit and beforeShellExecution.
# Protocol: event JSON on stdin; respond {"permission":"allow"|"deny"} on
# stdout (exit 2 also treated as deny by current Cursor releases).
#
# CAVEAT (documented in docs/TEAM-WORKFLOW.md): Cursor allow-list rules can
# take precedence over hook deny responses in some versions. The commit-time
# and CI gates remain authoritative.

set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CORE="$ROOT/scripts/spec-gate-core.sh"
[ -x "$CORE" ] || { echo '{"permission":"allow"}'; exit 0; }
command -v jq >/dev/null 2>&1 || { echo '{"permission":"allow"}'; exit 0; }

INPUT=$(cat)

allow() { echo '{"permission":"allow"}'; exit 0; }
deny() {
    jq -n --arg r "$1" '{permission:"deny", userMessage:$r, agentMessage:$r}'
    exit 2
}

CMD=$(jq -r '.command // .tool_input.command // empty' <<<"$INPUT" 2>/dev/null)
if [ -n "$CMD" ] && [ "$CMD" != "null" ]; then
    if ! REASON=$("$CORE" shell "$CMD"); then deny "$REASON"; fi
    allow
fi

TARGET=$(jq -r '.file_path // .filePath // .tool_input.file_path // empty' <<<"$INPUT" 2>/dev/null)
if [ -n "$TARGET" ] && [ "$TARGET" != "null" ]; then
    if ! REASON=$("$CORE" write "$TARGET"); then deny "$REASON"; fi
    CONTENT=$(jq -r '[.content?, .new_string?, ((.edits // []) | map(.text? // .new_string? // "") | join("\n"))] | map(select(. != null and . != "")) | join("\n")' <<<"$INPUT" 2>/dev/null)
    if [ -n "$CONTENT" ]; then
        if ! REASON=$(printf '%s' "$CONTENT" | "$CORE" content "$TARGET"); then deny "$REASON"; fi
    fi
fi
allow
