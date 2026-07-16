# Global Serper Web Search Release

Date: 2026-07-16

Status: implementation prepared; not yet deployed.

## Reason

The Admin Panel shows Serper configuration, but normal users are still asked
for personal API keys and a real conversation receives no `web_search` tool.
The saved base override contains a malformed environment-variable reference,
so LibreChat cannot resolve system-defined Serper authentication.

## Production Scope

The release changes only:

- `/opt/librechat/.env` (`SERPER_API_KEY`, value never printed);
- `/opt/librechat/librechat.yaml` (global Serper configuration and
  `webSearch: true` on `gpt-5.6-sol` only);
- the base Admin Config document's stale `overrides.webSearch` section;
- the Compose `api` service, which is force-recreated once.

It does not change frontend assets, Office routes, CodeAPI, deployment-skill
files, provider endpoints, conversations, uploads, or other model specs.

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
- The stale Admin Config `webSearch` override is absent.
- Direct Serper search and scrape probes succeed.
- Root and `/api/config` return `200`.
- `/office/` remains `401`.
- `LibreChat-CodeAPI` and `LibreChat-NGINX` are not recreated.
- The unchanged `office-document-parser` file still hashes to
  `29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a`,
  and the new API startup loads deployment skills successfully.
- A browser conversation must still confirm a real `web_search` tool call and
  source links before the release is marked fully accepted.

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

Pending deployment and browser acceptance.
