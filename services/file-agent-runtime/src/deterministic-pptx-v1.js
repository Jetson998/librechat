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
  PPTX_ACCEPTANCE_TYPES,
  PPTX_ARTIFACT_LOGICAL_ID,
} from './pptx-acceptance.js';
import { PPTX_CAPABILITY_PROFILE, PPTX_MIME as PPTX_MIME_CONSTANT } from './constants.js';

export const PPTX_MIME = PPTX_MIME_CONSTANT;
export const PPTX_WORKER_VERSION = 'pptx-worker-v1.0.0';
export const PPTX_VERIFIER_PROFILE = 'pptx-structure-v1';
export const PPTX_VERIFIER_VERSION = '1.0.0';
export const PPTX_WORKER_IDS = Object.freeze([
  'pptx.inspect.v1',
  'pptx.transform.v1',
  'pptx.patch.v1',
  'pptx.validate.v1',
]);

const PPTX_WORKER_SET = new Set(PPTX_WORKER_IDS);
const WORKER_MARKER = '__FILE_AGENT_PPTX_WORKER__';
const VERIFIER_MARKER = '__FILE_AGENT_PPTX_VERIFIER__';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SHAPE_NAME_PATTERN = /^.{1,128}$/su;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `\\'"'"'`)}'`;
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
  const filename = requiredString(value, 'PPTX input filename').replaceAll('\\', '/');
  if (
    filename.startsWith('/') ||
    filename.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('PPTX input filename must be a safe relative path');
  }
  if (!filename.toLowerCase().endsWith('.pptx')) {
    throw new TypeError('PPTX Worker supports exactly one .pptx input');
  }
  return filename;
}

function safeWorkspaceRoot(value, taskId) {
  const root = (value ?? `/mnt/data/.agent/${taskId}`).replaceAll('{taskId}', taskId);
  const expectedPrefix = `/mnt/data/.agent/${taskId}`;
  if (root !== expectedPrefix && !root.startsWith(`${expectedPrefix}/`)) {
    throw new TypeError('PPTX workspaceRoot must remain inside the task workspace');
  }
  if (root.split('/').includes('..')) {
    throw new TypeError('PPTX workspaceRoot cannot contain path traversal');
  }
  return root;
}

function resolvePptxContract(task) {
  const inputs = task?.manifest?.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new TypeError('PPTX task must contain exactly one input');
  }
  const input = inputs[0];
  if (input.mimeType !== PPTX_MIME) {
    throw new TypeError('PPTX task input MIME must be PPTX');
  }
  const filename = safeRelativeFilename(input.logicalName ?? input.filename);
  if (!SHA256_PATTERN.test(input.sha256 ?? '')) {
    throw new TypeError('PPTX task input sha256 must be a SHA-256 digest');
  }
  const codeEnvRef = input.codeEnvRef;
  if (
    !codeEnvRef ||
    typeof codeEnvRef.storage_session_id !== 'string' ||
    codeEnvRef.storage_session_id.trim() === '' ||
    typeof codeEnvRef.file_id !== 'string' ||
    codeEnvRef.file_id.trim() === ''
  ) {
    throw new TypeError('PPTX input requires a CodeAPI codeEnvRef');
  }
  const workspaceRoot = safeWorkspaceRoot(task.manifest.execution?.workspaceRoot, task.taskId);
  const sessionId = task.manifest.execution?.sessionId ?? codeEnvRef.storage_session_id;
  if (sessionId !== codeEnvRef.storage_session_id) {
    throw new TypeError('PPTX input and execution session must match');
  }
  return {
    filename,
    inputSha256: input.sha256.toLowerCase(),
    sessionId,
    workspaceRoot,
    inputPath: `${workspaceRoot}/input/source.pptx`,
    scriptPath: `${workspaceRoot}/scripts/pptx_worker.py`,
    verifierPath: `${workspaceRoot}/scripts/pptx_verifier.py`,
    historyPath: `${workspaceRoot}/internal/worker-history.json`,
    inspectPath: `${workspaceRoot}/internal/inspect.json`,
    verificationPath: `${workspaceRoot}/internal/verification/verify-${task.planRevision}.json`,
    renderDir: `${workspaceRoot}/internal/render`,
    outputPath: `${workspaceRoot}/output/working.pptx`,
    injectedFiles: [{
      name: filename,
      resource_id: codeEnvRef.resource_id,
      storage_session_id: codeEnvRef.storage_session_id,
      file_id: codeEnvRef.file_id,
    }],
  };
}

