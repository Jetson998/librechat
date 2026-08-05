# Build with the repository root as context:
# docker build -f services/file-agent-runtime/Dockerfile -t file-agent-runtime:<revision> .
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
FROM ${NODE_IMAGE}
ARG TARGETARCH=amd64

WORKDIR /opt/file-agent

# The Runtime uses Node.js for orchestration and registered Python Workers for
# deterministic Office transformations. LibreOffice is used for full-slide
# and full-page rendering during verification.
COPY --chown=node:node services/file-agent-runtime /opt/file-agent/services/file-agent-runtime
COPY --chown=node:node services/librechat-file-agent-connector /opt/file-agent/services/librechat-file-agent-connector
COPY services/file-agent-runtime/apt-packages.lock /tmp/apt-packages.lock

USER root
RUN test "$TARGETARCH" = "amd64" \
  && test "$(dpkg --print-architecture)" = "amd64" \
  && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260702T000000Z bookworm main' \
    > /etc/apt/sources.list.d/debian-ca-bootstrap.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates=20230311+deb12u1 \
  && rm -f /etc/apt/sources.list.d/debian-ca-bootstrap.list \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260702T000000Z bookworm main' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260702T000000Z bookworm-updates main' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260702T000000Z bookworm-security main' \
    > /etc/apt/sources.list.d/debian-snapshot.list \
  && apt-get update \
  && xargs -r apt-get install -y --no-install-recommends < /tmp/apt-packages.lock \
  && python3 -m venv /opt/file-agent/venv \
  && /opt/file-agent/venv/bin/pip install --no-cache-dir --require-hashes \
    -r /opt/file-agent/services/file-agent-runtime/requirements.lock \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/apt-packages.lock \
  && mkdir -p /var/lib/file-agent-runtime \
  && chown -R node:node /opt/file-agent /var/lib/file-agent-runtime

ENV PATH="/opt/file-agent/venv/bin:${PATH}"

USER node
WORKDIR /opt/file-agent/services/file-agent-runtime

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/production-server.js"]
