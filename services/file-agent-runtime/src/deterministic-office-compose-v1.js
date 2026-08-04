import { createHash } from 'node:crypto';
import path from 'node:path';

import { normalizeActionEnvelope } from './action-envelope.js';
import {
  DOCX_MIME,
  PPTX_CAPABILITY_PROFILE,
  PPTX_MIME,
  XLSX_MIME,
} from './constants.js';
import {
  OFFICE_COMPOSE_ACCEPTANCE_TYPES,
  OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID,
  OFFICE_COMPOSE_MAX_INPUTS,
  OFFICE_COMPOSE_MAX_SLIDES,
  normalizeOfficeComposeAcceptanceAssertions,
} from './office-compose-acceptance.js';
import {
  ExecutorAdapter,
  ExecutorArtifactError,
  ExecutorProtocolError,
  ExecutorRejectedError,
} from './executor-adapter.js';

export const OFFICE_COMPOSE_CAPABILITY_PROFILE = 'office-compose-v1';
export const OFFICE_COMPOSE_WORKER_VERSION = 'office-compose-worker-v1.0.0';
export const OFFICE_COMPOSE_VERIFIER_PROFILE = 'office-compose-structure-v1';
export const OFFICE_COMPOSE_VERIFIER_VERSION = '1.0.0';
export const OFFICE_COMPOSE_WORKER_IDS = Object.freeze([
  'office-compose.inspect.v1',
  'office-compose.generate.v1',
  'office-compose.validate.v1',
]);

const WORKER_SET = new Set(OFFICE_COMPOSE_WORKER_IDS);
const WORKER_MARKER = '__FILE_AGENT_OFFICE_COMPOSE_WORKER__';
const VERIFIER_MARKER = '__FILE_AGENT_OFFICE_COMPOSE_VERIFIER__';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SOURCE_LOGICAL_ID_PATTERN = /^source:[a-z][a-z0-9._-]{0,63}$/;
const SOURCE_LOCATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._!$:#\-\[\]]{0,159}$/u;
const SOURCE_KIND_BY_MIME = Object.freeze({
  [DOCX_MIME]: 'docx',
  [XLSX_MIME]: 'xlsx',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredString(value, field, max = 4_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  if (value.length > max) {
    throw new TypeError(`${field} exceeds ${max} characters`);
  }
  return value.trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `\\'"'"'`)}'`;
}

function pythonFromBase64(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `python3 -c ${shellQuote(`import base64;exec(base64.b64decode("${encoded}"))`)}`;
}

function environment(entries) {
  return entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}

function safeRelativeFilename(value, mimeType, field) {
  const filename = requiredString(value, field, 160).replaceAll('\\', '/');
  if (
    filename.startsWith('/') ||
    filename.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError(`${field} must be a safe relative path`);
  }
  const extension = mimeType === XLSX_MIME ? '.xlsx' : '.docx';
  if (!filename.toLowerCase().endsWith(extension)) {
    throw new TypeError(`${field} must end with ${extension}`);
  }
  return filename;
}

function safeWorkspaceRoot(value, taskId) {
  const root = (value ?? `/mnt/data/.agent/${taskId}`).replaceAll('{taskId}', taskId);
  const expectedPrefix = `/mnt/data/.agent/${taskId}`;
  if (root !== expectedPrefix && !root.startsWith(`${expectedPrefix}/`)) {
    throw new TypeError('Office Compose workspaceRoot must remain inside the task workspace');
  }
  if (root.split('/').includes('..')) {
    throw new TypeError('Office Compose workspaceRoot cannot contain path traversal');
  }
  return root;
}

function normalizeSourceInput(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`Office Compose input[${index}] must be an object`);
  }
  const mimeType = input.mimeType;
  if (!SOURCE_KIND_BY_MIME[mimeType]) {
    throw new TypeError(`Office Compose input[${index}] must be DOCX or XLSX`);
  }
  const logicalId = requiredString(input.logicalId, `Office Compose input[${index}].logicalId`, 72);
  if (!SOURCE_LOGICAL_ID_PATTERN.test(logicalId)) {
    throw new TypeError(`Office Compose input[${index}].logicalId must be a source logical ID`);
  }
  if (!SHA256_PATTERN.test(input.sha256 ?? '')) {
    throw new TypeError(`Office Compose input[${index}].sha256 must be a SHA-256 digest`);
  }
  const codeEnvRef = input.codeEnvRef;
  if (
    !codeEnvRef ||
    typeof codeEnvRef.storage_session_id !== 'string' ||
    codeEnvRef.storage_session_id.trim() === '' ||
    typeof codeEnvRef.file_id !== 'string' ||
    codeEnvRef.file_id.trim() === ''
  ) {
    throw new TypeError(`Office Compose input[${index}] requires a CodeAPI codeEnvRef`);
  }
  return {
    logicalId,
    mimeType,
    kind: SOURCE_KIND_BY_MIME[mimeType],
    filename: safeRelativeFilename(input.logicalName ?? input.filename, mimeType, `Office Compose input[${index}].logicalName`),
    sha256: input.sha256.toLowerCase(),
    codeEnvRef: {
      storage_session_id: codeEnvRef.storage_session_id.trim(),
      file_id: codeEnvRef.file_id.trim(),
    },
  };
}