function positiveInteger(value, field, max = 200) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${field} must be a positive integer no greater than ${max}`);
  }
  return value;
}

function shapeName(value, field) {
  const name = requiredString(value, field);
  if (!SHAPE_NAME_PATTERN.test(name)) {
    throw new TypeError(`${field} is not a valid PPTX shape name`);
  }
  return name;
}

function scalar(value, field) {
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

function normalizePptxParameters(parameters, worker) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('PPTX Action parameters must be an object');
  }
  const operation = parameters.operation ?? (
    worker === 'pptx.inspect.v1' ? 'inspect' : worker === 'pptx.validate.v1' ? 'validate' : 'replace_text'
  );
  const normalized = { operation };
  if (worker === 'pptx.inspect.v1' && operation !== 'inspect') {
    throw new TypeError('pptx.inspect.v1 requires operation inspect');
  }
  if (worker === 'pptx.validate.v1' && operation !== 'validate') {
    throw new TypeError('pptx.validate.v1 requires operation validate');
  }
  if (
    (worker === 'pptx.transform.v1' || worker === 'pptx.patch.v1') &&
    !['replace_text', 'set_table_cell', 'add_slide', 'delete_slide', 'reorder_slides'].includes(operation)
  ) {
    throw new TypeError(`Unsupported PPTX transform operation: ${operation}`);
  }
  if (['replace_text', 'set_table_cell'].includes(operation)) {
    normalized.slide = positiveInteger(parameters.slide, 'parameters.slide');
    normalized.shape = shapeName(parameters.shape, 'parameters.shape');
  }
  if (operation === 'replace_text') {
    normalized.value = scalar(parameters.value, 'parameters.value');
    if (typeof normalized.value !== 'string') {
      throw new TypeError('parameters.value must be text for replace_text');
    }
  } else if (operation === 'set_table_cell') {
    normalized.row = positiveInteger(parameters.row, 'parameters.row', 200);
    normalized.column = positiveInteger(parameters.column, 'parameters.column', 200);
    normalized.value = scalar(parameters.value, 'parameters.value');
  } else if (operation === 'add_slide') {
    normalized.layoutIndex = parameters.layoutIndex ?? 0;
    if (!Number.isSafeInteger(normalized.layoutIndex) || normalized.layoutIndex < 0 || normalized.layoutIndex > 30) {
      throw new TypeError('parameters.layoutIndex must be an integer from 0 through 30');
    }
    if (parameters.title != null) {
      normalized.title = requiredString(parameters.title, 'parameters.title');
    }
  } else if (operation === 'delete_slide') {
    normalized.slide = positiveInteger(parameters.slide, 'parameters.slide');
  } else if (operation === 'reorder_slides') {
    if (!Array.isArray(parameters.order) || parameters.order.length === 0 || parameters.order.length > 200) {
      throw new TypeError('parameters.order must contain between 1 and 200 slide numbers');
    }
    normalized.order = parameters.order.map((entry, index) => positiveInteger(entry, `parameters.order[${index}]`));
    if (new Set(normalized.order).size !== normalized.order.length) {
      throw new TypeError('parameters.order must not contain duplicate slide numbers');
    }
  }
  if (worker === 'pptx.patch.v1') {
    if (!SHA256_PATTERN.test(parameters.expectedBaseSha256 ?? '')) {
      throw new TypeError('pptx.patch.v1 requires expectedBaseSha256');
    }
    normalized.expectedBaseSha256 = parameters.expectedBaseSha256.toLowerCase();
  }
  return normalized;
}

export function normalizePptxAction(action) {
  const normalized = normalizeActionEnvelope(action, { allowedWorkers: PPTX_WORKER_SET });
  const parameters = normalizePptxParameters(normalized.parameters, normalized.worker);
  if (!normalized.inputRefs.includes('input:source-pptx')) {
    throw new TypeError('PPTX Action must reference input:source-pptx');
  }
  if (normalized.targetRef !== 'candidate:working-pptx') {
    throw new TypeError('PPTX Action targetRef must be candidate:working-pptx');
  }
  return { ...normalized, parameters };
}

function action(worker, parameters, expectedChange, summary) {
  return normalizePptxAction({
    schemaVersion: '1.0',
    objective: 'Apply the bounded PPTX change and preserve unrelated presentation content',
    worker,
    inputRefs: ['input:source-pptx'],
    targetRef: 'candidate:working-pptx',
    parameters,
    expectedChange,
    verificationProfile: PPTX_VERIFIER_PROFILE,
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
import subprocess
import tempfile
import zipfile
from pathlib import Path

from pptx import Presentation

MARKER = "__FILE_AGENT_PPTX_WORKER__"

def contains_unsupported_part(name):
    normalized = name.replace("\\", "/")
    return (
        normalized == "vbaProject.bin"
        or normalized.endswith("/vbaProject.bin")
        or "/externalLinks/" in f"/{normalized}"
        or normalized.endswith("/externalLinks")
        or "/embeddings/" in f"/{normalized}"
        or normalized.endswith("/embeddings")
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
        raise RuntimeError("PPTX path escaped the task workspace")
    current = path
    while current != task_root and current.resolve() != task_root:
        if current.is_symlink():
            raise RuntimeError("PPTX path traverses a symbolic link")
        current = current.parent
    if resolved != root and root not in resolved.parents:
        raise RuntimeError("PPTX path escaped the CodeAPI data root")
    return path

def source_path():
    root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()
    task_root = Path(os.environ["FILE_AGENT_TASK_ROOT"])
    if task_root.is_symlink():
        raise RuntimeError("PPTX task root cannot be a symbolic link")
    task_root = task_root.resolve()
    if root != task_root and root not in task_root.parents:
        raise RuntimeError("PPTX task root escaped the CodeAPI data root")
    downloaded = root / os.environ["FILE_AGENT_INPUT_NAME"]
    downloaded_resolved = downloaded.resolve()
    if downloaded_resolved != root and root not in downloaded_resolved.parents:
        raise RuntimeError("PPTX injected input escaped the CodeAPI data root")
    current = downloaded
    while current != root and current.resolve() != root:
        if current.is_symlink():
            raise RuntimeError("PPTX injected input traverses a symbolic link")
        current = current.parent
    source = safe_path(Path(os.environ["FILE_AGENT_INPUT_PATH"]), root, task_root)
    source.parent.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        shutil.copyfile(downloaded, source)
    if digest(source) != os.environ["FILE_AGENT_INPUT_SHA256"]:
        raise RuntimeError("PPTX input content hash does not match the manifest")
    return root, task_root, source

def inspect_package(source):
    with zipfile.ZipFile(source, "r") as package:
        names = set(package.namelist())
        if package.testzip():
            raise RuntimeError("PPTX package contains a damaged ZIP member")
        if any(contains_unsupported_part(name) for name in names):
            raise ValueError("PPTX contains an unsupported OOXML feature")
    presentation = Presentation(str(source))
    slides = []
    media_count = 0
    for slide_index, slide in enumerate(presentation.slides, start=1):
        shapes = []
        for shape in slide.shapes:
            item = {
                "name": shape.name,
                "shapeType": int(shape.shape_type),
                "left": int(shape.left),
                "top": int(shape.top),
                "width": int(shape.width),
                "height": int(shape.height),
            }
            if getattr(shape, "has_text_frame", False):
                item["text"] = shape.text[:400]
            if getattr(shape, "has_table", False):
                item["table"] = {
                    "rows": len(shape.table.rows),
                    "columns": len(shape.table.columns),
                    "cells": [
                        [shape.table.cell(row, column).text[:200] for column in range(len(shape.table.columns))]
                        for row in range(min(len(shape.table.rows), 20))
                    ],
                }
            if str(shape.shape_type).endswith("PICTURE"):
                media_count += 1
            shapes.append(item)
        slides.append({
            "index": slide_index,
            "shapeCount": len(slide.shapes),
            "shapes": shapes[:100],
        })
    return {
        "operation": "inspect",
        "sha256": digest(source),
        "slideCount": len(presentation.slides),
        "slideWidth": int(presentation.slide_width),
        "slideHeight": int(presentation.slide_height),
        "mediaCount": media_count,
        "slides": slides,
    }

def record_history(path, entry):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        history = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except Exception:
        history = []
    history.append(entry)
    path.write_text(json.dumps(history[-32:], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def find_shape(slide, name):
    for shape in slide.shapes:
        if shape.name == name:
            return shape
    raise ValueError("PPTX shape was not found")

def replace_simple_text(shape, value):
    if not getattr(shape, "has_text_frame", False):
        raise ValueError("The requested shape does not contain editable text")
    paragraphs = list(shape.text_frame.paragraphs)
    runs = [run for paragraph in paragraphs for run in paragraph.runs]
    if len(paragraphs) != 1 or len(runs) > 1:
        raise ValueError("PPTX rich text replacement is not supported for this shape")
    if runs:
        runs[0].text = value
    else:
        shape.text = value

def replace_simple_table_cell(cell, value):
    paragraphs = list(cell.text_frame.paragraphs)
    runs = [run for paragraph in paragraphs for run in paragraph.runs]
    if len(paragraphs) != 1 or len(runs) > 1:
        raise ValueError("PPTX rich text replacement is not supported for this table cell")
    if runs:
        runs[0].text = value
    else:
        cell.text = value

def reorder_slides(presentation, order):
    if sorted(order) != list(range(1, len(presentation.slides) + 1)):
        raise ValueError("PPTX slide order must contain every slide exactly once")
    slide_ids = list(presentation.slides._sldIdLst)
    slide_id_list = presentation.slides._sldIdLst
    for slide_id in list(slide_id_list):
        slide_id_list.remove(slide_id)
    for index in order:
        slide_id_list.append(slide_ids[index - 1])

def delete_slide(presentation, slide_number):
    if len(presentation.slides) <= 1:
        raise ValueError("PPTX presentation must retain one slide")
    if slide_number < 1 or slide_number > len(presentation.slides):
        raise ValueError("PPTX slide was not found")
    slide_id_list = presentation.slides._sldIdLst
    slide_id_list.remove(slide_id_list[slide_number - 1])

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
        result = inspect_package(output)
        result["operation"] = "validate"
        result["ok"] = True
        result["outputHash"] = digest(output)
        print(MARKER + json.dumps(result, ensure_ascii=False))
        return
    action = json.loads(base64.b64decode(os.environ["FILE_AGENT_ACTION_B64"]).decode("utf-8"))
    parameters = action["parameters"]
    input_path = output if output.exists() else source
    before = digest(input_path)
    expected = parameters.get("expectedBaseSha256")
    if expected and expected != before:
        fail("PPTX_BASE_HASH_MISMATCH", "The candidate changed since the action was planned")
    presentation = Presentation(str(input_path))
    operation = parameters["operation"]
    if operation == "replace_text":
        shape = find_shape(presentation.slides[parameters["slide"] - 1], parameters["shape"])
        if not getattr(shape, "has_text_frame", False):
            fail("PPTX_SHAPE_NOT_TEXT", "The requested shape does not contain editable text")
        replace_simple_text(shape, parameters["value"])
    elif operation == "set_table_cell":
        shape = find_shape(presentation.slides[parameters["slide"] - 1], parameters["shape"])
        if not getattr(shape, "has_table", False):
            fail("PPTX_SHAPE_NOT_TABLE", "The requested shape does not contain a table")
        table = shape.table
        row = parameters["row"] - 1
        column = parameters["column"] - 1
        if row < 0 or column < 0 or row >= len(table.rows) or column >= len(table.columns):
            fail("PPTX_TABLE_CELL_NOT_FOUND", "The requested table cell does not exist")
        replace_simple_table_cell(
            table.cell(row, column),
            str(parameters.get("value") if parameters.get("value") is not None else ""),
        )
    elif operation == "add_slide":
        slide = presentation.slides.add_slide(presentation.slide_layouts[parameters["layoutIndex"]])
        title = parameters.get("title")
        if title:
            for shape in slide.shapes:
                if getattr(shape, "has_text_frame", False) and "Title" in shape.name:
                    replace_simple_text(shape, title)
                    break
    elif operation == "delete_slide":
        delete_slide(presentation, parameters["slide"])
    elif operation == "reorder_slides":
        reorder_slides(presentation, parameters["order"])
    else:
        fail("PPTX_OPERATION_UNSUPPORTED", "The requested PPTX operation is unsupported")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".pptx", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        presentation.save(str(temporary_path))
        temporary_path.replace(output)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    after = digest(output)
    record_history(history_file, {
        "workerVersion": "pptx-worker-v1.0.0",
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
    fail("PPTX_UNSUPPORTED_FEATURE", str(error))
except Exception:
    fail("PPTX_WORKER_FAILED", "The deterministic PPTX worker failed")
`;

