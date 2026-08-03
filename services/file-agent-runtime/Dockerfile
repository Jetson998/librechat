# Build with the repository root as context:
# docker build -f services/file-agent-runtime/Dockerfile -t file-agent-runtime:<revision> .
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /opt/file-agent

# Both source packages use only Node.js built-ins. The Connector supplies the
# shared HMAC scope implementation used by the Runtime's internal API.
COPY --chown=node:node services/file-agent-runtime /opt/file-agent/services/file-agent-runtime
COPY --chown=node:node services/librechat-file-agent-connector /opt/file-agent/services/librechat-file-agent-connector

RUN mkdir -p /var/lib/file-agent-runtime && chown node:node /var/lib/file-agent-runtime

USER node
WORKDIR /opt/file-agent/services/file-agent-runtime

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/production-server.js"]
