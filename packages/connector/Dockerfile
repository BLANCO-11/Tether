# The plugin connector (plans/plugins-2026-10-27). Build context: packages/connector.
#   node src/server.mjs  — the connector (root with SETUID/SETGID only; each piece runs in a worker as uid 30001)
#   node src/egress.mjs  — connector-egress, the only way out of connector-net (run as `node`)
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
RUN mkdir -p /data && node --check src/server.mjs && node --check src/egress.mjs && node --check src/worker.mjs \
 && chmod -R a+rX /app
ENV CONNECTOR_DATA=/data PORT=4010
EXPOSE 4010 3128
CMD ["node", "src/server.mjs"]