const VERIFIER_SCRIPT = String.raw`#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path

from pptx import Presentation

MARKER = "__FILE_AGENT_PPTX_VERIFIER__"

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

def same_value(expected, actual):
    if expected is None:
        return actual in (None, "")
    return str(expected) == str(actual)

def fail(code, summary, failed, assertion_class="STRUCTURE"):
    failed.append({"code": code, "class": assertion_class, "summary": summary, "evidenceRef": "workspace://verification/current.json"})

def shape_map(presentation, by_part=False):
    values = {}
    tables = {}
    for slide_index, slide in enumerate(presentation.slides, start=1):
        slide_key = str(slide.slide_id) if by_part else str(slide_index)
        for shape in slide.shapes:
            key = f"{slide_key}!{shape.name}"
            if getattr(shape, "has_text_frame", False):
                values[key] = shape.text
            if getattr(shape, "has_table", False):
                for row in range(len(shape.table.rows)):
                    for column in range(len(shape.table.columns)):
                        tables[f"{key}!{row}!{column}"] = shape.table.cell(row, column).text
    return values, tables

def image_map(presentation, by_part=False):
    values = {}
    for slide_index, slide in enumerate(presentation.slides, start=1):
        slide_key = str(slide.slide_id) if by_part else str(slide_index)
        for shape in slide.shapes:
            if str(shape.shape_type).endswith("PICTURE"):
                values[f"{slide_key}!{shape.name}"] = hashlib.sha256(shape.image.blob).hexdigest()
    return values

def source_slide_order(presentation):
    return [slide.slide_id for slide in presentation.slides]

def main():
    input_path = Path(os.environ["FILE_AGENT_INPUT_PATH"])
    output = Path(os.environ["FILE_AGENT_OUTPUT_PATH"])
    evidence = Path(os.environ["FILE_AGENT_VERIFICATION_PATH"])
    render_dir = Path(os.environ["FILE_AGENT_RENDER_DIR"])
    assertions = json.loads(base64.b64decode(os.environ["FILE_AGENT_ACCEPTANCE_ASSERTIONS_B64"]).decode("utf-8"))
    failed = []
    passed = []
    metrics = {"slideCount": 0, "mediaCount": 0, "rendered": False, "renderedPages": 0}
    try:
        with zipfile.ZipFile(output, "r") as package:
            if package.testzip():
                raise ValueError("damaged ZIP member")
        passed.append("ooxml.zip.valid")
    except Exception:
        fail("ooxml.zip.valid", "The candidate is not a valid PPTX OOXML package", failed)
    source_presentation = None
    candidate = None
    source_texts = {}
    source_tables = {}
    candidate_texts = {}
    candidate_tables = {}
    source_identity_images = {}
    candidate_identity_images = {}
    try:
        source_presentation = Presentation(str(input_path))
        candidate = Presentation(str(output))
        source_texts, source_tables = shape_map(source_presentation)
        candidate_texts, candidate_tables = shape_map(candidate)
        source_identity_texts, source_identity_tables = shape_map(source_presentation, by_part=True)
        candidate_identity_texts, candidate_identity_tables = shape_map(candidate, by_part=True)
        source_identity_images = image_map(source_presentation, by_part=True)
        candidate_identity_images = image_map(candidate, by_part=True)
        metrics["slideCount"] = len(candidate.slides)
        with zipfile.ZipFile(output, "r") as package:
            metrics["mediaCount"] = sum(1 for name in package.namelist() if name.startswith("ppt/media/"))
        passed.append("pptx.presentation.openable")
    except Exception:
        fail("pptx.presentation.openable", "The candidate presentation could not be opened", failed)
    if candidate is not None:
        if len(candidate.slides) > 0:
            passed.append("pptx.slide_order.valid")
        else:
            fail("pptx.slide_order.valid", "The presentation has no slides", failed, "CONTENT")
        source_parts = source_slide_order(source_presentation)
        candidate_parts = source_slide_order(candidate)
        required_slides = [item for item in assertions if item.get("type") == "pptx.slide_present.v1"]
        required_slides_ok = all(1 <= item["slide"] <= len(candidate.slides) for item in required_slides)
        absent_slides_ok = all(
            1 <= item.get("slide", 0) <= len(source_parts)
            and source_parts[item["slide"] - 1] not in candidate_parts
            for item in assertions
            if item.get("type") == "pptx.slide_absent.v1"
        )
        added_slides_ok = all(
            len(candidate.slides) == len(source_parts) + 1
            and (
                item.get("title") is None
                or any(
                    getattr(shape, "has_text_frame", False) and shape.text == item["title"]
                    for shape in candidate.slides[-1].shapes
                )
            )
            for item in assertions
            if item.get("type") == "pptx.slide_add.v1"
        )
        count_ok = all(item["count"] == len(candidate.slides) for item in assertions if item.get("type") == "pptx.slide_count.v1")
        if required_slides_ok:
            passed.append("pptx.required_sections.present")
        else:
            fail("pptx.required_sections.present", "A required slide is missing", failed, "CONTENT")
        if absent_slides_ok:
            passed.append("pptx.required_slides.absent")
        else:
            fail("pptx.required_slides.absent", "A forbidden slide is still present", failed, "CONTENT")
        if count_ok:
            passed.append("pptx.slide_count.matches")
        else:
            fail("pptx.slide_count.matches", "The presentation has an unexpected slide count", failed, "CONTENT")
        changes_ok = True
        change_failures = []
        for item in assertions:
            kind = item.get("type")
            if kind == "pptx.text_value.v1":
                key = f"{item['slide']}!{item['shape']}"
                if key not in candidate_texts or not same_value(item.get("value"), candidate_texts[key]):
                    changes_ok = False
                    change_failures.append("text")
            elif kind == "pptx.table_cell_value.v1":
                key = f"{item['slide']}!{item['shape']}!{item['row']}!{item['column']}"
                if key not in candidate_tables or not same_value(item.get("value"), candidate_tables[key]):
                    changes_ok = False
                    change_failures.append("table")
            elif kind == "pptx.slide_order.v1":
                source_index = {part: index for index, part in enumerate(source_parts, start=1)}
                actual_order = [source_index.get(part) for part in candidate_parts]
                if actual_order != item.get("order"):
                    changes_ok = False
                    change_failures.append("order:" + ",".join(str(value) for value in actual_order))
        if changes_ok and required_slides_ok and absent_slides_ok and added_slides_ok and count_ok and any(item.get("type") in {"pptx.slide_present.v1", "pptx.slide_absent.v1", "pptx.slide_add.v1", "pptx.slide_count.v1", "pptx.text_value.v1", "pptx.table_cell_value.v1", "pptx.slide_order.v1"} for item in assertions):
            passed.append("pptx.required_changes.applied")
        else:
            fail("pptx.required_changes.applied", "The declared presentation change is not present: " + ",".join(change_failures), failed, "CONTENT")
        removed_source_parts = {
            str(source_parts[item["slide"] - 1])
            for item in assertions
            if item.get("type") == "pptx.slide_absent.v1"
            and 1 <= item.get("slide", 0) <= len(source_parts)
            and source_parts[item["slide"] - 1] not in candidate_parts
        }
        authorized_identity_texts = {
            f"{candidate.slides[item['slide'] - 1].slide_id}!{item['shape']}"
            for item in assertions
            if item.get("type") == "pptx.text_value.v1"
            and 1 <= item.get("slide", 0) <= len(candidate.slides)
        }
        texts_ok = all(
            candidate_identity_texts.get(key) == value
            for key, value in source_identity_texts.items()
            if key not in authorized_identity_texts and key.split("!", 1)[0] not in removed_source_parts
        )
        if texts_ok:
            passed.append("pptx.source_values.traceable")
        else:
            fail("pptx.source_values.traceable", "An unrequested text shape changed", failed, "SAFETY")
        authorized_identity_tables = {
            f"{candidate.slides[item['slide'] - 1].slide_id}!{item['shape']}!{item['row']}!{item['column']}"
            for item in assertions
            if item.get("type") == "pptx.table_cell_value.v1"
            and 1 <= item.get("slide", 0) <= len(candidate.slides)
        }
        tables_ok = all(
            candidate_identity_tables.get(key) == value
            for key, value in source_identity_tables.items()
            if key not in authorized_identity_tables and key.split("!", 1)[0] not in removed_source_parts
        )
        unauthorized_table_count = sum(
            1
            for key, value in source_identity_tables.items()
            if key not in authorized_identity_tables
            and key.split("!", 1)[0] not in removed_source_parts
            and candidate_identity_tables.get(key) != value
        )
        if tables_ok:
            passed.append("pptx.tables.preserved")
        else:
            fail("pptx.tables.preserved", f"An unrequested table cell changed ({unauthorized_table_count})", failed, "SAFETY")
        images_ok = all(
            candidate_identity_images.get(key) == value
            for key, value in source_identity_images.items()
            if key.split("!", 1)[0] not in removed_source_parts
        )
        if images_ok:
            passed.append("pptx.images.preserved")
        else:
            fail("pptx.images.preserved", "An existing presentation image changed", failed, "SAFETY")
        overflow_ok = all(
            len(value) <= 400
            for value in candidate_texts.values()
        )
        if overflow_ok:
            passed.append("pptx.basic_overflow_check.passed")
        else:
            fail("pptx.basic_overflow_check.passed", "A text shape exceeds the bounded overflow limit", failed, "RENDER")
    else:
        for code in [
            "pptx.slide_order.valid",
            "pptx.required_sections.present",
            "pptx.required_slides.absent",
            "pptx.slide_count.matches",
            "pptx.required_changes.applied",
            "pptx.source_values.traceable",
            "pptx.tables.preserved",
            "pptx.basic_overflow_check.passed",
        ]:
            fail(code, "The candidate presentation could not be inspected", failed)
    render_ok = False
    rendered_pages = 0
    if candidate is not None and not failed:
        try:
            render_dir.mkdir(parents=True, exist_ok=True)
            command = [os.environ.get("FILE_AGENT_RENDER_BIN", "soffice"), "--headless", "--convert-to", "pdf", "--outdir", str(render_dir), str(output)]
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False)
            pdf = render_dir / (output.stem + ".pdf")
            if pdf.is_file() and pdf.stat().st_size > 0:
                info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=30, check=False)
                match = re.search(r"^Pages:\s+(\d+)", info.stdout, re.MULTILINE)
                rendered_pages = int(match.group(1)) if match else 0
            render_ok = result.returncode == 0 and pdf.is_file() and pdf.stat().st_size > 0 and rendered_pages == len(candidate.slides)
        except Exception:
            render_ok = False
    metrics["rendered"] = render_ok
    metrics["renderedPages"] = rendered_pages
    if render_ok:
        passed.append("pptx.all_slides.rendered")
    else:
        fail("pptx.all_slides.rendered", "The PPTX candidate could not be rendered deterministically", failed, "RENDER")
    failed_codes = {item["code"] for item in failed}
    required = set(passed) | failed_codes
    result = {
        "schemaVersion": "1.0",
        "profile": "pptx-structure-v1",
        "profileVersion": "1.0.0",
        "passed": len(failed) == 0,
        "requiredAssertionCount": len(required),
        "passedAssertionCodes": sorted(set(passed)),
        "failedAssertions": failed,
        "artifact": {"logicalId": "candidate:working-pptx", "revision": int(os.environ.get("FILE_AGENT_PLAN_REVISION", "0")), "sha256": digest(output) if output.is_file() else None, "size": output.stat().st_size if output.is_file() else 0},
        "metrics": metrics,
        "errorClass": None if not failed else "PPTX_" + sorted(failed_codes)[0].replace(".", "_").upper(),
        "summary": "PPTX structure, frozen acceptance, source preservation, and render passed" if not failed else "PPTX verification failed",
    }
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(MARKER + json.dumps(result, ensure_ascii=False))

try:
    main()
except Exception:
    print(MARKER + json.dumps({"schemaVersion": "1.0", "profile": "pptx-structure-v1", "profileVersion": "1.0.0", "passed": False, "requiredAssertionCount": 1, "passedAssertionCodes": [], "failedAssertions": [{"code": "pptx.verifier.failed", "class": "VERIFIER", "summary": "The deterministic PPTX verifier failed", "evidenceRef": "workspace://verification/current.json"}], "artifact": {"logicalId": "candidate:working-pptx", "revision": 0}, "metrics": {}, "errorClass": "PPTX_VERIFIER_FAILED", "summary": "PPTX verification failed"}, ensure_ascii=False))
`;

