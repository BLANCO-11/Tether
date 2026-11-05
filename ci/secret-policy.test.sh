#!/usr/bin/env bash
# Controls for ci/secret-policy.sh and ci/check-secrets.sh.
#
# Feature: 20260828-125520-secret-scan-templates-and-speed
#
# ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
#
# Three defects were found in the secret gate, and two had survived because
# nothing asserted the behaviour either way:
#
#   1. `.env.local.example` — a placeholder TEMPLATE — was forbidden by name,
#      because the exemption was three literal basenames rather than a shape.
#   2. The two rules disagreed: `is_forbidden_secret_file` matched on BASENAME
#      and `is_secret_scan_exempt` on FULL PATH, so a nested `.env.example` was
#      content-scanned and the root one was not.
#   3. `check_diff` spawned two processes per pattern per line — measured at
#      363,684 ms for 265 lines on an EDR-hooked host.
#
# ⚠ THE MOST IMPORTANT ASSERTIONS HERE ARE THE NEGATIVE ONES. Widening a name
# rule is one careless glob away from admitting `.env.production`, and the
# symptom of that is a gate that passes. Every ALLOW case below is paired with a
# FORBID case that a sloppier rule would let through.
#
# ⚠ SECOND MOST IMPORTANT: the planted-secret cases. A fast scan that misses a
# real credential satisfies every timing assertion in the spec. Speed must never
# be verified without them.
#
# ⚠ THE PLANTED VALUES ARE ASSEMBLED FROM FRAGMENTS ON PURPOSE. Writing a
# credential-shaped literal here would make this file match its own subject —
# the pre-commit gate refused exactly that while this file was being written, so
# the constraint is real rather than theoretical. `secret-policy.sh` solves the
# same problem in its own patterns by writing `[-]{5}` instead of five dashes.
# Keep the fragments split; a "tidy-up" that joins them breaks the commit.
#
# Usage:  bash ci/secret-policy.test.sh
# Exit:   0 all pass · 1 a failure

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
. "$ROOT/ci/secret-policy.sh"

PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        %s\n' "$1" "$2"; }

# A credential-shaped value the scanner must catch, built so this file does not
# contain it. Matches AKIA[0-9A-Z]{16}; deliberately carries no placeholder word
# (no "example"/"sample"/"dummy"), or is_placeholder_line would suppress it and
# the test would pass for the wrong reason.
REAL_KEY="AKIA""IOSFODNN7QQRSTUV"

# name_is <path> <allowed|forbidden>
name_is() {
    local f="$1" want="$2" got
    if is_forbidden_secret_file "$f"; then got=forbidden; else got=allowed; fi
    if [ "$got" = "$want" ]; then ok "name: $f -> $want"
    else bad "name: $f" "expected $want, got $got"; fi
}

# content_is <path> <scanned|exempt>
content_is() {
    local f="$1" want="$2" got
    if is_secret_scan_exempt "$f"; then got=exempt; else got=scanned; fi
    if [ "$got" = "$want" ]; then ok "content: $f -> $want"
    else bad "content: $f" "expected $want, got $got"; fi
}

# ── FR-001 / FR-003: a template is allowed, at any depth ─────────────────────
printf '\nname rule — templates are ALLOWED (FR-001, FR-003)\n'
for f in .env.example .env.sample .env.template \
         .env.local.example .env.development.sample .env.staging.template; do
    name_is "$f" allowed
    name_is "packages/client/$f" allowed
    name_is "a/b/c/$f" allowed
done

# ── FR-002: everything else in the family stays FORBIDDEN ────────────────────
#
# ⚠ These are the cases a careless glob breaks. `.env*example*` would admit
# `.env.example.bak`; an unanchored suffix test would admit `.env.examples`.
printf '\nname rule — real secrets files stay FORBIDDEN (FR-002)\n'
for f in .env .env.local .env.production .env.development \
         .env.example.bak .env.template.local .env.examples .env.sampled; do
    name_is "$f" forbidden
    name_is "packages/client/$f" forbidden
done

printf '\nname rule — the other forbidden families are undisturbed\n'
for f in id_rsa id_rsa.pub id_ed25519 .netrc .pypirc \
         terraform.tfstate credentials.json service-account-x.json; do
    name_is "$f" forbidden
done
name_is "x/key.pem" forbidden
name_is "x/store.jks" forbidden
name_is "packages/server/src/index.ts" allowed
name_is "README.md" allowed

# ── FR-004: templates ARE content-scanned ────────────────────────────────────
#
# ⚠ This pairing is what makes the name widening safe. Allowing a template into
# git while ALSO exempting its content turns a loud false positive into a silent
# blind spot.
printf '\ncontent rule — templates are SCANNED (FR-004)\n'
for f in .env.example .env.local.example packages/mcp-bridge/.env.example \
         a/b/.env.staging.template; do
    content_is "$f" scanned
done

# ── FR-005: files that legitimately hold real secrets stay exempt ────────────
printf '\ncontent rule — real local secret files stay EXEMPT (FR-005)\n'
for f in .env .env.local packages/x/.env.production x/key.pem id_rsa; do
    content_is "$f" exempt
done

# ── FR-006: the scanner's own files, matched on FULL PATH deliberately ───────
printf '\ncontent rule — the scanner itself is EXEMPT, by path not basename (FR-006, D-3)\n'
content_is "ci/secret-policy.sh" exempt
content_is "ci/check-secrets.sh" exempt
content_is "other/secret-policy.sh" scanned
content_is "vendor/ci/check-secrets.sh" scanned

