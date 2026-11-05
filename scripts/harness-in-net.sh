#!/usr/bin/env bash
# Runs a host-authored harness FROM INSIDE the compose networks.
#
#   scripts/harness-in-net.sh packages/server/src/scenarios/itops-verify.ts [args…]
#
# ── Why this exists ─────────────────────────────────────────────────────────
#
# A harness that talks to the stack by service name (postgres, ops-api, server) works only from inside the compose
# network. This runs it there, in the SAME network position the server occupies: a throwaway container on
# `infra_default`. No port is published and nothing outlives the command.
#
# ── What it takes from where ────────────────────────────────────────────────
#
# The server container's whole environment, read live rather than duplicated.
#
# The repo is bind-mounted from the host, so the harness runs against the working
# tree and the host's installed `node_modules` — the server IMAGE has neither.
set -euo pipefail

SERVER="${FOUNDRY_SERVER_CONTAINER:-foundry-parent-server}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ $# -lt 1 ]; then
  echo "usage: $0 <path/to/harness.ts> [args…]" >&2
  exit 2
fi
if ! docker inspect "$SERVER" >/dev/null 2>&1; then
  echo "container $SERVER is not running — docker compose -f infra/docker-compose.yml up -d" >&2
  exit 1
fi

SCRIPT="$1"; shift
if [ ! -f "$REPO/$SCRIPT" ]; then
  echo "no such harness: $SCRIPT (paths are relative to the repo root)" >&2
  exit 2
fi

# The server's environment, verbatim, as a file docker can consume. Written to a
# private temp file and removed on exit: it carries PARENT_API_KEY,
# CREDENTIAL_ENC_KEY. 
ENVFILE="$(mktemp)"
chmod 600 "$ENVFILE"
trap 'rm -f "$ENVFILE"' EXIT
docker inspect "$SERVER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > "$ENVFILE"

NAME="foundry-harness-$$"
# On `infra_default`, where Postgres, ops-api and the server live.
# The container's lifetime bounds the harness: 900 s unless HARNESS_LIFETIME_SECS says otherwise (a whole-goal-set
# measurement runs about an hour). The EXIT trap below removes it either way; nothing outlives the command.
docker run -d --name "$NAME" \
  --network infra_default \
  -v "$REPO":/repo -w "/repo/$(dirname "$SCRIPT")" \
  --env-file "$ENVFILE" \
  --entrypoint sleep node:22-slim "${HARNESS_LIFETIME_SECS:-900}" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$ENVFILE"' EXIT
# The server is on more than `infra_default` (the runner's and Forge's internal networks), and a harness that starts a
# run must reach the runner the way the server does — so join every network the server is on.
for NET in $(docker inspect "$SERVER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'); do
  [ "$NET" = "infra_default" ] || docker network connect "$NET" "$NAME" >/dev/null
done

# ⚠ THE HOST'S `tsx` CANNOT BE REUSED, and the reason is worth stating because
# the error does not say it: `tsx` bundles `esbuild`, whose binary is
# platform-specific, so the host's darwin-arm64 copy dies inside a linux
# container with a stack trace about `generateBinPath` and no mention of
# architecture.
#
# Only the TOOLCHAIN has that problem. Every runtime dependency this repo's
# harnesses use — `pg`, `drizzle-orm`, `zod` — is pure JavaScript, so the host's
# installed `node_modules` is fine for the application and a container-local
# `tsx` is all that is missing. Installed here rather than baked into an image
# so this script stays a script.
docker exec -i "$NAME" npm i -g --silent tsx >/dev/null
docker exec -i "$NAME" tsx "/repo/$SCRIPT" "$@"
