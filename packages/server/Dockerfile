# Foundry Parent API — production image (multi-stage).
# Build context is the repo root so the pnpm workspace resolves.
#   docker build -f packages/server/Dockerfile -t foundry-parent-server .
FROM node:24-slim AS build
WORKDIR /repo
# ── Corporate CA trust — OPTIONAL, and OFF unless explicitly requested ───────
#
# Feature 20260824-211547-docker-ca-trust. A build container inherits no host
# environment and no host filesystem, so the workstation's own NODE_EXTRA_CA_CERTS
# cannot reach this build. Behind a TLS-intercepting proxy every fetch below dies
# with UNABLE_TO_GET_ISSUER_CERT_LOCALLY unless the corporate root is supplied here.
#
# ⚠ NODE_EXTRA_CA_CERTS *appends* to Node's built-in roots, so the single corporate
# root is sufficient and public trust is preserved. Do NOT "improve" this to
# --use-openssl-ca: node:22-slim has NO system trust store at all — no
# ca-certificates package, no /etc/ssl/certs/ca-certificates.crt, no
# update-ca-certificates, no openssl — so that flag reduces trust to nothing.
# Measured; see specs/20260824-211547-docker-ca-trust/baseline-pre-change.txt.
#
# ⚠ Trust follows the ARG, never the presence of a file. A staged-but-unrequested
# certificate is copied in and ignored, so two developers' builds can never differ
# by the contents of an untracked directory.
#
# ⚠ The refusals below are the point, not defensiveness. Node treats an UNREADABLE
# NODE_EXTRA_CA_CERTS as ABSENT and silently falls back to its bundled roots — so
# without them a typo reproduces the original error several steps later with
# nothing naming the cause. Validation uses node's own crypto because there is no
# openssl in this image.
ARG CORP_CA_FILE=
COPY infra/certs/ /tmp/foundry-ca/
RUN set -eu; \
    if [ -n "${CORP_CA_FILE:-}" ]; then \
      case "${CORP_CA_FILE}" in \
        */*) echo "corp-ca: CORP_CA_FILE must be a bare filename, got '${CORP_CA_FILE}'." >&2; exit 1 ;; \
      esac; \
      src="/tmp/foundry-ca/${CORP_CA_FILE}"; \
      if [ ! -f "$src" ]; then \
        echo "corp-ca: '${CORP_CA_FILE}' not found in /tmp/foundry-ca/ (staged from infra/certs/)." >&2; \
        echo "corp-ca: stage it with ./scripts/stage-corp-ca.sh, or unset CORP_CA_FILE to build without a corporate CA." >&2; \
        exit 1; \
      fi; \
      node -e 'const fs=require("fs");const{X509Certificate}=require("crypto");new X509Certificate(fs.readFileSync(process.argv[1]))' "$src" \
        || { echo "corp-ca: '${CORP_CA_FILE}' is not a parseable X.509 certificate." >&2; exit 1; }; \
      mkdir -p /etc/foundry; \
      cp "$src" /etc/foundry/corp-ca.pem; \
      echo "corp-ca: trusting ${CORP_CA_FILE}"; \
    fi
ENV NODE_EXTRA_CA_CERTS=${CORP_CA_FILE:+/etc/foundry/corp-ca.pem}
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
# @foundry/redact is a workspace dependency (the redaction control is shared with
# ops-api — one regex, because a copied security control drifts silently). Its
# SOURCE is copied before the install because the root `postinstall` builds it.
COPY packages/redact packages/redact
# @foundry/flow-edit is a workspace dependency of the server (the one editing
# vocabulary — D-121). Its source is copied before the install so the workspace
# resolves; `pnpm --filter @foundry/server build` below builds its dist.
COPY packages/flow-edit packages/flow-edit
# @foundry/shared is a workspace dependency (the guardrail-port rules — egress,
# rate-limit, request-policy — shared with every process). Source copied before
# the install because the root `postinstall` builds it.
COPY packages/shared packages/shared
COPY packages/server/package.json packages/server/
RUN pnpm install --filter @foundry/server... --frozen-lockfile=false
COPY packages/server packages/server
RUN pnpm --filter @foundry/server build

FROM node:22-slim AS runtime
WORKDIR /repo
# ── Corporate CA trust — OPTIONAL, and OFF unless explicitly requested ───────
#
# Feature 20260824-211547-docker-ca-trust. A build container inherits no host
# environment and no host filesystem, so the workstation's own NODE_EXTRA_CA_CERTS
# cannot reach this build. Behind a TLS-intercepting proxy every fetch below dies
# with UNABLE_TO_GET_ISSUER_CERT_LOCALLY unless the corporate root is supplied here.
#
# ⚠ NODE_EXTRA_CA_CERTS *appends* to Node's built-in roots, so the single corporate
# root is sufficient and public trust is preserved. Do NOT "improve" this to
# --use-openssl-ca: node:22-slim has NO system trust store at all — no
# ca-certificates package, no /etc/ssl/certs/ca-certificates.crt, no
# update-ca-certificates, no openssl — so that flag reduces trust to nothing.
# Measured; see specs/20260824-211547-docker-ca-trust/baseline-pre-change.txt.
#
# ⚠ Trust follows the ARG, never the presence of a file. A staged-but-unrequested
# certificate is copied in and ignored, so two developers' builds can never differ
# by the contents of an untracked directory.
#
# ⚠ The refusals below are the point, not defensiveness. Node treats an UNREADABLE
# NODE_EXTRA_CA_CERTS as ABSENT and silently falls back to its bundled roots — so
# without them a typo reproduces the original error several steps later with
# nothing naming the cause. Validation uses node's own crypto because there is no
# openssl in this image.
ARG CORP_CA_FILE=
COPY infra/certs/ /tmp/foundry-ca/
RUN set -eu; \
    if [ -n "${CORP_CA_FILE:-}" ]; then \
      case "${CORP_CA_FILE}" in \
        */*) echo "corp-ca: CORP_CA_FILE must be a bare filename, got '${CORP_CA_FILE}'." >&2; exit 1 ;; \
      esac; \
      src="/tmp/foundry-ca/${CORP_CA_FILE}"; \
      if [ ! -f "$src" ]; then \
        echo "corp-ca: '${CORP_CA_FILE}' not found in /tmp/foundry-ca/ (staged from infra/certs/)." >&2; \
        echo "corp-ca: stage it with ./scripts/stage-corp-ca.sh, or unset CORP_CA_FILE to build without a corporate CA." >&2; \
        exit 1; \
      fi; \
      node -e 'const fs=require("fs");const{X509Certificate}=require("crypto");new X509Certificate(fs.readFileSync(process.argv[1]))' "$src" \
        || { echo "corp-ca: '${CORP_CA_FILE}' is not a parseable X.509 certificate." >&2; exit 1; }; \
      mkdir -p /etc/foundry; \
      cp "$src" /etc/foundry/corp-ca.pem; \
      echo "corp-ca: trusting ${CORP_CA_FILE}"; \
    fi
