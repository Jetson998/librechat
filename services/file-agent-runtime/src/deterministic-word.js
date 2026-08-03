import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  ExecutorAdapter,
  ExecutorArtifactError,
  ExecutorProtocolError,
  ExecutorRejectedError,
} from './executor-adapter.js';
import { normalizeActionEnvelope } from './action-envelope.js';
import { DOCX_MIME as DOCX_MIME_CONSTANT, WORD_CAPABILITY_PROFILE } from './constants.js';

export const DOCX_MIME = DOCX_MIME_CONSTANT;
export const WORD_WORKER_VERSION = 'word-worker-v1.0.0';
export const WORD_VERIFIER_PROFILE = 'word-structure-v1';
export const WORD_VERIFIER_VERSION = '1.0.0';

export const WORD_WORKER_IDS = Object.freeze([
  'word.inspect.v1',
  'word.transform.v1',
  'word.patch.v1',
  'word.validate.v1',
]);

const WORD_WORKER_SET = new Set(WORD_WORKER_IDS);
const WORKER_MARKER = '__FILE_AGENT_WORD_WORKER__';
const VERIFIER_MARKER = '__FILE_AGENT_WORD_VERIFIER__';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_WORD_TEXT_CHARS = 4_000;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `\'"\'"\'`)}'`;
}

