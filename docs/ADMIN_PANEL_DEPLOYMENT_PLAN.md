# LibreChat Admin Panel Deployment Plan

Date: 2026-07-11

## Objective

Deploy the official LibreChat Admin Panel for the existing production service,
use it to inspect and remove or correct runtime configuration overrides, and
verify that every fresh conversation starts with `GPT-5.6 SOL` while `Fable 5`
remains available for manual switching.

The same release will give the GPT model spec the bundled OpenAI icon at
`/assets/openai.svg`.

## Confirmed Findings

- Production LibreChat is built from upstream commit
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9` and reports version `0.8.7`.
- The upstream repository contains the Admin Config API and includes an
  `admin-panel` service in its official Docker Compose stacks.
- The Admin Panel frontend is delivered as the separate official image
  `registry.librechat.ai/clickhouse/librechat-admin-panel:latest`; its frontend
  source is not embedded in the main LibreChat client tree.
- The production deployment currently has no Admin Panel service or public
  route, and `ADMIN_PANEL_URL` still points to `http://admin.localhost`.
- A real authenticated browser check on 2026-07-11 reproduced the defect:
  navigating to `/c/new` still selected `Fable 5` even though the committed
  YAML marks `gpt-5.6-sol` as the sole hard default.
- LibreChat merges active Admin Config database overrides over the YAML base
  configuration. A base, role, or user override can therefore make the
  browser-visible default differ from `/app/librechat.yaml`.
- The committed GPT model spec has no `iconURL`. The running client already
  serves the official OpenAI asset at `/assets/openai.svg`, so no frontend
  bundle patch or new image asset is required.

## Source-of-Truth Rule

The repository-tracked YAML remains the durable base configuration. The Admin
Panel is an operational editor and inspection surface, not an undocumented
replacement for Git.

For each Admin Panel change:

1. Export or record the affected override before modification.
2. Prefer deleting stale overrides when the intended value already exists in
   the committed YAML.
3. If an override must remain, store a sanitized snapshot and its purpose in
   the repository before treating the release as complete.
4. Never enter API keys, passwords, cookies, or session secrets into Git.

## Deployment Design

Use the official Admin Panel image as a separate Docker service on the existing
LibreChat Docker network. Pin the deployed image by digest after the production
host successfully resolves the official `latest` tag.

Required runtime settings:

```text
SESSION_SECRET=<generated only on the production host>
API_SERVER_URL=http://LibreChat-API:3080
VITE_API_BASE_URL=https://152.32.172.162.sslip.io
SESSION_COOKIE_SECURE=true
```

Expose the panel through a dedicated HTTPS virtual host:

```text
https://admin.152.32.172.162.sslip.io/
```

`admin.152.32.172.162.sslip.io` already resolves to the production IP. The
deployment must obtain a certificate covering this exact hostname and set:

```text
ADMIN_PANEL_URL=https://admin.152.32.172.162.sslip.io
```

on `LibreChat-API` before the panel login flow is accepted.

The Admin Panel container must not publish its port directly to the Internet.
Only the HTTPS reverse proxy may reach it. Existing LibreChat, Office, CodeAPI,
MongoDB, uploads, and generated-file mounts are unchanged.

## Default Model And Icon Correction

Before changing runtime state, inspect active Admin Config records in this
order:

1. Base principal `__base__`.
2. The `ADMIN` and `USER` role principals.
3. The affected signed-in user principal.

If any active override contains `modelSpecs`, compare it with the committed
YAML. Remove a stale `modelSpecs` field or update it to the exact intended
two-model list only after recording the prior value.

The committed GPT model spec will also receive:

```yaml
iconURL: "/assets/openai.svg"
```

The desired effective model list is:

- `gpt-5.6-sol`: `default: true`, OpenAI icon, endpoint `MuskAPI`, model
  `gpt-5.6-sol`, and `reasoning_effort: max`.
- `claude-fable-5`: `default: false`, endpoint `anthropic`, still manually
  selectable.

Do not patch the compiled frontend or clear every user's browser storage. A
hard effective default is expected to win over the saved last model in this
upstream version.

## Release Sequence

1. Read-only production discovery: Compose files, Docker network, reverse
   proxy, certificate tooling, existing environment wiring, active config
   overrides, and current image availability.
2. Back up every file that will change and export the active config records.
3. Pull the official Admin Panel image, capture its immutable digest, and
   validate its required environment without exposing a public port.
4. Add the Admin Panel service and HTTPS virtual host atomically.
5. Set `ADMIN_PANEL_URL` on `LibreChat-API` and restart only the required
   services.
6. Sign in through the panel with an existing LibreChat admin account.
7. Remove or correct the stale model override and add the GPT icon to the
   repository-tracked YAML.
8. Run HTTP, container, API, and authenticated browser verification.
9. Commit the sanitized production record and exact image digest.

## Acceptance Criteria

- Main LibreChat root and `/api/config` return `200`.
- `/office/` remains `401` with realm `Office Converter`.
- `LibreChat-CodeAPI` remains healthy.
- Admin hostname has a valid certificate and returns the Admin Panel login
  flow; the panel container has no host-published port.
- A LibreChat admin can sign in and read configuration overrides.
- A fresh `/c/new` page selects `GPT-5.6 SOL`, including after a conversation
  was manually switched to `Fable 5`.
- GPT displays `/assets/openai.svg` in the model selector, conversation header,
  and assistant messages.
- `Fable 5` remains selectable and returns a normal response.
- A GPT response records endpoint `MuskAPI` and model `gpt-5.6-sol`.
- No Office/file-pipeline source or database message record is changed.

## Rollback

Rollback must restore the timestamped Compose, reverse-proxy, environment, and
`librechat.yaml` backups; remove the Admin Panel service and virtual host;
restart only affected services; and re-run the main LibreChat, Office, and
CodeAPI health checks.

If a config override was changed, restore its exported pre-change value through
the Admin Config API. Do not perform an unscoped MongoDB restore.

