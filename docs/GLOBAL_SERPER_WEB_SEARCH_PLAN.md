# Global Serper Web Search Plan

Date: 2026-07-16

Status: design gate; production not yet changed.

## Problem

LibreChat exposes the `网络搜索` menu and the Admin Panel shows Serper as both
the search and scraper provider, but a new user conversation cannot use the
`web_search` tool.

Verified production behavior:

- the Admin Panel base configuration contains a Serper environment-variable
  reference with the API key accidentally embedded in the variable name;
- the user-side web-search dialog therefore asks for search and scraper keys;
- a new `GPT-5.6-Sol` conversation reports that no web-search tool is
  available and produces no `web_search` call.

LibreChat's runtime requires web-search credential fields to contain an
environment-variable reference. It then resolves the referenced variable from
the API process environment. A malformed reference cannot authenticate the
system-wide provider.

## Scope

This release will change only:

- `/opt/librechat/.env` by setting `SERPER_API_KEY` without printing it;
- `/opt/librechat/librechat.yaml` by adding the global Serper configuration and
  enabling `webSearch: true` for the `gpt-5.6-sol` model spec;
- the base Admin Config override by removing its stale `webSearch` section so
  the committed YAML configuration is authoritative;
- the `LibreChat-API` container, which must be force-recreated to receive the
  environment variable and reload YAML.

It will not change:

- frontend bundles, upload menus, Office routes, deployment skills, CodeAPI,
  model endpoints, conversation data, user files, or generated artifacts;
- `claude-fable-5` or any other model spec;
- Serper account settings or billing.

## Secret Migration

The deployment must never print, download, or commit the Serper key.

The production runner will use this order:

1. Reuse an existing non-empty `SERPER_API_KEY` from `/opt/librechat/.env`.
2. Otherwise, recover the existing key only when the malformed Admin Config
   value matches the exact observed safe migration shape
   `${SERPER_API<40 lowercase hexadecimal characters>_KEY}`.
3. Fail closed when neither source is available. Do not prompt in logs and do
   not write an empty key.

The recovered value remains only in shell memory and the protected production
`.env` file.

## Implementation

1. Add a checked-in release directory with:
   - the intended YAML fragment;
   - a structural YAML merge helper;
   - local contract tests and secret scanning;
   - an atomic production runner and repository-owned SSH transport.
2. Run read-only production preflight:
   - confirm exactly one base Admin Config document contains the current
     `webSearch` override;
   - confirm the current provider values and supported malformed-reference
     shape;
   - confirm `gpt-5.6-sol` exists exactly once in production YAML;
   - capture API container ID, start time, restart count, and health.
3. Back up `.env`, `librechat.yaml`, and the complete base Admin Config document
   under `/opt/librechat/backups/global-serper-web-search-<timestamp>/` with
   restrictive permissions.
4. Write `SERPER_API_KEY` to `.env`, structurally merge the global web-search
   YAML, set `webSearch: true` only on `gpt-5.6-sol`, and remove the stale base
   Admin Config `webSearch` override.
5. Force-recreate only the Compose `api` service.
6. Verify the new API container has a non-empty `SERPER_API_KEY` without
   printing it, the resolved config uses Serper, HTTP checks pass, CodeAPI stays
   healthy, and `/office/` remains protected.
7. Run a new browser conversation that requests current football news and
   confirm a `web_search` tool call plus source links.

## Rollback

On any failure after the first write:

1. Restore the timestamped `.env` and `librechat.yaml` backups.
2. Restore the complete base Admin Config document from its protected backup.
3. Force-recreate only the Compose `api` service.
4. Wait for `/api/config` and verify root, Office protection, and CodeAPI
   health.

The rollback must not alter conversations, files, or other containers.

## Acceptance Criteria

- `SERPER_API_KEY` is present inside the recreated API container, but its value
  is never printed.
- Resolved global configuration uses `searchProvider: serper`,
  `scraperProvider: serper`, and `serperApiKey: ${SERPER_API_KEY}`.
- `gpt-5.6-sol` resolves with `webSearch: true`.
- A normal user is not asked to enter a personal Serper key.
- A new conversation produces a successful `web_search` tool call and real
  source links.
- Root and `/api/config` return `200`; `/office/` returns `401`; CodeAPI remains
  healthy.
- Backup paths, hashes, container metadata, and browser acceptance are recorded
  in the release README and `docs/PRODUCTION_VERIFICATION.md`.
