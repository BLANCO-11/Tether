# Foundry on Kubernetes

`foundry/` is a Helm chart for the stack in `infra/docker-compose.yml`. `kind/` runs it on a local
kind cluster and checks it.

```bash
docker compose -f infra/docker-compose.yml build   # the chart uses these images
./infra/k8s/kind/up.sh                             # kind + Calico + ingress-nginx + the chart → http://localhost:8088
./infra/k8s/kind/check.sh                          # 75 checks; every "blocked" has a control that must connect
./infra/k8s/kind/dry-run.sh                        # the pipeline's steps, locally, into an AKS-shaped namespace
NS=foundry-ext DB_HOST=pg-external ./infra/k8s/kind/check.sh   # 71 checks (no ingress in that namespace)
./infra/k8s/kind/down.sh
```

| File | What |
| :--- | :--- |
| `build-push.sh` | build the five images, tag `$REGISTRY/foundry-<name>:$TAG`, push |
| `deploy.sh` | namespace + secrets from one env file + `helm upgrade --atomic` — the pipeline and the dry run both run it |
| `aks/values.yaml`, `aks/storageclass.yaml` | AKS settings, and Azure Files NFS with root squash off |
| `../../azure-pipelines.deploy.yml` | Azure DevOps: Build (push to ACR) → Deploy (`deploy.sh`) |

Service names are the compose names (`server`, `forge`, `flow-runner`, …), so the code's defaults work unchanged.

## What the local run proved (2026-10-26, kind v0.33, Kubernetes v1.37, Calico v3.28.2)

