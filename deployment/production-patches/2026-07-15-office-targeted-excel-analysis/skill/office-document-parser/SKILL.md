---
name: office-document-parser
description: Use this skill when users upload Word, Excel, or PowerPoint files and need reliable extraction, audit, analysis, summarization, or edits with lower token usage and without unnecessary full-document dumps.
allowed-tools:
  - execute_code
---

# Office Document Parser

Use the current LibreChat code environment for Office extraction, analysis,
generation, and modification over supported files such as `.docx`, `.xlsx`,
`.xlsm`, `.ppt`, `.pptx`, `.csv`, `.tsv`, `.ods`, and `.odp`.

Important runtime rule:

- Use only files explicitly mounted under `/mnt/data` for the current thread.
- Never inspect `/srv/codeapi-data`, other session directories, or the filesystem
  root to locate user files.
- Use the exact filename shown under `/mnt/data`; do not invent a path.
- If the expected upload is absent, report that the current code session did not
  receive it. Do not redirect the user to another upload site and do not claim
  to have parsed the file.

Extraction workflow:

- Excel: use `openpyxl` and inspect real sheet names, visibility, formulas,
  values, headers, dimensions, and relevant rows.
- Word: use `python-docx` and preserve heading order, paragraphs, tables, and
  structured text.
- PowerPoint: use `python-pptx` and preserve slide order, titles, text boxes,
  notes, tables, and existing media where the library supports it.
- CSV/TSV: use Python's `csv` module or a suitable dataframe library when
  available.
- Avoid persistent intermediate files for ordinary analysis. If an intermediate
  file is technically indispensable for a requested deliverable, store it under
  `/mnt/data`, not `/tmp`.

Extraction expectations:

- Excel: preserve sheet names, row numbers, cell references, headers, formulas,
  and compact table previews.
- Word: preserve headings, paragraph order, tables, and notable structured text.
- PowerPoint: preserve slide numbers, titles, text boxes, speaker notes, and
  table text where extractable.

Excel token and artifact discipline:

- Work directly from the original workbook with `openpyxl`. Do not convert an
  entire workbook to TXT, Markdown, CSV, JSON, or a file named `full_dump`
  unless the user explicitly requests that export.
- Treat an initial-review request such as "review these first" or "take a look"
  as a structure-first pass: report sheet metadata, headers, dimensions, counts,
  key fields, and bounded representative rows before deep analysis.
- Filter, aggregate, join, and compare in Python before printing tool output.
  Do not print every cell or send the entire workbook into model context.
- Keep each preview bounded and focused on the user's task. For large files,
  summarize structure first and ask before deeply analyzing every section.
- Reopen the original workbook on later tool calls instead of creating a whole-
  workbook text copy solely to persist extracted content.
- Preserve evidence references such as `SheetName!A12`, row numbers, formulas,
  and key identifiers in findings and comparisons.
- Only create a file under `/mnt/data` when it is a user-requested deliverable
  or technically required to produce that deliverable. Intermediate analysis
  dumps are not deliverables and should not be exposed as download cards.
- For an exhaustive audit, process all rows in Python but return bounded issue
  sets, aggregates, and cited evidence. A complete export remains opt-in.

Generation/edit workflow:

- Follow the user's requested content, slide count, style, layout, and output
  format; do not substitute a fixed template or fixed business topic.
- Excel generation/modification: use `openpyxl`, save `.xlsx` under `/mnt/data`,
  and mention the generated filename.
- PowerPoint generation/modification: use `python-pptx`, save `.pptx` under
  `/mnt/data`, and mention the generated filename.
- Word generation/modification: use `python-docx`, save `.docx` under
  `/mnt/data`, and mention the generated filename.
- For PPT requests based on Excel data, first inspect the workbook with
  `openpyxl`, then build slides from the real sheet names, headers, rows, and
  values. Do not reply with only a plan.
- Mention a generated file only after the code tool reports a real artifact for
  that file.

Do not paste a whole extraction into the final answer unless the user asks.