# ── FR-007: the placeholder recogniser is unchanged ──────────────────────────
printf '\nplaceholder recogniser is unchanged (FR-007)\n'
for line in 'KEY=your-api-key' 'KEY=<your-key-here>' 'KEY=changeme' \
            'KEY=${SOME_VAR}' 'KEY=os.environ["X"]' 'TOKEN=REDACTED'; do
    if is_placeholder_line "$line"; then ok "placeholder: $line"
    else bad "placeholder: $line" "should be recognised as a placeholder"; fi
done
for line in 'KEY=hunter2averyrealvalue' 'TOKEN=abcdef0123456789abcdef01'; do
    if is_placeholder_line "$line"; then bad "not-placeholder: $line" "should NOT be a placeholder"
    else ok "not-placeholder: $line"; fi
done

# ── End-to-end, through the real entry point ─────────────────────────────────
#
# ⚠ Run against a throwaway git repo rather than by calling the policy functions
# directly. The bug class being guarded against is the FAST PATH losing a match
# or losing the filename, and no unit call on is_forbidden_secret_file can see
# either.
printf '\nend-to-end — a planted secret in a TEMPLATE is reported (SC-002, FR-009)\n'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.email t@example.com
git -C "$TMP" config user.name t
mkdir -p "$TMP/ci" "$TMP/packages/client"
cp "$ROOT/ci/secret-policy.sh" "$ROOT/ci/check-secrets.sh" "$TMP/ci/"

T="$TMP/packages/client/.env.local.example"
printf 'AWS_ACCESS_KEY_ID=%s\n' "$REAL_KEY" > "$T"
# ...and an obvious placeholder in the SAME file, which must NOT be reported.
printf 'OTHER_KEY=your-api-key-here\n' >> "$T"
git -C "$TMP" add -A
out="$(cd "$TMP" && bash ci/check-secrets.sh staged 2>&1)"; rc=$?

# ⚠ Assert the CONTENT message specifically, not merely that the filename
# appears. Before the fix this file is name-forbidden, so a looser assertion
# passes on the "forbidden secret file" message and would keep passing even if
# the content scan never ran — a test that cannot fail for the reason it exists.
if [ "$rc" -ne 0 ] \
   && printf '%s' "$out" | grep -q 'possible hardcoded secret' \
   && printf '%s' "$out" | grep -q 'packages/client/.env.local.example'; then
    ok "planted secret in a template is reported as CONTENT, naming the file"
else
    bad "planted secret in a template is reported as CONTENT" "exit=$rc out=${out:0:300}"
fi
if printf '%s' "$out" | grep -q 'your-api-key-here'; then
    bad "placeholder in the same file is not reported" "the placeholder was reported"
else
    ok "placeholder in the same file is not reported"
fi

printf '\nend-to-end — a clean template is allowed (FR-001, SC-001)\n'
printf 'AUTH_SECRET=\nLOCAL_ADMIN_PASSWORD=\n' > "$T"
git -C "$TMP" add -A
out="$(cd "$TMP" && bash ci/check-secrets.sh staged 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "clean template passes the scan"
else bad "clean template passes the scan" "exit=$rc out=${out:0:200}"; fi

printf '\nend-to-end — a real .env is still refused (FR-002, SC-003)\n'
printf 'SOME_VALUE=whatever\n' > "$TMP/.env"
git -C "$TMP" add -f .env
out="$(cd "$TMP" && bash ci/check-secrets.sh staged 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'forbidden secret file'; then
    ok ".env is refused by the name rule"
else
    bad ".env is refused by the name rule" "exit=$rc out=${out:0:200}"
fi
git -C "$TMP" rm -q --cached .env
rm -f "$TMP/.env"

# ── Attribution must survive awkward line content (T-109) ────────────────────
#
# The fast path prefixes each candidate line with its path plus a delimiter. A
# line carrying that delimiter, a tab, or a colon must not be mis-attributed.
printf '\nend-to-end — attribution survives awkward content (T-109)\n'
mkdir -p "$TMP/odd dir"
{
    printf 'A=1\t2:3\n'
    printf 'B=%b\n' '\x01injected'
    printf 'AWS_ACCESS_KEY_ID=%s\n' "$REAL_KEY"
} > "$TMP/odd dir/.env.local.example"
git -C "$TMP" add -A
out="$(cd "$TMP" && bash ci/check-secrets.sh staged 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'odd dir/.env.local.example'; then
    ok "match attributed to the right file despite delimiter/tab/colon in content"
else
    bad "attribution survives awkward content" "exit=$rc out=${out:0:300}"
fi
rm -rf "$TMP/odd dir"
git -C "$TMP" add -A

# ── Edge cases (T-110) ───────────────────────────────────────────────────────
printf '\nend-to-end — edge cases (T-110)\n'
git -C "$TMP" -c core.hooksPath=/dev/null commit -qm base
out="$(cd "$TMP" && bash ci/check-secrets.sh staged 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "empty staged diff exits clean"
else bad "empty staged diff exits clean" "exit=$rc out=${out:0:200}"; fi

python3 -c "print('X=' + 'a'*200000)" > "$TMP/long.txt"
git -C "$TMP" add -A
out="$(cd "$TMP" && bash ci/check-secrets.sh staged 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "a 200k-character line is handled without hanging"
else bad "a 200k-character line is handled" "exit=$rc out=${out:0:200}"; fi

printf '\n---\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
