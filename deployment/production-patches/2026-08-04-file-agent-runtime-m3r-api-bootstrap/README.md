# File Agent Runtime M3-R API bootstrap

This is a small, default-disabled production bootstrap for the reviewed M3-R
File Agent Runtime integration. It mounts four API files and recreates only
`LibreChat-API`.

It does not start `file-agent-runtime`, configure a service secret or user
allowlist, alter MongoDB, create a user conversation, or send a model request.
The mounted API explicitly receives `FILE_AGENT_RUNTIME_ENABLED=false`, so the
existing native Agent path remains active.

The runner refuses an apply unless the three existing API targets match the
captured baseline hashes. It snapshots the current Compose override and API
container before changing the override, verifies mounted file hashes and the
disabled flag after restart, and restores the snapshot if the bounded checks
fail.

The production release record supplies the only supported execution path:

```sh
scripts/release-preflight.sh 20260804-file-agent-runtime-m3r-api-bootstrap \
  --evidence .release-state/20260804-file-agent-runtime-m3r-api-bootstrap/runtime-preflight.json
scripts/release-deploy.sh 20260804-file-agent-runtime-m3r-api-bootstrap \
  --confirm 20260804-file-agent-runtime-m3r-api-bootstrap
```

An enabled Word pilot is a separate change: it needs a private Runtime service,
an HMAC secret, an explicit allowlist, and a bounded DOCX acceptance task.
