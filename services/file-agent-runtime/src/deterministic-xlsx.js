import path from 'node:path';

import {
  ExecutorAdapter,
  ExecutorArtifactError,
  ExecutorProtocolError,
} from './executor-adapter.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PENDING_MARKER = '__PHASE1_PATCH_PENDING__';
const APPLIED_MARKER = '__PHASE1_PATCH_APPLIED__';
const VERIFY_MARKER = '__FILE_AGENT_VERIFY__';

const STABLE_SCRIPT = `import os
from pathlib import Path
from openpyxl import load_workbook

root = Path(os.environ.get("FILE_AGENT_MNT_DATA", "/mnt/data"))
source = root / os.environ["FILE_AGENT_INPUT"]
output = root / os.environ["FILE_AGENT_OUTPUT"]
workbook = load_workbook(source)
if "Agent Summary" in workbook.sheetnames:
    del workbook["Agent Summary"]
sheet = workbook.create_sheet("Agent Summary")
sheet["A1"] = "File Agent Runtime Phase 1"
sheet["A2"] = "Source workbook"
sheet["B2"] = source.name
sheet["A3"] = "Repair marker"
sheet["B3"] = "${PENDING_MARKER}"
output.parent.mkdir(parents=True, exist_ok=True)
workbook.save(output)
`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function pythonFromBase64(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `python3 -c ${shellQuote(`import base64;exec(base64.b64decode("${encoded}"))`)}`;
}

function safeRelativeFilename(filename) {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new TypeError('XLSX input filename is required');
  }
  const normalized = filename.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => ['.', '..', ''].includes(part))) {
    throw new TypeError('XLSX input filename must be a safe relative path');
  }
  if (!normalized.toLowerCase().endsWith('.xlsx')) {
    throw new TypeError('Phase 1 supports exactly one XLSX input');
  }
  return normalized;
}

function resolveTaskContract(task) {
  const inputs = task.manifest.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new TypeError('Phase 1 task must contain exactly one input');
  }
  const input = inputs[0];
  const filename = safeRelativeFilename(input.logicalName ?? input.filename);
  const codeEnvRef = input.codeEnvRef;
  if (
    !codeEnvRef ||
    typeof codeEnvRef.storage_session_id !== 'string' ||
    typeof codeEnvRef.file_id !== 'string'
  ) {
    throw new TypeError('Phase 1 XLSX input requires a CodeAPI codeEnvRef');
  }
  const configuredRoot = task.manifest.execution?.workspaceRoot;
  const workspaceRoot = (configuredRoot ?? `/mnt/data/.agent/${task.taskId}`)
    .replaceAll('{taskId}', task.taskId);
  if (!workspaceRoot.startsWith('/mnt/data/.agent/')) {
    throw new TypeError('Phase 1 workspaceRoot must be under /mnt/data/.agent');
  }
  const sessionId = task.manifest.execution?.sessionId ?? codeEnvRef.storage_session_id;
  if (sessionId !== codeEnvRef.storage_session_id) {
    throw new TypeError('Phase 1 input and execution session must match');
  }
  return {
    filename,
    sessionId,
    workspaceRoot,
    scriptPath: `${workspaceRoot}/scripts/transform_workbook.py`,
    outputPath: `${workspaceRoot}/output/phase1-output.xlsx`,
    injectedFiles: [
      {
        name: filename,
        storage_session_id: codeEnvRef.storage_session_id,
        file_id: codeEnvRef.file_id,
      },
    ],
  };
}

function executionEnvironment(contract) {
  return [
    `FILE_AGENT_MNT_DATA=${shellQuote('/mnt/data')}`,
    `FILE_AGENT_INPUT=${shellQuote(contract.filename)}`,
    `FILE_AGENT_OUTPUT=${shellQuote(contract.outputPath.slice('/mnt/data/'.length))}`,
  ].join(' ');
}

function parseVerification(stdout) {
  const markerIndex = stdout.lastIndexOf(VERIFY_MARKER);
  if (markerIndex < 0) {
    throw new ExecutorProtocolError('Workbook verification returned no result marker');
  }
  try {
    return JSON.parse(stdout.slice(markerIndex + VERIFY_MARKER.length).trim());
  } catch (error) {
    throw new ExecutorProtocolError('Workbook verification returned invalid JSON', { cause: error });
  }
}

export class DeterministicXlsxProvider {
  async plan() {
    return {
      needsInput: false,
      summary: 'Run the stable Phase 1 workbook transform',
      actions: [
        {
          kind: 'xlsx_transform',
          summary: 'Run the persisted workbook transform script',
        },
      ],
    };
  }

  async repair({ verification }) {
    return {
      needsInput: false,
      summary: 'Patch the stable script and rerun the same output path',
      actions: [
        {
          kind: 'xlsx_patch_and_transform',
          summary: `Apply one incremental patch: ${verification.summary}`,
        },
      ],
    };
  }
}

