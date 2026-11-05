#!/usr/bin/env bash
# Is the backup restorable? Take one, restore it alongside the live databases,
# and compare. Nothing live is touched.
#
# WHY THIS EXISTS AS A HARNESS AND NOT AS A RUNBOOK STEP
# ─────────────────────────────────────────────────────
# `pg_dump` exiting 0 means it wrote a file. `pg_restore` exiting 0 means it read
# one. Neither says the rows arrived, and BOTH succeed against an empty database
# — so "the backup works" is the single easiest thing in operations to believe
# without evidence. This compares row counts on the tables a restore is actually
# judged on, and it has a NEGATIVE CONTROL: it asserts the comparison can fail,
# by checking a deliberately wrong count first. Without that, a comparison bug
# reports green forever and the first real test is an incident.
#
# Usage: scripts/backup-verify.sh [--keep]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PG_CONTAINER="${PG_CONTAINER:-foundry-parent-postgres}"
PG_USER="${PG_USER:-foundry}"
SUFFIX="restorecheck"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %-46s \033[2m%s\033[0m\n' "$1" "${2:-}"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %-46s \033[2m%s\033[0m\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
q()    { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -t -A -c "$2" 2>/dev/null | tr -d ' '; }

cleanup() {
  if [ "$KEEP" = 0 ]; then
    bash "$HERE/restore.sh" --drop-suffix "$SUFFIX" >/dev/null 2>&1 || true
    [ -n "${TMPBK:-}" ] && rm -rf "$TMPBK"
  fi
}
trap cleanup EXIT

echo
echo "════════════════════════════════════════════════════════════════════"
echo "Backup/restore round trip — nothing live is written"
echo "════════════════════════════════════════════════════════════════════"
echo

live_ws="$(q foundry_parent 'SELECT count(*) FROM workspaces;')"

# The comparison used by step 4 and, deliberately, by the control in step 4b.
# Returns 0 when the two databases agree on a table, 1 when they do not.
tables_agree() {
  local t="$1" a b
  a="$(q foundry_parent "SELECT count(*) FROM $t;")"
  b="$(q "foundry_parent_$SUFFIX" "SELECT count(*) FROM $t;")"
  [ -n "$b" ] && [ "$a" = "$b" ]
}

# ── 1. take a backup ──────────────────────────────────────────────────────────
TMPBK="$(mktemp -d "${TMPDIR:-/tmp}/foundry-backup-verify.XXXXXX")"
if bash "$HERE/backup.sh" --out "$TMPBK/bk" >/dev/null 2>&1; then
  ok "backup.sh completes" "$(du -sh "$TMPBK/bk" | cut -f1)"
else
  bad "backup.sh completes" "see above"; exit 1
fi

[ -f "$TMPBK/bk/MANIFEST.json" ] && ok "manifest written" \
  "$(grep -o '"mode": "[^"]*"' "$TMPBK/bk/MANIFEST.json" | cut -d'"' -f4)" \
  || bad "manifest written"

# The key fingerprint must be a real value, not the "unknown" fallback — an
# unknown fingerprint silently disables the one check that catches a wrong key.
fp="$(grep -o '"credentialEncKeyFingerprint": "[^"]*"' "$TMPBK/bk/MANIFEST.json" | cut -d'"' -f4)"
[ -n "$fp" ] && [ "$fp" != "unknown" ] \
  && ok "enc-key fingerprint recorded" "$fp" \
  || bad "enc-key fingerprint recorded" "got '$fp' — the wrong-key check is disabled"

# And it must not be the key. Belt and braces on the one mistake that turns every
# backup into a credential leak.
if [ -f "$ROOT/.env" ]; then
  k="$(grep -E '^CREDENTIAL_ENC_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  if [ -n "$k" ] && grep -rqF "$k" "$TMPBK/bk" 2>/dev/null; then
    bad "artifact excludes CREDENTIAL_ENC_KEY" "THE KEY IS IN THE BACKUP"
  else
    ok "artifact excludes CREDENTIAL_ENC_KEY" "fingerprint only"
  fi
fi

# ── 2. restore it alongside ───────────────────────────────────────────────────
if bash "$HERE/restore.sh" "$TMPBK/bk" --suffix "$SUFFIX" >"$TMPBK/restore.log" 2>&1; then
  ok "restore --suffix completes" "into *_$SUFFIX"
else
  bad "restore --suffix completes" "$(tail -3 "$TMPBK/restore.log" | tr '\n' ' ')"; exit 1
fi

# ── 3. the live databases were not touched ────────────────────────────────────
after_ws="$(q foundry_parent 'SELECT count(*) FROM workspaces;')"
[ "$after_ws" = "$live_ws" ] \
  && ok "live foundry_parent untouched" "$live_ws workspaces before and after" \
  || bad "live foundry_parent untouched" "$live_ws → $after_ws"

# ── 4. the rows actually arrived ──────────────────────────────────────────────
# Named once, because the negative control at step 8 must perturb a table this
# loop actually compares — a control checking something unchecked proves nothing.
ROUNDTRIP_TABLES="workspaces flows flow_revisions flow_executions workspace_secrets"
for t in $ROUNDTRIP_TABLES; do
  if tables_agree "$t"; then
    ok "foundry_parent.$t round-trips" "$(q foundry_parent "SELECT count(*) FROM $t;") rows"
  else
    bad "foundry_parent.$t round-trips" \
        "live=$(q foundry_parent "SELECT count(*) FROM $t;") restored=$(q "foundry_parent_$SUFFIX" "SELECT count(*) FROM $t;")"
  fi
done


a="$(q foundry_ops 'SELECT count(*) FROM api_call_log;')"
b="$(q "foundry_ops_$SUFFIX" 'SELECT count(*) FROM api_call_log;')"
[ -n "$b" ] && [ "$a" = "$b" ] \
  && ok "foundry_ops.api_call_log round-trips" "$a rows" \
  || bad "foundry_ops.api_call_log round-trips" "live=$a restored=${b:-<missing>}"

# ── 6. a wrong key is refused ─────────────────────────────────────────────────
# The check that matters most is the one nobody exercises. Hand restore.sh an
# artifact whose fingerprint cannot match and assert it REFUSES — otherwise the
# guard is decoration.
sed -i 's/"credentialEncKeyFingerprint": "[^"]*"/"credentialEncKeyFingerprint": "deadbeefdeadbeef"/' \
  "$TMPBK/bk/MANIFEST.json"
if bash "$HERE/restore.sh" "$TMPBK/bk" --suffix "$SUFFIX" >/dev/null 2>&1; then
  bad "wrong enc-key is refused" "restore proceeded with a mismatched fingerprint"
else
  ok "wrong enc-key is refused" "restore stopped before writing"
fi

# ── 7. and refusing to guess ──────────────────────────────────────────────────
if bash "$HERE/restore.sh" "$TMPBK/bk" >/dev/null 2>&1; then
  bad "restore refuses to guess" "ran with neither --suffix nor --force"
else
  ok "restore refuses to guess" "neither --suffix nor --force → refused"
fi

# ── 8. the negative control, LAST, using the SAME comparison ──────────────────
# Every row assertion in step 4 is `tables_agree` returning 0. If it can only
# return 0 — a typo in the table name, an empty result read as agreement — that
# block is decoration and passes against an empty restore. So perturb the
# RESTORED copy and require the same function to notice.
#
# It runs last because the perturbation would otherwise corrupt step 5, and it
# perturbs the SCRATCH database, which is dropped on exit. The live one is never
# written — step 3 is the assertion that says so.
# ⚠ The subject is CHOSEN AT RUNTIME, from the same list step 4 compared, taking
# the first that actually holds rows. It used to name `flow_executions`, and that
# stopped working the moment `slate:clear` emptied it: the control went
# INCONCLUSIVE and — correctly — failed the whole run. Hardcoding a different
# table would just move the trap to whichever one is emptied next. Picking one
# with rows keeps the control live no matter what the deployment happens to hold,
# and it still refuses to pass if every candidate is empty.
CONTROL_TABLE=""
for t in $ROUNDTRIP_TABLES; do
  n="$(q "foundry_parent_$SUFFIX" "SELECT count(*) FROM $t;")"
  if [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null; then CONTROL_TABLE="$t"; break; fi
done

if [ -z "$CONTROL_TABLE" ]; then
  bad "negative control" \
      "every round-tripped table is empty ($ROUNDTRIP_TABLES) — nothing to perturb, control INCONCLUSIVE"
else
before="$(q "foundry_parent_$SUFFIX" "SELECT count(*) FROM $CONTROL_TABLE;")"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "foundry_parent_$SUFFIX" -q -c \
  "DELETE FROM $CONTROL_TABLE WHERE ctid IN (SELECT ctid FROM $CONTROL_TABLE LIMIT 1);" >/dev/null 2>&1 || true
after="$(q "foundry_parent_$SUFFIX" "SELECT count(*) FROM $CONTROL_TABLE;")"

if [ "$before" = "$after" ]; then
  # The perturbation did not happen (a foreign key refused it), so the control
  # proves nothing. Say that rather than reporting a pass — an inconclusive
  # control reported as green is the exact failure it exists to catch.
  bad "negative control" "could not perturb $CONTROL_TABLE in the restored copy ($before rows) — control INCONCLUSIVE"
elif tables_agree "$CONTROL_TABLE"; then
  bad "negative control" "$CONTROL_TABLE went $before→$after in the restored copy and the comparison still agreed"
else
  ok "negative control" "$CONTROL_TABLE $before→$after is detected"
fi
fi

echo
echo "════════════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%d passed\033[0m — the backup restores, and the restore was checked, not assumed.\n' "$PASS"
  echo
  exit 0
else
  printf '\033[32m%d passed\033[0m · \033[31m%d FAILED\033[0m\n' "$PASS" "$FAIL"
  echo
  exit 1
fi
