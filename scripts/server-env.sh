#!/usr/bin/env bash
# Prints `export` lines for a HOST-run harness: the credentials it needs, read live out of the running server
# container rather than duplicated, plus where the API is.
#
#   eval "$(./scripts/server-env.sh)"
set -euo pipefail
SERVER="${FOUNDRY_SERVER_CONTAINER:-foundry-parent-server}"
if ! docker inspect "$SERVER" >/dev/null 2>&1; then
  echo "echo 'container $SERVER is not running — docker compose -f infra/docker-compose.yml up -d' >&2; exit 1"
  exit 0
fi
for k in RUNTIME_JWT_SECRET PARENT_API_KEY; do
  docker exec "$SERVER" env | grep "^$k=" | sed 's/^/export /; s/=\(.*\)$/="\1"/' || true
done
echo "export FOUNDRY_BASE_URL=\"${FOUNDRY_BASE_URL:-http://127.0.0.1:4000}\""
