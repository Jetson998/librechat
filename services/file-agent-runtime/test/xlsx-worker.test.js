import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import {
  CodeApiXlsxV1Executor,
  DeterministicXlsxProvider,
  getXlsxScriptDigests,
  getXlsxTaskPaths,
  normalizeXlsxAction,
  XLSX_MIME,
  XLSX_VERIFIER_PROFILE,
  XLSX_VERIFIER_VERSION,
} from '../src/deterministic-xlsx-v1.js';
import { FileAgentRuntime, RuntimeShutdownError } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';
import { IsolatedCodeApiServer } from './isolated-codeapi.js';
import { normalizeXlsxAcceptanceAssertions } from '../src/xlsx-acceptance.js';

function runPython(source, args = []) {
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', source, ...args], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createWorkbook(filePath) {
  await runPython(
    'from openpyxl import Workbook\nfrom openpyxl.styles import Font\nfrom openpyxl.workbook.defined_name import DefinedName\nimport sys\nwb=Workbook()\nws=wb.active\nws.title="Source"\nws.append(["Month", "Amount", "Double"])\nws.append(["Jan", 10, "=B2*2"])\nws.append(["Feb", 20, "=B3*2"])\nws["A1"].font=Font(bold=True)\nws["B2"].number_format="0.00"\nwb.create_sheet("Config")\nwb["Config"]["A1"]="DO NOT CHANGE"\nwb.defined_names.add(DefinedName("SourceAmount", attr_text="Source!$B$2:$B$3"))\nwb.save(sys.argv[1])',
    [filePath],
  );
}

