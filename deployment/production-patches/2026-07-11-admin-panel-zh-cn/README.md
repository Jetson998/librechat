# LibreChat Admin Panel Simplified Chinese Release

Date: 2026-07-11

Status: deployed to production on 2026-07-11 23:16:35 Asia/Hong_Kong.

Repository CI verification passed before production packaging:

```text
source sha256: 95388ccb14d2d6c61b68ccb4d04faaafd47ea9b50628a23d7d5b91a82739460d
commit:        5f1f280f7240aaa75dfe5c3f8dd445d22a71f304
tag:           admin-ci-95388ccb14d2
workflow run:  29149061012
result:        22/22 test files and 760/760 tests passed; build passed
```

The first production-host build attempt exhausted host responsiveness before an
image was produced. No deployment ran. See `INCIDENT_2026-07-11.md` for the
confirmed boundary and mandatory recovery gate.

The corrected repository-owned deployment completed successfully. The
production evidence is recorded in:

```text
results/latest/BUILD_RESULT.txt
results/latest/DEPLOY_RESULT.txt
```

This release will derive a bilingual Admin Panel image from the official source
revision:

```text
repository: https://github.com/ClickHouse/librechat-admin-panel
revision:   64bc4b6151894b080694f5953f7b31aa99bc2cc4
license:    AGPL-3.0
```

The detailed design, safety boundary, verification plan, release sequence, and
rollback are recorded in:

```text
docs/ADMIN_PANEL_ZH_CN_PLAN.md
```

The complete corresponding modified source is under `source/`. It adds:

- Simplified Chinese as the default Admin Panel language;
- English as a browser-persisted selectable language;
- a compact login language control and Settings language control;
- immediate synchronization of `html[lang]`;
- a visible modified-source link on Help;
- exact translation-key, interpolation-placeholder, and mixed-language gates.

The pinned upstream revision has 19 existing Prettier differences, recorded in
`source/format-baseline.txt`. The image build scans the complete source tree and
fails if that exact baseline changes, so modified files must be formatted while
unrelated upstream files remain byte-identical.

The same policy applies to the upstream import sorter: its 3 existing
differences are recorded in `source/import-baseline.txt`, while all modified
localization files must remain sorted.

Strict ESLint still covers the complete source tree with `--max-warnings 0`, but
it runs in the repository GitHub Actions gate together with typecheck, unit
tests, and the application build. A successful gate publishes an immutable
`admin-ci-<source-hash>` tag only after tests, build, GHCR publication and the
release image asset all succeed. The existence of that final tag is therefore
not treated separately from the complete workflow result.

## Current Fast Release Path

The normal Admin Panel release is intentionally limited to three operator
stages:

1. Run one local preflight command: `scripts/admin-panel-ci-preflight.sh`.
2. Push once and require the complete GitHub Actions workflow to pass.
3. Deploy the CI-built GHCR image with a backup, targeted container recreation
   and page-level acceptance.

The local and GitHub checks both call
`.github/scripts/admin-panel-quality-gate.sh`, so their locale, format, import,
lint, typecheck, test and build definitions cannot drift. The 4 GiB production
host does not repeat dependency installation, tests or the Admin application
build.

When Bun `1.3.11` is available locally, run the complete source gate with:

```bash
scripts/admin-panel-ci-preflight.sh
```

Run the source and localization preflight with:

```bash
scripts/verify-source.sh
```

Create a reproducible release tarball locally with:

```bash
scripts/package-release.sh
```

That command writes a tarball under `/tmp`, extracts it into a sibling verify
directory, and reruns the source and CI-attestation gates against the packed
artifact. It also writes a sibling `.env` metadata file containing
`LOCAL_TARBALL` and `TARBALL_SHA256` for the remote deploy step.

After the implementation commit is pushed, verify that the complete workflow
run succeeded, that the matching `admin-ci-<source-hash>` final tag exists, and
that the GHCR image is available. Record the run, source hash, tag and image in
the release before production deployment.

The older production-host BuildKit commands below remain a recovery fallback;
they are not the normal release path:

```bash
scripts/build-image.sh
PREFLIGHT_ONLY=true scripts/deploy.sh /tmp/librechat-admin-panel-zh-cn-release
scripts/deploy.sh /tmp/librechat-admin-panel-zh-cn-release
```

For password-based SSH deployment, use the repository-owned remote runner
instead of generating temporary `/tmp` scripts on the operator machine:

```bash
source /tmp/librechat-admin-panel-zh-cn-release-525a22b.env
RELEASE_DIR="$PWD" \
SSH_HOST=152.32.172.162 \
SSH_USER=root \
SSH_PASS='...' \
expect scripts/deploy-remote.exp
```

`scripts/deploy-remote.exp` uploads only the tarball and the checked-in
`scripts/run-remote-release.sh`, then executes that remote script with the
tarball path and SHA-256. The remote runner performs, in order:

- recovery audit and protected-service health checks;
- tarball SHA-256 verification;
- source and CI-attestation verification;
- `1 GiB / 0.5 CPU / 45m` BuildKit image build;
- deploy preflight and one-service Admin Panel recreate;
- pull `BUILD_RESULT.txt` and `DEPLOY_RESULT.txt` back into `results/latest/`;
- post-deploy protected-container ID checks;
- agreed BuildKit and Open WebUI cleanup.

This keeps future production runs on fixed repository scripts and avoids the
approval fragility of ad hoc generated deployment scripts.

`build-image.sh` fails unless the recorded CI source hash matches the current
source tree and the recorded tag is exactly `admin-ci-<source-hash>`. The build
result carries the verified commit, tag, and workflow run; `deploy.sh` checks
those values again before any production write.

`BUILD_MEMORY`, `BUILD_CPU_QUOTA`, and `BUILD_TIMEOUT` may be lowered after the
host capacity check. They must not be raised on a production host without first
confirming enough headroom for all running services.

The deployment runner requires the current official Compose override to match
`compose.before.yaml`, changes only the Admin Panel image, and recreates only
`LibreChat-Admin-Panel`. It records and verifies that the API, Nginx, CodeAPI,
and MongoDB container IDs remain unchanged. Any failed post-write assertion
restores the official image override and recreates only the Admin Panel.
The deployment result records the actual before/after IDs for every protected
container and the Admin Panel's before/after container and image identities.

This release can be rolled back without touching MongoDB data, LibreChat API,
CodeAPI, Office helper routing, or the main site Nginx path. Use:

```text
ROLLBACK.md
```

Any post-deployment Admin Panel changes made through the browser UI must be
logged separately from this image release. Use:

```text
ADMIN_PANEL_RUNTIME_CONFIG.md
```

Production deployment must not begin until this implementation is committed,
pushed, and verified. The derived image must be built from this committed source
and recorded by immutable image ID.

The release changes only the standalone Admin Panel image. It does not modify
LibreChat chat behavior, model specs, Office, CodeAPI, MongoDB config records,
uploads, conversations, or generated files.