function environment(entries) {
  return entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}

function stableScriptWriteCommand(contract) {
  const files = [
    [contract.scriptPath, Buffer.from(WORKER_SCRIPT, 'utf8').toString('base64'), sha256(WORKER_SCRIPT)],
    [contract.verifierPath, Buffer.from(VERIFIER_SCRIPT, 'utf8').toString('base64'), sha256(VERIFIER_SCRIPT)],
  ];
  const python = [
    'import base64, hashlib, os',
    'from pathlib import Path',
    'data_root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()',
    'task_root = Path(os.environ["FILE_AGENT_TASK_ROOT"])',
    'if task_root.is_symlink(): raise RuntimeError("PPTX task root cannot be a symbolic link")',
    'task_root = task_root.resolve()',
    'if task_root != data_root and data_root not in task_root.parents: raise RuntimeError("PPTX task root escaped the CodeAPI data root")',
    'def checked_path(absolute):',
    '    virtual_path = Path(absolute)',
    '    try:',
    '        relative = virtual_path.relative_to(Path("/mnt/data"))',
    '    except ValueError:',
    '        raise RuntimeError("PPTX script path is outside the CodeAPI data root")',
    '    path = data_root / relative',
    '    resolved = path.resolve()',
    '    if resolved != task_root and task_root not in resolved.parents: raise RuntimeError("PPTX script escaped the task workspace")',
    '    current = path',
    '    while current != task_root and current.resolve() != task_root:',
    '        if current.is_symlink(): raise RuntimeError("PPTX script traverses a symbolic link")',
    '        current = current.parent',
    '    return path',
    `files = ${JSON.stringify(files)}`,
    'for absolute, source, expected in files:',
    '    path = checked_path(absolute)',
    '    path.parent.mkdir(parents=True, exist_ok=True)',
    '    data = base64.b64decode(source)',
    '    if path.exists():',
    '        if hashlib.sha256(path.read_bytes()).hexdigest() != expected: raise RuntimeError("stable PPTX script revision conflict")',
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
        code: result.code ?? 'PPTX_OPERATION_REJECTED',
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
    throw new ExecutorProtocolError('PPTX verifier returned no result marker');
  }
  try {
    return JSON.parse(stdout.slice(index + VERIFIER_MARKER.length).trim());
  } catch (error) {
    throw new ExecutorProtocolError('PPTX verifier returned invalid JSON', { cause: error });
  }
}