function xlsxAction(worker, parameters, expectedChange, summary) {
  return normalizeXlsxAction({
    schemaVersion: '1.0',
    objective: 'Apply one bounded workbook change',
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

function manifest({ sessionId, fileId, inputHash, acceptanceAssertions }) {
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1.2',
    taskType: 'office_transform',
    intent: 'Add a verified summary sheet to the authorized workbook',
    acceptance: ['Return one verified XLSX artifact'],
    acceptanceAssertions,
    model: {
      modelRouteId: 'file-agent-xlsx-test',
      capabilityProfile: 'xlsx-edit-v1',
    },
    execution: {
      executor: 'codeapi',
      sessionId,
      workspaceRoot: '/mnt/data/.agent/{taskId}',
    },
    inputs: [{
      logicalName: 'source.xlsx',
      mimeType: XLSX_MIME,
      sha256: inputHash,
      codeEnvRef: {
        storage_session_id: sessionId,
        file_id: fileId,
      },
    }],
    limits: { maxVisibleArtifacts: 1 },
  };
}

async function createHarness(
  t,
  {
    unsupported = false,
    actions: suppliedActions = null,
    acceptanceAssertions: suppliedAcceptanceAssertions = null,
    testHooks = null,
    rootDir: suppliedRootDir = null,
  } = {},
) {
  const rootDir = suppliedRootDir ?? await mkdtemp(path.join(tmpdir(), 'file-agent-xlsx-v1-'));
  const fixturePath = path.join(rootDir, 'source.xlsx');
  await createWorkbook(fixturePath);
  if (unsupported) {
    await runPython(
      'import sys,zipfile\nsource=sys.argv[1]\nwith zipfile.ZipFile(source,"a") as package: package.writestr("xl/vbaProject.bin", b"unsupported")',
      [fixturePath],
    );
  }
  const source = await readFile(fixturePath);
  const codeApi = await new IsolatedCodeApiServer(path.join(rootDir, 'codeapi')).start();
  const sessionId = 'xlsx-v1-isolated-session';
  const fileId = 'xlsx-v1-input';
  await codeApi.registerFile({ sessionId, fileId, name: 'source.xlsx', sourcePath: fixturePath });
  const actions = [
    xlsxAction('xlsx.transform.v1', {
      operation: 'add_sheet',
      sheet: 'Summary',
    }, ['workbook.sheet'], 'Create the summary sheet'),
    xlsxAction('xlsx.transform.v1', {
      operation: 'set_cell',
      sheet: 'Summary',
      cell: 'A1',
      value: 'Monthly Report',
    }, ['Summary.A1'], 'Write the summary title'),
    xlsxAction('xlsx.transform.v1', {
      operation: 'set_formula',
      sheet: 'Summary',
      cell: 'B1',
      formula: '=SUM(Source!B2:B3)',
    }, ['Summary.B1'], 'Write the summary formula'),
    xlsxAction('xlsx.transform.v1', {
      operation: 'set_number_format',
      sheet: 'Summary',
      cell: 'B1',
      numberFormat: '0.00',
    }, ['Summary.B1.number_format'], 'Set the summary number format'),
  ];
  const acceptanceAssertions = [
    { type: 'xlsx.sheet_present.v1', sheet: 'Summary' },
    { type: 'xlsx.cell_value.v1', sheet: 'Summary', cell: 'A1', value: 'Monthly Report' },
    { type: 'xlsx.formula.v1', sheet: 'Summary', cell: 'B1', formula: '=SUM(Source!B2:B3)' },
    { type: 'xlsx.number_format.v1', sheet: 'Summary', cell: 'B1', numberFormat: '0.00' },
    { type: 'xlsx.protected_cell.v1', sheet: 'Config', cell: 'A1', value: 'DO NOT CHANGE' },
  ];
  const effectiveActions = suppliedActions ?? actions;
  const effectiveAcceptanceAssertions = suppliedAcceptanceAssertions ?? acceptanceAssertions;
  const store = new FileTaskStore(path.join(rootDir, 'runtime'));
  const executor = new CodeApiXlsxV1Executor({
    transport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
  });
  const runtime = new FileAgentRuntime({
    store,
    provider: new DeterministicXlsxProvider({ actions: effectiveActions }),
    executor,
    testHooks,
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await codeApi.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  return {
    codeApi,
    executor,
    fileId,
    fixturePath,
    inputHash: sha256(source),
    manifest: manifest({
      sessionId,
      fileId,
      inputHash: sha256(source),
      acceptanceAssertions: effectiveAcceptanceAssertions,
    }),
    rootDir,
    runtime,
    sessionId,
    source,
    store,
  };
}

test('XLSX v1 creates, modifies, verifies, renders, and publishes one workbook', async (t) => {
  const harness = await createHarness(t);
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'xlsx-v1-complete',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 30_000 },
  );

  assert.equal(completed.planRevision, 2);
  assert.equal(completed.verification.passed, true);
  assert.equal(completed.verification.profile, XLSX_VERIFIER_PROFILE);
  assert.equal(completed.verification.profileVersion, XLSX_VERIFIER_VERSION);
  assert.equal(completed.result.artifacts.length, 1);
  assert.equal(completed.result.artifacts[0].name, 'working.xlsx');
  assert.equal(completed.result.artifacts[0].mimeType, XLSX_MIME);
  assert.ok(completed.events.some((event) => event.item?.kind === 'xlsx.inspect.v1'));
  assert.ok(completed.events.some((event) => event.item?.kind === 'xlsx.transform.v1'));

  const paths = getXlsxTaskPaths(completed);
  const outputPath = harness.codeApi.virtualPath(harness.sessionId, paths.outputPath);
  const workbook = JSON.parse(await runPython(
    'import json,sys\nfrom openpyxl import load_workbook\nwb=load_workbook(sys.argv[1],data_only=False)\nprint(json.dumps({"sheets":wb.sheetnames,"title":wb["Summary"]["A1"].value,"formula":wb["Summary"]["B1"].value,"format":wb["Summary"]["B1"].number_format,"protected":wb["Config"]["A1"].value,"sourceFormula":wb["Source"]["C2"].value}))',
    [outputPath],
  ));
  assert.deepEqual(workbook.sheets, ['Source', 'Config', 'Summary']);
  assert.equal(workbook.title, 'Monthly Report');
  assert.equal(workbook.formula, '=SUM(Source!B2:B3)');
  assert.equal(workbook.format, '0.00');
  assert.equal(workbook.protected, 'DO NOT CHANGE');
  assert.equal(workbook.sourceFormula, '=B2*2');

  const historyPath = harness.codeApi.virtualPath(harness.sessionId, paths.historyPath);
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  assert.equal(history.length, 4);
  assert.equal(history[0].workerVersion, 'xlsx-worker-v1.0.0');
  assert.equal(history.at(-1).afterSha256, completed.verification.artifact.sha256);
  assert.deepEqual(getXlsxScriptDigests(), {
    workerVersion: 'xlsx-worker-v1.0.0',
    workerSha256: getXlsxScriptDigests().workerSha256,
    verifierProfile: 'xlsx-structure-v1',
    verifierVersion: '1.0.0',
    verifierSha256: getXlsxScriptDigests().verifierSha256,
    capabilityProfile: 'xlsx-edit-v1',
    artifactLogicalId: 'candidate:working-xlsx',
  });
  for (const request of harness.codeApi.requests) {
    assert.equal(harness.codeApi.executionCount(request.item_id), 1);
  }
});

test('XLSX acceptance requires a real workbook change and supports Sheet-only changes', async (t) => {
  assert.throws(
    () => normalizeXlsxAcceptanceAssertions([
      { type: 'xlsx.protected_cell.v1', sheet: 'Config', cell: 'A1', value: 'DO NOT CHANGE' },
    ]),
    /independent workbook assertion/,
  );

  const harness = await createHarness(t, {
    actions: [xlsxAction('xlsx.transform.v1', {
      operation: 'add_sheet',
      sheet: 'Summary',
    }, ['workbook.sheet'], 'Create the summary sheet')],
    acceptanceAssertions: [
      { type: 'xlsx.sheet_present.v1', sheet: 'Summary' },
    ],
  });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'xlsx-v1-sheet-only',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 30_000 },
  );

  assert.equal(completed.verification.passed, true);
  assert.ok(completed.verification.passedAssertionCodes.includes('xlsx.required_changes.applied'));
});

