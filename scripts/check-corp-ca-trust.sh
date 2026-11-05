#!/usr/bin/env bash
# Verify corporate CA trust, per image, against BUILT IMAGES.
#
# Feature: 20260824-211547-docker-ca-trust
#
# ── Why this asserts against images and not against Dockerfiles ──────────────
#
# Trust cannot be verified by reading a Dockerfile. The three runtimes honour
# three DIFFERENT mechanisms (research R1-R3): node:22-slim has no system trust
# store at all and reads NODE_EXTRA_CA_CERTS; the Python base has one and pip
# consults it; the JVM ignores every environment variable and reads
# lib/security/cacerts. A grep over Dockerfile text would pass over an image
# that trusts nothing, which is the failure this whole feature exists to stop.
#
# ── Why --control exists, and why it can FAIL THE RUN ────────────────────────
#
# An assertion that has never been observed failing is indistinguishable from an
# assertion that examines nothing. `--control` runs every assertion against an
# image built WITHOUT a certificate and requires each one to fail. If a control
# passes, that is reported as a DEFECT and exits non-zero — a green run over a
# check that cannot fail is worse than no check (the repo's own I-38 lesson).
#
# Usage:
#   ./scripts/check-corp-ca-trust.sh              # assert trust IS established
#   ./scripts/check-corp-ca-trust.sh --control    # assert every check can fail
#
# ⚠ ONE --control RUN DOES NOT COVER EVERY ASSERTION, and assuming it does is the
# same mistake this mode exists to catch. check_node_image RETURNS EARLY on its
# first failure, so a control against a bare base image exercises assertion 1
# ("the variable is set") and never reaches 2 ("the file exists") or 3 ("it
# parses"). Full coverage needs THREE runs against three different images:
#
#   1. no CA at all           NODE_IMAGES="node:22-slim"      -> fires assertion 1
#   2. variable set, no file  NODE_IMAGES="<dangling probe>"  -> fires assertion 2
#   3. file present, junk     NODE_IMAGES="<junk probe>"      -> fires assertion 3
#
# In runs 2 and 3 the EARLIER assertions correctly pass, so the script reports
# them as "CONTROL DID NOT FIRE" and exits 2. That is expected for a targeted
# probe and is not a defect — read the line that matters for the probe you built.
# All three were observed failing on 2026-08-25.
#
# Exit: 0 all good · 1 an assertion failed · 2 a control did not fail · 3 setup error

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 3

MODE="assert"
[ "${1:-}" = "--control" ] && MODE="control"

# ── Image tags are overridable, and --control NEEDS that ─────────────────────
#
# Control mode must run the assertions against images that genuinely LACK the
# corporate CA. On an intercepted network those images cannot be built at all —
# a no-CA build fails at its first fetch, which is the bug — so there is nothing
# locally tagged foundry-* that lacks the certificate.
#
# Pointing the checks at the BASE images solves it honestly: they really do have
# no corporate CA, so every assertion fails for the RIGHT reason. Letting the
# control "fire" merely because an image is missing would be the failure this
# mode exists to detect, wearing a green hat.
NODE_IMAGES="${NODE_IMAGES:-foundry-parent-server foundry-parent-web foundry-mcp-bridge}"
FRAGMENT_IMAGE="${FRAGMENT_IMAGE:-foundry/fragment-base:py3.12-pandas2.2.3}"

PASS=0
FAIL=0
DEFECT=0

# In control mode a FAILING assertion is the desired outcome, so the two modes
# interpret the same result oppositely. Keeping that inversion in ONE place is
# deliberate: two copies drift in the direction where the control silently stops
# discriminating.
record() { # $1 = ok|no, $2 = label, $3 = detail
    local ok="$1" label="$2" detail="${3:-}"
    if [ "$MODE" = "assert" ]; then
        if [ "$ok" = "ok" ]; then
            PASS=$((PASS + 1)); printf '  PASS  %s\n' "$label"
        else
            FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        %s\n' "$label" "$detail"
        fi
    else
        if [ "$ok" = "no" ]; then
            PASS=$((PASS + 1)); printf '  CONTROL FIRED  %s\n' "$label"
        else
            DEFECT=$((DEFECT + 1))
            printf '  ⚠ CONTROL DID NOT FIRE  %s\n        this assertion cannot fail and proves nothing\n' "$label"
        fi
    fi
}

