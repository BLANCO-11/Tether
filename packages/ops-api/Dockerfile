# Foundry ops-api — the operational tool layer, :4004 (multi-stage).
# Build context is the repo root so the pnpm workspace resolves.
#   docker build -f packages/ops-api/Dockerfile -t foundry-ops-api .
#
# `@foundry/redact` is a workspace dependency, so its package.json must be
# copied before `pnpm install` for the filter to resolve it, and its source
# before the build. That shared package is the ONLY thing this image takes from
# the rest of the repo — there is no dependency on @foundry/server, and adding
# one would drag the parent's config loader, Drizzle schema and credential
# encryptor into a process whose whole purpose is holding none of them.
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
# Redact's SOURCE comes before the install, not after, because the root
# `postinstall` builds it — and a build step that runs before its own source
# exists fails with `tsc: not found`-adjacent noise that points nowhere near the
# ordering.
COPY packages/redact packages/redact
COPY packages/ops-api/package.json packages/ops-api/
RUN pnpm install --filter @foundry/ops-api... --frozen-lockfile=false
COPY packages/ops-api packages/ops-api
RUN pnpm --filter @foundry/ops-api build

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
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json ./
COPY packages/redact/package.json packages/redact/
COPY packages/ops-api/package.json packages/ops-api/
# `--ignore-scripts`: a --prod install has no typescript, so the root
# `postinstall` (which builds @foundry/redact) cannot run and does not need to —
# both dists are copied from the build stage on the next two lines.
RUN pnpm install --filter @foundry/ops-api... --prod --frozen-lockfile=false --ignore-scripts
COPY --from=build /repo/packages/redact/dist packages/redact/dist
COPY --from=build /repo/packages/ops-api/dist packages/ops-api/dist

# No docker CLI, no socket, no curl — for the same reasons as the parent image
# (D-28), and one more that is specific to this service: it is the process that
# terminates calls made by generated automations. Its blast radius is its own
# database and a read-only view of hr_demo, and every binary added here is an
# argument about whether that is still true.
#
# It also runs as a non-root user, which the parent image does not — nothing
# here stages a mode-600 script the way Kestra does for a fragment, so there is
# no reason for this process to be root.
USER node
EXPOSE 4004
CMD ["node", "packages/ops-api/dist/index.js"]
