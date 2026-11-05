#!/usr/bin/env bash
# T026 · T028 · T029 · T031 — the four US2 proofs that CANNOT be taken on a
# TLS-intercepting network. Run this ONCE on a network with no interception (or
# in CI) and paste the summary into baseline-pre-change.txt.
#
# ── WHY THESE COULD NOT BE TAKEN ON THE DEV WORKSTATION ──────────────────────
#
# Every one of them requires a SUCCESSFUL build with no certificate. Behind the
# proxy such a build fails at its first fetch — which is the defect this feature
# fixes — so the test cannot discriminate between "the feature left the image
# unchanged" (what FR-003 claims) and "the network broke the build" (the bug).
# A failing build is not evidence either way. That is the whole reason these are
# deferred rather than asserted.
#
# ⚠ RUN FROM THE REPO ROOT.
# ⚠ THIS SCRIPT DELIBERATELY DOES NOT PASS --env-file. `.env` sets
#   CORP_CA_FILE=corp-ca.pem, which is exactly the variable that must be EMPTY
#   here. Sourcing it would make every check below pass for the wrong reason.
#
# Usage:   bash specs/20260824-211547-docker-ca-trust/verify-fr003.sh
# Exit:    0 all four proofs hold · 1 a proof failed · 3 setup error

set -uo pipefail

BASELINE="specs/20260824-211547-docker-ca-trust/baseline-pre-change.txt"
[ -f "$BASELINE" ] || { echo "run me from the repo root (missing $BASELINE)"; exit 3; }

# Read the recorded numbers rather than hardcoding them. A literal goes stale the
# first time a base image refreshes its own bundle, and then reports a false
# failure that reads like this feature broke.
BASE_BUNDLE="$(awk -F= '/^fragment-base.bundle_certs=/{print $2}' "$BASELINE" | tr -d '[:space:]')"
BASE_TRUST="$(awk -F= '/^kestra.truststore_entries=/{print $2}'  "$BASELINE" | tr -d '[:space:]')"
[ -n "$BASE_BUNDLE" ] && [ -n "$BASE_TRUST" ] || { echo "could not read baseline figures"; exit 3; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n        %s\n' "$1" "${2:-}"; }

# ── Step 0: prove the network is NOT intercepted ─────────────────────────────
# Without this the whole run is worthless: on an intercepted network every build
# below fails, and a reader cannot tell that from a real FR-003 regression.
printf '\n=== 0. is this network actually un-intercepted? ===\n'
if docker run --rm node:22-slim node -e \
     'require("https").get("https://registry.npmjs.org/",r=>{console.log(r.statusCode);process.exit(0)}).on("error",e=>{console.error(e.code);process.exit(1)})'; then
    ok "public TLS validates with NO certificate — this network can discriminate"
else
    echo
    echo "⚠ STOP. Public TLS failed with no certificate, so this network IS intercepted."
    echo "  Every check below would fail for the expected reason and prove nothing."
    echo "  Move to a non-intercepted network or run this in CI."
    exit 3
fi

# ── T026 / T031: all six images build with the argument EMPTY ────────────────
printf '\n=== T026 + T031. build all six with CORP_CA_FILE empty, --no-cache ===\n'
BUILT=1
for svc in server web ops-api mcp-bridge fragment-base kestra; do
    printf -- '--- %s ---\n' "$svc"
    if CORP_CA_FILE= docker compose -f infra/docker-compose.yml build --no-cache "$svc"; then
        ok "$svc built with no certificate"
    else
        bad "$svc built with no certificate" "FR-003 regression, OR this network is intercepted after all"
        BUILT=0
    fi
done

if [ "$BUILT" -eq 0 ]; then
    echo
    echo "⚠ Not continuing to the image-level comparisons — they would report on"
    echo "  stale images from a previous build and read as passes."
    exit 1
fi

# ── T027 (re-checked here): the variable is EMPTY, not a dangling path ───────
# A dangling path is the silent fallback FR-005 exists to prevent: Node treats an
# unreadable NODE_EXTRA_CA_CERTS as ABSENT and quietly uses its bundled roots.
printf '\n=== T027. NODE_EXTRA_CA_CERTS is empty, not a path to nothing ===\n'
for img in foundry-parent-server foundry-parent-web foundry-ops-api foundry-mcp-bridge; do
    v="$(docker run --rm --entrypoint sh "$img" -c 'printf "%s" "${NODE_EXTRA_CA_CERTS:-}"')"
    if [ -z "$v" ]; then ok "$img NODE_EXTRA_CA_CERTS is empty"
    else bad "$img NODE_EXTRA_CA_CERTS is empty" "got '$v' — a dangling path is the silent-fallback bug"; fi
done

# ── T028: the fragment-base anchor RUN is a genuine NO-OP ────────────────────
# EXACT equality, not "did not shrink". A refresh that reorders or re-emits the
# bundle is also a change to what the image trusts.
printf '\n=== T028. fragment-base bundle count == baseline exactly ===\n'
n="$(docker run --rm --entrypoint sh foundry/fragment-base:py3.12-pandas2.2.3 -c \
      'grep -c "BEGIN CERTIFICATE" /etc/ssl/certs/ca-certificates.crt' | tr -d '[:space:]')"
if [ "$n" = "$BASE_BUNDLE" ]; then ok "bundle count $n == baseline $BASE_BUNDLE"
else bad "bundle count == baseline" "baseline=$BASE_BUNDLE got=$n — the anchor RUN was not a no-op"; fi

p="$(docker run --rm --entrypoint sh foundry/fragment-base:py3.12-pandas2.2.3 -c 'printf "%s" "${PIP_CERT:-}"')"
if [ -z "$p" ]; then ok "PIP_CERT is empty"
else bad "PIP_CERT is empty" "got '$p' — pip REPLACES its bundle from this value"; fi

# ── T029: the kestra truststore is untouched and the alias is ABSENT ─────────
printf '\n=== T029. kestra truststore == baseline, and no foundry-corp-ca alias ===\n'
k="$(docker run --rm --user root --entrypoint keytool foundry/kestra:v1.3.29-scripts \
      -list -cacerts -storepass changeit | grep -c 'trustedCertEntry' | tr -d '[:space:]')"
if [ "$k" = "$BASE_TRUST" ]; then ok "truststore entries $k == baseline $BASE_TRUST"
else bad "truststore entries == baseline" "baseline=$BASE_TRUST got=$k"; fi

if docker run --rm --user root --entrypoint keytool foundry/kestra:v1.3.29-scripts \
     -list -cacerts -storepass changeit -alias foundry-corp-ca >/dev/null 2>&1; then
    bad "alias foundry-corp-ca is ABSENT" "it is present — the keytool import ran with the argument empty"
else
    ok "alias foundry-corp-ca is absent"
fi

printf '\n---\n%s passed, %s failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi

cat <<'DONE'

All four proofs hold. Record in baseline-pre-change.txt:

  deferred.fr003_no_interception=VERIFIED <date>, on a non-intercepted network
  us2.t026_all_six_no_ca_build=VERIFIED <date>
  us2.t028_fragment_base_no_ca=VERIFIED <date>
  us2.t029_kestra_no_ca=VERIFIED <date>

and tick T026, T028, T029, T031 in tasks.md, replacing the BLOCKED sub-bullets.
DONE
