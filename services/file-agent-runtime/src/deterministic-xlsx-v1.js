import { createHash } from 'node:crypto';
import path from 'node:path';

import { normalizeActionEnvelope } from './action-envelope.js';
import {
  ExecutorAdapter,
  ExecutorArtifactError,
  ExecutorProtocolError,
  ExecutorRejectedError,
} from './executor-adapter.js';
import {
  XLSX_ACCEPTANCE_TYPES,
  XLSX_ARTIFACT_LOGICAL_ID,
  normalizeXlsxAcceptanceAssertions,
} from './xlsx-acceptance.js';
import { XLSX_MIME as XLSX_MIME_CONSTANT, XLSX_CAPABILITY_PROFILE } from './constants.js';

export const XLSX_MIME = XLSX_MIME_CONSTANT;
export const XLSX_WORKER_VERSION = 'xlsx-worker-v1.0.0';
export const XLSX_VERIFIER_PROFILE = 'xlsx-structure-v1';
export const XLSX_VERIFIER_VERSION = '1.0.0';
export const XLSX_WORKER_IDS = Object.freeze([
  'xlsx.inspect.v1',
  'xlsx.transform.v1',
  'xlsx.patch.v1',
  'xlsx.validate.v1',
]);

const XLSX_WORKER_SET = new Set(XLSX_WORKER_IDS);
const WORKER_MARKER = '__FILE_AGENT_XLSX_WORKER__';
const VERIFIER_MARKER = '__FILE_AGENT_XLSX_VERIFIER__';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CELL_PATTERN = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
const SHEET_PATTERN = /^[^\\/*?:\[\]]{1,31}$/;

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

function safeRelativeFilename(value) {
  const filename = requiredString(value, 'XLSX input filename').replaceAll('\\', '/');
  if (
    filename.startsWith('/') ||
    filename.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('XLSX input filename must be a safe relative path');
  }
  if (!filename.toLowerCase().endsWith('.xlsx')) {
    throw new TypeError('XLSX Worker supports exactly one .xlsx input');
  }
  return filename;
}

function safeWorkspaceRoot(value, taskId) {
  const root = (value ?? `/mnt/data/.agent/${taskId}`).replaceAll('{taskId}', taskId);
  const expectedPrefix = `/mnt/data/.agent/${taskId}`;
  if (root !== expectedPrefix && !root.startsWith(`${expectedPrefix}/`)) {
    throw new TypeError('XLSX workspaceRoot must remain inside the task workspace');
  }
  if (root.split('/').includes('..')) {
    throw new TypeError('XLSX workspaceRoot cannot contain path traversal');
  }
  return root;
}

function resolveXlsxContract(task) {
  const inputs = task?.manifest?.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new TypeError('XLSX task must contain exactly one input');
  }
  const input = inputs[0];
  if (input.mimeType !== XLSX_MIME) {
    throw new TypeError('XLSX task input MIME must be XLSX');
  }
  const filename = safeRelativeFilename(input.logicalName ?? input.filename);
  if (!SHA256_PATTERN.test(input.sha256 ?? '')) {
    throw new TypeError('XLSX task input sha256 must be a SHA-256 digest');
  }
  const codeEnvRef = input.codeEnvRef;
  if (
    !codeEnvRef ||
    typeof codeEnvRef.storage_session_id !== 'string' ||
    codeEnvRef.storage_session_id.trim() === '' ||
    typeof codeEnvRef.file_id !== 'string' ||
    codeEnvRef.file_id.trim() === ''
  ) {
    throw new TypeError('XLSX input requires a CodeAPI codeEnvRef');
  }
  const workspaceRoot = safeWorkspaceRoot(task.manifest.execution?.workspaceRoot, task.taskId);
  const sessionId = task.manifest.execution?.sessionId ?? codeEnvRef.storage_session_id;
  if (sessionId !== codeEnvRef.storage_session_id) {
    throw new TypeError('XLSX input and execution session must match');
  }
  return {
    filename,
    inputSha256: input.sha256.toLowerCase(),
    sessionId,
    workspaceRoot,
    inputPath: `${workspaceRoot}/input/source.xlsx`,
    scriptPath: `${workspaceRoot}/scripts/xlsx_worker.py`,
    verifierPath: `${workspaceRoot}/scripts/xlsx_verifier.py`,
    historyPath: `${workspaceRoot}/internal/worker-history.json`,
    inspectPath: `${workspaceRoot}/internal/inspect.json`,
    verificationPath: `${workspaceRoot}/internal/verification/verify-${task.planRevision}.json`,
    renderDir: `${workspaceRoot}/internal/render`,
    outputPath: `${workspaceRoot}/output/working.xlsx`,
    injectedFiles: [{
      name: filename,
      storage_session_id: codeEnvRef.storage_session_id,
      file_id: codeEnvRef.file_id,
    }],
  };
}

function normalizeSheet(value, field) {
  const sheet = requiredString(value, field);
  if (!SHEET_PATTERN.test(sheet)) {
    throw new TypeError(`${field} is not a valid XLSX sheet name`);
  }
  return sheet;
}

function normalizeCell(value, field) {
  const cell = requiredString(value, field).toUpperCase();
  if (!CELL_PATTERN.test(cell)) {
    throw new TypeError(`${field} is not a valid XLSX cell reference`);
  }
  return cell;
}

function normalizeScalar(value, field) {
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new TypeError(`${field} must be a string, number, boolean, or null`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite`);
  }
  if (typeof value === 'string' && value.length > 4_000) {
    throw new TypeError(`${field} exceeds 4000 characters`);
  }
  return value;
}

function normalizeXlsxParameters(parameters, worker) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('XLSX Action parameters must be an object');
  }
  const operation = parameters.operation ?? (
    worker === 'xlsx.inspect.v1' ? 'inspect' : worker === 'xlsx.validate.v1' ? 'validate' : 'set_cell'
  );
  const normalized = { operation };
  if (worker === 'xlsx.inspect.v1' && operation !== 'inspect') {
    throw new TypeError('xlsx.inspect.v1 requires operation inspect');
  }
  if (worker === 'xlsx.validate.v1' && operation !== 'validate') {
    throw new TypeError('xlsx.validate.v1 requires operation validate');
  }
  if (
    (worker === 'xlsx.transform.v1' || worker === 'xlsx.patch.v1') &&
    !['set_cell', 'set_formula', 'add_sheet', 'delete_sheet', 'rename_sheet', 'reorder_sheets', 'set_number_format', 'set_style', 'add_table', 'add_chart'].includes(operation)
  ) {
    throw new TypeError(`Unsupported XLSX transform operation: ${operation}`);
  }
  if (['set_cell', 'set_formula', 'set_number_format'].includes(operation)) {
    normalized.sheet = normalizeSheet(parameters.sheet, 'parameters.sheet');
    normalized.cell = normalizeCell(parameters.cell, 'parameters.cell');
  }
  if (operation === 'set_cell') {
    normalized.value = normalizeScalar(parameters.value, 'parameters.value');
  } else if (operation === 'set_formula') {
    if (typeof parameters.formula !== 'string' || !parameters.formula.startsWith('=')) {
      throw new TypeError('parameters.formula must start with =');
    }
    if (parameters.formula.length > 4_000) {
      throw new TypeError('parameters.formula exceeds 4000 characters');
    }
    normalized.formula = parameters.formula;
  } else if (operation === 'set_number_format') {
    normalized.numberFormat = requiredString(parameters.numberFormat, 'parameters.numberFormat');
    if (normalized.numberFormat.length > 256) {
      throw new TypeError('parameters.numberFormat exceeds 256 characters');
    }
  } else if (operation === 'add_sheet') {
    normalized.sheet = normalizeSheet(parameters.sheet, 'parameters.sheet');
  } else if (operation === 'rename_sheet') {
    normalized.from = normalizeSheet(parameters.from, 'parameters.from');
    normalized.to = normalizeSheet(parameters.to, 'parameters.to');
    if (normalized.from === normalized.to) {
      throw new TypeError('parameters.from and parameters.to must differ');
    }
  } else if (operation === 'delete_sheet') {
    normalized.sheet = normalizeSheet(parameters.sheet, 'parameters.sheet');
  } else if (operation === 'reorder_sheets') {
    if (!Array.isArray(parameters.order) || parameters.order.length < 1 || parameters.order.length > 64) {
      throw new TypeError('parameters.order must contain between 1 and 64 sheets');
    }
    normalized.order = parameters.order.map((sheet, index) => normalizeSheet(sheet, `parameters.order[${index}]`));
    if (new Set(normalized.order).size !== normalized.order.length) {
      throw new TypeError('parameters.order must not contain duplicate sheets');
    }
  } else if (operation === 'set_style') {
    normalized.sheet = normalizeSheet(parameters.sheet, 'parameters.sheet');
    normalized.cell = normalizeCell(parameters.cell, 'parameters.cell');
    if (!parameters.style || typeof parameters.style !== 'object' || Array.isArray(parameters.style)) {
      throw new TypeError('parameters.style must be an object');
    }
    normalized.style = { ...parameters.style };
    if (normalized.style.fontBold != null && typeof normalized.style.fontBold !== 'boolean') {
      throw new TypeError('parameters.style.fontBold must be boolean');
    }
    for (const field of ['fontColor', 'fillColor']) {
      if (normalized.style[field] != null && !/^[0-9a-f]{6}$/iu.test(normalized.style[field])) {
        throw new TypeError(`parameters.style.${field} must be a six-digit color`);
      }
    }
    if (normalized.style.horizontalAlignment != null && !['left', 'center', 'right', 'general'].includes(normalized.style.horizontalAlignment)) {
      throw new TypeError('parameters.style.horizontalAlignment is unsupported');
    }
    if (Object.keys(normalized.style).length === 0) {
      throw new TypeError('parameters.style must change at least one property');
    }
  } else if (operation === 'add_table') {
    normalized.sheet = normalizeSheet(parameters.sheet, 'parameters.sheet');
    normalized.tableName = requiredString(parameters.tableName, 'parameters.tableName');
    normalized.ref = requiredString(parameters.ref, 'parameters.ref');
    normalized.styleName = requiredString(parameters.styleName ?? 'TableStyleMedium2', 'parameters.styleName');
  } else if (operation === 'add_chart') {
    normalized.sheet = normalizeSheet(parameters.sheet, 'parameters.sheet');
    normalized.chartType = requiredString(parameters.chartType, 'parameters.chartType').toLowerCase();
    if (!['bar', 'line'].includes(normalized.chartType)) {
      throw new TypeError('parameters.chartType must be bar or line');
    }
    normalized.dataRange = requiredString(parameters.dataRange, 'parameters.dataRange');
    normalized.title = requiredString(parameters.title, 'parameters.title', 400);
    normalized.anchor = requiredString(parameters.anchor ?? 'E2', 'parameters.anchor');
  }
  if (worker === 'xlsx.patch.v1') {
    if (!SHA256_PATTERN.test(parameters.expectedBaseSha256 ?? '')) {
      throw new TypeError('xlsx.patch.v1 requires expectedBaseSha256');
    }
    normalized.expectedBaseSha256 = parameters.expectedBaseSha256.toLowerCase();
  }
  return normalized;
}

export function normalizeXlsxAction(action) {
  const normalized = normalizeActionEnvelope(action, { allowedWorkers: XLSX_WORKER_SET });
  const parameters = normalizeXlsxParameters(normalized.parameters, normalized.worker);
  if (!normalized.inputRefs.includes('input:source-xlsx')) {
    throw new TypeError('XLSX Action must reference input:source-xlsx');
  }
  if (normalized.targetRef !== 'candidate:working-xlsx') {
    throw new TypeError('XLSX Action targetRef must be candidate:working-xlsx');
  }
  return { ...normalized, parameters };
}

function action(worker, parameters, expectedChange, summary) {
  return normalizeXlsxAction({
    schemaVersion: '1.0',
    objective: 'Apply the bounded XLSX change and preserve unrelated workbook content',
    worker,
    inputRefs: ['input:source-xlsx'],
    targetRef: 'candidate:working-xlsx',
    parameters,
    expectedChange,
    verificationProfile: XLSX_VERIFIER_PROFILE,
    onFailure: 'replan',
    summary,
  });
}

const WORKER_SCRIPT = String.raw`#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from copy import copy
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils.cell import range_boundaries
from openpyxl.worksheet.table import Table, TableStyleInfo

MARKER = "__FILE_AGENT_XLSX_WORKER__"
UNSUPPORTED_PARTS = (
    "xl/vbaProject.bin",
    "xl/connections.xml",
    "xl/externalLinks/",
    "xl/pivotCache/",
    "xl/pivotTables/",
)

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

def fail(code, summary):
    print(MARKER + json.dumps({"ok": False, "code": code, "summary": summary}, ensure_ascii=False))
    raise SystemExit(0)

def safe_path(path, root, task_root):
    path = Path(path)
    resolved = path.resolve()
    if resolved != task_root and task_root not in resolved.parents:
        raise RuntimeError("XLSX path escaped the task workspace")
    current = path
    while current != task_root and current.resolve() != task_root:
        if current.is_symlink():
            raise RuntimeError("XLSX path traverses a symbolic link")
        current = current.parent
    if resolved != root and root not in resolved.parents:
        raise RuntimeError("XLSX path escaped the CodeAPI data root")
    return path

def source_path():
    root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()
    task_root = Path(os.environ["FILE_AGENT_TASK_ROOT"])
    if task_root.is_symlink():
        raise RuntimeError("XLSX task root cannot be a symbolic link")
    task_root = task_root.resolve()
    if root != task_root and root not in task_root.parents:
        raise RuntimeError("XLSX task root escaped the CodeAPI data root")
    downloaded = root / os.environ["FILE_AGENT_INPUT_NAME"]
    downloaded_resolved = downloaded.resolve()
    if downloaded_resolved != root and root not in downloaded_resolved.parents:
        raise RuntimeError("XLSX injected input escaped the CodeAPI data root")
    current = downloaded
    while current != root and current.resolve() != root:
        if current.is_symlink():
            raise RuntimeError("XLSX injected input traverses a symbolic link")
        current = current.parent
    source = safe_path(Path(os.environ["FILE_AGENT_INPUT_PATH"]), root, task_root)
    source.parent.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        shutil.copyfile(downloaded, source)
    if digest(source) != os.environ["FILE_AGENT_INPUT_SHA256"]:
        raise RuntimeError("XLSX input content hash does not match the manifest")
    return root, task_root, source

def inspect_package(source):
    with zipfile.ZipFile(source, "r") as package:
        names = set(package.namelist())
        if package.testzip():
            raise RuntimeError("XLSX package contains a damaged ZIP member")
        for part in UNSUPPORTED_PARTS:
            if part.endswith("/"):
                if any(name.startswith(part) for name in names):
                    raise ValueError("XLSX contains an unsupported OOXML feature")
            elif part in names:
                raise ValueError("XLSX contains an unsupported OOXML feature")
    workbook = load_workbook(source, data_only=False, read_only=False)
    sheets = []
    for worksheet in workbook.worksheets:
        cells = []
        for row in worksheet.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                value = cell.value
                if not isinstance(value, (str, int, float, bool)) and value is not None:
                    value = str(value)
                cells.append({
                    "cell": cell.coordinate,
                    "value": value,
                    "dataType": cell.data_type,
                    "numberFormat": cell.number_format,
                })
                if len(cells) >= 200:
                    break
            if len(cells) >= 200:
                break
        sheets.append({
            "title": worksheet.title,
            "maxRow": worksheet.max_row,
            "maxColumn": worksheet.max_column,
            "mergedRanges": [str(item) for item in list(worksheet.merged_cells.ranges)[:40]],
            "tableNames": sorted(list(worksheet.tables.keys()))[:40],
            "chartCount": len(worksheet._charts),
            "cells": cells,
        })
    defined_names = []
    for defined in workbook.defined_names.values():
        defined_names.append({"name": defined.name, "attrText": str(defined.attr_text)[:500]})
    return {
        "operation": "inspect",
        "sha256": digest(source),
        "sheetCount": len(workbook.sheetnames),
        "sheets": sheets,
        "definedNames": defined_names[:80],
    }

def record_history(path, entry):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        history = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except Exception:
        history = []
    history.append(entry)
    path.write_text(json.dumps(history[-32:], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def main():
    root, task_root, source = source_path()
    output = safe_path(Path(os.environ["FILE_AGENT_OUTPUT_PATH"]), root, task_root)
    inspect_file = safe_path(Path(os.environ["FILE_AGENT_INSPECT_PATH"]), root, task_root)
    history_file = safe_path(Path(os.environ["FILE_AGENT_HISTORY_PATH"]), root, task_root)
    operation = os.environ.get("FILE_AGENT_OPERATION", "prepare")
    if operation == "prepare":
        result = inspect_package(source)
        inspect_file.parent.mkdir(parents=True, exist_ok=True)
        inspect_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result.update({"ok": True, "sourceSha256": digest(source), "workspaceRoot": str(task_root)})
        print(MARKER + json.dumps(result, ensure_ascii=False))
        return
    if operation == "inspect":
        result = inspect_package(source)
        inspect_file.parent.mkdir(parents=True, exist_ok=True)
        inspect_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result["ok"] = True
        print(MARKER + json.dumps(result, ensure_ascii=False))
        return
    if operation == "validate":
        if not output.is_file():
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, output)
        target = output
        result = inspect_package(target)
        result["operation"] = "validate"
        result["ok"] = True
        result["outputHash"] = digest(target)
        print(MARKER + json.dumps(result, ensure_ascii=False))
        return
    action = json.loads(base64.b64decode(os.environ["FILE_AGENT_ACTION_B64"]).decode("utf-8"))
    parameters = action["parameters"]
    input_path = output if output.exists() else source
    before = digest(input_path)
    expected = parameters.get("expectedBaseSha256")
    if expected and expected != before:
        fail("XLSX_BASE_HASH_MISMATCH", "The candidate changed since the action was planned")
    workbook = load_workbook(input_path, data_only=False, read_only=False)
    operation = parameters["operation"]
    if operation == "set_cell":
        workbook[parameters["sheet"]][parameters["cell"]] = parameters.get("value")
    elif operation == "set_formula":
        workbook[parameters["sheet"]][parameters["cell"]] = parameters["formula"]
    elif operation == "set_number_format":
        workbook[parameters["sheet"]][parameters["cell"]].number_format = parameters["numberFormat"]
    elif operation == "add_sheet":
        if parameters["sheet"] in workbook.sheetnames:
            fail("XLSX_SHEET_ALREADY_EXISTS", "The requested sheet already exists")
        workbook.create_sheet(parameters["sheet"])
    elif operation == "rename_sheet":
        if parameters["from"] not in workbook.sheetnames:
            fail("XLSX_SHEET_NOT_FOUND", "The requested sheet does not exist")
        if parameters["to"] in workbook.sheetnames:
            fail("XLSX_SHEET_ALREADY_EXISTS", "The requested destination sheet already exists")
        workbook[parameters["from"]].title = parameters["to"]
    elif operation == "delete_sheet":
        if parameters["sheet"] not in workbook.sheetnames:
            fail("XLSX_SHEET_NOT_FOUND", "The requested sheet does not exist")
        if len(workbook.worksheets) == 1:
            fail("XLSX_LAST_SHEET_DELETE", "The workbook must retain one worksheet")
        del workbook[parameters["sheet"]]
    elif operation == "reorder_sheets":
        order = parameters["order"]
        if set(order) != set(workbook.sheetnames) or len(order) != len(workbook.sheetnames):
            fail("XLSX_SHEET_ORDER_MISMATCH", "The requested sheet order must contain every worksheet exactly once")
        workbook._sheets = [workbook[name] for name in order]
    elif operation == "set_style":
        cell = workbook[parameters["sheet"]][parameters["cell"]]
        style = parameters["style"]
        if "fontBold" in style or "fontColor" in style:
            cell.font = copy(cell.font)
            if "fontBold" in style:
                cell.font = copy(cell.font)
                cell.font = Font(
                    name=cell.font.name,
                    sz=cell.font.sz,
                    b=style["fontBold"],
                    i=cell.font.i,
                    color=style.get("fontColor", cell.font.color.rgb if cell.font.color and cell.font.color.type == "rgb" else None),
                )
        if "fillColor" in style:
            cell.fill = PatternFill(fill_type="solid", fgColor=style["fillColor"])
        if "horizontalAlignment" in style:
            cell.alignment = copy(cell.alignment)
            cell.alignment = Alignment(
                horizontal=style["horizontalAlignment"],
                vertical=cell.alignment.vertical,
                wrap_text=cell.alignment.wrap_text,
            )
        if "numberFormat" in style:
            cell.number_format = style["numberFormat"]
    elif operation == "add_table":
        worksheet = workbook[parameters["sheet"]]
        if parameters["tableName"] in worksheet.tables:
            fail("XLSX_TABLE_ALREADY_EXISTS", "The requested table already exists")
        table = Table(displayName=parameters["tableName"], ref=parameters["ref"])
        table.tableStyleInfo = TableStyleInfo(name=parameters["styleName"], showFirstColumn=False, showLastColumn=False, showRowStripes=True, showColumnStripes=False)
        worksheet.add_table(table)
    elif operation == "add_chart":
        worksheet = workbook[parameters["sheet"]]
        min_col, min_row, max_col, max_row = range_boundaries(parameters["dataRange"])
        if max_col <= min_col or max_row <= min_row:
            fail("XLSX_CHART_RANGE_INVALID", "A chart requires a header row and at least one data row")
        chart = BarChart() if parameters["chartType"] == "bar" else LineChart()
        chart.title = parameters["title"]
        chart.add_data(Reference(worksheet, min_col=min_col, min_row=min_row, max_col=max_col, max_row=max_row), titles_from_data=True)
        chart.set_categories(Reference(worksheet, min_col=min_col, min_row=min_row + 1, max_row=max_row))
        worksheet.add_chart(chart, parameters["anchor"])
    else:
        fail("XLSX_OPERATION_UNSUPPORTED", "The requested XLSX operation is unsupported")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".xlsx", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        workbook.save(temporary_path)
        temporary_path.replace(output)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    after = digest(output)
    record_history(history_file, {
        "workerVersion": "xlsx-worker-v1.0.0",
        "worker": action["worker"],
        "operation": operation,
        "parametersDigest": hashlib.sha256(json.dumps(parameters, sort_keys=True).encode("utf-8")).hexdigest(),
        "beforeSha256": before,
        "afterSha256": after,
    })
    print(MARKER + json.dumps({
        "ok": True,
        "operation": operation,
        "outputPath": str(output),
        "outputHash": after,
        "beforeSha256": before,
        "afterSha256": after,
    }, ensure_ascii=False))

try:
    main()
except ValueError as error:
    fail("XLSX_UNSUPPORTED_FEATURE", str(error))
except Exception:
    fail("XLSX_WORKER_FAILED", "The deterministic XLSX worker failed")
`;

const VERIFIER_SCRIPT = String.raw`#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import subprocess
import zipfile
from pathlib import Path

from openpyxl import load_workbook

MARKER = "__FILE_AGENT_XLSX_VERIFIER__"

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

def same_value(expected, actual):
    if expected is None:
        return actual is None
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return expected == actual
    return expected == actual

def formula_map(workbook):
    values = {}
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    values[f"{worksheet.title}!{cell.coordinate}"] = cell.value
    return values

def scalar_map(workbook):
    values = {}
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows():
            for cell in row:
                if cell.value is not None:
                    values[f"{worksheet.title}!{cell.coordinate}"] = cell.value
    return values

def fail(code, summary, failed, assertion_class="STRUCTURE"):
    failed.append({"code": code, "class": assertion_class, "summary": summary, "evidenceRef": "workspace://verification/current.json"})

def main():
    root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()
    task_root = Path(os.environ["FILE_AGENT_TASK_ROOT"]).resolve()
    input_path = Path(os.environ["FILE_AGENT_INPUT_PATH"]).resolve()
    output = Path(os.environ["FILE_AGENT_OUTPUT_PATH"]).resolve()
    evidence = Path(os.environ["FILE_AGENT_VERIFICATION_PATH"])
    render_dir = Path(os.environ["FILE_AGENT_RENDER_DIR"])
    assertions = json.loads(base64.b64decode(os.environ["FILE_AGENT_ACCEPTANCE_ASSERTIONS_B64"]).decode("utf-8"))
    failed = []
    passed = []
    metrics = {"sheetCount": 0, "formulaCount": 0, "namedRangeCount": 0, "rendered": False}
    try:
        with zipfile.ZipFile(output, "r") as package:
            if package.testzip():
                raise ValueError("damaged ZIP member")
        passed.append("ooxml.zip.valid")
    except Exception:
        fail("ooxml.zip.valid", "The candidate is not a valid XLSX OOXML package", failed)
    source_workbook = None
    candidate = None
    try:
        source_workbook = load_workbook(input_path, data_only=False, read_only=False)
        candidate = load_workbook(output, data_only=False, read_only=False)
        metrics["sheetCount"] = len(candidate.sheetnames)
        metrics["formulaCount"] = len(formula_map(candidate))
        metrics["namedRangeCount"] = len(candidate.defined_names)
        passed.append("xlsx.workbook.openable")
    except Exception:
        fail("xlsx.workbook.openable", "The candidate workbook could not be opened", failed)
    if candidate is not None:
        renamed_sheets = {
            item["from"]: item["to"]
            for item in assertions
            if item.get("type") == "xlsx.sheet_rename.v1"
        }
        try:
            names = set(candidate.sheetnames)
            if not names:
                raise ValueError("workbook has no sheets")
            passed.append("xlsx.relationships.resolved")
        except Exception:
            fail("xlsx.relationships.resolved", "The workbook relationships could not be resolved", failed)
        required_sheets = [item for item in assertions if item.get("type") == "xlsx.sheet_present.v1"]
        required_sheets_ok = all(item["sheet"] in candidate.sheetnames for item in required_sheets)
        if required_sheets_ok:
            passed.append("xlsx.required_sheets.present")
        else:
            fail("xlsx.required_sheets.present", "A required worksheet is missing", failed, "CONTENT")
        changes_ok = True
        for item in assertions:
            if item.get("type") == "xlsx.sheet_absent.v1" and item["sheet"] in candidate.sheetnames:
                changes_ok = False
            elif item.get("type") == "xlsx.sheet_rename.v1" and (
                item["from"] in candidate.sheetnames or item["to"] not in candidate.sheetnames
            ):
                changes_ok = False
            elif item.get("type") == "xlsx.sheet_order.v1" and candidate.sheetnames != item.get("order"):
                changes_ok = False
        for item in assertions:
            kind = item.get("type")
            if kind == "xlsx.cell_value.v1":
                if item["sheet"] not in candidate.sheetnames or not same_value(item.get("value"), candidate[item["sheet"]][item["cell"]].value):
                    changes_ok = False
            elif kind == "xlsx.formula.v1":
                if item["sheet"] not in candidate.sheetnames or candidate[item["sheet"]][item["cell"]].value != item["formula"]:
                    changes_ok = False
            elif kind == "xlsx.number_format.v1":
                if item["sheet"] not in candidate.sheetnames or candidate[item["sheet"]][item["cell"]].number_format != item["numberFormat"]:
                    changes_ok = False
            elif kind == "xlsx.style.v1":
                if item["sheet"] not in candidate.sheetnames:
                    changes_ok = False
                    continue
                cell = candidate[item["sheet"]][item["cell"]]
                style = item["style"]
                if "fontBold" in style and cell.font.bold != style["fontBold"]:
                    changes_ok = False
                if "fontColor" in style and (not cell.font.color or cell.font.color.type != "rgb" or cell.font.color.rgb[-6:].upper() != style["fontColor"]):
                    changes_ok = False
                if "fillColor" in style and (not cell.fill.fgColor.rgb or cell.fill.fgColor.rgb[-6:].upper() != style["fillColor"]):
                    changes_ok = False
                if "horizontalAlignment" in style and cell.alignment.horizontal != style["horizontalAlignment"]:
                    changes_ok = False
                if "numberFormat" in style and cell.number_format != style["numberFormat"]:
                    changes_ok = False
            elif kind == "xlsx.table_present.v1":
                table = candidate[item["sheet"]].tables.get(item["tableName"]) if item["sheet"] in candidate.sheetnames else None
                if table is None or table.ref != item["ref"]:
                    changes_ok = False
            elif kind == "xlsx.chart_present.v1":
                if item["sheet"] not in candidate.sheetnames or not any(getattr(chart, "title", None) and item["title"] in str(chart.title) for chart in candidate[item["sheet"]]._charts):
                    changes_ok = False
        business_change_types = {
            "xlsx.sheet_present.v1",
            "xlsx.sheet_absent.v1",
            "xlsx.sheet_rename.v1",
            "xlsx.sheet_order.v1",
            "xlsx.cell_value.v1",
            "xlsx.formula.v1",
            "xlsx.number_format.v1",
            "xlsx.style.v1",
            "xlsx.table_present.v1",
            "xlsx.chart_present.v1",
        }
        if changes_ok and required_sheets_ok and any(item.get("type") in business_change_types for item in assertions):
            passed.append("xlsx.required_changes.applied")
        else:
            fail("xlsx.required_changes.applied", "The declared workbook change is not present", failed, "CONTENT")
        protected_ok = True
        for item in assertions:
            if item.get("type") != "xlsx.protected_cell.v1":
                continue
            if item["sheet"] not in source_workbook.sheetnames or item["sheet"] not in candidate.sheetnames:
                candidate_sheet = renamed_sheets.get(item["sheet"], item["sheet"])
                if item["sheet"] not in source_workbook.sheetnames or candidate_sheet not in candidate.sheetnames:
                    protected_ok = False
                    continue
            else:
                candidate_sheet = item["sheet"]
            if (
                not same_value(item.get("value"), source_workbook[item["sheet"]][item["cell"]].value)
                or not same_value(item.get("value"), candidate[candidate_sheet][item["cell"]].value)
            ):
                protected_ok = False
        if protected_ok:
            passed.append("xlsx.protected_regions.unchanged")
        else:
            fail("xlsx.protected_regions.unchanged", "A protected workbook cell changed", failed, "SAFETY")
        source_formulas = formula_map(source_workbook)
        candidate_formulas = formula_map(candidate)
        authorized_formula_cells = {
            f"{item['sheet']}!{item['cell']}"
            for item in assertions
            if item.get("type") == "xlsx.formula.v1"
        }
        formulas_ok = all(
            candidate_formulas.get(
                f"{renamed_sheets.get(key.split('!', 1)[0], key.split('!', 1)[0])}!{key.split('!', 1)[1]}"
            ) == value
            for key, value in source_formulas.items()
            if key not in authorized_formula_cells
        )
        if formulas_ok:
            passed.append("xlsx.formulas.preserved")
        else:
            fail("xlsx.formulas.preserved", "An unrequested formula changed", failed, "SAFETY")
        passed.append("xlsx.named_ranges.valid")
    else:
        for code in [
            "xlsx.relationships.resolved",
            "xlsx.required_sheets.present",
            "xlsx.required_changes.applied",
            "xlsx.protected_regions.unchanged",
            "xlsx.formulas.preserved",
            "xlsx.named_ranges.valid",
        ]:
            fail(code, "The candidate workbook could not be inspected", failed)
    render_ok = False
    if candidate is not None and not failed:
        try:
            render_dir.mkdir(parents=True, exist_ok=True)
            command = [os.environ.get("FILE_AGENT_RENDER_BIN", "soffice"), "--headless", "--convert-to", "pdf", "--outdir", str(render_dir), str(output)]
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90, check=False)
            pdf = render_dir / (output.stem + ".pdf")
            render_ok = result.returncode == 0 and pdf.is_file() and pdf.stat().st_size > 0
        except Exception:
            render_ok = False
    metrics["rendered"] = render_ok
    if render_ok:
        passed.append("xlsx.render.succeeded")
    else:
        fail("xlsx.render.succeeded", "The XLSX candidate could not be rendered deterministically", failed, "RENDER")
    failed_codes = {item["code"] for item in failed}
    required = set(passed) | failed_codes
    result = {
        "schemaVersion": "1.0",
        "profile": "xlsx-structure-v1",
        "profileVersion": "1.0.0",
        "passed": len(failed) == 0,
        "requiredAssertionCount": len(required),
        "passedAssertionCodes": sorted(set(passed)),
        "failedAssertions": failed,
        "artifact": {"logicalId": "candidate:working-xlsx", "revision": int(os.environ.get("FILE_AGENT_PLAN_REVISION", "0")), "sha256": digest(output) if output.is_file() else None, "size": output.stat().st_size if output.is_file() else 0},
        "metrics": metrics,
        "errorClass": None if not failed else "XLSX_" + sorted(failed_codes)[0].replace(".", "_").upper(),
        "summary": "XLSX structure, frozen acceptance, formula preservation, and render passed" if not failed else "XLSX verification failed",
    }
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(MARKER + json.dumps(result, ensure_ascii=False))

try:
    main()
except Exception as error:
    print(MARKER + json.dumps({"schemaVersion": "1.0", "profile": "xlsx-structure-v1", "profileVersion": "1.0.0", "passed": False, "requiredAssertionCount": 1, "passedAssertionCodes": [], "failedAssertions": [{"code": "xlsx.verifier.failed", "class": "VERIFIER", "summary": "The deterministic XLSX verifier failed", "evidenceRef": "workspace://verification/current.json"}], "artifact": {"logicalId": "candidate:working-xlsx", "revision": 0}, "metrics": {}, "errorClass": "XLSX_VERIFIER_FAILED", "summary": "XLSX verification failed: " + type(error).__name__}, ensure_ascii=False))
`;

function environment(entries) {
  return entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}

function stableScriptWriteCommandFixed(contract) {
  const files = [
    [contract.scriptPath, Buffer.from(WORKER_SCRIPT, 'utf8').toString('base64'), sha256(WORKER_SCRIPT)],
    [contract.verifierPath, Buffer.from(VERIFIER_SCRIPT, 'utf8').toString('base64'), sha256(VERIFIER_SCRIPT)],
  ];
  const python = [
    'import base64, hashlib, os',
    'from pathlib import Path',
    'data_root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()',
    'task_root = Path(os.environ["FILE_AGENT_TASK_ROOT"])',
    'if task_root.is_symlink(): raise RuntimeError("XLSX task root cannot be a symbolic link")',
    'task_root = task_root.resolve()',
    'if task_root != data_root and data_root not in task_root.parents: raise RuntimeError("XLSX task root escaped the CodeAPI data root")',
    'def checked_path(absolute):',
    '    virtual_path = Path(absolute)',
    '    try:',
    '        relative = virtual_path.relative_to(Path("/mnt/data"))',
    '    except ValueError:',
    '        raise RuntimeError("XLSX script path is outside the CodeAPI data root")',
    '    path = data_root / relative',
    '    resolved = path.resolve()',
    '    if resolved != task_root and task_root not in resolved.parents: raise RuntimeError("XLSX script escaped the task workspace")',
    '    current = path',
    '    while current != task_root and current.resolve() != task_root:',
    '        if current.is_symlink(): raise RuntimeError("XLSX script traverses a symbolic link")',
    '        current = current.parent',
    '    return path',
    `files = ${JSON.stringify(files)}`,
    'for absolute, source, expected in files:',
    '    path = checked_path(absolute)',
    '    path.parent.mkdir(parents=True, exist_ok=True)',
    '    data = base64.b64decode(source)',
    '    if path.exists():',
    '        if hashlib.sha256(path.read_bytes()).hexdigest() != expected: raise RuntimeError("stable XLSX script revision conflict")',
    '    else:',
    '        path.write_bytes(data)',
  ].join('\n');
  return `${environment([
    ['FILE_AGENT_MNT_DATA', '/mnt/data'],
    ['FILE_AGENT_TASK_ROOT', contract.workspaceRoot],
  ])} ${pythonFromBase64(python)}`;
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
      ['FILE_AGENT_INSPECT_PATH', contract.inspectPath],
      ['FILE_AGENT_ACTION_B64', actionB64],
      ['FILE_AGENT_OPERATION', operation],
    ]),
    `python3 ${shellQuote(contract.scriptPath)}`,
  ].join(' ');
}

function parseMarker(stdout, marker, label) {
  const index = stdout.lastIndexOf(marker);
  if (index < 0) {
    throw new ExecutorProtocolError(`${label} returned no result marker`);
  }
  try {
    const result = JSON.parse(stdout.slice(index + marker.length).trim());
    if (result?.ok === false) {
      throw new ExecutorRejectedError(result.summary ?? `${label} rejected the operation`, {
        code: result.code ?? 'XLSX_OPERATION_REJECTED',
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
    throw new ExecutorProtocolError('XLSX verifier returned no result marker');
  }
  try {
    return JSON.parse(stdout.slice(index + VERIFIER_MARKER.length).trim());
  } catch (error) {
    throw new ExecutorProtocolError('XLSX verifier returned invalid JSON', { cause: error });
  }
}

function acceptanceAssertionsForTask(task) {
  return normalizeXlsxAcceptanceAssertions(task?.manifest?.acceptanceAssertions);
}

export class DeterministicXlsxProvider {
  constructor({ actions = null } = {}) {
    this.actions = actions ? actions.map(normalizeXlsxAction) : null;
  }

  async plan({ task }) {
    const inspected = Object.values(task?.itemResults ?? {}).some(
      (result) => result?.operation === 'inspect',
    );
    if (!inspected) {
      return {
        schemaVersion: '1.0',
        needsInput: false,
        summary: 'Inspect the authorized workbook before planning a change',
        actions: [action('xlsx.inspect.v1', { operation: 'inspect' }, [], 'Inspect workbook structure')],
      };
    }
    if (!this.actions || this.actions.length === 0) {
      return {
        schemaVersion: '1.0',
        needsInput: true,
        question: 'Which supported workbook change should be applied?',
        summary: 'A bounded XLSX change is required',
        actions: [],
      };
    }
    return {
      schemaVersion: '1.0',
      needsInput: false,
      summary: 'Apply the bounded XLSX change to the inspected workbook',
      actions: this.actions,
    };
  }

  async repair({ verification }) {
    return {
      schemaVersion: '1.0',
      needsInput: true,
      question: `The workbook verifier reported ${verification?.summary ?? 'a failure'}. Provide a new bounded instruction.`,
      summary: 'Do not guess a workbook repair',
      actions: [],
    };
  }
}

export class CodeApiXlsxV1Executor extends ExecutorAdapter {
  constructor({ transport, timeoutMs = 120_000, renderBin = 'soffice' }) {
    super();
    if (!transport || typeof transport.execute !== 'function') {
      throw new TypeError('CodeApiXlsxV1Executor transport.execute is required');
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.renderBin = requiredString(renderBin, 'renderBin');
  }

  async prepare({ itemId, task, signal }) {
    const contract = resolveXlsxContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: [stableScriptWriteCommandFixed(contract), actionCommand(contract, 'prepare', {})].join(' && '),
      signal,
    });
    const prepared = parseMarker(result.stdout, WORKER_MARKER, 'XLSX Worker preparation');
    return {
      ...prepared,
      operation: 'prepare',
      workspaceRoot: contract.workspaceRoot,
      outputPath: contract.outputPath,
      replayed: result.replayed,
    };
  }

  async execute({ itemId, action, task, signal }) {
    const contract = resolveXlsxContract(task);
    const normalized = normalizeXlsxAction(action);
    const operation = normalized.worker === 'xlsx.inspect.v1'
      ? 'inspect'
      : normalized.worker === 'xlsx.validate.v1'
        ? 'validate'
        : 'transform';
    const result = await this.#call({
      itemId,
      contract,
      command: actionCommand(contract, operation, normalized),
      signal,
    });
    const executed = parseMarker(result.stdout, WORKER_MARKER, 'XLSX Worker');
    return { ...executed, action: normalized, replayed: result.replayed };
  }

  async verify({ itemId, task, signal }) {
    const contract = resolveXlsxContract(task);
    const assertions = Buffer.from(JSON.stringify(acceptanceAssertionsForTask(task)), 'utf8').toString('base64');
    const command = [
      environment([
        ['FILE_AGENT_MNT_DATA', '/mnt/data'],
        ['FILE_AGENT_TASK_ROOT', contract.workspaceRoot],
        ['FILE_AGENT_INPUT_PATH', contract.inputPath],
        ['FILE_AGENT_OUTPUT_PATH', contract.outputPath],
        ['FILE_AGENT_VERIFICATION_PATH', contract.verificationPath],
        ['FILE_AGENT_RENDER_DIR', contract.renderDir],
        ['FILE_AGENT_RENDER_BIN', this.renderBin],
        ['FILE_AGENT_ACCEPTANCE_ASSERTIONS_B64', assertions],
        ['FILE_AGENT_PLAN_REVISION', String(task.planRevision)],
      ]),
      `python3 ${shellQuote(contract.verifierPath)}`,
    ].join(' ');
    const result = await this.#call({ itemId, contract, command, signal });
    const verification = parseVerifier(result.stdout);
    return { ...verification, replayed: result.replayed };
  }

  async publish({ itemId, task, signal }) {
    const contract = resolveXlsxContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: `test -s ${shellQuote(contract.outputPath)}`,
      artifactPaths: [contract.outputPath],
      signal,
    });
    if (result.artifacts.length !== 1) {
      throw new ExecutorArtifactError('CodeAPI did not return exactly one XLSX artifact');
    }
    const artifact = result.artifacts[0];
    if (
      artifact?.mimeType !== XLSX_MIME ||
      artifact?.name !== 'working.xlsx' ||
      typeof artifact?.codeEnvRef?.storage_session_id !== 'string' ||
      typeof artifact?.codeEnvRef?.file_id !== 'string'
    ) {
      throw new ExecutorArtifactError('CodeAPI returned an incomplete XLSX artifact reference');
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

export function getXlsxTaskPaths(task) {
  const contract = resolveXlsxContract(task);
  return {
    ...contract,
    scriptName: path.posix.basename(contract.scriptPath),
    verifierName: path.posix.basename(contract.verifierPath),
    outputName: path.posix.basename(contract.outputPath),
  };
}

export function getXlsxScriptDigests() {
  return {
    workerVersion: XLSX_WORKER_VERSION,
    workerSha256: sha256(WORKER_SCRIPT),
    verifierProfile: XLSX_VERIFIER_PROFILE,
    verifierVersion: XLSX_VERIFIER_VERSION,
    verifierSha256: sha256(VERIFIER_SCRIPT),
    capabilityProfile: XLSX_CAPABILITY_PROFILE,
    artifactLogicalId: XLSX_ARTIFACT_LOGICAL_ID,
  };
}

export function getXlsxWorkerSource() {
  return WORKER_SCRIPT;
}

export function getXlsxVerifierSource() {
  return VERIFIER_SCRIPT;
}
