#!/usr/bin/env bash
# Capture the whole of Foundry's durable state as one restorable artifact.
#
# WHY THIS IS NOT `pg_dump foundry_parent`
# ────────────────────────────────────────
# Several databases share one instance (`foundry-parent-postgres`, volume
# `infra_foundry_pgdata`), and two of them are load-bearing:
#
#   foundry_parent  workspaces, workflows, runs, chats, secrets
#
# pg_dump is transactionally consistent WITHIN one database and gives no
# guarantee ACROSS databases, even on one instance. Dump them in sequence under
# load and you get a torn artifact: pointer rows naming executions that were
# never dumped, or executions with no pointer. Restore that and the runs list
# renders rows whose detail 404s — which reads as a UI bug for as long as anyone
# is willing to look.
#
# So the default mode STOPS THE WRITERS first. That is a real downtime cost and
# it is the honest one; `--online` exists, warns, and marks the artifact torn.
#
# WHAT IS DELIBERATELY NOT IN HERE
# ────────────────────────────────
#  * `CREDENTIAL_ENC_KEY`. `workspace_secrets` holds ciphertext; the key lives in
#    `.env`. Putting both in one artifact turns every backup into a full
#    credential compromise — the encryption stops being worth anything the moment
#    the tape is readable. What IS recorded is the key's FINGERPRINT, so a restore
#    can refuse a mismatched key up front instead of decrypting garbage later.
#  * The demo datasets (`hr_demo`, `hr_demo_alt`, `finance_demo`). They are
#    reseedable from the CLI and their oracle is computed from the dataset
#    definition, not the rows. `--include-demo` adds them.
#    ⚠ This list must gain every new demo database. One that is in neither list
#    is silently in no backup at all, and the omission is invisible: the
#    artifact's manifest names what it HAS, not what it skipped.
#  * Any external runtime with a SEPARATE compose stack, its own Postgres and its own
#    workspace/artifact volume (~65 MB + ~181 MB at time of writing), and agent
#    run transcripts living there. Backing that up is that stack's operation; this script
#    names the omission rather than leaving you to discover it during a restore.
#
# Usage:
#   scripts/backup.sh [--online] [--include-demo] [--out DIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

PG_CONTAINER="${PG_CONTAINER:-foundry-parent-postgres}"
PG_USER="${PG_USER:-foundry}"
CORE_DBS=(foundry_parent)  # foundry_ops left with ops-api on 2026-10-30
# ⚠ EVERY demo database must be here. One in neither this list nor the core list
# is silently in NO backup at all, and the omission is invisible: the artifact's
# manifest names what it HAS, never what it skipped, so nobody finds out until a
# restore. `itops_demo` was missing from 2026-09-03 until 2026-09-04 for exactly
# that reason — it was recorded as owed and then not done.
# fleet_demo: the compiled-builder held-out domain (D-313), reseedable with `heldout:seed`.
DEMO_DBS=(hr_demo hr_demo_alt finance_demo legal_demo itops_demo support_demo orders_demo hiring_demo fleet_demo)

# ── `foundry_sbx_*` is DELIBERATELY in neither list ─────────────────────────
#
# A development sandbox (Programme 3 Stage 4) is a PROJECTION of a frozen fixture
# that lives in `foundry_parent.datasource_fixtures` — the rows, the DDL and the
# schema fingerprint are all in a database that IS backed up, and
# `pnpm --filter @foundry/server sandbox:rebuild` replays them byte-identically
# without asking a model again (asserted by `kestra:sandbox` block 6).
#
# So this is an omission with a reason, written down. The rule the file header
# states — "a database in neither list is silently in no backup at all" — still
# holds for everything else, and the next one added must go in a list.

ONLINE=0
INCLUDE_DEMO=0
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --online)       ONLINE=1 ;;
    --include-demo) INCLUDE_DEMO=1 ;;
    --out)          OUT="$2"; shift ;;
    -h|--help)      sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-$ROOT/backups/$STAMP}"
mkdir -p "$OUT"
# The artifact carries role password hashes (see below). Lock it down before a
# single byte is written into it, not after.
chmod 700 "$OUT"

DBS=("${CORE_DBS[@]}")
[ "$INCLUDE_DEMO" = 1 ] && DBS+=("${DEMO_DBS[@]}")

say() { printf '  %s\n' "$*"; }
die() { printf '\n  FAILED: %s\n' "$*" >&2; exit 1; }

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 \
  || die "postgres container '$PG_CONTAINER' is not running"

echo
echo "Foundry backup → $OUT"
echo

