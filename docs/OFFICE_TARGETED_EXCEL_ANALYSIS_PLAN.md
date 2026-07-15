# Targeted Excel Analysis Plan

Date: 2026-07-15

## Problem

In a production conversation, the Office skill parsed two large Excel
workbooks, wrote complete `*_full_dump.txt` copies, exposed those intermediate
files as download cards, and then planned to read roughly 80,000 characters in
batches.

Reliable Excel work does require deterministic parsing, but it does not require
flattening the entire workbook into a text artifact. A full dump duplicates the
source, weakens spreadsheet structure, and can greatly increase model context
when the dump is subsequently read.

## Root Cause

The existing `office-document-parser` skill already asks for `openpyxl`, cell
references, compact previews, and a structure-first pass for large files. It
does not explicitly prohibit whole-workbook dump files or distinguish a
user-requested deliverable from an internal analysis intermediate. The model
therefore chose a technically valid but unnecessarily expensive persistence
strategy.

## Design

The skill remains the single source of truth for Office analysis behavior.
This release does not change upload routing, CodeAPI file mounting, artifact
cards, the Office converter, or model-specific prompt prefixes.

Default Excel behavior:

1. Open the original workbook directly with `openpyxl`.
2. For an initial review, return workbook structure, sheet metadata, headers,
   dimensions, counts, and bounded representative rows.
3. Filter, aggregate, join, and compare rows in Python before returning data to
   the model context.
4. Preserve sheet names, row numbers, cell references, formulas, and key field
   names in every finding.
5. Reopen the original workbook on a later tool call instead of creating a full
   text copy solely for persistence.
6. Do not create or expose whole-workbook TXT, Markdown, CSV, or JSON dumps
   unless the user explicitly requests an export.
7. Create files under `/mnt/data` only for user-requested deliverables or a
   technically indispensable intermediate needed to produce that deliverable.
8. For exhaustive audits, process every row in Python while sending only
   bounded issue sets, aggregates, and cited evidence into model context.

## Verification

Repository test:

```sh
node deployment/production-patches/2026-07-15-office-targeted-excel-analysis/scripts/test-release.js
```

Production acceptance in a fresh normal conversation:

1. Upload two representative XLSX workbooks through `Office文件上传`.
2. Ask the model to review the files before a later policy is supplied.
3. Confirm it reports structure and relevant fields without generating
   `full_dump`, whole-workbook TXT, Markdown, CSV, or JSON artifacts.
4. Confirm the response preserves sheet/row/cell references.
5. Supply the comparison policy and confirm subsequent analysis targets only
   relevant rows and fields.
6. Explicitly request a text export once and confirm that the skill still
   permits user-requested exports.

## Rollback

Restore the timestamped production `SKILL.md` backup created by the release.
The release and rollback do not restart any container. If a fresh conversation
shows that the running API cached the previous skill body, record the file as
updated-but-not-active and require a separately approved restart release. No
database, upload, Office converter, frontend, or CodeAPI rollback is required.
