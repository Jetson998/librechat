# Admin Panel Simplified Chinese Plan

Date: 2026-07-11

## Objective

Provide a complete Simplified Chinese interface for the official LibreChat
Admin Panel while retaining English as a selectable language and fallback.
Simplified Chinese is the default for users without a saved language choice.

This change is limited to the standalone Admin Panel. It must not modify the
main LibreChat client, model configuration, MongoDB configuration records,
Office routes, CodeAPI, uploads, conversations, or generated files.

## Verified Upstream

The production image is:

```text
registry.librechat.ai/clickhouse/librechat-admin-panel@sha256:1d3916ae84439e83da83507afd4aae14a99bd81ff2e1890079f57d8d377eb8e9
```

Its OCI labels identify the source and revision as:

```text
source:   https://github.com/ClickHouse/librechat-admin-panel
revision: 64bc4b6151894b080694f5953f7b31aa99bc2cc4
license:  AGPL-3.0
```

The revision is a verified upstream commit dated 2026-06-25. The production
bundle contains `i18next`, `react-i18next`, and browser language detection, but
its resource map contains only `en`. There is no current `LANG`, `LOCALE`, or
Admin Config switch that can add a Chinese UI.

The source tree contains 1,213 English translation keys. The main LibreChat
Simplified Chinese dictionary shares only a small set of generic keys, so the
Admin Panel needs its own complete dictionary instead of an incomplete merge.

## Source And License Boundary

Keep the complete corresponding modified source in this repository under the
production release directory, including the upstream license, source notice,
patches, translation dictionary, build files, and reproducible build script.
The running Help page must include a visible source-code link for the modified
version, satisfying the Admin Panel's AGPL network-source requirement.

Do not edit minified production assets or use an Nginx response substitution.
All UI changes are made against the pinned TypeScript source and rebuilt.

## Design

### Language resources

- Add `src/locales/zh-Hans/translation.json` with exactly the same key set as
  `src/locales/en/translation.json`.
- Register `zh-Hans` and `en` in `src/locales/i18n.ts`.
- Use `zh-Hans` as the fallback/default language for a user with no explicit
  saved choice.
- Continue using `i18nextLng` in local storage so the choice survives reloads.
- Set the document `lang` attribute whenever the active language changes.
- Keep English strings available as a deterministic fallback.

### User control

Add a two-option segmented language control to the existing Settings dialog:

```text
简体中文 | English
```

The control uses the existing Admin styling and accessibility patterns. It is
not added as a separate page or a new configuration database value. Language
selection is per browser, immediate, and does not restart any service.

### Translation policy

- Translate navigation, login, dashboard, configuration, access, grants,
  audit, help, dialogs, validation, notifications, and accessibility labels.
- Preserve literal product names, provider names, model names, YAML keys, API
  field names, acronyms, URLs, environment variables, and code values where
  translation would make operations ambiguous.
- Prefer concise operational Chinese. Avoid marketing wording and avoid
  translating technical identifiers that operators must match to YAML.
- Preserve every interpolation variable such as `{{name}}`, `{{count}}`, and
  `{{field}}` exactly.

### Derived image

Build from the pinned upstream source revision with its locked Bun dependency
graph. Tag the local production image with the upstream revision and repository
commit, then pin the resulting image ID/digest in the production release
record. The Compose service remains private to the existing Docker network.

The build must stop if:

- the upstream revision or source archive checksum differs;
- English and Chinese translation keys differ;
- interpolation placeholders differ for any key;
- raw `com_*` translation keys remain in a production render;
- lint, typecheck, unit tests, build, or authenticated UI tests fail.

## Verification

Repository checks:

1. Verify the source revision and archive checksum.
2. Compare English and Simplified Chinese key sets exactly.
3. Compare interpolation placeholders for every translated entry.
4. Run upstream format, lint, typecheck, and unit tests.
5. Build the production image and record its immutable ID/digest.

Browser checks at desktop and mobile widths:

1. A fresh browser with no `i18nextLng` opens the login page in Simplified
   Chinese and reports `html[lang="zh-Hans"]`.
2. Sign in and inspect Dashboard, Configuration, Access, Grants, and Help.
3. Confirm configuration field labels and descriptions are Chinese while
   literal model/provider/YAML identifiers remain unchanged.
4. Switch to English in Settings; verify the visible page and document language
   update immediately and survive reload.
5. Switch back to Simplified Chinese and verify persistence.
6. Confirm the modified-source link is visible and points to this repository.
7. Confirm there is no untranslated `com_*` key, overlapping control, clipped
   Chinese text, or browser-console error.
8. Verify an Admin read and a harmless settings navigation; do not change any
   production configuration during localization acceptance.

Production regression checks:

- Main root and `/api/config` return `200`.
- Admin root and `/health` return success.
- Admin login and configuration reads still work.
- Admin container has no published host port.
- MongoDB `configs` count is unchanged.
- `/office/` remains `401` with realm `Office Converter`.
- CodeAPI remains healthy.
- A fresh main LibreChat chat still defaults to `GPT-5.6 SOL` with the OpenAI
  icon.

## Release Sequence

1. Commit and push this plan before implementation.
2. Add the pinned upstream source, source notice, full Chinese dictionary,
   language control, tests, and build scripts.
3. Run all repository and local image checks.
4. Commit and push the implementation before any production write.
5. Stage the committed release on the server and rerun preflight.
6. Back up Compose state and the currently running Admin image reference.
7. Build or load the derived image, update only the Admin service image, and
   recreate only the Admin container.
8. Run HTTP, container, authenticated browser, language, and regression checks.
9. Commit and push the sanitized production result and immutable image ID.

## Rollback

Restore the official production image digest shown above and recreate only the
Admin container. Keep the existing Admin URL, Nginx routes, API service,
database, Office route, and CodeAPI unchanged. Then rerun Admin login, main
root, `/api/config`, `/office/`, CodeAPI health, and GPT-default checks.

No MongoDB restore, browser-storage wipe, or message rewrite is part of this
rollback.
