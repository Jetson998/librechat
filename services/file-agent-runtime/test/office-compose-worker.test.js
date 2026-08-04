import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import {
  CodeApiOfficeComposeV1Executor,
  DeterministicOfficeComposeProvider,
  getOfficeComposeTaskPaths,
  normalizeOfficeComposeAction,
  OFFICE_COMPOSE_VERIFIER_PROFILE,
} from '../src/deterministic-office-compose-v1.js';
import {
  OFFICE_COMPOSE_ACCEPTANCE_TYPES,
  normalizeOfficeComposeAcceptanceAssertions,
} from '../src/office-compose-acceptance.js';
import { FileAgentRuntime, validateTaskManifest } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';
import { IsolatedCodeApiServer } from './isolated-codeapi.js';
import { writeWordFixture } from './word-fixtures.js';

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

async function writeSourceWorkbook(filePath) {
  await runPython(
    'from openpyxl import Workbook\nimport sys\nwb=Workbook()\nws=wb.active\nws.title="Source"\nws["A1"]="January"\nws["B1"]=100\nwb.save(sys.argv[1])',
    [filePath],
  );
}

function composeAction(slides) {
  return normalizeOfficeComposeAction({
    schemaVersion: '1.0',
    objective: 'Compose a bounded source summary without copying the source document into the plan',
    worker: 'office-compose.generate.v1',
    inputRefs: ['input:office-sources'],
    targetRef: 'candidate:working-pptx',
    parameters: {
      operation: 'generate',
      title: 'Office Source Summary',
      slides,
    },
    expectedChange: ['one complete PPTX', 'source values remain traceable'],
    verificationProfile: OFFICE_COMPOSE_VERIFIER_PROFILE,
    onFailure: 'replan',
    summary: 'Compose one complete PPTX from frozen source facts',
  });
}

function sourceValueAssertion({ sourceLogicalId, sourceLocation, targetSlide, value }) {
  return {
    type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_VALUE,
    sourceLogicalId,
    sourceLocation,
    targetSlide,
    targetShape: 'body',
    value,
  };
}

function sourceMappingAssertion({ sourceLogicalId, sourceLocation, targetSlide }) {
  return {
    type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_MAPPING,
    sourceLogicalId,
    sourceLocation,
    targetSlide,
    targetShape: 'body',
  };
}

async function createHarness(t, { includeWorkbook, includeWord }) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-compose-v1-'));
  const sourcePaths = [];
  if (includeWorkbook) {
    const filePath = path.join(rootDir, 'source.xlsx');
    await writeSourceWorkbook(filePath);
    sourcePaths.push({
      filePath,
      logicalName: 'source.xlsx',
      logicalId: 'source:finance',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      location: 'Source!A1',
      value: 'January',
    });
  }
  if (includeWord) {
    const filePath = path.join(rootDir, 'source.docx');
    await writeWordFixture(filePath, 'normal');
    sourcePaths.push({
      filePath,
      logicalName: 'source.docx',
      logicalId: 'source:brief',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      location: 'body.paragraph[0]',
      value: 'Source paragraph',
    });
  }
  const codeApi = await new IsolatedCodeApiServer(path.join(rootDir, 'codeapi')).start();
  const sessionId = 'compose-v1-isolated-session';
  for (const [index, source] of sourcePaths.entries()) {
    await codeApi.registerFile({
      sessionId,
      fileId: `compose-input-${index + 1}`,
      name: source.logicalName,
      sourcePath: source.filePath,
    });
  }
  const sourceBuffers = await Promise.all(sourcePaths.map((source) => readFile(source.filePath)));
  const slides = sourcePaths.map((source, index) => ({
    title: index === 0 ? 'Source Facts' : `Source Facts ${index + 1}`,
    bullets: [{
      sourceLogicalId: source.logicalId,
      sourceLocation: source.location,
      label: source.logicalId,
    }],
  }));
  const acceptance = [
    ...sourcePaths.flatMap((source, index) => [
      {
        type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_HASH,
        sourceLogicalId: source.logicalId,
        sha256: sha256(sourceBuffers[index]),
      },
      sourceMappingAssertion({
        sourceLogicalId: source.logicalId,
        sourceLocation: source.location,
        targetSlide: index + 1,
      }),
      sourceValueAssertion({
        sourceLogicalId: source.logicalId,
        sourceLocation: source.location,
        targetSlide: index + 1,
        value: source.value,
      }),
    ]),
    ...sourcePaths.map((source, index) => ({
      type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SECTION_PRESENT,
      slide: index + 1,
      title: index === 0 ? 'Source Facts' : `Source Facts ${index + 1}`,
    })),
  ];
  const normalizedAcceptance = normalizeOfficeComposeAcceptanceAssertions(acceptance);
  const store = new FileTaskStore(path.join(rootDir, 'runtime'));
  const executor = new CodeApiOfficeComposeV1Executor({
    transport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
  });
  const runtime = new FileAgentRuntime({
    store,
    provider: new DeterministicOfficeComposeProvider({ actions: [composeAction(slides)] }),
    executor,
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
    inputHash: sourceBuffers.map((source) => sha256(source)),
    manifest: {
      schemaVersion: '1.0',
      taskContractVersion: 'office-file-agent.v1.2',
      taskType: 'office_transform',
      intent: 'Compose a source-backed executive summary presentation',
      acceptance: ['Return one verified PPTX with source mappings'],
      acceptanceAssertions: normalizedAcceptance,
      model: {
        modelRouteId: 'file-agent-compose-test',
        capabilityProfile: 'office-compose-v1',
      },
      execution: {
        executor: 'codeapi',
        sessionId,
        workspaceRoot: '/mnt/data/.agent/{taskId}',
      },
      inputs: sourcePaths.map((source, index) => ({
        logicalName: source.logicalName,
        logicalId: source.logicalId,
        mimeType: source.mimeType,
        sha256: sha256(sourceBuffers[index]),
        codeEnvRef: {
          storage_session_id: sessionId,
          file_id: `compose-input-${index + 1}`,
        },
      })),
      limits: { maxVisibleArtifacts: 1 },
    },
    runtime,
    store,
  };
}

