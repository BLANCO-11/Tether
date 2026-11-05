# Forge — the builder agent (`pi`) in its own container (2026-10-13). See host.mjs for why.
#   Build context is the repo root (for infra/certs, like the server):
#   docker build -f packages/forge/Dockerfile -t foundry/forge .
FROM node:22-slim
WORKDIR /app
# ── Corporate CA trust — OPTIONAL, and OFF unless explicitly requested (the server's block, verbatim) ──
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

# npm itself, upgraded before anything is installed with it. The npm node:22-slim ships (10.9.x) bundles ip-address
# 10.1.0 and brace-expansion 2.0.2, both flagged by the dependency scan (2026-10-22); 12.2.1 bundles ip-address 10.7.2
# and brace-expansion 5.0.12, and supports this image's Node 22 (>=22.22.2). An exact version, never `latest`.
RUN npm install -g npm@12.2.1 && npm --version

# pi 0.74.2 + the LiteLLM provider, resolved as of a fixed date (see the server Dockerfile's note on why). The agent
# settings go to /opt/pi-agent: forge-host copies them into each conversation's own pi directory (PI_CODING_AGENT_DIR),
# which belongs to that conversation's uid.
ARG PI_DEPS_AS_OF=2026-10-08T00:00:00Z
RUN export npm_config_before="$PI_DEPS_AS_OF" \
 && npm install -g @earendil-works/pi-coding-agent@0.74.2 \
 && mkdir -p /opt/pi-agent \
 && printf '%s\n' '{"defaultProvider":"litellm","defaultModel":"gpt-6-luna","packages":["npm:pi-provider-litellm@1.2.2"]}' > /opt/pi-agent/settings.json \
 && PI_CODING_AGENT_DIR=/opt/pi-agent pi install npm:pi-provider-litellm@1.2.2 \
 && command -v pi && pi --version

# Forge's document tools: python3 with libraries for every file a chat accepts (moved here from the server image).
# util-linux gives prlimit and setpriv.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && if [ -f /etc/foundry/corp-ca.pem ]; then \
      cp /etc/foundry/corp-ca.pem /usr/local/share/ca-certificates/foundry-corp-ca.crt && update-ca-certificates; \
    fi \
 && python3 -m venv /opt/forge-py \
 && PIP_CERT=/etc/ssl/certs/ca-certificates.crt /opt/forge-py/bin/pip install --no-cache-dir \
      "openpyxl==3.1.5" "xlsxwriter==3.2.0" "python-docx==1.1.2" "pypdf==5.1.0" "reportlab==4.2.5" \
      "pillow==11.0.0" "odfpy==1.4.1" \
 && /opt/forge-py/bin/python -c "import openpyxl, xlsxwriter, docx, pypdf, reportlab, PIL, odf; print('forge python ok')"
ENV PI_BIN=/usr/local/bin/pi
COPY packages/forge/host.mjs packages/forge/egress-proxy.mjs packages/forge/entrypoint.sh /app/
RUN chmod 0755 /app/entrypoint.sh && chmod -R a+rX /app /opt/pi-agent /usr/local/lib/node_modules \
 && node --check /app/host.mjs && node --check /app/egress-proxy.mjs
EXPOSE 4100 3128
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["host"]
