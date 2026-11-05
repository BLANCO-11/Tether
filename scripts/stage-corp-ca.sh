#!/usr/bin/env bash
# Stage the corporate root CA into the Docker build context.
#
# Feature: 20260824-211547-docker-ca-trust · specs/…/contracts/build-inputs.md
#
# ── Why this exists ──────────────────────────────────────────────────────────
#
# A Docker build reads ONLY its own build context. It inherits no host
# environment and sees no host filesystem — so NODE_EXTRA_CA_CERTS and
# SSL_CERT_FILE on the workstation, which is what makes every other tool here
# work behind the intercepting proxy, are structurally unavailable to a `RUN`
# step. The certificate has to be copied INTO the context, and this is the one
# documented action that does it (FR-009).
#
# ── Why ONE destination serves six images ────────────────────────────────────
#
# `infra/certs/` is visible to both build contexts this repo uses: as
# `infra/certs/` from the repo-root context (the four Node images) and as
# `certs/` from the `infra/` context (fragment-base). That is the whole
# reason those two build contexts were moved up a level — see research.md R4.
#
# ⚠ THE DESTINATION EXTENSION IS `.pem` AND THAT IS LOAD-BEARING.
# `.gitignore` has a `*.pem` rule and NO `*.crt` rule. A file staged as
# `corp-ca.crt` would be untracked by intent but not by rule — key material one
# `git add -A` away from history (Constitution VIII). Debian's anchor directory
# does require `.crt`, but that rename happens inside the Dockerfile's COPY,
# where git cannot see it. This script refuses to write a `.crt`.
#
# Usage:
#   ./scripts/stage-corp-ca.sh
#   CORP_CA_SOURCE=/path/to/root-ca.pem ./scripts/stage-corp-ca.sh
#
# Exit codes: 0 staged (or already correct) · 1 refused, with a reason.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$REPO_ROOT/infra/certs"
DEST="$DEST_DIR/corp-ca.pem"
SOURCE="${CORP_CA_SOURCE:-$HOME/zscaler-ca.pem}"

die() { printf 'stage-corp-ca: %s\n' "$1" >&2; exit 1; }

# ── 1. The source must exist ─────────────────────────────────────────────────
[ -n "$SOURCE" ] || die "CORP_CA_SOURCE is set but empty. Unset it to use the default, or give it a path."

if [ ! -f "$SOURCE" ]; then
    die "no certificate at '$SOURCE'.
  Set CORP_CA_SOURCE to your corporate root CA, e.g.
      CORP_CA_SOURCE=/path/to/root-ca.pem $0
  On macOS you can export it from the keychain with:
      security find-certificate -a -c '<CA name>' -p /Library/Keychains/System.keychain > root-ca.pem"
fi

# ── 2. It must actually BE a certificate ─────────────────────────────────────
#
# Checked by parsing, never by extension or by grepping for the PEM header.
# PEM armour around arbitrary bytes passes a header check and fails a parse —
# and it is the failure that matters, because an unparseable file handed to
# Node's NODE_EXTRA_CA_CERTS is silently IGNORED, reproducing the original
# UNABLE_TO_GET_ISSUER_CERT_LOCALLY later with nothing naming the cause.
if command -v openssl >/dev/null 2>&1; then
    openssl x509 -noout -in "$SOURCE" >/dev/null 2>&1 \
        || die "'$SOURCE' is not a parseable X.509 certificate.
  It exists, but openssl cannot read it as a certificate. Check you exported the
  certificate itself and not a key, a bundle in another format, or an HTML error page."
    SUBJECT="$(openssl x509 -noout -subject -in "$SOURCE" 2>/dev/null || echo 'subject unavailable')"
elif command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const { X509Certificate } = require("crypto");
      try { new X509Certificate(fs.readFileSync(process.argv[1])); }
      catch (e) { console.error(e.message); process.exit(1); }
    ' "$SOURCE" >/dev/null 2>&1 \
        || die "'$SOURCE' is not a parseable X.509 certificate (checked with node)."
    SUBJECT="subject unavailable (openssl not installed)"
else
    die "neither openssl nor node is available to validate the certificate.
  Refusing to stage an unvalidated file: an unparseable certificate is silently
  ignored at build time and reproduces the original error with no diagnosis."
fi

# ── 3. Refuse a .crt destination (see the header note) ───────────────────────
case "$DEST" in
    *.crt) die "internal error: destination '$DEST' ends in .crt, which .gitignore does NOT cover." ;;
esac

# ── 4. Idempotent, and never a silent overwrite ──────────────────────────────
mkdir -p "$DEST_DIR"

if [ -f "$DEST" ]; then
    if cmp -s "$SOURCE" "$DEST"; then
        printf 'stage-corp-ca: already staged and identical: %s\n' "$DEST"
        printf 'stage-corp-ca: %s\n' "$SUBJECT"
        exit 0
    fi
    if [ "${CORP_CA_FORCE:-}" != "1" ]; then
        die "a DIFFERENT certificate is already staged at '$DEST'.
  Refusing to overwrite silently — a swapped CA changes what every image trusts.
  Re-run with CORP_CA_FORCE=1 to replace it deliberately."
    fi
    printf 'stage-corp-ca: replacing the existing certificate (CORP_CA_FORCE=1)\n'
fi

cp "$SOURCE" "$DEST"
chmod 644 "$DEST"

# ── 5. Say what happens next ─────────────────────────────────────────────────
#
# Staging alone changes nothing: trust follows the EXPLICIT build argument and
# never the mere presence of a file (FR-010), so a staged-but-unrequested
# certificate is copied into the image and ignored.
printf 'stage-corp-ca: staged %s -> %s\n' "$SOURCE" "$DEST"
printf 'stage-corp-ca: %s\n' "$SUBJECT"
cat <<'NEXT'

Staged. Nothing is trusted yet — trust follows the build argument, not the file.

Next:
  1. add to your repo-root .env:      CORP_CA_FILE=corp-ca.pem
  2. build:                           docker compose --env-file .env -f infra/docker-compose.yml build

⚠ --env-file .env is NOT optional. Compose interpolates ${VAR} from the
   directory holding the compose file (infra/), not the repo root. Without it
   CORP_CA_FILE expands to empty, the build proceeds WITHOUT trust, and fails at
   the first fetch looking exactly like the original bug.
NEXT
