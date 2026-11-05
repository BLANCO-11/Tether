#!/usr/bin/env bash
# Single source of truth for secret-protection policy.
# Sourced by:
#   ci/check-secrets.sh          (scanner used by all layers)
#   scripts/spec-gate-core.sh    (agent pre-write content scan)
# Definitions only - no side effects.

# Files that must never be COMMITTED (they may exist locally - .env is the
# correct place for local secrets and is gitignored).
# Is this an .env-family TEMPLATE — a file whose purpose is to document variable
# NAMES with no real values? Recognised by SHAPE, not by an enumerated list.
#
# ⚠ THE LIST FORM ALREADY FAILED ONCE. This was three literal basenames
# (.env.example|.env.sample|.env.template), so `.env.local.example` — a template
# by every reading, including this policy's own advice to "provide a placeholder
# in .env.example" — fell through to the forbidden branch and blocked every push
# of a new branch. A fourth plausible name (`.env.staging.template`) would have
# failed the same way.
#
# ⚠ THE SUFFIX MUST BE FINAL, and that is the property most easily broken by a
# careless glob. `.env.example.bak` ends in `.bak` and is NOT a template;
# `.env.examples` is not one either. Widening this by one character is how
# `.env.production` gets admitted, and the symptom of that is a gate that passes.
is_template_env_file() { # $1 = repo-relative path or basename
    local base="${1##*/}"
    case "$base" in
        .env | .env.*) ;;
        *) return 1 ;;
    esac
    case "$base" in
        *.example | *.sample | *.template) return 0 ;;
    esac
    return 1
}

is_forbidden_secret_file() { # $1 = repo-relative path
    local base="${1##*/}"
    is_template_env_file "$base" && return 1
    case "$base" in
        .env | .env.*) return 0 ;;
        id_rsa | id_rsa.* | id_dsa | id_ecdsa | id_ed25519) return 0 ;;
        *.pem | *.p12 | *.pfx | *.jks | *.keystore | *.ppk) return 0 ;;
        .netrc | _netrc | .pypirc) return 0 ;;
        terraform.tfstate | terraform.tfstate.*) return 0 ;;
        *-credentials.json | credentials.json | service-account*.json) return 0 ;;
    esac
    return 1
}

# Content patterns (ERE), one per line via SECRET_CONTENT_PATTERNS.
# Deliberately high-signal to keep false positives rare. Written so the
# patterns do not match their own source text (e.g. [-]{5} instead of -----).
SECRET_CONTENT_PATTERNS=(
    '[-]{5}BEGIN[ A-Z]*PRIVATE KEY'                       # PEM/OpenSSH private keys
    'AKIA[0-9A-Z]{16}'                                    # AWS access key id
    'aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{40}'
    'gh[pousr]_[A-Za-z0-9]{36}'                           # GitHub tokens
    'sk-[A-Za-z0-9_-]{32,}'                               # OpenAI / Anthropic style keys
    'xox[baprs]-[0-9A-Za-z]{10,}-[0-9A-Za-z-]{10,}'       # Slack tokens
    'AIza[0-9A-Za-z_-]{35}'                               # Google API key
    'AccountKey=[A-Za-z0-9+/=]{40,}'                      # Azure storage connection string
    'SharedAccessSignature=sv='                           # Azure SAS
    'eyJ[A-Za-z0-9_-]{17,}\.eyJ[A-Za-z0-9_-]{17,}\.'      # signed JWT
    '(api[_-]?key|apikey|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd)["'\'']?[[:space:]]*[:=][[:space:]]*["'\''][A-Za-z0-9+/_.=-]{16,}["'\'']'
)

# A matching line is ignored when it is clearly a placeholder / template /
# env-var indirection rather than a real credential.
is_placeholder_line() { # $1 = line
    printf '%s' "$1" | grep -Eiq \
        '(example|sample|changeme|change-me|placeholder|dummy|redacted|fake|xxxx|your[_-]?(api)?[_-]?(key|token|secret|password)|<[a-z0-9_ .-]+>|\$\{|\{\{|%s|process\.env|os\.environ|getenv|ENV\[|keyvault|secretref|vault:)'
}

# Paths whose CONTENT is exempt from scanning:
#   - the scanner and this policy (they contain the patterns themselves)
#   - forbidden secret files (writing secrets THERE is correct; the commit
#     gates keep them out of git, so scanning them is noise)
#
# ⚠ .env TEMPLATES ARE **NOT** EXEMPT, AND THAT IS THE POINT. They used to be —
# which meant that allowing a name also stopped the content being read. So the
# obvious fix for the `.env.local.example` false positive (add it to both lists)
# would have made that file committable AND unexamined: a real key pasted into a
# `*.example` file would have been invisible. A false positive is loud and
# recoverable; a blind spot is silent. Given the choice, take the loud one.
#
# ⚠ Verified a no-op at the time of the change: neither `.env.example` nor
# `packages/mcp-bridge/.env.example` matched any content pattern, and the latter
# was already being scanned.
#
# ⚠ The scanner's own two files are matched on FULL PATH, deliberately. A file
# named `secret-policy.sh` somewhere else is NOT this policy and must be scanned;
# basename matching here would be a real widening. Everything else decides from
# the BASENAME, so a file's verdict never depends on its directory — the two
# rules used to disagree about exactly that, and a nested `.env.example` was
# scanned while the root one was not.
is_secret_scan_exempt() { # $1 = repo-relative path
    case "$1" in
        ci/secret-policy.sh | ci/check-secrets.sh) return 0 ;;
    esac
    is_template_env_file "$1" && return 1
    is_forbidden_secret_file "$1" && return 0
    return 1
}
