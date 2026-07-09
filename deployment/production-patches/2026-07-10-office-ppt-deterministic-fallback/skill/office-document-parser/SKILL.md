---
name: office-document-parser
description: Use this skill when users upload Word, Excel, or PowerPoint files and need reliable extraction, audit, analysis, summarization, or edits with lower token usage.
allowed-tools:
  - execute_code
always-apply: true
---

# Office Document Parser

Use deterministic Office extraction before doing audit, review, comparison, or issue-log analysis over `.docx`, `.xlsx`, `.xlsm`, or `.pptx` files.

Important runtime rule:

- If this chat has a real code execution sandbox and the uploaded file path is available, run the bundled parser script.
- If this chat does not expose a sandbox/file path, do not pretend to run code. Ask the user to open `/office/`, upload the Office file there, and paste or upload the generated Markdown back into LibreChat.
- On this server, the converter page is available at `http://152.32.172.162.sslip.io/office/` and `http://152.32.172.162/office/`.

Sandbox workflow, only when a file path is actually available:

```bash
python skills/office-document-parser/scripts/office_to_markdown.py INPUT_FILE > /tmp/office_extract.md
```

Then read `/tmp/office_extract.md` and answer from that parsed content.

Extraction expectations:

- Excel: preserve sheet names, row numbers, cell references, headers, formulas, and compact table previews.
- Word: preserve headings, paragraph order, tables, and notable structured text.
- PowerPoint: preserve slide numbers, titles, text boxes, speaker notes, and table text where extractable.

Generation/edit workflow:

- If the user asks to generate or edit Office files, use the same code sandbox instead of only extracting text.
- Excel generation/modification: use `openpyxl`, save `.xlsx` under `/mnt/data`, and mention the generated filename.
- PowerPoint generation/modification: use `python-pptx`, save `.pptx` under `/mnt/data`, and mention the generated filename.
- Word generation/modification: use `python-docx`, save `.docx` under `/mnt/data`, and mention the generated filename.
- For PPT requests based on Excel data, first inspect the workbook with `openpyxl`, then build slides from the real sheet names, headers, rows, and values. Do not reply with only a plan.

For large files, summarize structure first and ask before deeply analyzing every section. Do not paste the whole extraction into the final answer unless the user asks.