function resolveComposeContract(task) {
  const inputs = task?.manifest?.inputs;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > OFFICE_COMPOSE_MAX_INPUTS) {
    throw new TypeError(`Office Compose requires one or two authorized DOCX/XLSX inputs`);
  }
  const normalizedInputs = inputs.map(normalizeSourceInput);
  const logicalIds = new Set(normalizedInputs.map((input) => input.logicalId));
  if (logicalIds.size !== normalizedInputs.length) {
    throw new TypeError('Office Compose input logical IDs must be unique');
  }
  const filenames = new Set(normalizedInputs.map((input) => input.filename));
  if (filenames.size !== normalizedInputs.length) {
    throw new TypeError('Office Compose input filenames must be unique');
  }
  const sessionId = normalizedInputs[0].codeEnvRef.storage_session_id;
  if (normalizedInputs.some((input) => input.codeEnvRef.storage_session_id !== sessionId)) {
    throw new TypeError('Office Compose inputs must use one CodeAPI storage session');
  }
  const workspaceRoot = safeWorkspaceRoot(task.manifest.execution?.workspaceRoot, task.taskId);
  return {
    inputs: normalizedInputs.map((input, index) => ({
      ...input,
      stagedName: input.filename,
      inputPath: `${workspaceRoot}/input/source-${index + 1}${input.kind === 'xlsx' ? '.xlsx' : '.docx'}`,
    })),
    sessionId,
    workspaceRoot,
    scriptPath: `${workspaceRoot}/scripts/office_compose.py`,
    verifierPath: `${workspaceRoot}/scripts/office_compose_verifier.py`,
    historyPath: `${workspaceRoot}/internal/worker-history.json`,
    sourceFactsPath: `${workspaceRoot}/internal/source-facts.json`,
    mappingPath: `${workspaceRoot}/internal/source-mapping.json`,
    verificationPath: `${workspaceRoot}/internal/verification/compose-${task.planRevision}.json`,
    renderDir: `${workspaceRoot}/internal/render`,
    outputPath: `${workspaceRoot}/output/working.pptx`,
    injectedFiles: normalizedInputs.map((input, index) => ({
      name: input.filename,
      storage_session_id: input.codeEnvRef.storage_session_id,
      file_id: input.codeEnvRef.file_id,
    })),
  };
}