function pythonFromBase64(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `python3 -c ${shellQuote(`import base64;exec(base64.b64decode("${encoded}"))`)}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function safeRelativeFilename(filename) {
  const normalized = requiredString(filename, 'DOCX input filename').replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('DOCX input filename must be a safe relative path');
  }
  if (!normalized.toLowerCase().endsWith('.docx')) {
    throw new TypeError('Word Worker supports exactly one .docx input');
  }
  return normalized;
}

function safeWorkspaceRoot(value, taskId) {
  const root = (value ?? `/mnt/data/.agent/${taskId}`).replaceAll('{taskId}', taskId);
  const expectedPrefix = `/mnt/data/.agent/${taskId}`;
  if (root !== expectedPrefix && !root.startsWith(`${expectedPrefix}/`)) {
    throw new TypeError('Word workspaceRoot must remain inside the task workspace');
  }
  if (root.split('/').includes('..')) {
    throw new TypeError('Word workspaceRoot cannot contain path traversal');
  }
  return root;
}

function resolveWordContract(task) {
  const inputs = task?.manifest?.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new TypeError('Word task must contain exactly one input');
  }
  const input = inputs[0];
  if (input.mimeType !== DOCX_MIME) {
    throw new TypeError('Word task input MIME must be DOCX');
  }
  const filename = safeRelativeFilename(input.logicalName ?? input.filename);
  if (!SHA256_PATTERN.test(input.sha256 ?? '')) {
    throw new TypeError('Word task input sha256 must be a SHA-256 digest');
  }
  const codeEnvRef = input.codeEnvRef;
  if (
    !codeEnvRef ||
    typeof codeEnvRef.storage_session_id !== 'string' ||
    codeEnvRef.storage_session_id.trim() === '' ||
    typeof codeEnvRef.file_id !== 'string' ||
    codeEnvRef.file_id.trim() === ''
  ) {
    throw new TypeError('Word input requires a CodeAPI codeEnvRef');
  }
  const workspaceRoot = safeWorkspaceRoot(task.manifest.execution?.workspaceRoot, task.taskId);
  const sessionId = task.manifest.execution?.sessionId ?? codeEnvRef.storage_session_id;
  if (sessionId !== codeEnvRef.storage_session_id) {
    throw new TypeError('Word input and execution session must match');
  }
  return {
    filename,
    inputSha256: input.sha256.toLowerCase(),
    sessionId,
    workspaceRoot,
    inputPath: `${workspaceRoot}/input/source.docx`,
    scriptPath: `${workspaceRoot}/scripts/word_worker.py`,
    verifierPath: `${workspaceRoot}/scripts/word_verifier.py`,
    historyPath: `${workspaceRoot}/internal/worker-history.json`,
    verificationPath: `${workspaceRoot}/internal/verification/verify-${task.planRevision}.json`,
    renderDir: `${workspaceRoot}/internal/render`,
    outputPath: `${workspaceRoot}/output/working.docx`,
    injectedFiles: [{
      name: filename,
      storage_session_id: codeEnvRef.storage_session_id,
      file_id: codeEnvRef.file_id,
    }],
  };
}

function normalizedText(value, field) {
  const text = requiredString(value, field);
  if (text.length > MAX_WORD_TEXT_CHARS) {
    throw new TypeError(`${field} exceeds ${MAX_WORD_TEXT_CHARS} characters`);
  }
  return text;
}

function normalizeWordParameters(parameters, worker) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('Word Action parameters must be an object');
  }
  const operation = parameters.operation ?? (worker === 'word.inspect.v1' ? 'inspect' : 'validate');
  if (!['inspect', 'validate', 'replace_text', 'append_paragraph', 'replace_table_cell'].includes(operation)) {
    throw new TypeError(`Unsupported Word operation: ${operation}`);
  }
  if (worker === 'word.inspect.v1' && operation !== 'inspect') {
    throw new TypeError('word.inspect.v1 requires operation inspect');
  }
  if (worker === 'word.validate.v1' && operation !== 'validate') {
    throw new TypeError('word.validate.v1 requires operation validate');
  }
  if (worker === 'word.transform.v1' && !['replace_text', 'append_paragraph', 'replace_table_cell'].includes(operation)) {
    throw new TypeError('word.transform.v1 requires a transform operation');
  }
  if (worker === 'word.patch.v1' && !['replace_text', 'append_paragraph', 'replace_table_cell'].includes(operation)) {
    throw new TypeError('word.patch.v1 requires a patch operation');
  }

  const normalized = { operation };
  if (operation === 'replace_text') {
    normalized.find = normalizedText(parameters.find, 'parameters.find');
    const replacement = parameters.replace ?? '';
    if (typeof replacement !== 'string' || replacement.length > MAX_WORD_TEXT_CHARS) {
      throw new TypeError('parameters.replace must be a string within the Word text limit');
    }
    normalized.replace = replacement;
    if (parameters.occurrence != null) {
      if (!Number.isSafeInteger(parameters.occurrence) || parameters.occurrence < 1) {
        throw new TypeError('parameters.occurrence must be a positive integer');
      }
      normalized.occurrence = parameters.occurrence;
    }
  } else if (operation === 'append_paragraph') {
    normalized.text = normalizedText(parameters.text, 'parameters.text');
    if (parameters.style != null) {
      if (
        typeof parameters.style !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_ -]{0,63}$/.test(parameters.style)
      ) {
        throw new TypeError('parameters.style is not a valid Word style name');
      }
      normalized.style = parameters.style;
    }
  } else if (operation === 'replace_table_cell') {
    for (const field of ['tableIndex', 'rowIndex', 'columnIndex']) {
      if (!Number.isSafeInteger(parameters[field]) || parameters[field] < 0) {
        throw new TypeError(`parameters.${field} must be a non-negative integer`);
      }
      normalized[field] = parameters[field];
    }
    normalized.text = normalizedText(parameters.text, 'parameters.text');
  }

  if (worker === 'word.patch.v1') {
    if (!SHA256_PATTERN.test(parameters.expectedBaseSha256 ?? '')) {
      throw new TypeError('word.patch.v1 requires expectedBaseSha256');
    }
    normalized.expectedBaseSha256 = parameters.expectedBaseSha256.toLowerCase();
  }
  return normalized;
}

export function normalizeWordAction(action) {
  const normalized = normalizeActionEnvelope(action, { allowedWorkers: WORD_WORKER_SET });
  const parameters = normalizeWordParameters(normalized.parameters, normalized.worker);
  if (!normalized.inputRefs.includes('input:source-docx')) {
    throw new TypeError('Word Action must reference input:source-docx');
  }
  if (normalized.targetRef !== 'candidate:working-docx') {
    throw new TypeError('Word Action targetRef must be candidate:working-docx');
  }
  return { ...normalized, parameters };
}

function action(worker, parameters, expectedChange, summary) {
  return normalizeWordAction({
    schemaVersion: '1.0',
    objective: 'Apply the bounded Word document change and preserve unrelated content',
    worker,
    inputRefs: ['input:source-docx'],
    targetRef: 'candidate:working-docx',
    parameters,
    expectedChange,
    verificationProfile: WORD_VERIFIER_PROFILE,
    onFailure: 'replan',
    summary,
  });
}

function requiredChangesForTask(task) {
  if (Array.isArray(task.acceptanceLedger) && task.acceptanceLedger.length > 0) {
    return task.acceptanceLedger.map((entry) => ({
      worker: entry.worker,
      parameters: entry.parameters,
      expectedChange: entry.expectedChange ?? [],
    }));
  }
  const executedActions = Object.values(task.itemResults ?? {})
    .map((result) => result?.action)
    .filter((entry) => entry?.worker === 'word.transform.v1' || entry?.worker === 'word.patch.v1');
  const fallbackActions = executedActions.length > 0
    ? executedActions
    : (Array.isArray(task.plan?.actions) ? task.plan.actions : []);
  return fallbackActions
    .filter((entry) => entry?.worker === 'word.transform.v1' || entry?.worker === 'word.patch.v1')
    .map((entry) => normalizeWordAction(entry))
    .map(({ worker, parameters, expectedChange }) => ({ worker, parameters, expectedChange }));
}

export class DeterministicWordProvider {
  async plan({ task }) {
    const inspected = Object.values(task.itemResults ?? {})
      .some((result) => result?.operation === 'inspect');
    const configured = task.manifest.wordPlan;
    if (Array.isArray(configured) && configured.length > 0) {
      const actions = configured
        .map((entry) => normalizeWordAction(entry))
        .filter((entry) => !inspected || entry.worker !== 'word.inspect.v1');
      if (actions.length === 0) {
        return {
          needsInput: true,
          question: 'The Word inspection completed but no bounded modification was provided.',
          actions: [],
        };
      }
      return {
        needsInput: false,
        summary: 'Run the declared deterministic Word plan',
        actions,
      };
    }
    return inspected
      ? {
          needsInput: false,
          summary: 'Append one deterministic Word paragraph after inspection',
          actions: [
            action(
              'word.transform.v1',
              { operation: 'append_paragraph', text: 'File Agent Runtime Word output' },
              ['document.paragraph'],
              'Append the deterministic Word output paragraph',
            ),
          ],
        }
      : {
          needsInput: false,
          summary: 'Inspect and append one deterministic Word paragraph',
          actions: [
            action('word.inspect.v1', { operation: 'inspect' }, ['document.structure'], 'Inspect the authorized DOCX'),
            action(
              'word.transform.v1',
              { operation: 'append_paragraph', text: 'File Agent Runtime Word output' },
              ['document.paragraph'],
              'Append the deterministic Word output paragraph',
            ),
          ],
        };
  }

  async repair({ task, verification }) {
    const configured = task.manifest.wordRepairPlan;
    if (Array.isArray(configured) && configured.length > 0) {
      return {
        needsInput: false,
        summary: 'Run the declared deterministic Word repair plan',
        actions: configured.map((entry) => normalizeWordAction(entry)),
      };
    }
    const baseSha256 = verification?.artifact?.sha256;
    if (!SHA256_PATTERN.test(baseSha256 ?? '')) {
      return {
        needsInput: true,
        question: 'The Word candidate has no stable base hash for a safe repair.',
        actions: [],
      };
    }
    return {
      needsInput: false,
      summary: 'Apply one bounded repair to the current Word candidate',
      actions: [
        action(
          'word.patch.v1',
          {
            operation: 'append_paragraph',
            text: 'File Agent Runtime Word repair',
            expectedBaseSha256: baseSha256,
          },
          ['document.paragraph'],
          'Apply the stable Word repair patch',
        ),
      ],
    };
  }
}

const WORKER_SCRIPT = String.raw`import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}
ET.register_namespace("w", W_NS)
MARKER = "__FILE_AGENT_WORD_WORKER__"
WORKER_VERSION = "word-worker-v1.0.0"

