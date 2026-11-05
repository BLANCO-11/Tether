#!/usr/bin/env bash
# One-time bootstrap after cloning a project created from this template.
# Safe to re-run (idempotent).

set -uo pipefail

HERE="$(CDPATH="" cd "$(dirname "$0")" && pwd)"
cd "$HERE"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== Preflight =="
command -v git >/dev/null 2>&1 && ok "git" || fail "git missing - install git"
if command -v jq >/dev/null 2>&1; then
    ok "jq"
else
    fail "jq missing (REQUIRED by the enforcement gates) - sudo apt install jq / brew install jq"
fi
if command -v uv >/dev/null 2>&1 || command -v uvx >/dev/null 2>&1; then
    ok "uv/uvx"
else
    warn "uv missing (needed for spec-kit CLI upgrades) - curl -LsSf https://astral.sh/uv/install.sh | sh"
fi

AGENTS_FOUND=0
for agent in claude codex cursor-agent gemini; do
    if command -v "$agent" >/dev/null 2>&1; then
        ok "agent CLI: $agent"
        AGENTS_FOUND=$((AGENTS_FOUND + 1))
    fi
done
[ "$AGENTS_FOUND" -eq 0 ] && warn "no agent CLI found on PATH (claude/codex/cursor-agent/gemini) - install at least one"

echo
echo "== Repository =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ok "git repository present"
else
    git init -b main >/dev/null && ok "initialized git repository (main)"
fi

if [ ! -d .specify ]; then
    warn ".specify missing - running specify init (this should not happen in a template clone)"
    uvx --from git+https://github.com/github/spec-kit.git specify init . --integration claude --script sh --force --ignore-agent-tools
fi

echo
echo "== Permissions and hooks =="
chmod +x scripts/spec-gate-core.sh scripts/hooks/*.sh .claude/hooks/*.sh \
         .githooks/* ci/*.sh .specify/scripts/bash/*.sh \
         .specify/extensions/git/scripts/bash/*.sh 2>/dev/null
ok "scripts executable"

git config core.hooksPath .githooks
ok "git core.hooksPath -> .githooks (pre-commit spec+secret gates, pre-push secret scan)"

if command -v gitleaks >/dev/null 2>&1; then
    ok "gitleaks found (extra secret coverage; bundled scanner stays authoritative)"
else
    warn "gitleaks not installed (optional) - https://github.com/gitleaks/gitleaks for deeper secret scanning"
fi

# Codex CLI reads hooks from user-level config; merge our block if codex exists.
if command -v codex >/dev/null 2>&1; then
    CODEX_CFG="$HOME/.codex/config.toml"
    mkdir -p "$HOME/.codex"
    touch "$CODEX_CFG"
    if grep -q 'SPECKIT-MANAGED' "$CODEX_CFG" 2>/dev/null; then
        ok "codex hooks already configured ($CODEX_CFG)"
    else
        cat >>"$CODEX_CFG" <<EOF

# SPECKIT-MANAGED BEGIN (added by spec-kit starter template setup.sh)
# Pre-execution spec gate: denies source writes without an active spec-kit
# feature. Scoped to repos that contain scripts/spec-gate-core.sh (the
# adapter exits 0 elsewhere). Remove this block to disable.
[[hooks.preToolUse]]
command = ["bash", "-c", "if [ -x ./scripts/hooks/codex-adapter.sh ]; then ./scripts/hooks/codex-adapter.sh; fi"]
# SPECKIT-MANAGED END
EOF
        ok "codex hooks merged into $CODEX_CFG"
        warn "verify the hook table name matches your codex version (codex --help / docs; some versions use hooks.json)"
    fi
fi

echo
echo "== Standards onboarding =="
# Arm the foundational-standards gate for adopters. Writing a "pending" manifest
# makes scripts/spec-gate-core.sh block source writes until /speckit-start
# establishes the project's standards (constitution, frameworks, security, and
# design if there is a UI). Guarded so it never clobbers an existing manifest and
# never arms while the template itself is being developed (.speckit-template-dev).
STANDARDS_MANIFEST=".specify/memory/standards.json"
if [ -f "$STANDARDS_MANIFEST" ]; then
    ok "standards manifest present (state: $(jq -r '.status // "unknown"' "$STANDARDS_MANIFEST" 2>/dev/null))"
elif [ -f .speckit-template-dev ]; then
    warn "standards manifest not armed (.speckit-template-dev present - template development mode)"
else
    mkdir -p .specify/memory
    cat >"$STANDARDS_MANIFEST" <<EOF
{
  "schema_version": 1,
  "status": "pending",
  "has_ui": null,
  "standards": {
    "constitution": { "path": ".specify/memory/constitution.md", "required": true, "present": $( [ -f .specify/memory/constitution.md ] && echo true || echo false ) },
    "frameworks":   { "path": ".specify/memory/frameworks.md",   "required": true, "present": false },
    "security":     { "path": ".specify/memory/security.md",     "required": true, "present": false },
    "design":       { "path": ".specify/memory/design.md",       "required": false, "present": false }
  },
  "revision": 1,
  "created": "$(date +%F)",
  "history_log": ".specify/memory/standards-history.md"
}
EOF
    ok "standards gate armed (pending) - run /speckit-start to establish project standards before writing source"
fi

echo
echo "== Sanity checks =="
if [ -f .speckit-template-dev ]; then
    fail ".speckit-template-dev marker present - ENFORCEMENT IS OFF. Delete it: rm .speckit-template-dev"
else
    ok "enforcement marker absent (gates active)"
fi
if command -v jq >/dev/null 2>&1 && [ -f .claude/settings.json ]; then
    jq . .claude/settings.json >/dev/null 2>&1 && ok ".claude/settings.json parses" || fail ".claude/settings.json is invalid JSON"
fi
bash -n scripts/spec-gate-core.sh 2>/dev/null && ok "gate engine syntax OK" || fail "gate engine has syntax errors"
bash -n ci/check-secrets.sh 2>/dev/null && ok "secret scanner syntax OK" || fail "secret scanner has syntax errors"
[ -f .env.example ] && ok ".env.example present" || warn ".env.example missing - create it so devs know which variables to set"
grep -q '"feature_numbering": "timestamp"' .specify/init-options.json 2>/dev/null \
    && ok "timestamp feature numbering" || warn "feature_numbering is not 'timestamp' in .specify/init-options.json"

echo
if [ "$FAILED" = "1" ]; then
    echo "Setup finished WITH ERRORS - fix the ✗ items above."
    exit 1
fi
cat <<'EOF'
Setup complete. Next steps:
  1. Start your agent:      claude   (or codex / cursor / gemini)
  2. Establish standards:   /speckit-start   (REQUIRED first - constitution,
                            frameworks, security, and design if there's a UI)
  3. Build a feature:       /speckit-specify "..." -> /speckit-plan -> /speckit-tasks -> /speckit-implement
  4. Change a standard:     /speckit-update-standards
  5. Before the PR:         /speckit-comply
Docs: docs/TEAM-WORKFLOW.md , docs/STANDARDS.md
EOF
