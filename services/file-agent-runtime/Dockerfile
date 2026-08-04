# Build with the repository root as context:
# docker build -f services/file-agent-runtime/Dockerfile -t file-agent-runtime:<revision> .
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /opt/file-agent

# The Runtime uses Node.js for orchestration and registered Python Workers for
# deterministic Office transformations. LibreOffice is used for full-slide
# and full-page rendering during verification.
COPY --chown=node:node services/file-agent-runtime /opt/file-agent/services/file-agent-runtime
COPY --chown=node:node services/librechat-file-agent-connector /opt/file-agent/services/librechat-file-agent-connector

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-writer \
    python3 \
    python3-venv \
  && python3 -m venv /opt/file-agent/venv \
  && /opt/file-agent/venv/bin/pip install --no-cache-dir \
    openpyxl \
    python-docx \
    python-pptx \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/file-agent-runtime \
  && chown -R node:node /opt/file-agent /var/lib/file-agent-runtime

ENV PATH="/opt/file-agent/venv/bin:${PATH}"

USER node
WORKDIR /opt/file-agent/services/file-agent-runtime

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/production-server.js"]