def emit(value):
    print(MARKER + json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def fail(code, summary):
    emit({"ok": False, "code": code, "summary": summary})
    raise SystemExit(0)

def data_root():
    return Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()

def task_root():
    value = Path(os.environ["FILE_AGENT_TASK_ROOT"])
    if value.is_symlink():
        fail("WORD_PATH_SYMLINK", "The Word task root cannot be a symbolic link")
    root = value.resolve()
    data = data_root()
    if root != data and data not in root.parents:
        fail("WORD_PATH_SCOPE", "Word task root escaped the CodeAPI data root")
    return root

def reject_symlink_components(value, root):
    current = value
    while current != root:
        if current.is_symlink():
            fail("WORD_PATH_SYMLINK", "Word Worker paths cannot traverse symbolic links")
        current = current.parent

def task_path(name):
    value = Path(os.environ[name])
    root = task_root()
    resolved = value.resolve()
    if resolved != root and root not in resolved.parents:
        fail("WORD_PATH_SCOPE", "Word Worker path escaped the task workspace")
    reject_symlink_components(value, Path(os.environ["FILE_AGENT_TASK_ROOT"]))
    return value

def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def local_name(tag):
    return tag.rsplit("}", 1)[-1]

def read_xml(package, name):
    try:
        return ET.fromstring(package.read(name))
    except Exception:
        fail("WORD_XML_INVALID", "A required Word XML part could not be parsed")

def copy_input():
    root = data_root()
    source = root / os.environ["FILE_AGENT_INPUT_NAME"]
    if not source.is_file():
        fail("WORD_INPUT_MISSING", "The authorized DOCX input is not available")
    if source.is_symlink() or root not in source.resolve().parents:
        fail("WORD_INPUT_SYMLINK", "The authorized DOCX input traverses a symbolic link")
    input_path = task_path("FILE_AGENT_INPUT_PATH")
    input_path.parent.mkdir(parents=True, exist_ok=True)
    expected = os.environ["FILE_AGENT_INPUT_SHA256"].lower()
    if digest_file(source) != expected:
        fail("WORD_INPUT_HASH_MISMATCH", "The authorized DOCX input hash does not match the manifest")
    if input_path.exists():
        if digest_file(input_path) != expected:
            fail("WORD_INPUT_IMMUTABLE_VIOLATION", "The task input copy changed after initialization")
    else:
        shutil.copyfile(source, input_path)
        input_path.chmod(0o444)
    if digest_file(input_path) != expected:
        fail("WORD_INPUT_HASH_MISMATCH", "The task input copy could not be verified")
    return input_path

def ensure_package(path):
    if not path.is_file() or not zipfile.is_zipfile(path):
        fail("WORD_PACKAGE_INVALID", "The DOCX candidate is not a valid OOXML ZIP package")
    try:
        with zipfile.ZipFile(path, "r") as package:
            bad = package.testzip()
            if bad:
                fail("WORD_PACKAGE_INVALID", "The DOCX package contains a damaged ZIP member")
            names = set(package.namelist())
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                fail("WORD_PACKAGE_INCOMPLETE", "The DOCX package is missing required Word parts")
            unsupported = [
                name for name in names
                if name.lower().endswith(("vbaproject.bin", "vbadata.xml"))
                or "/embeddings/" in name.lower()
                or name.lower().startswith("embeddings/")
            ]
            if unsupported:
                fail("WORD_UNSUPPORTED_CONTENT", "The DOCX package contains macros or embedded objects")
    except zipfile.BadZipFile:
        fail("WORD_PACKAGE_INVALID", "The DOCX package cannot be opened")

def load_history(path):
    if not path.exists():
        return []
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        fail("WORD_HISTORY_INVALID", "The Worker history is not valid JSON")
    return value if isinstance(value, list) else []

def save_history(path, history):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)

def action_value():
    try:
        return json.loads(base64.b64decode(os.environ["FILE_AGENT_ACTION_B64"]).decode("utf-8"))
    except Exception:
        fail("WORD_ACTION_INVALID", "The Worker action payload is invalid")

def replace_text(root, parameters):
    find = parameters["find"]
    replacement = parameters.get("replace", "")
    occurrence = parameters.get("occurrence", 1)
    matches = 0
    for paragraph in root.findall(".//w:p", NS):
        nodes = paragraph.findall(".//w:t", NS)
        paragraph_text = "".join(node.text or "" for node in nodes)
        search_from = 0
        while True:
            index = paragraph_text.find(find, search_from)
            if index < 0:
                break
            matches += 1
            if matches == occurrence:
                end = index + len(find)
                ranges = []
                cursor = 0
                for node_index, node in enumerate(nodes):
                    text = node.text or ""
                    node_start = cursor
                    node_end = cursor + len(text)
                    if index < node_end and end > node_start:
                        ranges.append((node_index, node_start, node_end))
                    cursor = node_end
                if not ranges:
                    fail("WORD_TEXT_NOT_FOUND", "The requested Word text was not found")
                first_index = ranges[0][0]
                last_index = ranges[-1][0]
                first_text = nodes[first_index].text or ""
                first_offset = index - ranges[0][1]
                if first_index == last_index:
                    nodes[first_index].text = (
                        first_text[:first_offset]
                        + replacement
                        + first_text[first_offset + len(find):]
                    )
                else:
                    nodes[first_index].text = first_text[:first_offset] + replacement
                    for node_index in range(first_index + 1, last_index):
                        nodes[node_index].text = ""
                    last_text = nodes[last_index].text or ""
                    last_offset = end - ranges[-1][1]
                    nodes[last_index].text = last_text[last_offset:]
                return
            search_from = index + len(find)
    if matches < occurrence:
        fail("WORD_TEXT_NOT_FOUND", "The requested Word text was not found")

def append_paragraph(root, parameters):
    body = root.find(".//w:body", NS)
    if body is None:
        fail("WORD_DOCUMENT_BODY_MISSING", "The Word document body is missing")
    paragraph = ET.Element("{" + W_NS + "}p")
    if parameters.get("style"):
        properties = ET.SubElement(paragraph, "{" + W_NS + "}pPr")
        style = ET.SubElement(properties, "{" + W_NS + "}pStyle")
        style.set("{" + W_NS + "}val", parameters["style"])
    run = ET.SubElement(paragraph, "{" + W_NS + "}r")
    text = ET.SubElement(run, "{" + W_NS + "}t")
    text.text = parameters["text"]
    sect = body.find("w:sectPr", NS)
    if sect is None:
        body.append(paragraph)
    else:
        body.insert(list(body).index(sect), paragraph)

