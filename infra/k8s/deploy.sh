#!/usr/bin/env bash
# Deploy (or upgrade) Foundry into the cluster the current kubeconfig points at. Used by the pipeline for AKS and by
# kind/dry-run.sh locally, so the local run tests the same steps.
#
#   REGISTRY=myacr.azurecr.io TAG=abc1234 ENV_FILE=/path/foundry.env \
#   VALUES="infra/k8s/aks/values.yaml infra/k8s/aks/values.local.yaml" ./infra/k8s/deploy.sh
#
# ENV_FILE    the app's secrets, in .env format (the pipeline downloads it as a Secure File). Becomes the Secret
#             `foundry-env`; each pod reads only the keys the chart lists for it. If it also holds DATABASE_URL,
#             OPS_DATABASE_URL, ADMIN_DSN, OPS_DB_USER and OPS_DB_PASSWORD, those become `foundry-db` (external DB).
# DB_CA_FILE  optional: the CA that signs the database's certificate (not needed for Azure Database for PostgreSQL).
# NAMESPACE / RELEASE   default foundry / foundry.
#
# --atomic: a failed upgrade is rolled back by Helm. ⚠ Database migrations are NOT rolled back — they run forward-only
# in init containers, and the previous release must tolerate the newer schema (true of this repo's additive migrations).
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${REGISTRY:?set REGISTRY}"
: "${TAG:?set TAG}"
: "${ENV_FILE:?set ENV_FILE (the app secrets, .env format)}"
: "${VALUES:?set VALUES (one or more values files)}"
NAMESPACE=${NAMESPACE:-foundry}
RELEASE=${RELEASE:-foundry}
TIMEOUT=${TIMEOUT:-15m}
DB_KEYS="DATABASE_URL OPS_DATABASE_URL ADMIN_DSN OPS_DB_USER OPS_DB_PASSWORD"

say() { printf '\n== %s\n' "$*"; }
[ -f "$ENV_FILE" ] || { echo "ENV_FILE $ENV_FILE not found" >&2; exit 1; }

say "namespace $NAMESPACE — privileged enforcement (forge and flow-runner need SYS_ADMIN at boot), baseline warnings"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace "$NAMESPACE" --overwrite \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/warn=baseline \
  pod-security.kubernetes.io/audit=baseline >/dev/null

say "secrets (values never printed)"
# One line per key, the LAST one winning (as dotenv and compose read it): kubectl refuses a repeated key.
ENV_DEDUP=$(mktemp); trap 'rm -f "$ENV_DEDUP"' EXIT
awk '/^[[:space:]]*(#|$)/ {next} { k=$0; sub(/=.*/, "", k); if (!(k in v)) o[++n]=k; v[k]=$0 } END { for (i=1;i<=n;i++) print v[o[i]] }' \
  "$ENV_FILE" > "$ENV_DEDUP"
ENV_FILE=$ENV_DEDUP
kubectl -n "$NAMESPACE" create secret generic foundry-env --from-env-file="$ENV_FILE" --dry-run=client -o yaml \
  | kubectl apply -f - >/dev/null
db_args=()
for k in $DB_KEYS; do
  v=$(grep -E "^$k=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
  [ -n "$v" ] && db_args+=("--from-literal=$k=$v")
done
if [ ${#db_args[@]} -gt 0 ]; then
  [ ${#db_args[@]} -eq 5 ] || { echo "ENV_FILE has some of $DB_KEYS but not all five" >&2; exit 1; }
  kubectl -n "$NAMESPACE" create secret generic foundry-db "${db_args[@]}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "foundry-db from ENV_FILE (external database)"
fi
if [ -n "${DB_CA_FILE:-}" ]; then
  kubectl -n "$NAMESPACE" create configmap foundry-db-ca --from-file=ca.crt="$DB_CA_FILE" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null
fi

say "helm upgrade $RELEASE ($REGISTRY, $TAG)"
values_args=()
for f in $VALUES; do values_args+=(-f "$f"); done
# A placeholder left in a values file would deploy a sign-in address nobody can reach; refuse instead.
left=$(helm template "$RELEASE" infra/k8s/foundry -n "$NAMESPACE" "${values_args[@]}" | grep -o 'CHANGE-ME[^" ]*' | sort -u | xargs || true)
[ -z "$left" ] || { echo "values still hold placeholders: $left — set them in a values file listed in VALUES" >&2; exit 1; }
helm upgrade --install "$RELEASE" infra/k8s/foundry -n "$NAMESPACE" "${values_args[@]}" \
  --set images.server="$REGISTRY/foundry-server:$TAG" \
  --set images.web="$REGISTRY/foundry-web:$TAG" \
  --set images.opsApi="$REGISTRY/foundry-ops-api:$TAG" \
  --set images.forge="$REGISTRY/foundry-forge:$TAG" \
  --set images.flowRunner="$REGISTRY/foundry-flow-runner:$TAG" \
  --atomic --wait --timeout "$TIMEOUT"

say "deployed"
kubectl -n "$NAMESPACE" get pods -o wide
