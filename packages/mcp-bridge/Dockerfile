# Foundry MCP schema bridge — production image (multi-stage).
#   docker build -f packages/mcp-bridge/Dockerfile -t foundry-mcp-bridge .
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
COPY packages/mcp-bridge/package.json packages/mcp-bridge/
RUN pnpm install --filter @foundry/mcp-bridge... --frozen-lockfile=false
COPY packages/mcp-bridge packages/mcp-bridge
RUN pnpm --filter @foundry/mcp-bridge build

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
COPY packages/mcp-bridge/package.json packages/mcp-bridge/
RUN pnpm install --filter @foundry/mcp-bridge --prod --frozen-lockfile=false
COPY --from=build /repo/packages/mcp-bridge/dist packages/mcp-bridge/dist
EXPOSE 4003
CMD ["node", "packages/mcp-bridge/dist/index.js"]