def replace_table_cell(root, parameters):
    tables = root.findall(".//w:tbl", NS)
    table_index = parameters["tableIndex"]
    row_index = parameters["rowIndex"]
    column_index = parameters["columnIndex"]
    if table_index >= len(tables):
        fail("WORD_TABLE_NOT_FOUND", "The requested Word table was not found")
    rows = tables[table_index].findall("./w:tr", NS)
    if row_index >= len(rows):
        fail("WORD_TABLE_ROW_NOT_FOUND", "The requested Word table row was not found")
    cells = rows[row_index].findall("./w:tc", NS)
    if column_index >= len(cells):
        fail("WORD_TABLE_CELL_NOT_FOUND", "The requested Word table cell was not found")
    texts = cells[column_index].findall(".//w:t", NS)
    if not texts:
        paragraph = ET.SubElement(cells[column_index], "{" + W_NS + "}p")
        run = ET.SubElement(paragraph, "{" + W_NS + "}r")
        texts = [ET.SubElement(run, "{" + W_NS + "}t")]
    texts[0].text = parameters["text"]
    for node in texts[1:]:
        node.text = ""

def transform(action, source, output, history_path):
    ensure_package(source)
    before = digest_file(source)
    parameters = action["parameters"]
    if action["worker"] == "word.patch.v1" and before != parameters["expectedBaseSha256"]:
        fail("WORD_PATCH_BASE_CONFLICT", "The Word patch base hash no longer matches the candidate")
    with zipfile.ZipFile(source, "r") as package:
        members = [(name, package.read(name), package.getinfo(name)) for name in package.namelist()]
    document = next((data for name, data, _ in members if name == "word/document.xml"), None)
    if document is None:
        fail("WORD_DOCUMENT_MISSING", "The Word document part is missing")
    try:
        root = ET.fromstring(document)
    except Exception:
        fail("WORD_XML_INVALID", "The Word document part could not be parsed")
    operation = parameters["operation"]
    if operation == "replace_text":
        replace_text(root, parameters)
    elif operation == "append_paragraph":
        append_paragraph(root, parameters)
    elif operation == "replace_table_cell":
        replace_table_cell(root, parameters)
    else:
        fail("WORD_OPERATION_UNSUPPORTED", "The Word transform operation is not supported")
    new_document = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkstemp(prefix="word-candidate-", suffix=".docx", dir=str(output.parent))[1])
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as destination:
            for name, data, _ in members:
                destination.writestr(name, new_document if name == "word/document.xml" else data)
        after = digest_file(temporary)
        shutil.copystat(source, temporary, follow_symlinks=False)
        temporary.replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()
    history = load_history(history_path)
    history.append({
        "worker": action["worker"],
        "workerVersion": WORKER_VERSION,
        "operation": operation,
        "parametersDigest": hashlib.sha256(json.dumps(parameters, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        "beforeSha256": before,
        "afterSha256": after,
    })
    save_history(history_path, history)
    return {"ok": True, "worker": action["worker"], "operation": operation, "sha256": after, "size": output.stat().st_size}

def inspect(path):
    ensure_package(path)

    def clip(value, limit=320):
        value = value or ""
        return value if len(value) <= limit else value[:limit - 3] + "..."

    def paragraph_text(paragraph):
        return "".join(node.text or "" for node in paragraph.findall(".//w:t", NS))

    def paragraph_style(paragraph):
        properties = paragraph.find("w:pPr", NS)
        style = properties.find("w:pStyle", NS) if properties is not None else None
        return style.attrib.get("{" + W_NS + "}val") if style is not None else None

    def paragraph_records(root, location):
        records = []
        for index, paragraph in enumerate(root.findall(".//w:p", NS)):
            if len(records) >= 40:
                break
            records.append({
                "index": index,
                "location": location,
                "text": clip(paragraph_text(paragraph)),
                "style": paragraph_style(paragraph),
            })
        return records

    def table_records(root):
        records = []
        for table_index, table in enumerate(root.findall(".//w:tbl", NS)):
            if len(records) >= 8:
                break
            rows = []
            for row_index, row in enumerate(table.findall("./w:tr", NS)):
                if len(rows) >= 12:
                    break
                cells = []
                for cell in row.findall("./w:tc", NS)[:12]:
                    cells.append(clip(paragraph_text(cell), 240))
                rows.append({"index": row_index, "cells": cells})
            records.append({"index": table_index, "rows": rows})
        return records

    def part_records(package, names, prefix):
        records = []
        for name in names:
            if not name.startswith(prefix) or not name.endswith(".xml"):
                continue
            try:
                part_root = ET.fromstring(package.read(name))
            except Exception:
                continue
            records.append({
                "name": name,
                "paragraphs": [entry["text"] for entry in paragraph_records(part_root, name)[:20]],
            })
        return records

    with zipfile.ZipFile(path, "r") as package:
        names = sorted(package.namelist())
        root = ET.fromstring(package.read("word/document.xml"))
        paragraphs = len(root.findall(".//w:p", NS))
        tables = len(root.findall(".//w:tbl", NS))
        style_records = []
        if "word/styles.xml" in names:
            styles_root = ET.fromstring(package.read("word/styles.xml"))
            for style in styles_root.findall(".//w:style", NS)[:80]:
                name = style.find("w:name", NS)
                style_records.append({
                    "id": style.attrib.get("{" + W_NS + "}styleId"),
                    "name": name.attrib.get("{" + W_NS + "}val") if name is not None else None,
                })
        header_records = part_records(package, names, "word/header")
        footer_records = part_records(package, names, "word/footer")
    return {
        "ok": True,
        "operation": "inspect",
        "parts": names,
        "paragraphCount": paragraphs,
        "tableCount": tables,
        "styleCount": len(style_records),
        "paragraphs": paragraph_records(root, "body"),
        "tables": table_records(root),
        "styles": style_records,
        "headers": header_records,
        "footers": footer_records,
        "headerCount": len([name for name in names if name.startswith("word/header") and name.endswith(".xml")]),
        "footerCount": len([name for name in names if name.startswith("word/footer") and name.endswith(".xml")]),
        "imageCount": len([name for name in names if name.startswith("word/media/")]),
        "sha256": digest_file(path),
    }

def main():
    input_path = copy_input()
    output_path = task_path("FILE_AGENT_OUTPUT_PATH")
    history_path = task_path("FILE_AGENT_HISTORY_PATH")
    worker = os.environ.get("FILE_AGENT_OPERATION")
    if worker == "prepare":
        ensure_package(input_path)
        emit({"ok": True, "operation": "prepare", "inputSha256": digest_file(input_path)})
        return
    if worker == "inspect":
        result = inspect(input_path)
        inspect_path = task_path("FILE_AGENT_INSPECT_PATH")
        inspect_path.parent.mkdir(parents=True, exist_ok=True)
        inspect_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        emit(result)
        return
    if worker == "validate":
        ensure_package(output_path)
        emit({"ok": True, "operation": "validate", "sha256": digest_file(output_path), "size": output_path.stat().st_size})
        return
    action = action_value()
    if worker not in {"transform", "patch"}:
        fail("WORD_OPERATION_UNSUPPORTED", "The Word Worker operation is not supported")
    if worker == "patch" and not output_path.exists():
        fail("WORD_PATCH_CANDIDATE_MISSING", "The Word patch candidate does not exist")
    base_path = output_path if output_path.exists() else input_path
    result = transform(action, base_path, output_path, history_path)
    emit(result)

try:
    main()
except SystemExit:
    raise
except Exception:
    fail("WORD_WORKER_FAILED", "The deterministic Word Worker failed")
`;

const VERIFIER_SCRIPT = String.raw`import base64
import hashlib
import json
import os
import subprocess
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}
MARKER = "__FILE_AGENT_WORD_VERIFIER__"

def emit(value):
    print(MARKER + json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def local_name(tag):
    return tag.rsplit("}", 1)[-1]

def fail(code, summary, evidence, assertion_class="STRUCTURE"):
    evidence.append({"code": code, "class": assertion_class, "summary": summary})

def part_target(name, target):
    if target.startswith("http:") or target.startswith("https:") or target.startswith("mailto:"):
        return None
    base = ""
    if "/_rels/" in name:
        base = name.split("/_rels/", 1)[0]
    return str(Path(base, target).as_posix()).lstrip("./")

def scoped_path(value, lexical_root, resolved_root):
    value = Path(value)
    if lexical_root.is_symlink():
        raise ValueError("Word verifier task root cannot be a symbolic link")
    if not value.is_absolute():
        raise ValueError("Word verifier paths must be absolute")
    if value != lexical_root and lexical_root not in value.parents:
        raise ValueError("Word verifier path escaped the task workspace")
    current = value
    while current != lexical_root:
        if current.is_symlink():
            raise ValueError("Word verifier paths cannot traverse symbolic links")
        parent = current.parent
        if parent == current:
            raise ValueError("Word verifier path did not reach the task workspace")
        current = parent
    resolved = value.resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ValueError("Word verifier path escaped the task workspace")
    return resolved

def paragraph_text(paragraph):
    return "".join(node.text or "" for node in paragraph.findall(".//w:t", NS))

def paragraph_style(paragraph):
    properties = paragraph.find("w:pPr", NS)
    style = properties.find("w:pStyle", NS) if properties is not None else None
    return style.attrib.get("{" + W_NS + "}val") if style is not None else None

def document_model(root):
    paragraphs = []
    records = {}
    for paragraph in root.findall(".//w:p", NS):
        record = {"text": paragraph_text(paragraph), "style": paragraph_style(paragraph)}
        records[id(paragraph)] = record
        paragraphs.append(record)

    body = root.find(".//w:body", NS)
    body_paragraphs = []
    if body is not None:
        body_paragraphs = [records[id(paragraph)] for paragraph in body.findall("./w:p", NS)]

    tables = []
    for table in root.findall(".//w:tbl", NS):
        rows = []
        for row in table.findall("./w:tr", NS):
            cells = []
            for cell in row.findall("./w:tc", NS):
                cell_paragraphs = [records[id(paragraph)] for paragraph in cell.findall(".//w:p", NS)]
                cells.append({"paragraphs": cell_paragraphs})
            rows.append({"cells": cells})
        tables.append({"rows": rows})
    return {"paragraphs": paragraphs, "bodyParagraphs": body_paragraphs, "tables": tables}

def replace_nth_paragraph(model, find, replacement, occurrence):
    if not isinstance(find, str) or find == "" or not isinstance(replacement, str):
        return False
    if not isinstance(occurrence, int) or occurrence < 1:
        return False
    matches = 0
    for record in model["paragraphs"]:
        start = 0
        while True:
            index = record["text"].find(find, start)
            if index < 0:
                break
            matches += 1
            if matches == occurrence:
                record["text"] = record["text"][:index] + replacement + record["text"][index + len(find):]
                return True
            start = index + len(find)
    return False

def append_expected_paragraph(model, text, style):
    record = {"text": text, "style": style}
    model["paragraphs"].append(record)
    model["bodyParagraphs"].append(record)
    return True

def replace_expected_table_cell(model, parameters):
    try:
        table = model["tables"][parameters["tableIndex"]]
        row = table["rows"][parameters["rowIndex"]]
        cell = row["cells"][parameters["columnIndex"]]
        paragraphs = cell["paragraphs"]
        if not paragraphs:
            return False
        paragraphs[0]["text"] = parameters["text"]
        for paragraph in paragraphs[1:]:
            paragraph["text"] = ""
        return True
    except (KeyError, IndexError, TypeError):
        return False

def models_match(expected, actual):
    if len(expected["paragraphs"]) != len(actual["paragraphs"]):
        return False
    if any(left != right for left, right in zip(expected["paragraphs"], actual["paragraphs"])):
        return False
    if len(expected["bodyParagraphs"]) != len(actual["bodyParagraphs"]):
        return False
    if any(left != right for left, right in zip(expected["bodyParagraphs"], actual["bodyParagraphs"])):
        return False
    if len(expected["tables"]) != len(actual["tables"]):
        return False
    for expected_table, actual_table in zip(expected["tables"], actual["tables"]):
        if len(expected_table["rows"]) != len(actual_table["rows"]):
            return False
        for expected_row, actual_row in zip(expected_table["rows"], actual_table["rows"]):
            if len(expected_row["cells"]) != len(actual_row["cells"]):
                return False
            for expected_cell, actual_cell in zip(expected_row["cells"], actual_row["cells"]):
                expected_text = "".join(paragraph["text"] for paragraph in expected_cell["paragraphs"])
                actual_text = "".join(paragraph["text"] for paragraph in actual_cell["paragraphs"])
                if expected_text != actual_text:
                    return False
    return True

def main():
    output = Path(os.environ["FILE_AGENT_OUTPUT_PATH"])
    evidence_path = Path(os.environ["FILE_AGENT_VERIFICATION_PATH"])
    render_dir = Path(os.environ["FILE_AGENT_RENDER_DIR"])
    lexical_root = Path(os.environ["FILE_AGENT_TASK_ROOT"])
    resolved_root = lexical_root.resolve()
    input_path = scoped_path(os.environ["FILE_AGENT_INPUT_PATH"], lexical_root, resolved_root)
    output = scoped_path(output, lexical_root, resolved_root)
    evidence_path = scoped_path(evidence_path, lexical_root, resolved_root)
    render_dir = scoped_path(render_dir, lexical_root, resolved_root)
    render_bin = os.environ.get("FILE_AGENT_RENDER_BIN", "soffice")
    try:
        required_changes = json.loads(base64.b64decode(os.environ["FILE_AGENT_REQUIRED_CHANGES_B64"]).decode("utf-8"))
    except Exception:
        required_changes = []
    failed = []
    passed = []
    package = None
    names = set()
    document_root = None
    metrics = {"pageCount": 0, "paragraphCount": 0, "tableCount": 0, "imageCount": 0}

    try:
        if not output.is_file() or not zipfile.is_zipfile(output):
            raise ValueError("invalid zip")
        package = zipfile.ZipFile(output, "r")
        if package.testzip():
            raise ValueError("damaged zip member")
        names = set(package.namelist())
        passed.append("ooxml.zip.valid")
    except Exception:
        fail("ooxml.zip.valid", "The candidate is not a valid OOXML ZIP package", failed)

    if package is not None:
        try:
            content_types = ET.fromstring(package.read("[Content_Types].xml"))
            defaults = {(entry.attrib.get("Extension"), entry.attrib.get("ContentType")) for entry in content_types if local_name(entry.tag) == "Default"}
            overrides = {(entry.attrib.get("PartName"), entry.attrib.get("ContentType")) for entry in content_types if local_name(entry.tag) == "Override"}
            if ("xml", "application/xml") not in defaults or ("rels", "application/vnd.openxmlformats-package.relationships+xml") not in defaults or not any(part == "/word/document.xml" for part, _ in overrides):
                raise ValueError("content type declarations incomplete")
            passed.append("ooxml.content_types.valid")
        except Exception:
            fail("ooxml.content_types.valid", "OOXML content type declarations are invalid", failed)

        parseable = True
        for name in names:
            if name.endswith(".xml") or name.endswith(".rels"):
                try:
                    ET.fromstring(package.read(name))
                except Exception:
                    parseable = False
                    break
        if parseable:
            passed.append("xml.parts.parseable")
        else:
            fail("xml.parts.parseable", "One or more OOXML XML parts are not parseable", failed)

        try:
            document_root = ET.fromstring(package.read("word/document.xml"))
            passed.append("word.document.present")
            metrics["paragraphCount"] = len(document_root.findall(".//w:p", NS))
            metrics["tableCount"] = len(document_root.findall(".//w:tbl", NS))
            metrics["imageCount"] = len(document_root.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}inline", {}))
        except Exception:
            fail("word.document.present", "word/document.xml is missing or invalid", failed)
            fail("word.document.present", "Word document metrics are unavailable", failed)

        relationships_ok = True
        try:
            for name in names:
                if not name.endswith(".rels"):
                    continue
                rel_root = ET.fromstring(package.read(name))
                for relationship in rel_root:
                    target = relationship.attrib.get("Target", "")
                    resolved = part_target(name, target)
                    if resolved and resolved not in names:
                        relationships_ok = False
                        break
                if not relationships_ok:
                    break
        except Exception:
            relationships_ok = False
        if relationships_ok:
            passed.append("word.relationships.resolved")
        else:
            fail("word.relationships.resolved", "A Word relationship points to a missing or invalid part", failed)

        comments_ok = True
        try:
            comment_ids = set()
            if "word/comments.xml" in names:
                comments_root = ET.fromstring(package.read("word/comments.xml"))
                comment_ids = {entry.attrib.get("{%s}id" % W_NS) for entry in comments_root if local_name(entry.tag) == "comment"}
            references = set()
            if document_root is not None:
                for element in document_root.iter():
                    if local_name(element.tag) in {"commentRangeStart", "commentRangeEnd", "commentReference"}:
                        references.add(element.attrib.get("{%s}id" % W_NS))
            comments_ok = comment_ids == references
        except Exception:
            comments_ok = False
        if comments_ok:
            passed.append("word.comments.no_orphans")
        else:
            fail("word.comments.no_orphans", "Word comments contain an orphan or unresolved reference", failed)

        changes_ok = bool(required_changes) and document_root is not None
        if changes_ok:
            try:
                with zipfile.ZipFile(input_path, "r") as source_package:
                    source_root = ET.fromstring(source_package.read("word/document.xml"))
                expected_model = document_model(source_root)
                actual_model = document_model(document_root)
                for change in required_changes:
                    parameters = change.get("parameters", {})
                    operation = parameters.get("operation")
                    if operation == "replace_text":
                        occurrence = parameters.get("occurrence", 1)
                        changes_ok = replace_nth_paragraph(
                            expected_model,
                            parameters.get("find"),
                            parameters.get("replace", ""),
                            occurrence,
                        ) and changes_ok
                    elif operation == "append_paragraph":
                        changes_ok = append_expected_paragraph(
                            expected_model,
                            parameters.get("text"),
                            parameters.get("style"),
                        ) and changes_ok
                    elif operation == "replace_table_cell":
                        changes_ok = replace_expected_table_cell(expected_model, parameters) and changes_ok
                    else:
                        changes_ok = False
                changes_ok = changes_ok and models_match(expected_model, actual_model)
            except Exception:
                changes_ok = False
        if changes_ok:
            passed.append("word.required_changes.applied")
        else:
            fail("word.required_changes.applied", "The declared Word change is not present in the candidate", failed, "CONTENT")

    else:
        for code, summary in [
            ("ooxml.content_types.valid", "The candidate package cannot be inspected"),
            ("xml.parts.parseable", "The candidate package cannot be inspected"),
            ("word.document.present", "The Word document part is unavailable"),
            ("word.relationships.resolved", "The Word relationships cannot be inspected"),
            ("word.comments.no_orphans", "The Word comments cannot be inspected"),
            ("word.required_changes.applied", "The Word change cannot be inspected"),
        ]:
            fail(code, summary, failed)

    render_ok = False
    if package is not None and not any(item["code"] in {"ooxml.zip.valid", "xml.parts.parseable", "word.document.present"} for item in failed):
        try:
            render_dir.mkdir(parents=True, exist_ok=True)
            profile = render_dir / "libreoffice-profile"
            profile.mkdir(parents=True, exist_ok=True)
            command = [render_bin, "--headless", "-env:UserInstallation=file://" + str(profile), "--convert-to", "pdf", "--outdir", str(render_dir), str(output)]
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90, check=False)
            pdf = render_dir / (output.stem + ".pdf")
            render_ok = result.returncode == 0 and pdf.is_file() and pdf.stat().st_size > 0
            if render_ok:
                metrics["pageCount"] = max(1, pdf.read_bytes().count(b"/Type /Page"))
        except Exception:
            render_ok = False
    if render_ok:
        passed.append("word.render.succeeded")
    else:
        fail("word.render.succeeded", "The DOCX candidate could not be rendered deterministically", failed, "RENDER")

    if package is not None:
        package.close()
    failed_codes = {item["code"] for item in failed}
    result = {
        "schemaVersion": "1.0",
        "profile": "word-structure-v1",
        "profileVersion": "1.0.0",
        "passed": len(failed) == 0 and len(passed) == 8,
        "requiredAssertionCount": 8,
        "passedAssertionCodes": sorted(set(passed)),
        "failedAssertions": [
            {"code": item["code"], "class": item["class"], "summary": item["summary"], "evidenceRef": "workspace://verification/current.json"}
            for item in failed
        ],
        "artifact": {
            "logicalId": "candidate:working-docx",
            "revision": int(os.environ.get("FILE_AGENT_PLAN_REVISION", "0")),
            "sha256": digest_file(output) if output.is_file() else None,
            "size": output.stat().st_size if output.is_file() else 0,
        },
        "metrics": metrics,
        "errorClass": None if not failed else "WORD_" + sorted(failed_codes)[0].replace(".", "_").upper(),
        "summary": "Word structure, required changes, and render passed" if not failed else "Word verification failed",
    }
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    emit(result)

try:
    main()
except Exception:
    emit({"schemaVersion": "1.0", "profile": "word-structure-v1", "profileVersion": "1.0.0", "passed": False, "requiredAssertionCount": 8, "passedAssertionCodes": [], "failedAssertions": [{"code": "word.verifier.failed", "class": "VERIFIER", "summary": "The deterministic Word verifier failed", "evidenceRef": "workspace://verification/current.json"}], "artifact": {"logicalId": "candidate:working-docx", "revision": 0}, "metrics": {}, "errorClass": "WORD_VERIFIER_FAILED", "summary": "Word verification failed"})
`;

function environment(entries) {
  return entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}

function stableScriptWriteCommand(contract) {
  const files = [
    [
      contract.scriptPath,
      Buffer.from(WORKER_SCRIPT, 'utf8').toString('base64'),
      sha256(WORKER_SCRIPT),
    ],
    [
      contract.verifierPath,
      Buffer.from(VERIFIER_SCRIPT, 'utf8').toString('base64'),
      sha256(VERIFIER_SCRIPT),
    ],
  ];
  const python = `import base64, hashlib, os\nfrom pathlib import Path\ndata_root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()\ntask_root = Path(os.environ["FILE_AGENT_TASK_ROOT"])\nif task_root.is_symlink():\n    raise RuntimeError("Word task root cannot be a symbolic link")\ntask_root = task_root.resolve()\nif task_root != data_root and data_root not in task_root.parents:\n    raise RuntimeError("Word task root escaped the CodeAPI data root")\ndef checked_path(absolute):\n    virtual_path = Path(absolute)\n    try:\n        relative = virtual_path.relative_to(Path("/mnt/data"))\n    except ValueError:\n        raise RuntimeError("Word script path is outside the CodeAPI data root")\n    path = data_root / relative\n    resolved = path.resolve()\n    if resolved != task_root and task_root not in resolved.parents:\n        raise RuntimeError("Word script path escaped the task workspace")\n    current = path\n    while current != task_root:\n        if current.is_symlink():\n            raise RuntimeError("Word script path traverses a symbolic link")\n        current = current.parent\n    return path\nfiles = ${JSON.stringify(files)}\nfor absolute, source, expected in files:\n    path = checked_path(absolute)\n    path.parent.mkdir(parents=True, exist_ok=True)\n    data = base64.b64decode(source)\n    if path.exists():\n        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:\n            raise RuntimeError("stable Word script revision conflict")\n    else:\n        path.write_bytes(data)\n`;
  return `${environment([
    ['FILE_AGENT_MNT_DATA', '/mnt/data'],
    ['FILE_AGENT_TASK_ROOT', contract.workspaceRoot],
  ])} ${pythonFromBase64(python)}`;
}

function parseMarker(stdout, marker, label) {
  const index = stdout.lastIndexOf(marker);
  if (index < 0) {
    throw new ExecutorProtocolError(`${label} returned no result marker`);
  }
  try {
    const result = JSON.parse(stdout.slice(index + marker.length).trim());
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('result must be an object');
    }
    if (result.ok === false) {
      throw new ExecutorRejectedError(result.summary ?? `${label} rejected the operation`, {
        code: result.code ?? 'WORD_OPERATION_REJECTED',
      });
    }
    return result;
  } catch (error) {
    if (error instanceof ExecutorRejectedError) {
      throw error;
    }
    throw new ExecutorProtocolError(`${label} returned invalid JSON`, { cause: error });
  }
}

function parseVerifier(stdout) {
  const index = stdout.lastIndexOf(VERIFIER_MARKER);
  if (index < 0) {
    throw new ExecutorProtocolError('Word verifier returned no result marker');
  }
  try {
    return JSON.parse(stdout.slice(index + VERIFIER_MARKER.length).trim());
  } catch (error) {
    throw new ExecutorProtocolError('Word verifier returned invalid JSON', { cause: error });
  }
}

function actionCommand(contract, operation, action) {
  const actionB64 = Buffer.from(JSON.stringify(action), 'utf8').toString('base64');
  return [
    environment([
      ['FILE_AGENT_MNT_DATA', '/mnt/data'],
      ['FILE_AGENT_TASK_ROOT', contract.workspaceRoot],
      ['FILE_AGENT_INPUT_NAME', contract.filename],
      ['FILE_AGENT_INPUT_SHA256', contract.inputSha256],
      ['FILE_AGENT_INPUT_PATH', contract.inputPath],
      ['FILE_AGENT_OUTPUT_PATH', contract.outputPath],
      ['FILE_AGENT_HISTORY_PATH', contract.historyPath],
      ['FILE_AGENT_INSPECT_PATH', `${contract.workspaceRoot}/internal/inspect.json`],
      ['FILE_AGENT_ACTION_B64', actionB64],
      ['FILE_AGENT_OPERATION', operation],
    ]),
    `python3 ${shellQuote(contract.scriptPath)}`,
  ].join(' ');
}

export class CodeApiWordExecutor extends ExecutorAdapter {
  constructor({ transport, timeoutMs = 120_000, renderBin = 'soffice' }) {
    super();
    if (!transport || typeof transport.execute !== 'function') {
      throw new TypeError('CodeApiWordExecutor transport.execute is required');
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.renderBin = requiredString(renderBin, 'renderBin');
  }

  async prepare({ itemId, task, signal }) {
    const contract = resolveWordContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: [
        stableScriptWriteCommand(contract),
        actionCommand(contract, 'prepare', {}),
      ].join(' && '),
      signal,
    });
    const prepared = parseMarker(result.stdout, WORKER_MARKER, 'Word Worker preparation');
    return { ...prepared, workspaceRoot: contract.workspaceRoot, outputPath: contract.outputPath, replayed: result.replayed };
  }

  async execute({ itemId, action, task, signal }) {
    const contract = resolveWordContract(task);
    const normalized = normalizeWordAction(action);
    const operation = normalized.worker === 'word.inspect.v1'
      ? 'inspect'
      : normalized.worker === 'word.validate.v1'
        ? 'validate'
        : normalized.worker === 'word.patch.v1'
          ? 'patch'
          : 'transform';
    const result = await this.#call({
      itemId,
      contract,
      command: actionCommand(contract, operation, normalized),
      signal,
    });
    const executed = parseMarker(result.stdout, WORKER_MARKER, 'Word Worker');
    return { ...executed, action: normalized, replayed: result.replayed };
  }

  async verify({ itemId, task, signal }) {
    const contract = resolveWordContract(task);
    const requiredChanges = requiredChangesForTask(task);
    const requirementsB64 = Buffer.from(JSON.stringify(requiredChanges), 'utf8').toString('base64');
    const command = [
      environment([
        ['FILE_AGENT_MNT_DATA', '/mnt/data'],
        ['FILE_AGENT_TASK_ROOT', contract.workspaceRoot],
        ['FILE_AGENT_INPUT_PATH', contract.inputPath],
        ['FILE_AGENT_OUTPUT_PATH', contract.outputPath],
        ['FILE_AGENT_VERIFICATION_PATH', contract.verificationPath],
        ['FILE_AGENT_RENDER_DIR', contract.renderDir],
        ['FILE_AGENT_RENDER_BIN', this.renderBin],
        ['FILE_AGENT_REQUIRED_CHANGES_B64', requirementsB64],
        ['FILE_AGENT_PLAN_REVISION', String(task.planRevision)],
      ]),
      `python3 ${shellQuote(contract.verifierPath)}`,
    ].join(' ');
    const result = await this.#call({ itemId, contract, command, signal });
    const verification = parseVerifier(result.stdout);
    return { ...verification, replayed: result.replayed };
  }

  async publish({ itemId, task, signal }) {
    const contract = resolveWordContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: `test -s ${shellQuote(contract.outputPath)}`,
      artifactPaths: [contract.outputPath],
      signal,
    });
    if (result.artifacts.length !== 1) {
      throw new ExecutorArtifactError('CodeAPI did not return exactly one DOCX artifact');
    }
    const artifact = result.artifacts[0];
    if (
      artifact?.mimeType !== DOCX_MIME ||
      !artifact?.name?.toLowerCase().endsWith('.docx') ||
      typeof artifact?.codeEnvRef?.storage_session_id !== 'string' ||
      typeof artifact?.codeEnvRef?.file_id !== 'string'
    ) {
      throw new ExecutorArtifactError('CodeAPI returned an incomplete DOCX artifact reference');
    }
    return { artifacts: [artifact], replayed: result.replayed };
  }

  #call({ itemId, contract, command, artifactPaths, signal }) {
    return this.transport.execute({
      itemId,
      sessionId: contract.sessionId,
      command,
      injectedFiles: contract.injectedFiles,
      artifactPaths,
      timeoutMs: this.timeoutMs,
      signal,
    });
  }
}

export function getWordTaskPaths(task) {
  const contract = resolveWordContract(task);
  return {
    ...contract,
    scriptName: path.posix.basename(contract.scriptPath),
    verifierName: path.posix.basename(contract.verifierPath),
    outputName: path.posix.basename(contract.outputPath),
  };
}

export function getWordScriptDigests() {
  return {
    workerVersion: WORD_WORKER_VERSION,
    workerSha256: sha256(WORKER_SCRIPT),
    verifierProfile: WORD_VERIFIER_PROFILE,
    verifierVersion: WORD_VERIFIER_VERSION,
    verifierSha256: sha256(VERIFIER_SCRIPT),
    capabilityProfile: WORD_CAPABILITY_PROFILE,
  };
}
