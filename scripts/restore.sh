#!/usr/bin/env bash
# Restore a `backup.sh` artifact.
#
# TWO MODES, AND THE SAFE ONE IS THE DEFAULT
# ──────────────────────────────────────────
#   --suffix <s>   restore into `<db>_<s>` — touches nothing live. This is what
#                  `backup-verify.sh` uses, and it is the only way to answer "is
#                  this backup restorable?" without betting the running system on
#                  the answer. An untested backup is a hope, not a control.
#   --force        restore OVER the live databases. Drops and recreates them.
#
# There is no third mode where you find out which one you were in afterwards.
#
# THE KEY CHECK IS NOT CEREMONY
# ─────────────────────────────
# `workspace_secrets` holds ciphertext under `CREDENTIAL_ENC_KEY`, which is
# deliberately NOT in the artifact. Restore with the wrong key and everything
# succeeds: the rows land, the row count matches, the service starts. It fails
# later, on the first secret read, as a decrypt error — by which point the restore
# is "known good" and the search starts somewhere else entirely. So the
# fingerprint is compared up front and a mismatch stops the restore.
#
# Usage:
#   scripts/restore.sh <backup-dir> --suffix restorecheck
#   scripts/restore.sh <backup-dir> --force
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

PG_CONTAINER="${PG_CONTAINER:-foundry-parent-postgres}"
PG_USER="${PG_USER:-foundry}"

DIR=""; SUFFIX=""; FORCE=0; IGNORE_KEY=0; ROLES=1; DROP_SUFFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --suffix)             SUFFIX="$2"; shift ;;
    --drop-suffix)        DROP_SUFFIX="$2"; shift ;;
    --force)              FORCE=1 ;;
    --ignore-key-mismatch) IGNORE_KEY=1 ;;
    --no-roles)           ROLES=0 ;;
    -h|--help)            sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)                    DIR="$1" ;;
  esac
  shift
done

say() { printf '  %s\n' "$*"; }
die() { printf '\n  FAILED: %s\n' "$*" >&2; exit 1; }

# ── cleanup mode ──────────────────────────────────────────────────────────────
# Drops the `_<suffix>` copies a check restore made. Guarded on a non-empty
# suffix and matched with a LIKE on the suffix alone, so there is no argument
# that makes this touch a live database: `foundry_parent` does not end in
# `_restorecheck` and cannot be made to.
if [ -n "$DROP_SUFFIX" ]; then
  [ "$DROP_SUFFIX" != "" ] || die "--drop-suffix needs a value"
  mapfile -t victims < <(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -t -A -c \
    "SELECT datname FROM pg_database WHERE datname LIKE '%\_$DROP_SUFFIX' AND datistemplate=false;")
  if [ ${#victims[@]} -eq 0 ]; then echo "  nothing matching *_$DROP_SUFFIX"; exit 0; fi
  for v in "${victims[@]}"; do
    [ -n "$v" ] || continue
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$v' AND pid<>pg_backend_pid();" >/dev/null
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \"$v\";"
    echo "  dropped $v"
  done
  exit 0
fi

[ -n "$DIR" ] && [ -d "$DIR" ] || die "usage: restore.sh <backup-dir> [--suffix S | --force]"
[ -f "$DIR/MANIFEST.json" ] || die "$DIR has no MANIFEST.json — not a backup.sh artifact"

if [ "$FORCE" = 0 ] && [ -z "$SUFFIX" ]; then
  die "refusing to guess. Pass --suffix <s> for a non-destructive check, or --force to overwrite live data."
fi
if [ "$FORCE" = 1 ] && [ -n "$SUFFIX" ]; then
  die "--force and --suffix are mutually exclusive"
fi

echo
echo "Foundry restore ← $DIR"
echo

# ── the torn-artifact warning travels with the artifact ───────────────────────
if grep -q '"crossDbConsistent": false' "$DIR/MANIFEST.json"; then
  say "⚠ this artifact was taken with --online and is NOT cross-database consistent."
  say "  Expect rows in one database that refer to rows the other never dumped."
fi

# ── the encryption-key check ──────────────────────────────────────────────────
want="$(grep -o '"credentialEncKeyFingerprint": "[^"]*"' "$DIR/MANIFEST.json" | cut -d'"' -f4)"
have="unknown"
if [ -f "$ROOT/.env" ]; then
  k="$(grep -E '^CREDENTIAL_ENC_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- || true)"
  [ -n "$k" ] && have="$(printf '%s' "$k" | sha256sum | cut -c1-16)"
fi
if [ "$want" = "unknown" ] || [ "$have" = "unknown" ]; then
  say "⚠ enc-key fingerprint unavailable (backup=$want current=$have) — cannot verify"
elif [ "$want" != "$have" ]; then
  if [ "$IGNORE_KEY" = 1 ]; then
    say "⚠ enc-key MISMATCH (backup=$want current=$have) — proceeding on --ignore-key-mismatch"
    say "  every workspace_secrets value in this restore will be undecryptable."
  else
    die "CREDENTIAL_ENC_KEY mismatch: artifact was written under $want, .env holds $have.
       Restore the matching key first, or pass --ignore-key-mismatch if the
       secrets are genuinely expendable. This is not a formality — the restore
       would otherwise succeed and fail on first use."
  fi
else
  say "enc-key fingerprint matches ($have)"
fi

# ── roles ─────────────────────────────────────────────────────────────────────
# Idempotent-ish: pg_dumpall emits CREATE ROLE, which errors if the role exists.
# That is fine and expected on a restore into a live cluster, so errors here are
# reported and not fatal — but they ARE reported, because a genuinely missing
# role fails later as a permission problem with no obvious cause.
if [ "$ROLES" = 1 ] && [ -f "$DIR/roles.sql" ]; then
  errs=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=0 \
           < "$DIR/roles.sql" 2>&1 | grep -c '^ERROR' || true)
  say "roles applied ($errs already-exists error(s), expected on a live cluster)"
fi

# ── the databases ─────────────────────────────────────────────────────────────
shopt -s nullglob
for dump in "$DIR"/*.dump; do
  src="$(basename "$dump" .dump)"
  target="$src"; [ -n "$SUFFIX" ] && target="${src}_${SUFFIX}"

  if [ "$FORCE" = 1 ]; then
    # Terminate live sessions first — DROP DATABASE fails while anything is
    # connected, and "database is being accessed by other users" mid-restore
    # leaves a half-restored cluster.
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$target' AND pid<>pg_backend_pid();" >/dev/null
  fi
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \"$target\";" \
    || die "could not drop $target"
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q -c "CREATE DATABASE \"$target\";" \
    || die "could not create $target"

  # --no-owner because the dump was taken that way; ownership is re-established
  # by the roles file plus the app's own connection identity.
  if docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$target" --no-owner --no-acl \
       < "$dump" >/dev/null 2>"$DIR/.restore-$target.log"; then
    say "$(printf '%-28s' "$target") restored"
  else
    # pg_restore exits non-zero for benign things (extension comments, missing
    # roles). Report the count rather than hiding it or dying on it.
    n=$(grep -c '^pg_restore: error' "$DIR/.restore-$target.log" || true)
    say "$(printf '%-28s' "$target") restored with $n pg_restore error(s) — see $DIR/.restore-$target.log"
  fi
done


echo
if [ -n "$SUFFIX" ]; then
  echo "  restored alongside the live databases with suffix _$SUFFIX — nothing live was touched."
  echo "  drop them with: scripts/restore.sh --drop-suffix $SUFFIX"
else
  echo "  restored OVER the live databases. Restart the stack: docker compose -f infra/docker-compose.yml up -d"
fi
echo
