const OFFICE_EXTENSIONS = new Set([
  '.docx', '.xlsx', '.xlsm', '.ppt', '.pptx', '.csv', '.tsv', '.ods', '.odp',
]);
const MANIFEST_MARKER = '__LIBRECHAT_OFFICE_MANIFEST__';
const MAX_CONTEXT_CHARS = 80_000;
const DEFAULT_TIMEOUT_MS = 45_000;

const extensionOf = (filename) => {
  const basename = typeof filename === 'string' ? (filename.split(/[\\/]/).pop() ?? '') : '';
  const index = basename.lastIndexOf('.');
  return index >= 0 ? basename.slice(index).toLowerCase() : '';
};

const selectCurrentTurnOfficeFiles = (requestFiles, primedCodeFiles) => {
  const selected = [];
  for (const file of requestFiles ?? []) {
    if (!OFFICE_EXTENSIONS.has(extensionOf(file?.filename))) {
      continue;
    }
    const matches = new Map();
    for (const candidate of primedCodeFiles ?? []) {
      if (candidate?.source_file_id !== file?.file_id) continue;
      const key = `${candidate?.storage_session_id ?? ''}\0${candidate?.id ?? ''}`;
      matches.set(key, candidate);
    }
    if (matches.size !== 1) {
      const reason = matches.size > 1 ? 'ambiguous' : 'missing';
      throw new Error(
        `Office pre-parse ${reason} stable CodeAPI reference for "${file?.filename ?? 'unknown file'}".`,
      );
    }
    selected.push({
      file_id: file.file_id,
      filename: file.filename,
      primed: matches.values().next().value,
    });
  }
  return selected;
};

const getRegeneratedRequestFileIds = ({ isRegenerate, requestFiles, messages, parentMessageId }) => {
  if (isRegenerate !== true || (requestFiles?.length ?? 0) > 0) {
    return [];
  }
  const parent = (messages ?? []).find(
    (message) => message?.messageId === parentMessageId && message?.isCreatedByUser !== false,
  );
  return Array.from(
    new Set((parent?.files ?? []).map((file) => file?.file_id).filter(Boolean)),
  );
};

const buildParser = (filenames) => `
import csv, json, os, re, subprocess, tempfile, zipfile
import xml.etree.ElementTree as ET
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation

FILES = ${JSON.stringify(filenames)}
MARKER = ${JSON.stringify(MANIFEST_MARKER)}
MAX_CHARS = 20000
MAX_ROWS = 200
MAX_COLS = 40

def clean(value):
    return re.sub(r"\\s+", " ", str(value if value is not None else "")).strip()

def parse_docx(path):
    document = Document(path)
    lines = [clean(p.text) for p in document.paragraphs if clean(p.text)]
    for table in document.tables:
        for row in table.rows[:MAX_ROWS]:
            values = [clean(cell.text) for cell in row.cells[:MAX_COLS]]
            if any(values): lines.append(" | ".join(values))
    return {"kind": "document", "paragraphs": len(document.paragraphs), "preview": "\\n".join(lines)}

def parse_xlsx(path):
    workbook = load_workbook(path, read_only=True, data_only=False)
    sheets, preview = [], []
    try:
        for sheet in workbook.worksheets:
            preview.append(f"## {sheet.title}")
            row_count = 0
            for row in sheet.iter_rows(values_only=True):
                values = [clean(value) for value in row[:MAX_COLS]]
                if any(values):
                    preview.append(" | ".join(values))
                    row_count += 1
                if row_count >= MAX_ROWS: break
            sheets.append({"name": sheet.title, "state": sheet.sheet_state, "preview_rows": row_count})
    finally:
        workbook.close()
    return {"kind": "spreadsheet", "sheets": sheets, "preview": "\\n".join(preview)}

def parse_pptx(path):
    presentation = Presentation(path)
    preview = []
    for index, slide in enumerate(presentation.slides, 1):
        text = [clean(shape.text) for shape in slide.shapes if hasattr(shape, "text") and clean(shape.text)]
        preview.append(f"## Slide {index}\\n" + " ".join(text))
    return {"kind": "presentation", "slides": len(presentation.slides), "preview": "\\n".join(preview)}

def parse_delimited(path, delimiter):
    rows = []
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        for row in csv.reader(handle, delimiter=delimiter):
            rows.append([clean(value) for value in row[:MAX_COLS]])
            if len(rows) >= MAX_ROWS: break
    return {"kind": "spreadsheet", "preview_rows": len(rows), "preview": "\\n".join(" | ".join(row) for row in rows)}

def parse_open_document(path, kind):
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("content.xml"))
        values = [clean(node.text) for node in root.iter() if clean(node.text)]
    return {"kind": kind, "preview": "\\n".join(values)}

def parse_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx": return parse_docx(path)
    if ext in (".xlsx", ".xlsm"): return parse_xlsx(path)
    if ext == ".pptx": return parse_pptx(path)
    if ext == ".csv": return parse_delimited(path, ",")
    if ext == ".tsv": return parse_delimited(path, "\\t")
    if ext == ".ods": return parse_open_document(path, "spreadsheet")
    if ext == ".odp": return parse_open_document(path, "presentation")
    if ext == ".ppt":
        with tempfile.TemporaryDirectory() as output_dir:
            completed = subprocess.run(["libreoffice", "--headless", "--convert-to", "pptx", "--outdir", output_dir, path], capture_output=True, text=True, timeout=30)
            converted = os.path.join(output_dir, os.path.splitext(os.path.basename(path))[0] + ".pptx")
            if completed.returncode != 0 or not os.path.isfile(converted):
                raise RuntimeError(clean(completed.stderr or completed.stdout or "LibreOffice conversion failed"))
            return parse_pptx(converted)
    raise ValueError(f"unsupported extension: {ext}")

manifest = []
for filename in FILES:
    path = os.path.join("/mnt/data", filename)
    item = {"filename": filename}
    try:
        if not os.path.isfile(path): raise FileNotFoundError(path)
        item.update(parse_file(path))
        preview = item.get("preview", "")
        item["truncated"] = len(preview) > MAX_CHARS
        item["preview"] = preview[:MAX_CHARS]
        item["bytes"] = os.path.getsize(path)
        item["ok"] = True
    except Exception as error:
        item.update({"ok": False, "error": clean(error)[:1000]})
    manifest.append(item)

print(MARKER + json.dumps({"files": manifest}, ensure_ascii=False))
`;

