# Release Checklist

Use this for small LibreChat production changes. This checklist is a gate, not
an after-the-fact note. No production write is allowed until the "Repository
Gate" section is complete and pushed.

## Change Summary

- Release ID:
- Governance mode: `light` / `release` / `protected` / `enhanced`
- Date:
- Operator:
- Change name:
- Reason:
- Expected user-visible effect:
- Rollback action:
- Affected production files/services:
- Feature/function list:
- Verification plan:
- Business acceptance level: `light` / `heavy`
- Acceptance reason and affected business path:
- Existing evidence that can be reused:

## Repository Gate

- [ ] `deployment/release-records/<release-id>/RELEASE.json` exists for a new
      governed release.
- [ ] Intended patch/config/skill/static change is represented in this
      repository.
- [ ] Change summary, affected files/services, feature/function list,
      verification plan, and rollback action are documented.
- [ ] Relevant production patch archive or release note is created or updated.
- [ ] No production secrets or raw user data are staged.
- [ ] Local checks ran for the changed files.
- [ ] Change is committed.
- [ ] Change is pushed to `origin/main`.
- [ ] `git status --short --branch` shows local branch aligned with
      `origin/main`.
- [ ] `scripts/release-verify.sh <release-id>` passed.
- [ ] Package manifest was created from the recorded source revision when the
      selected mode requires one.

If any item above cannot be completed, stop. Do not change production.

## Before Production Write

- [ ] Root URL returns `200`.
- [ ] `/api/config` has been captured.
- [ ] Light or heavy business acceptance was selected from actual scope and
      risk.
- [ ] The affected business path and nearest critical guardrail are identified.
- [ ] Reused evidence matches the source revision, artifact, configuration, and
      relevant environment assumptions.
- [ ] Login works in a browser only when login, permissions, Admin, or UI changed.
- [ ] Simple chat returns non-empty content only when this release explicitly
      changes the model/tool path. Default acceptance sends no model request.
- [ ] Relevant files/configs are backed up when rollback cannot rely on the
      previous immutable artifact or revision.
- [ ] No production secrets will be committed to this project.
- [ ] Rollback artifact exists and is referenced in this checklist or release
      note.

Commands:

```sh
curl -k -I https://152.32.172.162.sslip.io/
curl -k -L https://152.32.172.162.sslip.io/api/config
```

## After Production Write

- [ ] Root URL returns `200`.
- [ ] Main frontend asset returns `200`.
- [ ] `/api/config` matches intended auth/interface settings when those settings changed.
- [ ] Browser login works when login, permissions, Admin, or UI changed.
- [ ] Simple chat returns non-empty content when the model/tool path changed.
- [ ] File upload still works if upload UI or backend changed.
- [ ] Code execution works if code environment changed.
- [ ] `/office/` reads a small XLSX workbook if Office/Excel backend changed.
- [ ] Runtime Chinese labels still show if frontend assets changed.
- [ ] `business-upload-label-patch` is present exactly once in public HTML.
- [ ] Any release replacing `compose.override.yaml` retains
      `/opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro`.
- [ ] Rollback path remains available.
- [ ] Business acceptance records its level, actual scope, reused evidence,
      result, key warnings, evidence location, and continue-or-rollback decision.
- [ ] Actual production state matches the committed plan, or differences are
      captured in a follow-up commit.
- [ ] Verification result is documented and pushed if it changed the record.
- [ ] `scripts/release-acceptance.sh <release-id>` passed.
- [ ] Final `RELEASE.json` records runtime, backup, acceptance, rollback, and
      unresolved issues.
- [ ] `scripts/release-finalize.sh <release-id>` passed after the final record
      was committed and pushed.

## Forbidden Shortcuts

- [ ] No untracked server-only hotfix was applied.
- [ ] No manual MongoDB/upload/conversation repair was done before the
      repository gate.
- [ ] No "temporary" production patch is left outside the repository.

## Not Default Business Acceptance

Do not add server cleanup, full-service health audits, vulnerability scans,
performance tests, full-repository formatting, or unrelated role/page checks
to an ordinary release. Reference existing results when relevant and use the
separate owning workflow when new evidence is required.

## Notes

Record exact observations, not guesses. If something is inferred, mark it as an
inference and add the command or browser check needed to verify it later.