function normalizeSourceReference(value, field) {
  const normalized = requiredString(value, field, 160);
  if (!SOURCE_LOGICAL_ID_PATTERN.test(normalized) && field.endsWith('sourceLogicalId')) {
    throw new TypeError(`${field} must be a source logical ID`);
  }
  if (field.endsWith('sourceLocation') && !SOURCE_LOCATION_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must be a bounded source location`);
  }
  return normalized;
}

function normalizeComposeParameters(parameters, worker) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('Office Compose Action parameters must be an object');
  }
  const operation = parameters.operation ?? (
    worker === 'office-compose.inspect.v1'
      ? 'inspect'
      : worker === 'office-compose.validate.v1'
        ? 'validate'
        : 'generate'
  );
  if (worker === 'office-compose.inspect.v1' && operation !== 'inspect') {
    throw new TypeError('office-compose.inspect.v1 requires operation inspect');
  }
  if (worker === 'office-compose.validate.v1' && operation !== 'validate') {
    throw new TypeError('office-compose.validate.v1 requires operation validate');
  }
  if (worker === 'office-compose.generate.v1' && operation !== 'generate') {
    throw new TypeError('office-compose.generate.v1 requires operation generate');
  }
  if (operation !== 'generate') {
    return { operation };
  }
  const title = requiredString(parameters.title, 'parameters.title', 400);
  if (!Array.isArray(parameters.slides) || parameters.slides.length < 1 || parameters.slides.length > OFFICE_COMPOSE_MAX_SLIDES) {
    throw new TypeError(`parameters.slides must contain between 1 and ${OFFICE_COMPOSE_MAX_SLIDES} slides`);
  }
  const slides = parameters.slides.map((slide, slideIndex) => {
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) {
      throw new TypeError(`parameters.slides[${slideIndex}] must be an object`);
    }
    if (slideIndex > 0 && typeof slide.title !== 'string') {
      throw new TypeError(`parameters.slides[${slideIndex}].title is required`);
    }
    const normalizedSlide = {
      title: requiredString(slide.title ?? title, `parameters.slides[${slideIndex}].title`, 400),
      bullets: [],
    };
    if (!Array.isArray(slide.bullets) || slide.bullets.length < 1 || slide.bullets.length > 8) {
      throw new TypeError(`parameters.slides[${slideIndex}].bullets must contain between 1 and 8 entries`);
    }
    normalizedSlide.bullets = slide.bullets.map((bullet, bulletIndex) => {
      if (!bullet || typeof bullet !== 'object' || Array.isArray(bullet)) {
        throw new TypeError(`parameters.slides[${slideIndex}].bullets[${bulletIndex}] must be an object`);
      }
      return {
        sourceLogicalId: normalizeSourceReference(
          bullet.sourceLogicalId,
          `parameters.slides[${slideIndex}].bullets[${bulletIndex}].sourceLogicalId`,
        ),
        sourceLocation: normalizeSourceReference(
          bullet.sourceLocation,
          `parameters.slides[${slideIndex}].bullets[${bulletIndex}].sourceLocation`,
        ),
        label: requiredString(
          bullet.label ?? bullet.sourceLocation,
          `parameters.slides[${slideIndex}].bullets[${bulletIndex}].label`,
          240,
        ),
      };
    });
    return normalizedSlide;
  });
  return { operation, title, slides };
}

export function normalizeOfficeComposeAction(action) {
  const normalized = normalizeActionEnvelope(action, { allowedWorkers: WORKER_SET });
  const parameters = normalizeComposeParameters(normalized.parameters, normalized.worker);
  if (!normalized.inputRefs.includes('input:office-sources')) {
    throw new TypeError('Office Compose Action must reference input:office-sources');
  }
  if (normalized.targetRef !== OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID) {
    throw new TypeError(`Office Compose Action targetRef must be ${OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID}`);
  }
  return { ...normalized, parameters };
}

function action(worker, parameters, expectedChange, summary) {
  return normalizeOfficeComposeAction({
    schemaVersion: '1.0',
    objective: 'Compose one verified PPTX from bounded authorized Office source facts',
    worker,
    inputRefs: ['input:office-sources'],
    targetRef: OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID,
    parameters,
    expectedChange,
    verificationProfile: OFFICE_COMPOSE_VERIFIER_PROFILE,
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
from pathlib import Path

from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
from pptx.util import Inches, Pt

MARKER = "${WORKER_MARKER}"
WORKER_VERSION = "${OFFICE_COMPOSE_WORKER_VERSION}"
MAX_FACTS_PER_SOURCE = 240

def fail(code, summary):
    print(MARKER + json.dumps({"ok": False, "code": code, "summary": summary}, ensure_ascii=False))
    raise SystemExit(2)

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

def task_path(name):
    data_root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()
    task_root = Path(os.environ["FILE_AGENT_TASK_ROOT"])
    if task_root.is_symlink():
        fail("COMPOSE_WORKSPACE_SYMLINK", "The task workspace cannot be a symbolic link")
    task_root = task_root.resolve()
    if data_root != task_root and data_root not in task_root.parents:
        fail("COMPOSE_WORKSPACE_ESCAPE", "The task workspace escaped the CodeAPI data root")
    path = Path(name)
    try:
        relative = path.relative_to(Path("/mnt/data"))
        path = data_root / relative
    except ValueError:
        pass
    resolved = path.resolve()
    if resolved != task_root and task_root not in resolved.parents:
        fail("COMPOSE_PATH_ESCAPE", "The Compose path escaped the task workspace")
    return path

def copy_inputs():
    try:
        definitions = json.loads(base64.b64decode(os.environ["FILE_AGENT_INPUTS_JSON_B64"]).decode("utf-8"))
    except Exception:
        fail("COMPOSE_INPUT_CONTRACT_INVALID", "The Compose input contract is invalid")
    copied = []
    data_root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()
    for definition in definitions:
        staged = data_root / definition["stagedName"]
        if not staged.is_file() or staged.is_symlink():
            fail("COMPOSE_INPUT_MISSING", "An authorized Compose input is missing")
        destination = task_path(definition["inputPath"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and digest(destination) != definition["sha256"]:
            fail("COMPOSE_INPUT_REBIND_CONFLICT", "The persisted Compose input changed")
        if not destination.exists():
            shutil.copyfile(staged, destination)
        if digest(destination) != definition["sha256"]:
            fail("COMPOSE_INPUT_HASH_MISMATCH", "An authorized Compose input hash does not match")
        copied.append({**definition, "path": str(destination)})
    return copied

def scalar(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    return str(value)

def inspect_xlsx(definition, source_path):
    try:
        workbook = load_workbook(source_path, data_only=False, read_only=True)
        locations = []
        for sheet in workbook.worksheets:
            for row in sheet.iter_rows():
                for cell in row:
                    if cell.value is None:
                        continue
                    locations.append({"location": f"{sheet.title}!{cell.coordinate}", "value": scalar(cell.value)})
                    if len(locations) >= MAX_FACTS_PER_SOURCE:
                        break
                if len(locations) >= MAX_FACTS_PER_SOURCE:
                    break
            if len(locations) >= MAX_FACTS_PER_SOURCE:
                break
        return {"logicalId": definition["logicalId"], "kind": "xlsx", "mimeType": definition["mimeType"], "sha256": digest(source_path), "locations": locations}
    except Exception:
        fail("COMPOSE_XLSX_INSPECT_FAILED", "The authorized XLSX source could not be inspected")

def inspect_docx(definition, source_path):
    try:
        document = Document(source_path)
        locations = []
        for index, paragraph in enumerate(document.paragraphs):
            if paragraph.text:
                locations.append({"location": f"body.paragraph[{index}]", "value": paragraph.text[:4000]})
            if len(locations) >= MAX_FACTS_PER_SOURCE:
                break
        return {"logicalId": definition["logicalId"], "kind": "docx", "mimeType": definition["mimeType"], "sha256": digest(source_path), "locations": locations}
    except Exception:
        fail("COMPOSE_DOCX_INSPECT_FAILED", "The authorized DOCX source could not be inspected")

def inspect_sources(definitions):
    sources = []
    for definition in definitions:
        source_path = Path(definition["path"])
        if definition["kind"] == "xlsx":
            sources.append(inspect_xlsx(definition, source_path))
        elif definition["kind"] == "docx":
            sources.append(inspect_docx(definition, source_path))
        else:
            fail("COMPOSE_SOURCE_TYPE_UNSUPPORTED", "The Compose source type is unsupported")
    facts = {"schemaVersion": "1.0", "sources": sources}
    facts["sourceFactsHash"] = hashlib.sha256(json.dumps(facts, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return facts

def action_value():
    try:
        return json.loads(base64.b64decode(os.environ["FILE_AGENT_ACTION_B64"]).decode("utf-8"))
    except Exception:
        fail("COMPOSE_ACTION_INVALID", "The Compose action payload is invalid")

def load_facts(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        fail("COMPOSE_FACTS_MISSING", "Source facts must be frozen before generation")

def value_text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)

def generate(definitions, facts, action, output, mapping_path):
    source_map = {}
    for source in facts["sources"]:
        for location in source["locations"]:
            source_map[(source["logicalId"], location["location"])] = location["value"]
    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)
    blank_layout = presentation.slide_layouts[6]
    mappings = []
    for slide_index, slide_spec in enumerate(action["parameters"]["slides"], start=1):
        slide = presentation.slides.add_slide(blank_layout)
        title_box = slide.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(12.1), Inches(0.8))
        title_box.name = "title"
        title_frame = title_box.text_frame
        title_frame.text = slide_spec["title"]
        title_frame.paragraphs[0].font.size = Pt(28)
        title_frame.paragraphs[0].font.bold = True
        body_box = slide.shapes.add_textbox(Inches(0.9), Inches(1.5), Inches(11.7), Inches(5.2))
        body_box.name = "body"
        body_frame = body_box.text_frame
        body_frame.word_wrap = True
        for bullet_index, bullet in enumerate(slide_spec["bullets"]):
            key = (bullet["sourceLogicalId"], bullet["sourceLocation"])
            if key not in source_map:
                fail("COMPOSE_SOURCE_MAPPING_MISSING", "The Compose plan references a source fact that was not inspected")
            paragraph = body_frame.paragraphs[0] if bullet_index == 0 else body_frame.add_paragraph()
            paragraph.text = f"{bullet['label']}: {value_text(source_map[key])}"
            paragraph.level = 0
            paragraph.font.size = Pt(20)
            mappings.append({"targetSlide": slide_index, "targetShape": "body", "sourceLogicalId": bullet["sourceLogicalId"], "sourceLocation": bullet["sourceLocation"], "value": source_map[key]})
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkstemp(prefix="compose-candidate-", suffix=".pptx", dir=str(output.parent))[1])
    metadata = {"schemaVersion": "1.0", "sourceFactsHash": facts["sourceFactsHash"], "mappings": mappings}
    try:
        presentation.save(temporary)
        with zipfile.ZipFile(temporary, "r") as package:
            members = [(name, package.read(name)) for name in package.namelist()]
        with zipfile.ZipFile(temporary.with_suffix(".tmp.pptx"), "w", compression=zipfile.ZIP_DEFLATED) as destination:
            for name, data in members:
                destination.writestr(name, data)
            destination.writestr("customXml/file-agent-compose.json", json.dumps(metadata, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        Path(temporary.with_suffix(".tmp.pptx")).replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()
        temporary_copy = temporary.with_suffix(".tmp.pptx")
        if temporary_copy.exists():
            temporary_copy.unlink()
    history_path = task_path(os.environ["FILE_AGENT_HISTORY_PATH"])
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history = json.loads(history_path.read_text(encoding="utf-8")) if history_path.exists() else []
    history.append({"worker": "office-compose.generate.v1", "workerVersion": WORKER_VERSION, "sourceFactsHash": facts["sourceFactsHash"], "afterSha256": digest(output)})
    history_path.write_text(json.dumps(history[-32:], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    mapping_path.parent.mkdir(parents=True, exist_ok=True)
    mapping_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "operation": "generate", "sha256": digest(output), "size": output.stat().st_size, "slideCount": len(presentation.slides), "sourceFactsHash": facts["sourceFactsHash"]}

def main():
    definitions = copy_inputs()
    operation = os.environ.get("FILE_AGENT_OPERATION", "prepare")
    source_facts_path = task_path(os.environ["FILE_AGENT_SOURCE_FACTS_PATH"])
    mapping_path = task_path(os.environ["FILE_AGENT_MAPPING_PATH"])
    output = task_path(os.environ["FILE_AGENT_OUTPUT_PATH"])
    if operation == "prepare":
        facts = inspect_sources(definitions)
        source_facts_path.parent.mkdir(parents=True, exist_ok=True)
        source_facts_path.write_text(json.dumps(facts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(MARKER + json.dumps({"ok": True, "operation": "prepare", "sourceFactsHash": facts["sourceFactsHash"]}, ensure_ascii=False))
        return
    if operation == "inspect":
        facts = inspect_sources(definitions)
        source_facts_path.parent.mkdir(parents=True, exist_ok=True)
        source_facts_path.write_text(json.dumps(facts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(MARKER + json.dumps({"ok": True, "operation": "inspect", "sourceFactsHash": facts["sourceFactsHash"], "sources": facts["sources"]}, ensure_ascii=False))
        return
    if operation == "validate":
        if not output.is_file():
            fail("COMPOSE_OUTPUT_MISSING", "The Compose output is missing")
        print(MARKER + json.dumps({"ok": True, "operation": "validate", "sha256": digest(output), "size": output.stat().st_size}, ensure_ascii=False))
        return
    if operation != "generate":
        fail("COMPOSE_OPERATION_UNSUPPORTED", "The Compose operation is unsupported")
    action = action_value()
    facts = load_facts(source_facts_path)
    result = generate(definitions, facts, action, output, mapping_path)
    print(MARKER + json.dumps(result, ensure_ascii=False))

main()
`;

const VERIFIER_SCRIPT = String.raw`#!/usr/bin/env python3
import base64
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path

from pptx import Presentation

MARKER = "${VERIFIER_MARKER}"
PROFILE = "${OFFICE_COMPOSE_VERIFIER_PROFILE}"
PROFILE_VERSION = "${OFFICE_COMPOSE_VERIFIER_VERSION}"

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

def fail(code, summary, failed, kind="VERIFIER"):
    failed.append({"code": code, "class": kind, "summary": summary, "evidenceRef": "workspace://verification/current.json"})

def value_text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)

def main():
    import os
    data_root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()
    output = Path(os.environ["FILE_AGENT_OUTPUT_PATH"])
    facts_path = Path(os.environ["FILE_AGENT_SOURCE_FACTS_PATH"])
    mapping_path = Path(os.environ["FILE_AGENT_MAPPING_PATH"])
    evidence_path = Path(os.environ["FILE_AGENT_VERIFICATION_PATH"])
    render_dir = Path(os.environ["FILE_AGENT_RENDER_DIR"])
    assertions = json.loads(base64.b64decode(__import__("os").environ["FILE_AGENT_ACCEPTANCE_ASSERTIONS_B64"]).decode("utf-8"))
    failed = []
    passed = []
    metrics = {"slideCount": 0, "sourceCount": 0, "mappingCount": 0, "rendered": False, "renderedPages": 0}
    try:
        with zipfile.ZipFile(output, "r") as package:
            if package.testzip():
                raise ValueError("damaged ZIP member")
        passed.append("ooxml.zip.valid")
    except Exception:
        fail("ooxml.zip.valid", "The Compose candidate is not a valid PPTX package", failed)
    facts = None
    metadata = None
    presentation = None
    try:
        facts = json.loads(facts_path.read_text(encoding="utf-8"))
        metadata = json.loads(mapping_path.read_text(encoding="utf-8"))
        presentation = Presentation(str(output))
        metrics["slideCount"] = len(presentation.slides)
        metrics["sourceCount"] = len(facts.get("sources", []))
        metrics["mappingCount"] = len(metadata.get("mappings", []))
        passed.append("pptx.presentation.openable")
    except Exception:
        fail("pptx.presentation.openable", "The Compose PPTX or frozen source facts could not be opened", failed)
    if facts is not None and metadata is not None and presentation is not None:
        facts_without_hash = {"schemaVersion": facts.get("schemaVersion"), "sources": facts.get("sources", [])}
        expected_facts_hash = hashlib.sha256(json.dumps(facts_without_hash, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        if facts.get("sourceFactsHash") == expected_facts_hash and metadata.get("sourceFactsHash") == expected_facts_hash:
            passed.append("compose.source_facts.frozen")
        else:
            fail("compose.source_facts.frozen", "Frozen source facts or their mapping hash was changed", failed, "SAFETY")
        try:
            definitions = json.loads(base64.b64decode(os.environ["FILE_AGENT_INPUTS_JSON_B64"]).decode("utf-8"))
            for definition in definitions:
                source_path = data_root / definition["stagedName"]
                if digest(source_path) != definition["sha256"]:
                    raise ValueError("source hash changed")
            passed.append("compose.source_files.unchanged")
        except Exception:
            fail("compose.source_files.unchanged", "An authorized source file changed during Compose", failed, "SAFETY")
        actual_source_hashes = {source["logicalId"]: source["sha256"] for source in facts.get("sources", [])}
        actual_values = {}
        for source in facts.get("sources", []):
            for location in source.get("locations", []):
                actual_values[(source["logicalId"], location["location"])] = location.get("value")
        actual_mappings = metadata.get("mappings", [])
        mapping_keys = {(item.get("targetSlide"), item.get("targetShape"), item.get("sourceLogicalId"), item.get("sourceLocation")) for item in actual_mappings}
        expected_mapping_keys = set()
        for assertion in assertions:
            if assertion.get("type") in {"compose.source_value.v1", "compose.source_mapping.v1"}:
                expected_mapping_keys.add((assertion.get("targetSlide"), assertion.get("targetShape"), assertion.get("sourceLogicalId"), assertion.get("sourceLocation")))
        if mapping_keys == expected_mapping_keys:
            passed.append("compose.source_mapping.complete")
        else:
            fail("compose.source_mapping.complete", "Generated source mappings do not exactly match independent acceptance", failed, "SAFETY")
        actual_by_key = {(item.get("targetSlide"), item.get("targetShape"), item.get("sourceLogicalId"), item.get("sourceLocation")): item for item in actual_mappings}
        for assertion in assertions:
            kind = assertion.get("type")
            if kind == "compose.source_hash.v1":
                if actual_source_hashes.get(assertion.get("sourceLogicalId")) == assertion.get("sha256"):
                    passed.append("compose.source_hash." + assertion["sourceLogicalId"].replace(":", "_"))
                else:
                    fail("compose.source_hash.match", "A source file hash does not match the frozen acceptance", failed, "SAFETY")
            elif kind == "compose.section_present.v1":
                slide_number = assertion.get("slide", 0)
                title = presentation.slides[slide_number - 1].shapes[0].text if 1 <= slide_number <= len(presentation.slides) else None
                if title == assertion.get("title"):
                    passed.append("compose.section_present." + str(slide_number))
                else:
                    fail("compose.section_present", "A required Compose section is missing", failed, "CONTENT")
            elif kind == "compose.source_mapping.v1":
                key = (assertion.get("targetSlide"), assertion.get("targetShape"), assertion.get("sourceLogicalId"), assertion.get("sourceLocation"))
                if key in actual_by_key and actual_values.get((assertion.get("sourceLogicalId"), assertion.get("sourceLocation"))) == actual_by_key[key].get("value"):
                    passed.append("compose.source_mapping." + str(assertion.get("targetSlide")))
                else:
                    fail("compose.source_mapping", "A source mapping is missing or points to a different source fact", failed, "SAFETY")
            elif kind == "compose.source_value.v1":
                key = (assertion.get("targetSlide"), assertion.get("targetShape"), assertion.get("sourceLogicalId"), assertion.get("sourceLocation"))
                actual = actual_by_key.get(key)
                slide_number = assertion.get("targetSlide", 0)
                shape_text = None
                if 1 <= slide_number <= len(presentation.slides):
                    shape_text = next((shape.text for shape in presentation.slides[slide_number - 1].shapes if shape.name == assertion.get("targetShape")), None)
                if actual and actual.get("value") == assertion.get("value") and value_text(assertion.get("value")) in (shape_text or ""):
                    passed.append("compose.source_value." + str(slide_number))
                else:
                    fail("compose.source_value", "A required source value is not present in the target slide", failed, "CONTENT")
        if all(item.get("type") not in {"compose.source_value.v1", "compose.source_mapping.v1"} or item.get("targetSlide") in range(1, len(presentation.slides) + 1) for item in assertions):
            passed.append("compose.required_sections.present")
        else:
            fail("compose.required_sections.present", "A Compose target slide is missing", failed, "CONTENT")
    else:
        for code in ["compose.source_mapping.complete", "compose.required_sections.present"]:
            fail(code, "The Compose candidate could not be inspected", failed)
    rendered = False
    rendered_pages = 0
    if presentation is not None and not failed:
        try:
            render_dir.mkdir(parents=True, exist_ok=True)
            result = subprocess.run([os.environ.get("FILE_AGENT_RENDER_BIN", "soffice"), "--headless", "--convert-to", "pdf", "--outdir", str(render_dir), str(output)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False)
            pdf = render_dir / (output.stem + ".pdf")
            if result.returncode == 0 and pdf.is_file() and pdf.stat().st_size > 0:
                info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=30, check=False)
                match = re.search(r"^Pages:\s+(\d+)", info.stdout, re.MULTILINE)
                rendered_pages = int(match.group(1)) if match else 0
            rendered = rendered_pages == len(presentation.slides) and rendered_pages > 0
        except Exception:
            rendered = False
    metrics["rendered"] = rendered
    metrics["renderedPages"] = rendered_pages
    if rendered:
        passed.append("pptx.all_slides.rendered")
    else:
        fail("pptx.all_slides.rendered", "The composed PPTX could not be rendered deterministically", failed, "RENDER")
    failed_codes = {item["code"] for item in failed}
    result = {
        "schemaVersion": "1.0",
        "profile": PROFILE,
        "profileVersion": PROFILE_VERSION,
        "passed": len(failed) == 0,
        "requiredAssertionCount": len(set(passed)) + len(failed_codes),
        "passedAssertionCodes": sorted(set(passed)),
        "failedAssertions": failed,
        "artifact": {"logicalId": "${OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID}", "revision": int(os.environ.get("FILE_AGENT_PLAN_REVISION", "0")), "sha256": digest(output) if output.is_file() else None, "size": output.stat().st_size if output.is_file() else 0},
        "metrics": metrics,
        "errorClass": None if not failed else "COMPOSE_" + sorted(failed_codes)[0].replace(".", "_").upper(),
        "summary": "Office source facts, source mappings, PPTX structure, and full render passed" if not failed else "Office Compose verification failed",
    }
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(MARKER + json.dumps(result, ensure_ascii=False))

main()
`;

function stableScriptWriteCommand(contract) {
  const files = [
    [contract.scriptPath, Buffer.from(WORKER_SCRIPT, 'utf8').toString('base64'), sha256(WORKER_SCRIPT)],
    [contract.verifierPath, Buffer.from(VERIFIER_SCRIPT, 'utf8').toString('base64'), sha256(VERIFIER_SCRIPT)],
  ];
  const python = [
    'import base64, hashlib, os',
    'from pathlib import Path',
    'data_root = Path(os.environ["FILE_AGENT_MNT_DATA"]).resolve()',
    'task_root = Path(os.environ["FILE_AGENT_TASK_ROOT"]).resolve()',
    'if data_root != task_root and data_root not in task_root.parents: raise RuntimeError("Compose task root escaped CodeAPI data root")',
    `files = ${JSON.stringify(files)}`,
    'for absolute, source, expected in files:',
    '    relative = Path(absolute).relative_to(Path("/mnt/data"))',
    '    path = data_root / relative',
    '    resolved = path.resolve()',
    '    if resolved != task_root and task_root not in resolved.parents: raise RuntimeError("Compose script escaped task workspace")',
    '    path.parent.mkdir(parents=True, exist_ok=True)',
    '    data = base64.b64decode(source)',
    '    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != expected: raise RuntimeError("stable Compose script revision conflict")',
    '    if not path.exists(): path.write_bytes(data)',
  ].join('\n');
  return `${environment([
    ['FILE_AGENT_MNT_DATA', '/mnt/data'],
    ['FILE_AGENT_TASK_ROOT', contract.workspaceRoot],
  ])} ${pythonFromBase64(python)}`;
}

function actionCommand(contract, operation, action) {
  const actionB64 = Buffer.from(JSON.stringify(action), 'utf8').toString('base64');
  const inputs = contract.inputs.map(({ logicalId, kind, mimeType, sha256: inputSha256, stagedName, inputPath }) => ({
    logicalId,
    kind,
    mimeType,
    sha256: inputSha256,
    stagedName,
    inputPath,
  }));
  return [
    environment([
      ['FILE_AGENT_MNT_DATA', '/mnt/data'],
      ['FILE_AGENT_TASK_ROOT', contract.workspaceRoot],
      ['FILE_AGENT_OUTPUT_PATH', contract.outputPath],
      ['FILE_AGENT_HISTORY_PATH', contract.historyPath],
      ['FILE_AGENT_SOURCE_FACTS_PATH', contract.sourceFactsPath],
      ['FILE_AGENT_MAPPING_PATH', contract.mappingPath],
      ['FILE_AGENT_INPUTS_JSON_B64', Buffer.from(JSON.stringify(inputs), 'utf8').toString('base64')],
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
        code: result.code ?? 'OFFICE_COMPOSE_OPERATION_REJECTED',
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
    throw new ExecutorProtocolError('Office Compose verifier returned no result marker');
  }
  try {
    return JSON.parse(stdout.slice(index + VERIFIER_MARKER.length).trim());
  } catch (error) {
    throw new ExecutorProtocolError('Office Compose verifier returned invalid JSON', { cause: error });
  }
}

function acceptanceAssertionsForTask(task) {
  return normalizeOfficeComposeAcceptanceAssertions(task?.manifest?.acceptanceAssertions);
}

export class DeterministicOfficeComposeProvider {
  constructor({ actions = null, title = 'Office Source Summary' } = {}) {
    this.actions = actions ? actions.map(normalizeOfficeComposeAction) : null;
    this.title = requiredString(title, 'Office Compose title', 400);
  }

  async plan({ task }) {
    const inspected = Object.values(task?.itemResults ?? {}).some(
      (result) => result?.operation === 'inspect' && result?.sourceFactsHash,
    );
    if (!inspected) {
      return {
        schemaVersion: '1.0',
        needsInput: false,
        summary: 'Inspect all authorized Office sources before composing a presentation',
        actions: [action('office-compose.inspect.v1', { operation: 'inspect' }, ['compose.source_facts'], 'Inspect authorized Office source facts')],
      };
    }
    if (!this.actions || this.actions.length === 0) {
      return {
        schemaVersion: '1.0',
        needsInput: true,
        question: 'Which bounded source facts should be placed into the presentation?',
        summary: 'A bounded Office Compose outline is required',
        actions: [],
      };
    }
    return {
      schemaVersion: '1.0',
      needsInput: false,
      summary: 'Compose one PPTX from the frozen Office source facts',
      actions: this.actions,
    };
  }

  async repair({ verification }) {
    return {
      schemaVersion: '1.0',
      needsInput: true,
      question: `The composed presentation verifier reported ${verification?.summary ?? 'a failure'}. Provide a new bounded outline.`,
      summary: 'Do not guess a cross-format repair',
      actions: [],
    };
  }
}

export class CodeApiOfficeComposeV1Executor extends ExecutorAdapter {
  constructor({ transport, timeoutMs = 120_000, renderBin = 'soffice' }) {
    super();
    if (!transport || typeof transport.execute !== 'function') {
      throw new TypeError('CodeApiOfficeComposeV1Executor transport.execute is required');
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.renderBin = requiredString(renderBin, 'renderBin', 80);
  }

  async prepare({ itemId, task, signal }) {
    const contract = resolveComposeContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: [stableScriptWriteCommand(contract), actionCommand(contract, 'prepare', {})].join(' && '),
      signal,
    });
    const prepared = parseMarker(result.stdout, WORKER_MARKER, 'Office Compose preparation');
    return {
      ...prepared,
      operation: 'prepare',
      workspaceRoot: contract.workspaceRoot,
      outputPath: contract.outputPath,
      replayed: result.replayed,
    };
  }

  async execute({ itemId, action, task, signal }) {
    const contract = resolveComposeContract(task);
    const normalized = normalizeOfficeComposeAction(action);
    const operation = normalized.worker === 'office-compose.inspect.v1'
      ? 'inspect'
      : normalized.worker === 'office-compose.validate.v1'
        ? 'validate'
        : 'generate';
    const result = await this.#call({
      itemId,
      contract,
      command: actionCommand(contract, operation, normalized),
      signal,
    });
    const executed = parseMarker(result.stdout, WORKER_MARKER, 'Office Compose Worker');
    return { ...executed, action: normalized, replayed: result.replayed };
  }

  async verify({ itemId, task, signal }) {
    const contract = resolveComposeContract(task);
    const assertions = Buffer.from(
      JSON.stringify(acceptanceAssertionsForTask(task)),
      'utf8',
    ).toString('base64');
    const command = [
      environment([
        ['FILE_AGENT_MNT_DATA', '/mnt/data'],
        ['FILE_AGENT_OUTPUT_PATH', contract.outputPath],
        ['FILE_AGENT_SOURCE_FACTS_PATH', contract.sourceFactsPath],
        ['FILE_AGENT_MAPPING_PATH', contract.mappingPath],
        ['FILE_AGENT_VERIFICATION_PATH', contract.verificationPath],
        ['FILE_AGENT_RENDER_DIR', contract.renderDir],
        ['FILE_AGENT_RENDER_BIN', this.renderBin],
        ['FILE_AGENT_INPUTS_JSON_B64', Buffer.from(JSON.stringify(contract.inputs), 'utf8').toString('base64')],
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
    const contract = resolveComposeContract(task);
    const result = await this.#call({
      itemId,
      contract,
      command: `test -s ${shellQuote(contract.outputPath)}`,
      artifactPaths: [contract.outputPath],
      signal,
    });
    if (result.artifacts.length !== 1) {
      throw new ExecutorArtifactError('CodeAPI did not return exactly one Office Compose artifact');
    }
    const artifact = result.artifacts[0];
    if (
      artifact?.mimeType !== PPTX_MIME ||
      artifact?.name !== 'working.pptx' ||
      typeof artifact?.codeEnvRef?.storage_session_id !== 'string' ||
      typeof artifact?.codeEnvRef?.file_id !== 'string'
    ) {
      throw new ExecutorArtifactError('CodeAPI returned an incomplete Office Compose artifact reference');
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

export function getOfficeComposeTaskPaths(task) {
  const contract = resolveComposeContract(task);
  return {
    ...contract,
    scriptName: path.posix.basename(contract.scriptPath),
    verifierName: path.posix.basename(contract.verifierPath),
    outputName: path.posix.basename(contract.outputPath),
  };
}

export function getOfficeComposeScriptDigests() {
  return {
    workerVersion: OFFICE_COMPOSE_WORKER_VERSION,
    workerSha256: sha256(WORKER_SCRIPT),
    verifierProfile: OFFICE_COMPOSE_VERIFIER_PROFILE,
    verifierVersion: OFFICE_COMPOSE_VERIFIER_VERSION,
    verifierSha256: sha256(VERIFIER_SCRIPT),
    capabilityProfile: OFFICE_COMPOSE_CAPABILITY_PROFILE,
    artifactLogicalId: OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID,
  };
}

export function getOfficeComposeWorkerSource() {
  return WORKER_SCRIPT;
}

export function getOfficeComposeVerifierSource() {
  return VERIFIER_SCRIPT;
}