have_image() { docker image inspect "$1" >/dev/null 2>&1; }

# ── Node images ──────────────────────────────────────────────────────────────
#
# Two independent facts, because either alone is satisfiable without trust:
#   1. NODE_EXTRA_CA_CERTS is set AND names a file that exists. A dangling path
#      is exactly the silent fallback FR-005 exists to prevent - Node treats an
#      unreadable value as ABSENT.
#   2. The file at that path parses as an X.509 certificate. PEM armour around
#      junk satisfies (1) and fails here.
check_node_image() { # $1 = image tag
    local img="$1"
    have_image "$img" || { record no "node/$img present" "image not built"; return; }

    local envval
    envval="$(docker run --rm --entrypoint sh "$img" -c 'printf "%s" "${NODE_EXTRA_CA_CERTS:-}"' 2>/dev/null)"
    if [ -n "$envval" ]; then
        record ok "node/$img NODE_EXTRA_CA_CERTS is set ($envval)"
    else
        record no "node/$img NODE_EXTRA_CA_CERTS is set" "empty - no corporate CA in this image"
        return
    fi

    if docker run --rm --entrypoint sh "$img" -c "test -f '$envval'" >/dev/null 2>&1; then
        record ok "node/$img certificate file exists at the referenced path"
    else
        record no "node/$img certificate file exists" "NODE_EXTRA_CA_CERTS points at a missing file - Node silently ignores this"
        return
    fi

    if docker run --rm --entrypoint node "$img" -e '
        const fs = require("fs");
        const { X509Certificate } = require("crypto");
        new X509Certificate(fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS));
    ' >/dev/null 2>&1; then
        record ok "node/$img certificate parses as X.509"
    else
        record no "node/$img certificate parses as X.509" "file present but not a parseable certificate"
    fi
}

# ── fragment-base ────────────────────────────────────────────────────────────
#
# The count is compared against the recorded baseline rather than a literal: a
# hardcoded number goes stale the first time the base image refreshes its own
# bundle, and then reports a false failure that reads like this feature broke.
check_fragment_base() {
    local img="$FRAGMENT_IMAGE"
    have_image "$img" || { record no "fragment-base present" "image not built"; return; }

    local baseline count
    baseline="$(awk -F= '/^fragment-base.bundle_certs=/{print $2}' \
        specs/20260824-211547-docker-ca-trust/baseline-pre-change.txt 2>/dev/null)"
    count="$(docker run --rm --entrypoint sh "$img" -c \
        'grep -c "BEGIN CERTIFICATE" /etc/ssl/certs/ca-certificates.crt' 2>/dev/null | tr -d '[:space:]')"

    if [ -z "$baseline" ] || [ -z "$count" ]; then
        record no "fragment-base bundle grew beyond baseline" "baseline or count unavailable (baseline='$baseline' count='$count')"
        return
    fi
    if [ "$count" -gt "$baseline" ]; then
        record ok "fragment-base bundle grew beyond baseline ($baseline -> $count)"
    else
        record no "fragment-base bundle grew beyond baseline" "baseline=$baseline count=$count - no certificate was added"
    fi

    local pipcert
    pipcert="$(docker run --rm --entrypoint sh "$img" -c 'printf "%s" "${PIP_CERT:-}"' 2>/dev/null)"
    if [ -n "$pipcert" ]; then
        record ok "fragment-base PIP_CERT is set ($pipcert)"
    else
        record no "fragment-base PIP_CERT is set" "empty"
    fi
}

# ── Run ──────────────────────────────────────────────────────────────────────
printf '\n=== corporate CA trust check (mode: %s) ===\n\n' "$MODE"

printf 'Node images\n'
for img in $NODE_IMAGES; do
    check_node_image "$img"
done

printf '\nfragment-base\n'
check_fragment_base


printf '\n---\n'
if [ "$MODE" = "assert" ]; then
    printf '%s passed, %s failed\n' "$PASS" "$FAIL"
    [ "$FAIL" -gt 0 ] && exit 1
    exit 0
else
    printf '%s controls fired, %s did NOT fire\n' "$PASS" "$DEFECT"
    if [ "$DEFECT" -gt 0 ]; then
        printf '\n⚠ An assertion that cannot fail is a defect, not a pass. Fix or delete it.\n'
        exit 2
    fi
    exit 0
fi
