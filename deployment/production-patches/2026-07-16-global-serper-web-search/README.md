# Global Serper Web Search Release

Date: 2026-07-16

Status: deployed and browser-accepted on 2026-07-17.

## Reason

The Admin Panel shows Serper configuration, but normal users are still asked
for personal API keys and a real conversation receives no `web_search` tool.
The saved base override contains a malformed environment-variable reference,
so LibreChat cannot resolve system-defined Serper authentication.

The first production release fixed those gates, but browser acceptance exposed
one more runtime gate: the explicit non-empty
`endpoints.agents.capabilities` allowlist omitted `web_search`, so ToolService
filtered the otherwise valid tool.

## Production Scope

The release changes only:

- `/opt/librechat/.env` (`SERPER_API_KEY`, value never printed);
- `/opt/librechat/librechat.yaml` (global Serper configuration and
  `webSearch: true` on `gpt-5.6-sol` only, plus one `web_search` entry in the
  existing agents capability allowlist);
- the base Admin Config document: remove its stale `overrides.webSearch`
  section and set `webSearch: true` only on the existing `gpt-5.6-sol` model
  entry;
- the Compose `api` service, which is force-recreated with `--no-deps`.

It does not change frontend assets, Office routes, CodeAPI, deployment-skill
files, provider endpoints, conversations, uploads, the existing Admin Config
model list, or any non-target model-spec field. The runner hashes the complete
remaining Admin Config `overrides` object before and after the targeted update
and rolls back if anything else changes.

The required API recreation will activate the already-deployed 2026-07-15
`office-document-parser` file that is currently present on disk but cached out
of the running process. This release verifies its fixed hash and startup load;
it does not replace the skill.

## Files

```text
README.md
scripts/deploy-remote.exp
scripts/deploy.sh
scripts/merge-config.cjs
scripts/run-remote-release.sh
scripts/test-release.py
```

## Behavior

- The system Serper key is available to all users through the API container.
- `gpt-5.6-sol` receives the LibreChat `web_search` tool by default.
- The explicit agents capability allowlist permits `web_search`.
- Users no longer need to enter personal Serper credentials.
- Search and scrape both use Serper.

## Local Test

```bash
python3 scripts/test-release.py
```

## Deployment

After the implementation commit is pushed to `origin/main`:

```bash
SSH_PASS='supplied out of band' \
RELEASE_COMMIT='<implementation-commit>' \
expect scripts/deploy-remote.exp
```

The transport verifies local `HEAD`, uploads only this checked-in release, runs
the local contract test on production, executes a read-only preflight, and then
runs the atomic deployment.

The production runner prefers an existing `.env` key. If absent, it can migrate
the current malformed Admin Config reference only when it exactly matches the
approved 40-character hexadecimal shape. It never prints the key.

## Verification

- Host and container YAML hashes match.
- `SERPER_API_KEY` is non-empty inside `LibreChat-API` without revealing it.
- YAML resolves to Serper search and scrape, with `gpt-5.6-sol.webSearch=true`.
- YAML resolves `endpoints.agents.capabilities` with exactly one
  `web_search` entry.
- The stale Admin Config `webSearch` override is absent.
- The existing Admin Config model list remains present and its unique
  `gpt-5.6-sol` entry has `webSearch: true`; a normalized preservation hash
  proves all unrelated override fields stayed unchanged.
- Direct Serper search and scrape probes succeed.
- Root and `/api/config` return `200`.
- `/office/` remains `401`.
- `LibreChat-RAG-API`, `LibreChat-CodeAPI`, and `LibreChat-NGINX` IDs and start
  times do not change during the capability follow-up.
- The unchanged `office-document-parser` file still hashes to
  `29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a`,
  and the new API startup loads deployment skills successfully.
- Browser conversation
  `https://152.32.172.162.sslip.io/c/2d6e3538-faeb-4883-80ae-a6ded86b0f2b`
  confirmed a real `web_search` call over 13 sources and returned three current
  news items with clickable links and the retrieval date.

## Rollback

Before the first write, the runner backs up `.env`, `librechat.yaml`, and the
complete Admin Config document under:

```text
/opt/librechat/backups/global-serper-web-search-<timestamp>/
```

Any failure restores those backups and force-recreates only the Compose `api`
service when the release had begun recreating it. No conversation or file data
is changed.

## Production Result

Initial deployment:

- release commit:
  `1b0018d89a848e31d02bbda7be5f5ab2d4b8eb04`;
- timestamp: `20260716234101`;
- backup: `/opt/librechat/backups/global-serper-web-search-20260716234101`;
- config SHA changed from
  `f07f13bd5de22b380c4c2cf377316e9e0e5fc254b9f9ea8e003468098a60e94b`
  to
  `0b17950db7562b2196cee5423f987785508f595c2059d3608c58da3ce0eab004`;
- Serper search and scrape probes passed; root and `/api/config` returned 200;
  `/office/` returned 401;
- Admin Config preservation SHA remained
  `90caa491b7e0d8d9a0ce83b4a20f438afdb79f4a4e1cc4843028c38ca0d24701`;
- browser conversation
  `https://152.32.172.162.sslip.io/c/167958ed-e533-444c-bac6-79a61bdce781`
  still received no `web_search` tool;
- the initial `docker compose up` also recreated RAG-API through its dependency
  graph. RAG-API returned healthy, and the follow-up changes both deploy and
  rollback commands to `--no-deps`.

Capability follow-up:

- release commit:
  `c6ece337e0add11ea845d1ba32afe0333c000b06`;
- timestamp: `20260717004307`;
- backup:
  `/opt/librechat/backups/global-serper-web-search-20260717004307`;
- config SHA changed from
  `0b17950db7562b2196cee5423f987785508f595c2059d3608c58da3ce0eab004`
  to
  `f67ddcfdd45df03ad3f2cbab0c2cd5f3fcb24bfb08627a09f7483113e5cd1e10`,
  matching the API-container config SHA;
- `.env` and Admin Config were unchanged; the existing Admin Config
  preservation SHA remained
  `90caa491b7e0d8d9a0ce83b4a20f438afdb79f4a4e1cc4843028c38ca0d24701`;
- only `LibreChat-API` was recreated with `--no-deps`; RAG-API, CodeAPI, and
  Nginx container IDs and start times remained unchanged;
- Serper search and scrape probes passed; root and `/api/config` returned 200;
  `/office/` returned 401;
- the unchanged Office skill retained SHA
  `29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a`
  and loaded at API startup;
- fresh browser conversation
  `https://152.32.172.162.sslip.io/c/2d6e3538-faeb-4883-80ae-a6ded86b0f2b`
  displayed `Searched the web - 13 sources` and returned three clickable
  football-news links with retrieval date `2026-07-16`.
