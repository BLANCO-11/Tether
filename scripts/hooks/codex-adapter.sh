#!/usr/bin/env bash
# OpenAI Codex CLI hook adapter for scripts/spec-gate-core.sh.
#
# Wire as a preToolUse / rule hook in Codex's hooks configuration (see
# setup.sh, which merges the SPECKIT-MANAGED block into ~/.codex/config.toml
# when the codex CLI is detected; Codex reads hooks from user-level config).
#
# Protocol: hook event JSON on stdin. Codex fires before shell commands and
# apply_patch operations. Deny = exit 2 (also prints a permissionDecision
# JSON for hook variants that consume structured output).
# Field names are parsed defensively - Codex releases have shifted between
# tool_input/arguments/params naming.

set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CORE="$ROOT/scripts/spec-gate-core.sh"
[ -x "$CORE" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

deny() {
    jq -n --arg r "$1" '{permissionDecision:"deny", reason:$r}'
    echo "$1" >&2
    exit 2
}

# Shell command (exec / local_shell / shell tool)
CMD=$(jq -r '.tool_input.command // .arguments.command // .params.command // .command // empty' <<<"$INPUT" 2>/dev/null)
if [ -n "$CMD" ] && [ "$CMD" != "null" ]; then
    if ! REASON=$("$CORE" shell "$CMD"); then deny "$REASON"; fi
    exit 0
fi

# File write (apply_patch / write_file style tools) - check every path mentioned
PATHS=$(jq -r '[.tool_input.file_path?, .arguments.file_path?, .params.file_path?,
                .tool_input.path?, .arguments.path?, .params.path?,
                ((.tool_input.changes // .arguments.changes // {}) | keys?)]
               | flatten | map(select(. != null and . != "")) | .[]' <<<"$INPUT" 2>/dev/null)
if [ -n "$PATHS" ]; then
    while IFS= read -r p; do
        [ -z "$p" ] && continue
        if ! REASON=$("$CORE" write "$p"); then deny "$REASON"; fi
    done <<<"$PATHS"
fi

# Content scan: apply_patch bodies / file contents, whatever this Codex
# version provides. Label with the first path (exemptions are per-file, so
# multi-file patches touching .env should go file-by-file - kept simple here).
CONTENT=$(jq -r '.tool_input.patch // .arguments.patch // .params.patch // .tool_input.content // .arguments.content // empty' <<<"$INPUT" 2>/dev/null)
if [ -n "$CONTENT" ] && [ "$CONTENT" != "null" ]; then
    FIRST_PATH=$(printf '%s\n' "$PATHS" | head -1)
    if ! REASON=$(printf '%s' "$CONTENT" | "$CORE" content "${FIRST_PATH:-patch}"); then deny "$REASON"; fi
fi
exit 0
