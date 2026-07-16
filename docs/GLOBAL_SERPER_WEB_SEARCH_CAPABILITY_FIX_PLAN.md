# Global Serper Web Search Capability Fix Plan

Date: 2026-07-16

Status: design gate; follow-up implementation not yet deployed.

## Current Production State

Release commit `1b0018d89a848e31d02bbda7be5f5ab2d4b8eb04` successfully:

- migrated the existing Serper key into `SERPER_API_KEY` without printing it;
- configured Serper for search and scraping;
- set `gpt-5.6-sol.webSearch: true` in YAML and the existing Admin Config
  model spec;
- preserved all unrelated Admin Config overrides;
- passed direct Serper search and scrape probes.

Browser acceptance still failed in fresh conversation
`167958ed-e533-444c-bac6-79a61bdce781`. The runtime context recorded five
tools (`read_file`, `bash_tool`, `create_file`, `edit_file`, and `skill`) and no
`web_search` tool.

## Root Cause

Production YAML explicitly defines a non-empty
`endpoints.agents.capabilities` allowlist containing:

```text
deferred_tools
execute_code
file_search
artifacts
tools
skills
context
```

It omits `web_search`.

LibreChat commit `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9` resolves agent capabilities by
using that explicit list whenever it is non-empty. Default capabilities are
used only when the configured list is empty. ToolService therefore filters out
`web_search` even though all other gates are valid.

Verified non-causes:

- both `ADMIN` and `USER` roles have `WEB_SEARCH.USE: true`;
- the production tool registry contains a `web_search` definition;
- an isolated production `loadAgent()` call produces
  `tools: ["execute_code", "web_search"]`;
- the Admin Config `endpoints` override does not define
  `agents.capabilities`, so no Mongo endpoint mutation is required.

## Scope

The follow-up release will:

1. Add `web_search` exactly once to the existing YAML
   `endpoints.agents.capabilities` list.
2. Preserve every existing capability and its order.
3. Leave `.env`, Admin Config, model specs, roles, conversations, frontend
   assets, Office files, CodeAPI, and Nginx unchanged.
4. Recreate only the Compose `api` service with `--no-deps` so RAG-API is not
   recreated again.

The API recreation reloads the YAML-derived base configuration and the
process-local APP_CONFIG caches. No standalone Redis cache deletion or Mongo
write is needed for this follow-up.

## Deployment

1. Back up `librechat.yaml` and capture API, RAG-API, CodeAPI, and Nginx
   container IDs and start times.
2. Structurally merge only the missing capability and verify idempotency.
3. Force-recreate `api` with `docker compose up -d --no-deps --force-recreate
   api`.
4. Verify YAML and container hashes, resolved capability presence, route
   health, unchanged neighboring container IDs, deployment-skill hash, and
   Serper search/scrape probes.
5. Run a fresh browser conversation and require a real `web_search` call plus
   source links.

## Rollback

On failure after the YAML write:

1. Restore the backed-up `librechat.yaml`.
2. Recreate only `api` with `--no-deps`.
3. Verify `/api/config`, root, Office protection, CodeAPI, RAG-API, and Nginx.

## Acceptance Criteria

- Resolved `endpoints.agents.capabilities` contains `web_search` exactly once.
- A fresh GPT-5.6-Sol conversation exposes and calls `web_search`.
- The answer contains current source links and no personal-key dialog.
- API returns healthy after recreation.
- RAG-API, CodeAPI, and Nginx container IDs and start times do not change.
- The release result and browser conversation URL are committed and pushed.