# ── 1. quiesce ────────────────────────────────────────────────────────────────
# The API — the writer.
STOPPED=()
if [ "$ONLINE" = 0 ]; then
  for svc in foundry-parent-server; do
    if docker inspect -f '{{.State.Running}}' "$svc" 2>/dev/null | grep -q true; then
      docker stop "$svc" >/dev/null && STOPPED+=("$svc") && say "stopped   $svc"
    fi
  done
  # Bring them back no matter how we exit — a backup script that leaves the
  # product down on an error is worse than no backup script.
  # shellcheck disable=SC2317
  restore_services() {
    for svc in "${STOPPED[@]}"; do docker start "$svc" >/dev/null 2>&1 || true; done
    [ ${#STOPPED[@]} -gt 0 ] && say "restarted ${STOPPED[*]}"
  }
  trap restore_services EXIT
else
  say "⚠ ONLINE mode — writers left running; this artifact may be TORN across databases"
fi

# ── 2. cluster roles ──────────────────────────────────────────────────────────
# Roles are CLUSTER state, not database state, so they are absent from every
# per-database dump — and every GRANT in those dumps references them by name. A
# restore without this step fails on the first grant, which reads as a corrupt
# dump rather than a missing prerequisite.
#
# ⚠ This file contains SCRAM password hashes for foundry / foundry_ro /
# ops / ops_ro. That is why the directory is 0700.
docker exec "$PG_CONTAINER" pg_dumpall -U "$PG_USER" --roles-only > "$OUT/roles.sql" \
  || die "pg_dumpall --roles-only"
chmod 600 "$OUT/roles.sql"
say "roles.sql $(wc -l < "$OUT/roles.sql") lines (contains password hashes)"

# ── 3. the databases ──────────────────────────────────────────────────────────
for db in "${DBS[@]}"; do
  # Custom format: parallel restore, selective restore, and it compresses.
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc --no-owner --no-acl "$db" \
    > "$OUT/$db.dump" || die "pg_dump $db"
  say "$(printf '%-16s' "$db.dump") $(du -h "$OUT/$db.dump" | cut -f1)"
done

# ── 4. the manifest ───────────────────────────────────────────────────────────
# The enc-key fingerprint is a SHA-256 of the key, truncated. It is not the key
# and cannot be turned back into one, but it is enough for a restore to say "this
# is the wrong CREDENTIAL_ENC_KEY" BEFORE anything tries to decrypt with it.
# Without it the failure surfaces as a decrypt error on the first secret read,
# hours later, attributed to the wrong thing.
enc_fp="unknown"
if [ -f "$ROOT/.env" ]; then
  k="$(grep -E '^CREDENTIAL_ENC_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  [ -n "$k" ] && enc_fp="$(printf '%s' "$k" | sha256sum | cut -c1-16)"
fi

{
  echo "{"
  echo "  \"takenAt\": \"$STAMP\","
  echo "  \"mode\": \"$([ "$ONLINE" = 1 ] && echo online-TORN || echo consistent)\","
  echo "  \"crossDbConsistent\": $([ "$ONLINE" = 1 ] && echo false || echo true),"
  echo "  \"databases\": [$(printf '"%s",' "${DBS[@]}" | sed 's/,$//')],"
  echo "  \"credentialEncKeyFingerprint\": \"$enc_fp\","
  echo "  \"postgresVersion\": \"$(docker exec "$PG_CONTAINER" postgres --version | awk '{print $3}')\","
  echo "  \"notCovered\": ["
  echo "    \"CREDENTIAL_ENC_KEY itself — restore needs the matching key from .env\","
  # Redis was named here as "provisioned but holds nothing". It is now not
  # provisioned at all (archive/GAPS.md 6.4), so listing it would describe a service
  # that does not exist — and `notCovered` is read by a person deciding what a
  # restore will and will not bring back.
  echo "  ]"
  echo "}"
} > "$OUT/MANIFEST.json"
say "MANIFEST.json  enc-key fingerprint $enc_fp"

# ── 5. a fingerprint of what was captured ─────────────────────────────────────
# Row counts for the tables a restore is judged on. `backup-verify.sh` compares
# these against the restored copy; without them "the restore worked" means "psql
# exited 0", which it does for an empty database.
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d foundry_parent -t -A -F'|' -c "
  SELECT 'workspaces',      count(*) FROM workspaces
  UNION ALL SELECT 'flows',            count(*) FROM flows
  UNION ALL SELECT 'flow_revisions',   count(*) FROM flow_revisions
  UNION ALL SELECT 'flow_executions',  count(*) FROM flow_executions
  UNION ALL SELECT 'workspace_secrets',count(*) FROM workspace_secrets
  ORDER BY 1;" > "$OUT/fingerprint-foundry_parent.txt" || die "fingerprint foundry_parent"


say "fingerprints  $(tr '\n' ' ' < "$OUT/fingerprint-foundry_parent.txt")"

echo
echo "  backup complete — $(du -sh "$OUT" | cut -f1) in $OUT"
echo "  ⚠ contains role password hashes. It does NOT contain CREDENTIAL_ENC_KEY;"
echo "    a restore is useless without the matching key (fingerprint $enc_fp)."
echo
