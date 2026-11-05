#!/usr/bin/env bash
# Bring up Foundry on a local kind cluster, from the images the compose stack already built.
#
#   ./infra/k8s/kind/up.sh          create (or reuse) the cluster, install Calico + ingress, install the chart
#   ./infra/k8s/kind/check.sh       run the checks
#   ./infra/k8s/kind/down.sh        delete the cluster
#
# Needs: docker, kind, kubectl, helm. Run from the repo root. Build the images first
# (`docker compose -f infra/docker-compose.yml build`); this script does not build.
set -euo pipefail
cd "$(dirname "$0")/../../.."

CLUSTER=foundry
NS=foundry
CALICO_VERSION=v3.28.2
INGRESS_VERSION=controller-v1.11.3
# Only the images this repo builds. Upstream images (postgres:16) are pulled by the node itself: `kind load`
# of a multi-platform image from Docker Desktop fails ("content digest … not found").
IMAGES=(infra-server:latest infra-web:latest infra-ops-api:latest foundry/forge:dev foundry/flow-runner:dev)
# Plugins (plugins.enabled): loaded only when built — `docker compose build connector`.
OPTIONAL_IMAGES=(foundry/connector:dev)

say() { printf '\n== %s\n' "$*"; }

say "cluster"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --config infra/k8s/kind/cluster.yaml --wait 0s
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

say "calico (enforces NetworkPolicies)"
kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/calico.yaml" >/dev/null
kubectl -n kube-system rollout status ds/calico-node --timeout=300s
kubectl wait --for=condition=Ready node --all --timeout=180s

say "ingress-nginx"
kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/$INGRESS_VERSION/deploy/static/provider/kind/deploy.yaml" >/dev/null
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s

say "images (loaded from the local Docker, not pulled)"
for img in "${IMAGES[@]}"; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "missing image $img — build the compose stack first" >&2; exit 1; }
  kind load docker-image --name "$CLUSTER" "$img"
done
for img in "${OPTIONAL_IMAGES[@]}"; do
  docker image inspect "$img" >/dev/null 2>&1 && kind load docker-image --name "$CLUSTER" "$img"
done

say "namespace — privileged enforcement (the sandboxes need SYS_ADMIN), baseline warnings"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl label namespace "$NS" --overwrite \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/warn=baseline \
  pod-security.kubernetes.io/audit=baseline >/dev/null

say "secret from .env (values never printed)"
[ -f .env ] || { echo "no .env at the repo root" >&2; exit 1; }
kubectl -n "$NS" create secret generic foundry-env --from-env-file=.env --dry-run=client -o yaml \
  | kubectl apply -f - >/dev/null

say "chart"
helm upgrade --install foundry infra/k8s/foundry -n "$NS" -f infra/k8s/kind/values.yaml --wait --timeout 10m

say "ready — http://localhost:8088"
kubectl -n "$NS" get pods -o wide