export class CodeApiXlsxExecutor extends ExecutorAdapter {
  constructor({ transport, timeoutMs = 120_000 }) {
    super();
    if (!transport || typeof transport.execute !== 'function') {
      throw new TypeError('CodeApiXlsxExecutor transport.execute is required');
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  async prepare({ itemId, task, signal }) {
    const contract = resolveTaskContract(task);
    const scriptRelative = contract.scriptPath.slice('/mnt/data/'.length);
    const writeScript = `import os\nfrom pathlib import Path\nimport base64\nroot = Path(os.environ.get("FILE_AGENT_MNT_DATA", "/mnt/data"))\npath = root / ${JSON.stringify(scriptRelative)}\npath.parent.mkdir(parents=True, exist_ok=True)\nif not path.exists():\n    path.write_bytes(base64.b64decode(${JSON.stringify(Buffer.from(STABLE_SCRIPT).toString('base64'))}))\n`;
    const result = await this.#call({
      itemId,
      contract,
      command: `FILE_AGENT_MNT_DATA=${shellQuote('/mnt/data')} ${pythonFromBase64(writeScript)}`,
      signal,
    });
    return {
      workspaceRoot: contract.workspaceRoot,
      scriptPath: contract.scriptPath,
      outputPath: contract.outputPath,
      replayed: result.replayed,
    };
  }

  async execute({ itemId, action, task, signal }) {
    const contract = resolveTaskContract(task);
    if (action.kind === 'xlsx_transform') {
      const command = `${executionEnvironment(contract)} python3 ${shellQuote(contract.scriptPath)}`;
      const result = await this.#call({ itemId, contract, command, signal });
      return {
        actionKind: action.kind,
        scriptPath: contract.scriptPath,
        outputPath: contract.outputPath,
        replayed: result.replayed,
      };
    }
    if (action.kind === 'xlsx_patch_and_transform') {
      const scriptRelative = contract.scriptPath.slice('/mnt/data/'.length);
      const patchScript = `import os\nfrom pathlib import Path\nroot = Path(os.environ.get("FILE_AGENT_MNT_DATA", "/mnt/data"))\npath = root / ${JSON.stringify(scriptRelative)}\nsource = path.read_text(encoding="utf-8")\nold = ${JSON.stringify(PENDING_MARKER)}\nnew = ${JSON.stringify(APPLIED_MARKER)}\nif source.count(old) != 1:\n    raise RuntimeError("stable script patch marker count must be exactly one")\npath.write_text(source.replace(old, new, 1), encoding="utf-8")\n`;
      const command = [
        `FILE_AGENT_MNT_DATA=${shellQuote('/mnt/data')} ${pythonFromBase64(patchScript)}`,
        `${executionEnvironment(contract)} python3 ${shellQuote(contract.scriptPath)}`,
      ].join(' && ');
      const result = await this.#call({ itemId, contract, command, signal });
      return {
        actionKind: action.kind,
        patch: { from: PENDING_MARKER, to: APPLIED_MARKER, replacements: 1 },
        scriptPath: contract.scriptPath,
        outputPath: contract.outputPath,
        replayed: result.replayed,
      };
    }
    throw new TypeError(`Unsupported Phase 1 action kind: ${action.kind}`);
  }

  async verify({ itemId, task, signal }) {
    const contract = resolveTaskContract(task);
    const verificationScript = `import json, os\nfrom pathlib import Path\nfrom openpyxl import load_workbook\nroot = Path(os.environ.get("FILE_AGENT_MNT_DATA", "/mnt/data"))\noutput = root / os.environ["FILE_AGENT_OUTPUT"]\nresult = {"passed": False, "summary": "Output workbook is missing"}\nif output.is_file():\n    workbook = load_workbook(output, read_only=True, data_only=False)\n    if "Agent Summary" not in workbook.sheetnames:\n        result = {"passed": False, "summary": "Agent Summary sheet is missing"}\n    else:\n        marker = workbook["Agent Summary"]["B3"].value\n        result = {"passed": marker == ${JSON.stringify(APPLIED_MARKER)}, "summary": "Incremental patch is required" if marker != ${JSON.stringify(APPLIED_MARKER)} else "Workbook structure and repair marker verified", "sheetCount": len(workbook.sheetnames), "repairMarker": marker}\nprint(${JSON.stringify(VERIFY_MARKER)} + json.dumps(result, ensure_ascii=False))\n`;
    const command = `${executionEnvironment(contract)} ${pythonFromBase64(verificationScript)}`;
    const result = await this.#call({ itemId, contract, command, signal });
    const verification = parseVerification(result.stdout);
    return { ...verification, replayed: result.replayed };
  }

  async publish({ itemId, task, signal }) {
    const contract = resolveTaskContract(task);
    const command = `test -f ${shellQuote(contract.outputPath)}`;
    const result = await this.#call({
      itemId,
      contract,
      command,
      artifactPaths: [contract.outputPath],
      signal,
    });
    if (result.artifacts.length !== 1) {
      throw new ExecutorArtifactError('CodeAPI did not return exactly one XLSX artifact');
    }
    const artifact = result.artifacts[0];
    if (
      artifact?.mimeType !== XLSX_MIME ||
      typeof artifact?.codeEnvRef?.storage_session_id !== 'string' ||
      typeof artifact?.codeEnvRef?.file_id !== 'string'
    ) {
      throw new ExecutorArtifactError('CodeAPI returned an incomplete XLSX artifact reference');
    }
    return {
      artifacts: [artifact],
      replayed: result.replayed,
    };
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

export function getPhase1TaskPaths(task) {
  const contract = resolveTaskContract(task);
  return {
    ...contract,
    scriptName: path.posix.basename(contract.scriptPath),
    outputName: path.posix.basename(contract.outputPath),
  };
}
