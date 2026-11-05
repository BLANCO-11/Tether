# O2 — THE base image for every `code` step fragment. One image, all fragments.
# docs/kestra-migration/09-risks-and-verification.md O2 · 04 §5.3.2
#
# ── Why one image and not one per flow ───────────────────────────────────────
#
# Per-flow images mean per-flow dependency resolution: slow, and a supply-chain
# surface that grows with every automation. Under R9 a fragment is a PURE
# FUNCTION with no I/O, so it needs almost nothing — `requirements.txt`
# generation is deleted (07 §7.0.1), not replaced.
#
# ── The import set is a contract, not a convenience ──────────────────────────
#
# The fragment prompt names this exact set, and the validator rejects an import
# outside it. Both matter: without the prompt the model reaches for `requests`
# and you get an `ImportError` that reads like a code bug rather than a
# misconfiguration; without the validator you find out at execution.
#
# **Bumping this image is a deliberate, versioned change.** Every existing
# fragment was generated against the import set below, so the tag carries the
# python version AND the pandas version — a silent rebuild under the same tag
# would invalidate fragments nobody re-tested.
#
#   docker build -f infra/fragment-base/Dockerfile \
#     -t foundry/fragment-base:py3.12-pandas2.2.3 infra
#
# ⚠ The context is `infra`, NOT `infra/fragment-base`. It was moved up one level
# so that one staged corporate CA (infra/certs/) serves every build context in
# the repo. Building with the old context fails at `COPY certs/`.
#
# Digest-pinned base: `python:3.12-slim` is a moving tag, and "the same image
# for every fragment" is worth nothing if the tag drifts between builds.
FROM python@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

# ── Corporate CA trust — OPTIONAL, and OFF unless explicitly requested ───────
#
# Feature 20260824-211547-docker-ca-trust. Behind a TLS-intercepting proxy the
# pip install below dies with CERTIFICATE_VERIFY_FAILED unless the corporate root
# is trusted here.
#
# ⚠ THE ANCHOR FILE MUST END IN `.crt`. update-ca-certificates only processes
# *.crt in /usr/local/share/ca-certificates — a `.pem` placed there is SILENTLY
# IGNORED, with no error and no warning. The staged file is `.pem` because
# .gitignore covers `*.pem` and has no `*.crt` rule (staging a `.crt` would put
# key material under a name git does not exclude), so the rename happens on the
# `cp` below, where git cannot see it.
#
# ⚠ PIP_CERT names the FULL system bundle, never the lone corporate root. Unlike
# Node's NODE_EXTRA_CA_CERTS, which appends, PIP_CERT *replaces* — pointing it at
# the single root would remove trust in every public authority.
#
# ⚠ MEASURED: pip 25.0.1 vendors `truststore` and consults the system store, so
# update-ca-certificates alone is sufficient and PIP_CERT is belt-and-braces. It
# is kept so this build depends on a bundle we named rather than on pip's current
# default. Baseline 150 certificates -> 151 after the refresh.
ARG CORP_CA_FILE=
COPY certs/ /tmp/foundry-ca/
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
      openssl x509 -noout -in "$src" \
        || { echo "corp-ca: '${CORP_CA_FILE}' is not a parseable X.509 certificate." >&2; exit 1; }; \
      cp "$src" /usr/local/share/ca-certificates/corp-ca.crt; \
      update-ca-certificates; \
      echo "corp-ca: trusting ${CORP_CA_FILE}"; \
    fi
ENV PIP_CERT=${CORP_CA_FILE:+/etc/ssl/certs/ca-certificates.crt}

# Stdlib + pandas covers the large majority of pure transforms. numpy arrives as
# a pandas dependency and is pinned for the same reason pandas is.
RUN pip install --no-cache-dir "pandas==2.2.3" "numpy==2.1.3"

# ── This image runs as ROOT, and that is forced, not lazy ────────────────────
#
# A non-root USER was tried first and every fragment died with
#
#     python: can't open file '…/1650149238.py': [Errno 13] Permission denied
#
# Kestra stages the script with the JVM's `Files.createTempFile`, which creates
# it mode 600 owned by root, and then copies it into the task container with
# ownership preserved. Nothing on our side of the boundary can widen it: it is
# not the image's file, not the image's directory, and the Docker runner's
# `user` property would only rename the problem. The choice is root or no
# `code` steps at all.
#
# What actually contains a fragment, none of which depends on the uid:
#
#   * `networkMode: none` — V1, MEASURED. Every outbound socket fails:
#     server:4000 → gaierror, 1.1.1.1:53 → OSError, 169.254.169.254 → OSError.
#     The positive control (`networkMode: bridge`) connects, so the test
#     discriminates rather than passing for an unrelated reason.
#   * No credentials — no env vars, no volumes, no mounted config (04 §5.3.2).
#   * `volume-enabled` is false by default in the Docker runner, so a task
#     cannot mount a host path even if a model asked for one.
#   * The container is ephemeral and deleted on completion.
#
# So the residual exposure is a container escape from a network-less throwaway
# container — real, and it is the honest cost of Kestra owning execution. It is
# NOT larger than what Phase 4 removes: `execution.service.ts` gave the same
# daemon the same kind of access, per generated script.
WORKDIR /work