test('XLSX verifier rejects a changed protected cell', async (t) => {
  const harness = await createHarness(t, {
    actions: [xlsxAction('xlsx.transform.v1', {
      operation: 'set_cell',
      sheet: 'Config',
      cell: 'A1',
      value: 'CHANGED',
    }, ['Config.A1'], 'Attempt to change a protected cell')],
    acceptanceAssertions: [
      { type: 'xlsx.cell_value.v1', sheet: 'Source', cell: 'A1', value: 'Month' },
      { type: 'xlsx.protected_cell.v1', sheet: 'Config', cell: 'A1', value: 'DO NOT CHANGE' },
    ],
  });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'xlsx-v1-protected-cell',
    manifest: harness.manifest,
  });
  const failed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'needs_input',
    { timeoutMs: 30_000 },
  );

  assert.equal(failed.verification.passed, false);
  assert.ok(failed.verification.failedAssertions.some(
    (entry) => entry.code === 'xlsx.protected_regions.unchanged',
  ));
});

test('XLSX verifier rejects an unauthorized formula change', async (t) => {
  const harness = await createHarness(t, {
    actions: [xlsxAction('xlsx.transform.v1', {
      operation: 'set_formula',
      sheet: 'Source',
      cell: 'C2',
      formula: '=999',
    }, ['Source.C2'], 'Attempt to change an unrelated formula')],
    acceptanceAssertions: [
      { type: 'xlsx.cell_value.v1', sheet: 'Source', cell: 'A1', value: 'Month' },
    ],
  });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'xlsx-v1-unauthorized-formula',
    manifest: harness.manifest,
  });
  const failed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'needs_input',
    { timeoutMs: 30_000 },
  );

  assert.equal(failed.verification.passed, false);
  assert.ok(failed.verification.failedAssertions.some(
    (entry) => entry.code === 'xlsx.formulas.preserved',
  ));
});

