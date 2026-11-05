#!/usr/bin/env bash
# Wipe every workflow and run — in Foundry and in ops-api's capture tables —
# and keep the tenants: workspaces, members, users, tools, datasources, DB operations,
# secrets, schemas and the demo databases.
#
#   ./scripts/fresh-slate.sh          dry run: what would be deleted, and what is kept
#   ./scripts/fresh-slate.sh --yes    apply. No undo short of `pnpm restore`.
#
# Runs inside the compose networks (harness-in-net.sh), so it reaches the stack by service name.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--yes" ]]; then
  exec ./scripts/harness-in-net.sh packages/server/src/demo/fresh-slate.ts clear --yes
fi
exec ./scripts/harness-in-net.sh packages/server/src/demo/fresh-slate.ts