for (const scenario of [
  { name: 'XLSX to PPTX', includeWorkbook: true, includeWord: false },
  { name: 'DOCX to PPTX', includeWorkbook: false, includeWord: true },
  { name: 'XLSX plus DOCX to PPTX', includeWorkbook: true, includeWord: true },
]) {
  test(`Office Compose v1 supports ${scenario.name}`, async (t) => {
    const harness = await createHarness(t, scenario);
    const submitted = await harness.runtime.submit({
      idempotencyKey: `compose-${scenario.name}`,
      manifest: harness.manifest,
    });
    const completed = await harness.runtime.waitFor(
      submitted.task.taskId,
      (task) => ['completed', 'failed', 'needs_input'].includes(task.status),
      { timeoutMs: 45_000 },
    );
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
    assert.equal(completed.verification.passed, true);
    assert.equal(completed.verification.profile, OFFICE_COMPOSE_VERIFIER_PROFILE);
    assert.equal(completed.result.artifacts.length, 1);
    assert.equal(completed.result.artifacts[0].name, 'working.pptx');
    assert.equal(completed.result.artifacts[0].mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.equal(completed.verification.metrics.sourceCount, scenario.includeWorkbook && scenario.includeWord ? 2 : 1);
    assert.ok(completed.events.some((event) => event.item?.kind === 'office-compose.inspect.v1'));
    assert.ok(completed.events.some((event) => event.item?.kind === 'office-compose.generate.v1'));
    const paths = getOfficeComposeTaskPaths(completed);
    assert.match(paths.sourceFactsPath, /source-facts\.json$/);
    assert.equal(harness.codeApi.executionCount(`${completed.taskId}:execute:1:0`), 1);
  });
}

test('Office Compose acceptance rejects unsafe target shapes and unauthorized sources before execution', () => {
  assert.throws(
    () => normalizeOfficeComposeAcceptanceAssertions([{
      type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_VALUE,
      sourceLogicalId: 'source:missing',
      sourceLocation: 'Source!Z99',
      targetSlide: 1,
      targetShape: 'notes',
      value: 'not present',
    }]),
    /title or body/,
  );
  assert.throws(
    () => validateTaskManifest({
      schemaVersion: '1.0',
      taskContractVersion: 'office-file-agent.v1.2',
      taskType: 'office_transform',
      intent: 'Compose a presentation',
      model: { capabilityProfile: 'office-compose-v1' },
      inputs: [{
        logicalId: 'source:known',
        logicalName: 'source.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha256: 'a'.repeat(64),
      }],
      acceptanceAssertions: [{
        type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_VALUE,
        sourceLogicalId: 'source:missing',
        sourceLocation: 'Source!A1',
        targetSlide: 1,
        targetShape: 'body',
        value: 'missing',
      }],
    }),
    /unauthorized source/,
  );
});
