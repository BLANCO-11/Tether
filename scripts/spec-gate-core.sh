#!/usr/bin/env bash
# spec-gate-core.sh - agent-neutral spec-driven-development gate.
#
# Every AI-agent hook adapter (.claude/hooks/spec-gate.sh, scripts/hooks/*.sh)
# delegates here so all agents enforce identical policy.
#
# Usage:
#   spec-gate-core.sh write <path>             # a file is about to be written
#   spec-gate-core.sh shell <command-string>   # a shell command is about to run
#   spec-gate-core.sh content <path>           # file content on stdin: secret scan
#
# Exit codes:
#   0 - allow (silent)
#   2 - deny; single-line reason on stdout (adapter formats it for its agent)
#
# Deny is a guardrail for agents, not a security boundary. The commit-time
# gate (.githooks/pre-commit) and the CI gate (ci/check-spec-compliance.sh)
# are the authoritative checks. See docs/TEAM-WORKFLOW.md.

set -uo pipefail

MODE="${1:-}"
ARG="${2:-}"

# --- Locate repo root (works from any cwd the agent uses) -------------------
ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
    ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi
if [ -z "$ROOT" ]; then
    d="$(pwd)"
    while [ "$d" != "/" ]; do
        [ -d "$d/.specify" ] && ROOT="$d" && break
        d="$(dirname "$d")"
    done
fi
[ -z "$ROOT" ] && exit 0   # not inside a spec-kit project: nothing to enforce

# --- Kill switches -----------------------------------------------------------
# SPECKIT_ENFORCE=0        documented human emergency override
# .speckit-template-dev    present only while the template itself is developed
[ "${SPECKIT_ENFORCE:-1}" = "0" ] && exit 0
[ -f "$ROOT/.speckit-template-dev" ] && exit 0

# shellcheck source=../ci/spec-policy.sh
if ! . "$ROOT/ci/spec-policy.sh" 2>/dev/null; then
    exit 0   # policy file missing: fail open rather than brick the agent
fi

deny() {
    printf '%s\n' "$1"
    exit 2
}

