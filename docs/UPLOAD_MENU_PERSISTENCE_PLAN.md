# Upload Menu Persistence Repair Plan

Date: 2026-07-12

## Scope

Restore and permanently own the LibreChat upload-menu customization:

- `图片上传`
- `Office文件上传`
- `文件提取文字上传`

This change is limited to LibreChat. It does not change WebAI, Office parsing,
CodeAPI execution, generated-file cards, MongoDB messages, or model routing.

## Read-Only Diagnosis

The regression is confirmed in production:

- The public HTML no longer contains `business-upload-label-patch`.
- The active frontend bundle still contains the upstream labels `Upload to
  Provider`, `Upload as Text`, and `Upload to Code Environment`.
- `/opt/librechat/ui-label-patch/client-dist/index.html` still exists and
  contains the intended labels, descriptions, and file guards.
- The active `LibreChat-API:/app/client/dist/index.html` is the clean image
  copy and does not contain the patch.
- `LibreChat-NGINX` proxies the main site to `LibreChat-API`; copying files into
  the Nginx static directory is therefore not the durable serving path.

The immediate cause is the Compose override replacement performed by the
Admin Panel release. The former read-only mount:

```text
/opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro
```

was not represented in the committed Admin Panel override. Recreating the
affected containers therefore returned the API frontend to the image copy.
The patch file remained on the host but was no longer mounted or served.

## Design Decision

Keep the proven runtime menu adapter, but make its source, build process,
Compose ownership, tests, deployment, and rollback part of this repository.

### Repository-Owned Source

Store the menu adapter as a standalone JavaScript source file. It must contain:

- all upstream and prior Chinese label aliases;
- the three required Chinese labels;
- the three operator descriptions;
- deterministic display order;
- file-input `accept` values;
- change-event validation with a clear rejection message.

The format rules are:

- Images: PNG, JPG/JPEG, WEBP, GIF, BMP, SVG, HEIC/HEIF, AVIF.
- Office: DOCX, XLSX, XLSM, PPT, PPTX, CSV, TSV, ODS, ODP.
- Text extraction: PDF, legacy and current Office formats, TXT, Markdown,
  CSV/TSV, JSON, HTML, RTF, ODT, ODS, and ODP.

### Build From The Active Image

Do not commit or hand-edit a complete generated LibreChat frontend bundle.
The deployment runner will:

1. Copy `/app/client/dist` from the running `LibreChat-API` container into a
   timestamped staging directory.
2. Add the repository-owned JavaScript file.
3. Idempotently inject one script tag with id
   `business-upload-label-patch` into `index.html`.
4. Verify every referenced local asset still exists.
5. Verify all labels, descriptions, and format rules before activation.

This keeps the patched HTML and asset hashes aligned with the exact API image
being deployed.

### Persistent Compose Ownership

The production Compose override must include the API read-only mount:

```yaml
services:
  api:
    volumes:
      - /opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro
```

Both committed Admin Panel override variants must retain this mount. Their
release tests and deployment preflight must fail if the mount, patch directory,
script marker, labels, or descriptions are absent.

Replacing `compose.override.yaml` with a release-specific file that omits
existing LibreChat patch ownership is forbidden.

## Deployment Sequence

1. Run repository tests.
2. Commit and push the implementation to `origin/main`.
3. Capture the public HTML hash, API image/container identity, current Compose
   override, and current patch-directory state.
4. Create timestamped backups under `/opt/librechat/backups/`.
5. Build the candidate dist from the active API container.
6. Install the Compose mount and candidate dist atomically.
7. Recreate only the API service required to activate the mount.
8. Verify root, `/api/config`, `/office/`, CodeAPI health, and container state.
9. Verify the public HTML contains exactly one patch marker and all required
   strings.
10. Verify the authenticated menu in a fresh browser page, including format
    rejection for each route.
11. Record hashes, backup path, container identities, browser result, and
    rollback command in the repository; commit and push the record.

## Rollback

On any deployment or verification failure:

1. Restore the backed-up Compose override.
2. Restore the previous patch directory, or remove the new directory if none
   existed before.
3. Recreate `LibreChat-API` with the restored Compose configuration.
4. Re-run root, `/api/config`, `/office/`, and CodeAPI checks.

No database, upload, conversation, or generated artifact is modified by this
release.

## Acceptance Criteria

- The public HTML has exactly one `business-upload-label-patch` marker.
- The authenticated menu shows the three required labels in the required
  order and includes the three descriptions.
- Image upload rejects an XLSX fixture.
- Office upload rejects an image fixture and accepts DOCX/XLSX/XLSM/PPT/PPTX,
  CSV/TSV, ODS, and ODP fixtures.
- Text extraction rejects an image fixture and accepts the documented text and
  document fixtures.
- Recreating `LibreChat-API` and `LibreChat-NGINX` preserves the menu.
- Admin Panel release tests fail if the upload-menu mount is removed.
- Production evidence and rollback details are committed and pushed.

## Result

Completed on 2026-07-12.

- Design commit: `e1282fe`.
- Implementation commit: `dfbe7a4`.
- Production timestamp: `20260712020837`.
- Backup: `/opt/librechat/backups/upload-menu-20260712020837`.
- Public patch marker count: `1`.
- Authenticated browser verification: passed before and after an actual Nginx
  force-recreation.
- API, CodeAPI, and MongoDB remained unchanged during the Nginx persistence
  test.
- Exact hashes and container identities are recorded in the release result.
