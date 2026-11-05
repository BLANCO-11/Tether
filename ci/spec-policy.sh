#!/usr/bin/env bash
# Single source of truth for spec-driven-development policy.
# Sourced by:
#   scripts/spec-gate-core.sh   (per-agent pre-write gate)
#   .githooks/pre-commit        (commit-time gate, any agent or human)
#   ci/check-spec-compliance.sh (PR gate in Azure DevOps)
# Keep this file free of side effects: definitions only.

# Feature branches / spec dirs use spec-kit timestamp numbering: 20260710-153001-user-auth
# (configured in .specify/init-options.json and .specify/extensions/git/git-config.yml)
FEATURE_BRANCH_REGEX='^[0-9]{8}-[0-9]{6}-[a-z0-9-]+$'

# The only branches exempt from spec gates. Every hotfix requires a follow-up
# /speckit-backfill PR within 2 working days (see docs/TEAM-WORKFLOW.md).
HOTFIX_BRANCH_REGEX='^(hotfix|revert)/'

DEFAULT_BRANCH='main'

# Paths that may always be written WITHOUT an active spec-kit feature.
# This is what lets the workflow bootstrap itself: /speckit-constitution and
# /speckit-specify only write inside these paths.
# Everything NOT matched here is "source" and requires spec/plan/tasks.
# NOTE: enforcement machinery (.githooks/, ci/, scripts/, azure-pipelines.yml,
# agent hook configs) is deliberately NOT allowlisted - changing the gates
# themselves requires a spec-kit feature.
is_always_editable() { # $1 = repo-relative path
    case "$1" in
        specs/*) return 0 ;;
        .specify/*) return 0 ;;
        docs/*) return 0 ;;
        .claude/skills/*) return 0 ;;
        .agents/skills/*) return 0 ;;
        .cursor/skills/*) return 0 ;;
        .gemini/commands/*) return 0 ;;
        .gitignore | LICENSE | LICENSE.*) return 0 ;;
        *.md) return 0 ;;
    esac
    return 1
}

# ---------------------------------------------------------------------------
# Foundational-standards policy (feature: /speckit-start onboarding).
#
# The standards manifest (.specify/memory/standards.json) is the decidable
# source of truth for the standards EXISTENCE gate. When absent, the standards
# gate is INACTIVE (template-dev / pre-setup). These helpers are definitions
# only (no side effects); they are sourced by scripts/spec-gate-core.sh,
# ci/check-standards-compliance.sh, and the git hooks. They tolerate a
# missing/malformed manifest (or missing jq) by echoing empty, so every caller
# fails open. All helpers take the repo root as $1.
# ---------------------------------------------------------------------------

# Repo-relative path to the standards manifest.
STANDARDS_MANIFEST_REL=".specify/memory/standards.json"

# The standard keys the existence gate knows about.
STANDARDS_KEYS="constitution frameworks security design"

# Echo the absolute manifest path for a given repo root.
standards_manifest_path() { # $1 = repo root
    printf '%s/%s' "$1" "$STANDARDS_MANIFEST_REL"
}

# Return 0 if a standards manifest exists for the repo root, else 1.
standards_manifest_exists() { # $1 = repo root
    [ -f "$(standards_manifest_path "$1")" ]
}

# Read a field from the manifest via jq. Echoes empty on any error
# (missing file, missing jq, malformed JSON) so callers fail open.
#   standards_field <root> <jq-filter>   e.g. standards_field "$ROOT" '.status'
standards_field() { # $1 = repo root, $2 = jq filter
    local mf; mf="$(standards_manifest_path "$1")"
    [ -f "$mf" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0
    jq -r "$2 // empty" "$mf" 2>/dev/null || return 0
}

# Echo the manifest status: "pending" | "established" | "" (absent/error).
standards_status() { # $1 = repo root
    standards_field "$1" '.status'
}

# Echo "true" | "false" | "" for has_ui.
standards_has_ui() { # $1 = repo root
    standards_field "$1" '.has_ui'
}

# Echo the repo-relative path configured for a standard key, or a sensible
# default under .specify/memory/ when the manifest doesn't specify one.
standard_path() { # $1 = repo root, $2 = key
    local p; p="$(standards_field "$1" ".standards.\"$2\".path")"
    if [ -n "$p" ]; then printf '%s' "$p"; else printf '.specify/memory/%s.md' "$2"; fi
}

# Return 0 if a standard key is REQUIRED given the manifest, else 1.
# Policy: constitution/frameworks/security always required; design required iff
# has_ui is true. An explicit manifest "required" field, when present, wins.
standard_required() { # $1 = repo root, $2 = key
    local explicit; explicit="$(standards_field "$1" ".standards.\"$2\".required")"
    case "$explicit" in
        true) return 0 ;;
        false) return 1 ;;
    esac
    case "$2" in
        security|constitution|frameworks) return 0 ;;
        design) [ "$(standards_has_ui "$1")" = "true" ] ;;
        *) return 1 ;;
    esac
}

# Echo the first REQUIRED standard whose file is MISSING on disk, or empty if
# all required standards are present. Used by the existence gate and review.
first_missing_required_standard() { # $1 = repo root
    local root="$1" key rel
    for key in $STANDARDS_KEYS; do
        standard_required "$root" "$key" || continue
        rel="$(standard_path "$root" "$key")"
        [ -f "$root/$rel" ] || { printf '%s' "$key"; return 0; }
    done
    return 0
}