ENV NODE_EXTRA_CA_CERTS=${CORP_CA_FILE:+/etc/foundry/corp-ca.pem}
RUN corepack enable

# ── NO pi and NO Python here (2026-10-13) ────────────────────────────────────
#
# Forge (the `pi` agent) and its document tools used to be installed in this image and run as children of this
# server, the process holding every secret, with a route to Postgres. They live in the `forge` container now
# (packages/forge): each conversation as its own Linux user, no secrets, no route but the AI gateway. This server
# reaches it over FORGE_HOST. Do not install pi here again to "just run one".

ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json ./
COPY packages/redact/package.json packages/redact/
COPY packages/flow-edit/package.json packages/flow-edit/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
# `--ignore-scripts`: a --prod install has no typescript, so the root
# `postinstall` cannot build @foundry/redact and does not need to — its dist is
# copied from the build stage below.
RUN pnpm install --filter @foundry/server... --prod --frozen-lockfile=false --ignore-scripts
COPY --from=build /repo/packages/redact/dist packages/redact/dist
COPY --from=build /repo/packages/flow-edit/dist packages/flow-edit/dist
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/server/dist packages/server/dist
# Drizzle migration files (SQL + meta/_journal.json) are read at runtime by the
# migrate step — they live outside dist, so copy them explicitly.
COPY --from=build /repo/packages/server/drizzle packages/server/drizzle
# Pi builder — blank sandbox template (not compiled; lives beside dist).
COPY --from=build /repo/packages/server/pi-builder-template packages/server/pi-builder-template
# Edge agent bootstrap served at GET /api/edge/agent.mjs (personal thin hands-free setup).
COPY --from=build /repo/packages/server/assets packages/server/assets
RUN mkdir -p packages/server/.pi-sandboxes

# ── NO docker CLI, and no docker.sock (D-28) ─────────────────────────────────
#
# This stage used to fetch the static Docker client from download.docker.com,
# because `execution.service.ts` ran every generated script via `spawn("docker",
# …)` against the host socket. Phase 4 deleted that service, and nothing in
# packages/server spawns a subprocess of any kind now — verifiable in one grep:
#
#   grep -rn "spawn\|execFile\|child_process" packages/server/src --include=*.ts
#
# Removing it does three things worth stating, in descending order of importance:
#
#   1. The API server no longer needs /var/run/docker.sock. It was a route onto
#      the host daemon held by the one process that terminates tenant HTTP and
#      holds PARENT_API_KEY / TETHER_API_KEY / CREDENTIAL_ENC_KEY. Kestra is now
#      the sole holder — unreachable by clients (R5), emitting only task types
#      the compiler chose (R8). See infra/docker-compose.yml.
#   2. The build stops reaching the internet for a 70 MB tarball, so it works on
#      an air-gapped or proxied builder.
#   3. `curl` and `ca-certificates` go with it, which is why the compose
#      healthcheck for this service uses `node -e` and fetch() instead.
#
# If something here ever needs to launch a container again, that is a design
# question (why is it not a Kestra task?) before it is a Dockerfile question.
EXPOSE 4000 4001
CMD ["node", "packages/server/dist/index.js"]
