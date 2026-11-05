#!/usr/bin/env bash
# Build the five images this repo makes, tag them for a registry, push them.
#
#   REGISTRY=myacr.azurecr.io TAG=$(git rev-parse --short HEAD) ./infra/k8s/build-push.sh
#
# The pipeline runs this after logging in to the registry; locally, kind/dry-run.sh runs it against a registry
# container. Built through compose, because flow-runner is FROM the fragment-base image compose builds first.
# Images land as $REGISTRY/foundry-<name>:$TAG — the names deploy.sh expects.
#
# Optional: CORP_CA_FILE=corp-ca.pem when building behind a TLS-intercepting proxy (see CLAUDE.md, "Corporate CA").
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${REGISTRY:?set REGISTRY, e.g. myacr.azurecr.io}"
: "${TAG:?set TAG, e.g. the commit sha}"
PUSH=${PUSH:-1}

# compose image name -> the name in the registry
IMAGES=(
  "infra-server:latest foundry-server"
  "infra-web:latest foundry-web"
  "infra-ops-api:latest foundry-ops-api"
  "foundry/forge:dev foundry-forge"
  "foundry/flow-runner:dev foundry-flow-runner"
)

# .env.example: a build needs no secret, and a clean agent has no .env. CORP_CA_FILE comes from the environment.
docker compose --env-file .env.example -f infra/docker-compose.yml build fragment-base server web ops-api forge flow-runner

for pair in "${IMAGES[@]}"; do
  set -- $pair
  docker tag "$1" "$REGISTRY/$2:$TAG"
  [ "$PUSH" = 1 ] && docker push "$REGISTRY/$2:$TAG"
done
echo "built: $REGISTRY/foundry-{server,web,ops-api,forge,flow-runner}:$TAG"