test('XLSX validate action runs after inspect and is idempotent across Runtime restart', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-xlsx-v1-restart-'));
  let interrupted = false;
  const first = await createHarness(t, {
    rootDir,
    actions: [xlsxAction('xlsx.validate.v1', {
      operation: 'validate',
    }, ['workbook.valid'], 'Validate the prepared workbook')],
    acceptanceAssertions: [
      { type: 'xlsx.cell_value.v1', sheet: 'Source', cell: 'A1', value: 'Month' },
    ],
    testHooks: {
      afterItemOperation({ kind }) {
        if (!interrupted && kind === 'xlsx.validate.v1') {
          interrupted = true;
          throw new RuntimeShutdownError('Injected checkpoint after XLSX validation');
        }
      },
    },
  });
  const submitted = await first.runtime.submit({
    idempotencyKey: 'xlsx-v1-restart',
    manifest: first.manifest,
  });
  const interruptedTask = await first.runtime.waitFor(
    submitted.task.taskId,
    (task) => interrupted && task.activeItem?.kind === 'xlsx.validate.v1',
    { timeoutMs: 30_000 },
  );
  const replayedItemId = interruptedTask.activeItem.itemId;
  await first.runtime.stop();

  const secondRuntime = new FileAgentRuntime({
    store: new FileTaskStore(path.join(rootDir, 'runtime')),
    provider: new DeterministicXlsxProvider(),
    executor: new CodeApiXlsxV1Executor({
      transport: new CodeApiHttpTransport({ baseUrl: first.codeApi.baseUrl }),
    }),
  });
  await secondRuntime.start();
  t.after(async () => {
    await secondRuntime.stop();
  });
  const completed = await secondRuntime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 30_000 },
  );

  assert.equal(completed.verification.passed, true);
  assert.equal(completed.itemResults[replayedItemId].replayed, true);
  assert.equal(first.codeApi.executionCount(replayedItemId), 1);
  assert.equal(
    first.codeApi.requests.filter((request) => request.item_id === replayedItemId).length,
    2,
  );
  assert.equal(completed.result.artifacts.length, 1);
});

test('XLSX unsupported OOXML fails before model planning and file delivery', async (t) => {
  const harness = await createHarness(t, { unsupported: true });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'xlsx-v1-unsupported',
    manifest: harness.manifest,
  });
  const failed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'failed',
    { timeoutMs: 15_000 },
  );
  assert.equal(failed.error.code, 'XLSX_UNSUPPORTED_FEATURE');
  assert.match(failed.error.summary, /unsupported/i);
  assert.equal(harness.codeApi.requests.length, 1);
  assert.equal(harness.codeApi.requests[0].command.includes('xlsx_worker.py'), true);
  assert.equal(Object.keys(failed.itemResults).some((itemId) => itemId.includes(':plan:')), false);
});

test('XLSX actions reject unsafe references and patch hash mismatches', () => {
  assert.throws(
    () => normalizeXlsxAction({
      schemaVersion: '1.0',
      objective: 'unsafe',
      worker: 'xlsx.transform.v1',
      inputRefs: ['input:source-xlsx'],
      targetRef: 'candidate:working-xlsx',
      parameters: {
        operation: 'set_cell',
        sheet: 'Source',
        cell: 'A1',
        value: '/absolute/path',
      },
      expectedChange: ['cell'],
      verificationProfile: XLSX_VERIFIER_PROFILE,
      onFailure: 'replan',
      summary: 'unsafe',
    }),
    /absolute path or URL/,
  );
  assert.throws(
    () => normalizeXlsxAction({
      schemaVersion: '1.0',
      objective: 'patch',
      worker: 'xlsx.patch.v1',
      inputRefs: ['input:source-xlsx'],
      targetRef: 'candidate:working-xlsx',
      parameters: { operation: 'set_cell', sheet: 'Source', cell: 'A1', value: 'x' },
      expectedChange: ['cell'],
      verificationProfile: XLSX_VERIFIER_PROFILE,
      onFailure: 'replan',
      summary: 'patch',
    }),
    /requires expectedBaseSha256/,
  );
});