function acceptanceAssertionsForTask(task) {
  const assertions = task?.manifest?.acceptanceAssertions;
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new TypeError('PPTX task acceptanceAssertions are required');
  }
  return assertions;
}

export class DeterministicPptxProvider {
  constructor({ actions = null } = {}) {
    this.actions = actions ? actions.map(normalizePptxAction) : null;
  }

  async plan({ task }) {
    const inspected = Object.values(task?.itemResults ?? {}).some(
      (result) => result?.operation === 'inspect',
    );
    if (!inspected) {
      return {
        schemaVersion: '1.0',
        needsInput: false,
        summary: 'Inspect the authorized presentation before planning a change',
        actions: [action('pptx.inspect.v1', { operation: 'inspect' }, [], 'Inspect presentation structure')],
      };
    }
    if (!this.actions || this.actions.length === 0) {
      return {
        schemaVersion: '1.0',
        needsInput: true,
        question: 'Which supported presentation change should be applied?',
        summary: 'A bounded PPTX change is required',
        actions: [],
      };
    }
    return {
      schemaVersion: '1.0',
      needsInput: false,
      summary: 'Apply the bounded PPTX change to the inspected presentation',
      actions: this.actions,
    };
  }

  async repair({ verification }) {
    return {
      schemaVersion: '1.0',
      needsInput: true,
      question: `The presentation verifier reported ${verification?.summary ?? 'a failure'}. Provide a new bounded instruction.`,
      summary: 'Do not guess a presentation repair',
      actions: [],
    };
  }
}

