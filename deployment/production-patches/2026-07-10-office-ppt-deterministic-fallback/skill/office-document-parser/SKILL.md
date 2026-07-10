---
name: office-document-parser
description: Use this skill when users upload Word, Excel, or PowerPoint files and need reliable extraction, audit, analysis, summarization, or edits with lower token usage.
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
- Store any intermediate file that must survive another tool call under
  `/mnt/data`, not `/tmp`.

Extraction expectations:

- Excel: preserve sheet names, row numbers, cell references, headers, formulas, and compact table previews.
- Word: preserve headings, paragraph order, tables, and notable structured text.
- PowerPoint: preserve slide numbers, titles, text boxes, speaker notes, and table text where extractable.

Generation/edit workflow:

- Follow the user's requested content, slide count, style, layout, and output
  format; do not substitute a fixed template or fixed business topic.
- Excel generation/modification: use `openpyxl`, save `.xlsx` under `/mnt/data`, and mention the generated filename.
- PowerPoint generation/modification: use `python-pptx`, save `.pptx` under `/mnt/data`, and mention the generated filename.
- Word generation/modification: use `python-docx`, save `.docx` under `/mnt/data`, and mention the generated filename.
- For PPT requests based on Excel data, first inspect the workbook with `openpyxl`, then build slides from the real sheet names, headers, rows, and values. Do not reply with only a plan.
- Mention a generated file only after the code tool reports a real artifact for
  that file.

For large files, summarize structure first and ask before deeply analyzing every section. Do not paste the whole extraction into the final answer unless the user asks.