# --- Resolve the active feature ---------------------------------------------
# Priority mirrors spec-kit's own resolution:
#   1. SPECIFY_FEATURE_DIRECTORY env  2. SPECIFY_FEATURE env
#   3. .specify/feature.json          4. current branch name matching specs/<branch>
FEATURE_DIR=""
if [ -n "${SPECIFY_FEATURE_DIRECTORY:-}" ]; then
    FEATURE_DIR="$SPECIFY_FEATURE_DIRECTORY"
    case "$FEATURE_DIR" in /*) : ;; *) FEATURE_DIR="$ROOT/$FEATURE_DIR" ;; esac
elif [ -n "${SPECIFY_FEATURE:-}" ]; then
    FEATURE_DIR="$ROOT/specs/$SPECIFY_FEATURE"
elif [ -f "$ROOT/.specify/feature.json" ]; then
    fd=""
    if command -v jq >/dev/null 2>&1; then
        fd=$(jq -r '.feature_directory // empty' "$ROOT/.specify/feature.json" 2>/dev/null)
    else
        fd=$(grep -o '"feature_directory"[[:space:]]*:[[:space:]]*"[^"]*"' \
                 "$ROOT/.specify/feature.json" 2>/dev/null \
             | head -1 | sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/')
    fi
    if [ -n "$fd" ]; then
        case "$fd" in /*) FEATURE_DIR="$fd" ;; *) FEATURE_DIR="$ROOT/$fd" ;; esac
    fi
fi
if [ -z "$FEATURE_DIR" ]; then
    branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [ -n "$branch" ] && printf '%s' "$branch" | grep -Eq "$FEATURE_BRANCH_REGEX"; then
        [ -d "$ROOT/specs/$branch" ] && FEATURE_DIR="$ROOT/specs/$branch"
    fi
fi

# --- Evaluate the gate --------------------------------------------------------
GATE_OK=false
GATE_REASON=""
if [ -z "$FEATURE_DIR" ] || [ ! -d "$FEATURE_DIR" ]; then
    GATE_REASON="No active spec-kit feature. All source changes must be spec-driven: run /speckit-specify \"<feature description>\" first (then /speckit-plan and /speckit-tasks). For changes that already exist without a spec, run /speckit-backfill."
else
    missing=""
    [ -f "$FEATURE_DIR/spec.md" ]  || missing="$missing spec.md (run /speckit-specify)"
    [ -f "$FEATURE_DIR/plan.md" ]  || missing="$missing plan.md (run /speckit-plan)"
    [ -f "$FEATURE_DIR/tasks.md" ] || missing="$missing tasks.md (run /speckit-tasks)"
    if [ -z "$missing" ]; then
        GATE_OK=true
    else
        GATE_REASON="Feature '$(basename "$FEATURE_DIR")' is missing required artifacts:$missing. Complete the spec-kit workflow before editing source files."
    fi
fi

# --- Evaluate the foundational-standards EXISTENCE gate -----------------------
# Independent of and PRIOR to the feature gate: a missing required standard
# denies a source write even inside a complete feature. Decidable only (manifest
# status + file existence); conformance is deferred to /speckit-comply. An absent
# or malformed manifest, or missing jq, leaves STD_REASON empty (gate inactive /
# fail open). Helpers come from ci/spec-policy.sh (sourced above).
STD_REASON=""
if command -v standards_manifest_exists >/dev/null 2>&1 && standards_manifest_exists "$ROOT"; then
    case "$(standards_status "$ROOT")" in
    pending)
        STD_REASON="Project standards not established. Run /speckit-start to set up constitution, frameworks, security (and design if there's a UI) before writing source."
        ;;
    established)
        STD_MISS="$(first_missing_required_standard "$ROOT")"
        [ -n "$STD_MISS" ] && STD_REASON="Required project standard missing: $STD_MISS ($(standard_path "$ROOT" "$STD_MISS")). Run /speckit-start to establish it before writing source."
        ;;
    *)
        : # unknown/malformed -> inactive (fail open)
        ;;
    esac
fi

case "$MODE" in
content)
    # Secret scan of content about to be written. Independent of the spec
    # gate: hardcoding a credential is blocked even inside a valid feature.
    # Writing to .env & friends is exempt (that IS where secrets belong;
    # the commit/push/CI layers keep those files out of git).
    [ -z "$ARG" ] && exit 0
    [ -x "$ROOT/ci/check-secrets.sh" ] || exit 0
    if ! FINDINGS=$(bash "$ROOT/ci/check-secrets.sh" stdin "$ARG" 2>&1); then
        deny "Blocked: hardcoded secret detected in content for '$ARG'. Never write credentials into tracked files - read them from environment variables or a secret store (Azure Key Vault). Put the local value in .env (gitignored) and add a placeholder entry to .env.example. Details: ${FINDINGS:0:200}"
    fi
    exit 0
    ;;
write)
    [ -z "$ARG" ] && exit 0
    # Normalize to repo-relative
    REL="$ARG"
    case "$REL" in
        "$ROOT"/*) REL="${REL#"$ROOT"/}" ;;
        /*) exit 0 ;;   # absolute path outside the repo: not our concern
    esac
    is_always_editable "$REL" && exit 0
    # Standards existence gate runs before the feature gate (see above).
    [ -n "$STD_REASON" ] && deny "Blocked write to '$REL'. $STD_REASON"
    $GATE_OK && exit 0
    deny "Blocked write to '$REL'. $GATE_REASON"
    ;;
shell)
    [ -z "$ARG" ] && exit 0
    CMD="$ARG"
    # Never block spec-kit's own tooling or git/navigation (workflow bootstrap).
    case "$CMD" in
        *".specify/scripts/"* | *".specify/extensions/"*) exit 0 ;;
    esac
    # Heuristic: is this an obvious file mutation NOT scoped to always-editable
    # areas? Read-only commands (git, grep, ls, ...) carry no mutation verbs or
    # redirection and are never blocked.
    MUTATES=false
    if printf '%s' "$CMD" | grep -Eq '(^|[;&|[:space:]])(rm|mv|cp|touch|tee|truncate|dd|install)([[:space:]]|$)|sed[[:space:]]+-i|perl[[:space:]]+-i|>>?[[:space:]]*[^&[:space:]]'; then
        # Tolerate mutations clearly scoped to always-editable areas only.
        if printf '%s' "$CMD" | grep -Eq '(^|[[:space:]"'"'"'=])(specs/|\.specify/|docs/|\.claude/skills/|\.agents/skills/|\.cursor/skills/|\.gemini/commands/)' \
           && ! printf '%s' "$CMD" | grep -Eq '(^|[[:space:]"'"'"'=])(src/|lib/|app/|pkg/|cmd/|tests?/|ci/|scripts/|\.githooks/)'; then
            MUTATES=false
        else
            MUTATES=true
        fi
    fi
    # Standards existence gate runs before the feature gate.
    if $MUTATES && [ -n "$STD_REASON" ]; then
        deny "Blocked potentially file-mutating shell command. $STD_REASON"
    fi
    $GATE_OK && exit 0
    $MUTATES && deny "Blocked potentially file-mutating shell command. $GATE_REASON"
    exit 0
    ;;
*)
    exit 0
    ;;
esac
