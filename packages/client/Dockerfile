# Foundry Parent web (Next.js) — production image.
#   docker build -f packages/client/Dockerfile -t foundry-parent-web .
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
# @foundry/flow-edit is a workspace dependency (D-121 — the canvas's pure edit
# functions, shared with the server so `spliceApproval` has ONE implementation).
# Its SOURCE is copied before the install because the root `postinstall` builds
# it, and `next build` resolves the package through its `dist`.
COPY packages/flow-edit packages/flow-edit
# @foundry/shared is a workspace dependency of the client (declared in its
# package.json; the workspace must resolve it even where the client keeps local
# mirrors). Source copied before the install because the root `postinstall`
# builds it.
COPY packages/shared packages/shared
COPY packages/client/package.json packages/client/
RUN pnpm install --filter @foundry/client... --frozen-lockfile=false
COPY packages/client packages/client
# ⚠ A `NEXT_PUBLIC_*` value is inlined by `next build`, so one must be passed HERE as a build argument; setting it on
# the running container does nothing. (NEXT_PUBLIC_BUILDER_CHAT was the last one; nothing reads it since 2026-09-28.)
RUN pnpm --filter @foundry/client build

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
# Install ONLY the client's production deps here (fresh, so the pnpm store is
# present in this stage) — otherwise `next start` would trigger a full network
# reinstall at container startup because the build stage's node_modules symlinks
# point at a store that isn't copied over.
COPY pnpm-workspace.yaml package.json ./
COPY packages/flow-edit/package.json packages/flow-edit/
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
# `--ignore-scripts`: a --prod install has no typescript, so the root
# `postinstall` cannot build @foundry/flow-edit — and does not need to. Its dist
# is copied from the build stage below. (Same reasoning as packages/server.)
RUN pnpm install --filter @foundry/client --prod --frozen-lockfile=false --ignore-scripts
COPY --from=build /repo/packages/flow-edit/dist packages/flow-edit/dist
COPY --from=build /repo/packages/shared/dist packages/shared/dist
# Bring only the built app + its config from the build stage (not source/node_modules).
COPY --from=build /repo/packages/client/.next packages/client/.next
COPY --from=build /repo/packages/client/next.config.mjs packages/client/next.config.mjs
WORKDIR /repo/packages/client
EXPOSE 4002
CMD ["pnpm", "start"]