| | Result |
| :--- | :--- |
| All seven pods start; migrations run as init containers | yes |
| `/api/health` | `degraded` only because a fresh database has no `hr_demo` (ops-api's health requires it). Not a Kubernetes issue. |
| Pod Security "baseline" refuses forge and flow-runner, and only them | yes: `SYS_ADMIN` and AppArmor `Unconfined`. They need a namespace at `privileged`. |
| `/proc` remounted `hidepid=invisible`; the running process no longer holds `SYS_ADMIN` | yes, both |
| One uid cannot see another's processes or read its folder (with controls) | yes, both |
| server and forge share the chat folder at the same path | yes (local disk; NFS still to prove on AKS) |
| NetworkPolicies, 23 probes | all hold; forge reaches the AI gateway only through forge-egress, which refuses other hosts |
| Each sandbox pod receives only its own secret | yes |
| Ingress: web, `/api/triggers`, WebSocket upgrade on `/ws` | yes (101 Switching Protocols) |
| forge / flow-runner replaced after deletion | yes, back in ~4 s |
| External Postgres, SSL required, admin NOT a superuser (as on Azure) | yes, 106 migrations; found and fixed `ops-db-init` failing with *"must be able to SET ROLE"* (PG16) |
| Node's `pg` with `sslmode=require` | treated as **verify-full**: a private CA needs `database.caConfigMap`; Azure's public CA needs nothing |
| Chat folder on external NFS 4.1 | all checks pass with root squash **off**; with it **on**, forge cannot create folders — it now refuses to start (`sandboxes_unusable`) instead of looking healthy |
| HTTPS ingress via cert-manager | certificate served, HTTP → 308, Entra callback on https, WebSocket over `wss://` |
| Pipeline scripts from a registry | from-scratch install, upgrade (chat files and data survive), a bad image rolled back by `--atomic` |
| AKS render | `kubeconform -strict`: 21/21 valid on Kubernetes 1.32, 1.33, 1.34 |
| A runaway conversation or run dies alone | yes, **since 2026-10-26** — before, one chat over the memory limit got the whole forge container `OOMKilled` (Kubernetes on cgroup v2 kills a container's processes as a group), ending every chat. See below. |

## Memory: every conversation and run has its own cap

Both sandbox entrypoints set up, while they still hold `SYS_ADMIN`:

```
/sys/fs/cgroup        the pod's own group — its limit read-only, even to root
  service/            forge's host / the runner
  work/               all conversations / runs; capped at the pod limit minus headroom (20%, at least 128 MiB)
    conv-<uid>/       one conversation (forge/host.mjs)   — sandbox.conversationMemoryBytes, default 1 GiB
    run-<uid>/        one run's steps (runner/isolation.py) — sandbox.runMemoryBytes, default 1 GiB
```

A conversation or run over its cap is killed as a group, alone; a run fails with *"ran out of memory — a run may use
1024 MB…"*. Several that together pass `work/`'s cap lose a group, never the pod. Only `work/` is writable afterwards:
with the whole tree writable, root in the pod could raise the pod's own `memory.max` (measured — it could).
The same images run under compose, where the pod limit is "none" and the per-conversation cap still applies.
Without cgroup v2 in a private namespace both refuse to start; `FORGE_REQUIRE_MEMORY_GROUPS=0` /
`FLOW_RUNNER_REQUIRE_MEMORY_GROUPS=0` run without, knowingly.

## Deploying to AKS

**Once, in Azure** (CLI shown; the portal works too):

```bash
az aks update -g <rg> -n <aks> --attach-acr <acr>                    # nodes pull from ACR, no pull secret
# the cluster needs a network-policy engine (--network-policy azure|calico|cilium) and cgroup v2 nodes
# (Ubuntu 22.04+ or Azure Linux — every current AKS node image)
kubectl apply -f infra/k8s/aks/storageclass.yaml                    # Azure Files NFS, root squash OFF
# an ingress controller (ingress-nginx, or the app-routing add-on: className webapprouting.kubernetes.azure.com)
# cert-manager + a ClusterIssuer (aks/values.yaml expects `letsencrypt`), or create the `foundry-tls` Secret yourself
```

Azure Database for PostgreSQL (Flexible Server): create database `foundry_parent`; the admin login is enough
(`ops-db-init` creates the `ops` role and `foundry_ops`). Allow the cluster's subnet to reach it (private access /
VNet integration, or a private endpoint). Entra app registration: add redirect URI
`https://<host>/api/auth/callback/microsoft-entra-id`.

**Per deployment, in git**: copy `aks/values.yaml`'s `CHANGE-ME` keys into `aks/values.<namespace>.yaml`
(host, database host, URLs — nothing secret). The pipeline layers it on; `deploy.sh` refuses while any placeholder is left.

**In Azure DevOps** (project `foundry`):

| Where | State |
| :--- | :--- |
| Library → `foundry-deploy` | **created** (2026-10-26): `CLUSTER_RG`, `CLUSTER_NAME`, `NAMESPACE=foundry`; **fill in `REGISTRY_NAME`** (ACR name, no `.azurecr.io`) |
| Library → `foundry-app` | **created**: the app's 23 keys from `.env` (11 marked secret) and the 5 database keys — **fill in `DATABASE_URL`, `OPS_DATABASE_URL` (`?sslmode=verify-full`), `ADMIN_DSN` (`/postgres?sslmode=require`), `OPS_DB_PASSWORD`** once the database exists (`OPS_DB_USER=ops`) |
| Service connections | **to create**: an Azure Resource Manager connection named `foundry-azure` (or pass `armConnection`), with push on the ACR and *Azure Kubernetes Service Cluster User* on the cluster |
| Agent pool | the cluster is **private**: the deploy runs on the self-hosted pool `AKS Cluster` (parameter `deployPool`), whose agent needs `az`, `kubectl`, `helm` |
| Environments | `foundry-prod` exists — add an Approval check to have a person release each deploy |
| Pipelines → New pipeline | existing YAML, `azure-pipelines.deploy.yml`; authorise both groups, the connection, the pool and the environment on the first run |

The pipeline writes the app's env file from `foundry-app` on the agent (mode 0600, deleted after) and stops if the
database keys are empty. To change a value: Library → the group → edit; the next deploy picks it up.

## Still to prove on a real AKS cluster

AppArmor on the chosen node image · Azure Files NFS itself (ownership semantics are proven on NFS locally) · Key Vault
CSI (optional: the env file is a Secure File today) · private networking to Azure Database for PostgreSQL · the
production ingress controller · Kata pod sandboxing (optional).

## Known caveats

- `kubectl exec` into forge or flow-runner gives a shell **with** `SYS_ADMIN`. Only the entrypoint's own process tree
  drops it. Keep `pods/exec` on those pods out of everyday RBAC.
- `server`, `forge` and `flow-runner` must stay at one replica (in-process scheduler, local uid locks).
- With an external database set `postgres.inCluster: false` and `database.host`; `deploy.sh` makes the `foundry-db`
  Secret from the env file. Node connection strings use `sslmode=verify-full` (what `pg` does anyway), `ADMIN_DSN`
  (psql only) `sslmode=require`.
- A failed deploy is rolled back by `--atomic`, but server, forge and flow-runner are Recreate (one copy only), so they
  are down until the rollback finishes. Database migrations are never rolled back.
- Images for AKS are built on the pipeline's amd64 agent; an image built on an arm Mac will not run on amd64 nodes.