export class CodeApiPptxV1Executor extends ExecutorAdapter {
  constructor({ transport, timeoutMs = 120_000, renderBin = 'soffice' }) {
    super();
    if (!transport || typeof transport.execute !== 'function') {
      throw new TypeError('CodeApiPptxV1Executor transport.execute is required');
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.renderBin = requiredString(renderBin, 'renderBin');
  }

  async prepare({ itemId, task, signal }) {
    const contract = resolvePptxContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: [stableScriptWriteCommand(contract), actionCommand(contract, 'prepare', {})].join(' && '),
      signal,
    });
    const prepared = parseMarker(result.stdout, WORKER_MARKER, 'PPTX Worker preparation');
    return {
      ...prepared,
      operation: 'prepare',
      workspaceRoot: contract.workspaceRoot,
      outputPath: contract.outputPath,
      replayed: result.replayed,
    };
  }

  async execute({ itemId, action, task, signal }) {
    const contract = resolvePptxContract(task);
    const normalized = normalizePptxAction(action);
    const operation = normalized.worker === 'pptx.inspect.v1'
      ? 'inspect'
      : normalized.worker === 'pptx.validate.v1'
        ? 'validate'
        : 'transform';
    const result = await this.#call({
      itemId,
      contract,
      command: actionCommand(contract, operation, normalized),
      signal,
    });
    const executed = parseMarker(result.stdout, WORKER_MARKER, 'PPTX Worker');
    return { ...executed, action: normalized, replayed: result.replayed };
  }

  async verify({ itemId, task, signal }) {
    const contract = resolvePptxContract(task);
    const assertions = Buffer.from(JSON.stringify(acceptanceAssertionsForTask(task)), 'utf8').toString('base64');
    const command = [
      environment([
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
    const contract = resolvePptxContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: `test -s ${shellQuote(contract.outputPath)}`,
      artifactPaths: [contract.outputPath],
      signal,
    });
    if (result.artifacts.length !== 1) {
      throw new ExecutorArtifactError('CodeAPI did not return exactly one PPTX artifact');
    }
    const artifact = result.artifacts[0];
    if (
      artifact?.mimeType !== PPTX_MIME ||
      artifact?.name !== 'working.pptx' ||
      typeof artifact?.codeEnvRef?.storage_session_id !== 'string' ||
      typeof artifact?.codeEnvRef?.file_id !== 'string'
    ) {
      throw new ExecutorArtifactError('CodeAPI returned an incomplete PPTX artifact reference');
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

export function getPptxTaskPaths(task) {
  const contract = resolvePptxContract(task);
  return {
    ...contract,
    scriptName: path.posix.basename(contract.scriptPath),
    verifierName: path.posix.basename(contract.verifierPath),
    outputName: path.posix.basename(contract.outputPath),
  };
}

export function getPptxScriptDigests() {
  return {
    workerVersion: PPTX_WORKER_VERSION,
    workerSha256: sha256(WORKER_SCRIPT),
    verifierProfile: PPTX_VERIFIER_PROFILE,
    verifierVersion: PPTX_VERIFIER_VERSION,
    verifierSha256: sha256(VERIFIER_SCRIPT),
    capabilityProfile: PPTX_CAPABILITY_PROFILE,
    artifactLogicalId: PPTX_ARTIFACT_LOGICAL_ID,
  };
}

export function getPptxWorkerSource() {
  return WORKER_SCRIPT;
}

export function getPptxVerifierSource() {
  return VERIFIER_SCRIPT;
}