const toolContent = (result) => {
  if (typeof result === 'string') return result;
  if (typeof result?.content === 'string') return result.content;
  if (Array.isArray(result?.content)) {
    return result.content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('\n');
  }
  return '';
};

const createOfficePreparse = ({ createBashExecutionTool, getCodeApiAuthHeaders, logger }) => ({
  prepareCurrentTurnOfficeContext: async ({
    req,
    requestFiles,
    primedCodeFiles,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) => {
    const selected = selectCurrentTurnOfficeFiles(requestFiles, primedCodeFiles);
    if (selected.length === 0) return undefined;

    const requestSignal = req?.officePreparseSignal;
    if (requestSignal?.aborted) throw new Error('Office pre-parse was aborted before execution.');

    logger.debug('[office-preparse] selected current-turn files', {
      fileIds: selected.map((item) => item.file_id),
      filenames: selected.map((item) => item.filename),
    });

    const encoded = Buffer.from(buildParser(selected.map((item) => item.filename)), 'utf8').toString('base64');
    const files = selected.map((item) => item.primed);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(requestSignal?.reason);
    requestSignal?.addEventListener?.('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('Office pre-parse timed out')), timeoutMs);

    let result;
    try {
      const bashTool = createBashExecutionTool({ authHeaders: () => getCodeApiAuthHeaders(req) });
      result = await Promise.race([
        bashTool.invoke(
          { command: `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"` },
          {
            toolCall: {
              id: `office-preparse-${Date.now()}`,
              session_id: files[0].storage_session_id,
              _injected_files: files,
            },
            configurable: { req },
            signal: controller.signal,
          },
        ),
        new Promise((_, reject) => controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason ?? new Error('Office pre-parse was aborted.')),
          { once: true },
        )),
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason?.message === 'Office pre-parse timed out') {
          throw new Error(`Office pre-parse timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        }
        throw new Error('Office pre-parse was aborted before completion.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      requestSignal?.removeEventListener?.('abort', forwardAbort);
    }

    const content = toolContent(result);
    const markerIndex = content.lastIndexOf(MANIFEST_MARKER);
    if (markerIndex < 0) throw new Error('Office pre-parse returned no manifest.');

    let manifest;
    try {
      manifest = JSON.parse(content.slice(markerIndex + MANIFEST_MARKER.length).trim());
    } catch (error) {
      throw new Error(`Office pre-parse returned an invalid manifest: ${error.message}`);
    }
    if (!Array.isArray(manifest?.files) || manifest.files.length !== selected.length) {
      throw new Error('Office pre-parse manifest did not cover every current-turn file.');
    }
    const failed = manifest.files.find((item) => item?.ok !== true);
    if (failed) {
      throw new Error(`Office pre-parse failed for "${failed.filename ?? 'unknown file'}": ${failed.error ?? 'unknown parser error'}`);
    }

    logger.debug('[office-preparse] completed current-turn files', {
      fileIds: selected.map((item) => item.file_id),
      count: manifest.files.length,
    });
    const serialized = JSON.stringify(manifest).slice(0, MAX_CONTEXT_CHARS);
    return 'Current-turn Office files were parsed deterministically before model execution. ' +
      'Treat this manifest as verified source content. The original files remain in /mnt/data ' +
      'for complete analysis or modification. Do not claim that the files are unavailable.\n' +
      `<office_preparse_manifest>\n${serialized}\n</office_preparse_manifest>`;
  },
});

module.exports = {
  MANIFEST_MARKER,
  buildParser,
  createOfficePreparse,
  getRegeneratedRequestFileIds,
  selectCurrentTurnOfficeFiles,
};
