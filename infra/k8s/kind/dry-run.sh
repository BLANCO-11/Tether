#!/usr/bin/env bash
# The pipeline's two steps, run locally: build-push.sh to a registry container, then deploy.sh into the
# `foundry-ext` namespace — external Postgres (SSL, non-superuser admin) and the chat folder on external NFS, as on AKS.
#
#   ./infra/k8s/kind/dry-run.sh            needs up.sh's cluster; starts the registry, Postgres and NFS if absent
#   NS=foundry-ext DB_HOST=pg-external ./infra/k8s/kind/check.sh     then check it
set -euo pipefail
cd "$(dirname "$0")/../../.."
NS=foundry-ext
TAG=${TAG:-$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . || echo -dirty)}
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
say() { printf '\n== %s\n' "$*"; }

say "registry kind-registry (push localhost:5001, pull kind-registry:5000)"
if ! docker inspect kind-registry >/dev/null 2>&1; then
  docker run -d --restart=always --name kind-registry --network kind -p 127.0.0.1:5001:5000 registry:2 >/dev/null
fi
docker exec foundry-control-plane sh -c '
  d=/etc/containerd/certs.d/kind-registry:5000; changed=
  [ -f $d/hosts.toml ] || { mkdir -p $d; printf "[host.\"http://kind-registry:5000\"]\n  capabilities = [\"pull\", \"resolve\"]\n" > $d/hosts.toml; changed=1; }
  grep -q "certs.d" /etc/containerd/config.toml || { printf "\n[plugins.\"io.containerd.grpc.v1.cri\".registry]\n  config_path = \"/etc/containerd/certs.d\"\n" >> /etc/containerd/config.toml; changed=1; }
  [ -z "$changed" ] || systemctl restart containerd'

say "external Postgres pg-external (SSL only; admin foundryadmin is NOT a superuser, like Azure's)"
if ! docker inspect pg-external >/dev/null 2>&1; then
  P=$WORK/pg; mkdir -p "$P"; cd "$P"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=foundry-test-ca" -keyout ca.key -out ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=pg-external" -keyout server.key -out server.csr 2>/dev/null
  printf 'subjectAltName=DNS:pg-external\n' > ext.cnf
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile ext.cnf -out server.crt 2>/dev/null
  cd - >/dev/null
  docker volume create pg-external-certs >/dev/null
  docker run --rm -v pg-external-certs:/c -v "$P":/s:ro alpine sh -c 'cp /s/ca.crt /s/server.crt /s/server.key /c/' >/dev/null
  docker run -d --name pg-external --network kind -e POSTGRES_USER=pgsuper -e POSTGRES_PASSWORD=super-pw \
    -v pg-external-certs:/certs:ro --entrypoint bash postgres:16 -c '
      install -o postgres -m 600 /certs/server.key /etc/pg.key; install -o postgres -m 644 /certs/server.crt /etc/pg.crt
      printf "local all all trust\nhostssl all all all scram-sha-256\nhost all all all reject\n" > /etc/hba.conf; chown postgres /etc/hba.conf
      mkdir -p /docker-entrypoint-initdb.d
      echo "CREATE ROLE foundryadmin LOGIN PASSWORD '"'ext-admin-pw'"' CREATEDB CREATEROLE; CREATE DATABASE foundry_parent OWNER foundryadmin;" > /docker-entrypoint-initdb.d/i.sql
      exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pg.crt -c ssl_key_file=/etc/pg.key -c hba_file=/etc/hba.conf' >/dev/null
fi
docker run --rm -v pg-external-certs:/c alpine cat /c/ca.crt > "$WORK/db-ca.crt"

say "external NFS nfs-external (root squash OFF — what Azure Files NFS must be set to)"
if ! docker inspect nfs-external >/dev/null 2>&1; then
  docker run -d --name nfs-external --network kind --privileged -v nfs-export:/export \
    -e NFS_EXPORT_0='/export *(rw,sync,no_subtree_check,no_root_squash,fsid=0)' -e NFS_DISABLE_VERSION_3=1 \
    erichough/nfs-server:2.2.1 >/dev/null
fi
kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolume
metadata: { name: foundry-ext-sandboxes-nfs }
spec:
  capacity: { storage: 10Gi }
  accessModes: [ReadWriteMany]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: nfs-static
  mountOptions: [nfsvers=4.1, hard]
  nfs: { server: nfs-external, path: / }
  claimRef: { namespace: $NS, name: foundry-sandboxes }
YAML

say "build + push ($TAG)"
REGISTRY=localhost:5001 TAG=$TAG PUSH=0 ./infra/k8s/build-push.sh
# The same images are kind-loaded for up.sh's release on this node. A pull of an identical image ID gives kubelet
# (1.37) a pull record for it, after which it refuses the kind-loaded name ("not present"). One label gives the
# dry run's images their own ID; the contents are unchanged.
for n in server web ops-api forge flow-runner; do
  printf 'FROM localhost:5001/foundry-%s:%s\nLABEL foundry.dry-run=%s\n' "$n" "$TAG" "$TAG" \
    | docker build -q -t "localhost:5001/foundry-$n:$TAG" - >/dev/null
  docker push -q "localhost:5001/foundry-$n:$TAG" >/dev/null
done

say "deploy"
H=pg-external
{ cat .env; echo
  echo "DATABASE_URL=postgres://foundryadmin:ext-admin-pw@$H:5432/foundry_parent?sslmode=verify-full"
  echo "OPS_DATABASE_URL=postgres://ops:ops-ext-pw@$H:5432/foundry_ops?sslmode=verify-full"
  echo "ADMIN_DSN=postgres://foundryadmin:ext-admin-pw@$H:5432/postgres?sslmode=require"
  echo "OPS_DB_USER=ops"; echo "OPS_DB_PASSWORD=ops-ext-pw"; } > "$WORK/foundry.env"
REGISTRY=kind-registry:5000 TAG=$TAG NAMESPACE=$NS ENV_FILE="$WORK/foundry.env" DB_CA_FILE="$WORK/db-ca.crt" \
  VALUES="infra/k8s/kind/values.yaml infra/k8s/kind/values-aks-like.yaml" TIMEOUT=10m ./infra/k8s/deploy.sh
