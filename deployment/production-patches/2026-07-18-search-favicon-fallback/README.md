# LibreChat Search Favicon Fallback Release

Date: 2026-07-18

Status: deployed and browser-verified.

## Behavior

The release replaces the unreachable Google favicon dependency in rendered
web-search results with deterministic local SVG data URLs. It does not change
search providers or result data, and it does not edit LibreChat's compressed
application bundles.

The readable source is inlined into the no-store Client HTML while a
commit-derived standalone copy is retained for SHA verification.

## Files

```text
client/search-favicon-fallback.js
scripts/build-client.py
scripts/test-contract.js
scripts/test-release.py
scripts/deploy.sh
scripts/run-remote-release.sh
scripts/deploy-remote.exp
```

## Production Boundary

The guarded release starts from:

```text
/opt/librechat/user-usage-cost-detail-availability/de2beeace561-20260718223055/client-dist
```

It creates a new versioned Client, replaces only the Client Compose mount, and
recreates only `LibreChat-API`. Existing usage, pricing, upload, login, Stage B,
Office, RAG, CodeAPI, MongoDB, Nginx, and Admin resources are protected.

## Local Verification

```bash
python3 scripts/test-release.py
git diff --check
```

## Release Flow

1. Commit and push the complete release package.
2. Run the exact pushed commit in preflight-only mode.
3. Deploy only after all baseline hashes pass.
4. Verify the existing search conversation without creating or sending a chat.
5. Record the release root, backup, hashes, and browser acceptance.

Browser acceptance uses the existing football-news conversation and does not
create or send a chat.

## Rollback

Restore the release backup's `compose.override.yaml` and recreate only
`LibreChat-API`.

## Production Result

The guarded release completed at `20260718230646` from commit `14b9fc7`.

```text
release_root=/opt/librechat/search-favicon-fallback/14b9fc7972f5-20260718230646
backup_dir=/opt/librechat/backups/search-favicon-fallback-20260718230646
```

Browser acceptance found 26 local fallback images, zero remaining Google
favicon URLs, and zero broken images in the existing football-news
conversation. See `DEPLOY_RESULT.md` for the complete evidence.
