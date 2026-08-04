import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import {
  CodeApiPptxV1Executor,
  DeterministicPptxProvider,
  getPptxScriptDigests,
  getPptxTaskPaths,
  normalizePptxAction,
  PPTX_MIME,
  PPTX_VERIFIER_PROFILE,
  PPTX_VERIFIER_VERSION,
} from '../src/deterministic-pptx-v1.js';
import { FileAgentRuntime, RuntimeShutdownError } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';
import { normalizePptxAcceptanceAssertions } from '../src/pptx-acceptance.js';
import { IsolatedCodeApiServer } from './isolated-codeapi.js';

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

async function createPresentation(filePath) {
  await runPython(
    'from pptx import Presentation\n'
      + 'from pptx.util import Inches\n'
      + 'from pptx.dml.color import RGBColor\n'
      + 'import base64,sys,tempfile\n'
      + 'image_data=base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")\n'
      + 'image_path=tempfile.mktemp(suffix=".png")\n'
      + 'open(image_path,"wb").write(image_data)\n'
      + 'presentation=Presentation()\n'
      + 'slide=presentation.slides.add_slide(presentation.slide_layouts[6])\n'
      + 'title=slide.shapes.add_textbox(Inches(1),Inches(0.5),Inches(8),Inches(0.6))\n'
      + 'title.name="TitleBox"\n'
      + 'title.text="Quarterly Report"\n'
      + 'title.text_frame.paragraphs[0].runs[0].font.bold=True\n'
      + 'title.text_frame.paragraphs[0].runs[0].font.color.rgb=RGBColor(0x12,0x34,0x56)\n'
      + 'body=slide.shapes.add_textbox(Inches(1),Inches(1.3),Inches(8),Inches(1))\n'
      + 'body.name="BodyBox"\n'
      + 'body.text="Keep this source text"\n'
      + 'table_shape=slide.shapes.add_table(2,2,Inches(1),Inches(3),Inches(5),Inches(1.2))\n'
      + 'table_shape.name="SummaryTable"\n'
      + 'table=table_shape.table\n'
      + 'table.cell(0,0).text="Metric"\n'
      + 'table.cell(0,1).text="Value"\n'
      + 'table.cell(1,0).text="Revenue"\n'
      + 'table.cell(1,1).text="10"\n'
      + 'picture=slide.shapes.add_picture(image_path,Inches(7),Inches(3),width=Inches(0.3),height=Inches(0.3))\n'
      + 'picture.name="Logo"\n'
      + 'second=presentation.slides.add_slide(presentation.slide_layouts[6])\n'
      + 'second_title=second.shapes.add_textbox(Inches(1),Inches(1),Inches(8),Inches(0.6))\n'
      + 'second_title.name="SecondTitle"\n'
      + 'second_title.text="Details"\n'
      + 'presentation.save(sys.argv[1])',
    [filePath],
  );
}

function pptxAction(worker, parameters, expectedChange, summary) {
  return normalizePptxAction({
    schemaVersion: '1.0',
    objective: 'Apply one bounded presentation change',
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

function manifest({ sessionId, fileId, inputHash, acceptanceAssertions }) {
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1.2',
    taskType: 'office_transform',
    intent: 'Apply a verified presentation change to the authorized deck',
    acceptance: ['Return one verified PPTX artifact'],
    acceptanceAssertions,
    model: {
      modelRouteId: 'file-agent-pptx-test',
      capabilityProfile: 'pptx-edit-v1',
    },
    execution: {
      executor: 'codeapi',
      sessionId,
      workspaceRoot: '/mnt/data/.agent/{taskId}',
    },
    inputs: [{
      logicalName: 'source.pptx',
      mimeType: PPTX_MIME,
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
  const rootDir = suppliedRootDir ?? await mkdtemp(path.join(tmpdir(), 'file-agent-pptx-v1-'));
  const fixturePath = path.join(rootDir, 'source.pptx');
  await createPresentation(fixturePath);
  if (unsupported) {
    await runPython(
      'import sys,zipfile\nsource=sys.argv[1]\nwith zipfile.ZipFile(source,"a") as package: package.writestr("ppt/externalLinks/externalLink1.xml", b"unsupported")',
      [fixturePath],
    );
  }
  const source = await readFile(fixturePath);
  const codeApi = await new IsolatedCodeApiServer(path.join(rootDir, 'codeapi')).start();
  const sessionId = 'pptx-v1-isolated-session';
  const fileId = 'pptx-v1-input';
  await codeApi.registerFile({ sessionId, fileId, name: 'source.pptx', sourcePath: fixturePath });
  const actions = [
    pptxAction('pptx.transform.v1', {
      operation: 'replace_text',
      slide: 1,
      shape: 'TitleBox',
      value: 'Updated Report',
    }, ['slide1.TitleBox'], 'Update the presentation title'),
    pptxAction('pptx.transform.v1', {
      operation: 'set_table_cell',
      slide: 1,
      shape: 'SummaryTable',
      row: 2,
      column: 2,
      value: '20',
    }, ['slide1.SummaryTable.2.2'], 'Update the revenue value'),
    pptxAction('pptx.transform.v1', {
      operation: 'add_slide',
      layoutIndex: 0,
      title: 'Appendix',
    }, ['slide3'], 'Add the appendix slide'),
    pptxAction('pptx.validate.v1', {
      operation: 'validate',
    }, ['presentation.valid'], 'Validate the final presentation'),
  ];
  const acceptanceAssertions = [
    { type: 'pptx.text_value.v1', slide: 1, shape: 'TitleBox', value: 'Updated Report' },
    { type: 'pptx.table_cell_value.v1', slide: 1, shape: 'SummaryTable', row: 2, column: 2, value: '20' },
    { type: 'pptx.slide_present.v1', slide: 3 },
  ];
  const effectiveActions = suppliedActions ?? actions;
  const effectiveAcceptanceAssertions = suppliedAcceptanceAssertions ?? acceptanceAssertions;
  const store = new FileTaskStore(path.join(rootDir, 'runtime'));
  const executor = new CodeApiPptxV1Executor({
    transport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
  });
  const runtime = new FileAgentRuntime({
    store,
    provider: new DeterministicPptxProvider({ actions: effectiveActions }),
    executor,
    testHooks,
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    await codeApi.stop();
    if (!suppliedRootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
  return {
    codeApi,
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

test('PPTX v1 creates, modifies, verifies, renders, and publishes one presentation', async (t) => {
  const harness = await createHarness(t);
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'pptx-v1-complete',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 45_000 },
  );

  assert.equal(completed.planRevision, 2);
  assert.equal(completed.verification.passed, true);
  assert.equal(completed.verification.profile, PPTX_VERIFIER_PROFILE);
  assert.equal(completed.verification.profileVersion, PPTX_VERIFIER_VERSION);
  assert.equal(completed.verification.metrics.slideCount, 3);
  assert.equal(completed.verification.metrics.mediaCount, 1);
  assert.equal(completed.verification.metrics.renderedPages, 3);
  assert.equal(completed.result.artifacts.length, 1);
  assert.equal(completed.result.artifacts[0].name, 'working.pptx');
  assert.equal(completed.result.artifacts[0].mimeType, PPTX_MIME);
  assert.ok(completed.events.some((event) => event.item?.kind === 'pptx.inspect.v1'));
  assert.ok(completed.events.some((event) => event.item?.kind === 'pptx.transform.v1'));

  const paths = getPptxTaskPaths(completed);
  const outputPath = harness.codeApi.virtualPath(harness.sessionId, paths.outputPath);
  const presentation = JSON.parse(await runPython(
    'import json,sys\nfrom pptx import Presentation\np=Presentation(sys.argv[1])\nprint(json.dumps({"slides":len(p.slides),"title":p.slides[0].shapes[0].text,"body":p.slides[0].shapes[1].text,"cell":p.slides[0].shapes[2].table.cell(1,1).text,"bold":p.slides[0].shapes[0].text_frame.paragraphs[0].runs[0].font.bold,"appendix":p.slides[2].shapes[0].text}))',
    [outputPath],
  ));
  assert.equal(presentation.slides, 3);
  assert.equal(presentation.title, 'Updated Report');
  assert.equal(presentation.body, 'Keep this source text');
  assert.equal(presentation.cell, '20');
  assert.equal(presentation.bold, true);
  assert.equal(presentation.appendix, 'Appendix');

  const historyPath = harness.codeApi.virtualPath(harness.sessionId, paths.historyPath);
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  assert.equal(history.length, 3);
  assert.equal(history[0].workerVersion, 'pptx-worker-v1.0.0');
  assert.equal(history.at(-1).afterSha256, completed.verification.artifact.sha256);
  assert.deepEqual(getPptxScriptDigests(), {
    workerVersion: 'pptx-worker-v1.0.0',
    workerSha256: getPptxScriptDigests().workerSha256,
    verifierProfile: 'pptx-structure-v1',
    verifierVersion: '1.0.0',
    verifierSha256: getPptxScriptDigests().verifierSha256,
    capabilityProfile: 'pptx-edit-v1',
    artifactLogicalId: 'candidate:working-pptx',
  });
  for (const request of harness.codeApi.requests) {
    assert.equal(harness.codeApi.executionCount(request.item_id), 1);
  }
});

test('PPTX slide order is independently verified', async (t) => {
  const harness = await createHarness(t, {
    actions: [pptxAction('pptx.transform.v1', {
      operation: 'reorder_slides',
      order: [2, 1],
    }, ['slide-order'], 'Move the detail slide before the report slide')],
    acceptanceAssertions: [
      { type: 'pptx.slide_order.v1', order: [2, 1] },
    ],
  });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'pptx-v1-reorder',
    manifest: harness.manifest,
  });
  const completed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 45_000 },
  );
  assert.equal(completed.verification.passed, true);
  assert.ok(completed.verification.passedAssertionCodes.includes('pptx.required_changes.applied'));
});

test('PPTX verifier rejects an unauthorized text or table change', async (t) => {
  const harness = await createHarness(t, {
    actions: [pptxAction('pptx.transform.v1', {
      operation: 'replace_text',
      slide: 1,
      shape: 'BodyBox',
      value: 'UNAUTHORIZED',
    }, ['slide1.BodyBox'], 'Attempt to change unrelated text')],
    acceptanceAssertions: [
      { type: 'pptx.text_value.v1', slide: 1, shape: 'TitleBox', value: 'Quarterly Report' },
    ],
  });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'pptx-v1-unauthorized-text',
    manifest: harness.manifest,
  });
  const failed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'needs_input',
    { timeoutMs: 45_000 },
  );
  assert.equal(failed.verification.passed, false);
  assert.ok(failed.verification.failedAssertions.some(
    (entry) => entry.code === 'pptx.source_values.traceable',
  ));
});

test('PPTX validate materializes a candidate and replays idempotently after Runtime restart', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-pptx-v1-restart-'));
  let interrupted = false;
  const first = await createHarness(t, {
    rootDir,
    actions: [pptxAction('pptx.validate.v1', {
      operation: 'validate',
    }, ['presentation.valid'], 'Validate the prepared presentation')],
    acceptanceAssertions: [
      { type: 'pptx.slide_present.v1', slide: 1 },
    ],
    testHooks: {
      afterItemOperation({ kind }) {
        if (!interrupted && kind === 'pptx.validate.v1') {
          interrupted = true;
          throw new RuntimeShutdownError('Injected checkpoint after PPTX validation');
        }
      },
    },
  });
  const submitted = await first.runtime.submit({
    idempotencyKey: 'pptx-v1-restart',
    manifest: first.manifest,
  });
  const interruptedTask = await first.runtime.waitFor(
    submitted.task.taskId,
    (task) => interrupted && task.activeItem?.kind === 'pptx.validate.v1',
    { timeoutMs: 45_000 },
  );
  const replayedItemId = interruptedTask.activeItem.itemId;
  await first.runtime.stop();

  const secondRuntime = new FileAgentRuntime({
    store: new FileTaskStore(path.join(rootDir, 'runtime')),
    provider: new DeterministicPptxProvider(),
    executor: new CodeApiPptxV1Executor({
      transport: new CodeApiHttpTransport({ baseUrl: first.codeApi.baseUrl }),
    }),
  });
  await secondRuntime.start();
  t.after(async () => {
    await secondRuntime.stop();
    await first.codeApi.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const completed = await secondRuntime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'completed',
    { timeoutMs: 45_000 },
  );
  assert.equal(completed.verification.passed, true);
  assert.equal(completed.itemResults[replayedItemId].replayed, true);
  assert.equal(first.codeApi.executionCount(replayedItemId), 1);
  assert.equal(first.codeApi.requests.filter((request) => request.item_id === replayedItemId).length, 2);
  assert.equal(completed.result.artifacts.length, 1);
});

test('PPTX unsupported OOXML fails before model planning and delivery', async (t) => {
  const harness = await createHarness(t, { unsupported: true });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'pptx-v1-unsupported',
    manifest: harness.manifest,
  });
  const failed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'failed',
    { timeoutMs: 20_000 },
  );
  assert.equal(failed.error.code, 'PPTX_UNSUPPORTED_FEATURE');
  assert.match(failed.error.summary, /unsupported/i);
  assert.equal(harness.codeApi.requests.length, 1);
  assert.equal(Object.keys(failed.itemResults).some((itemId) => itemId.includes(':plan:')), false);
});

test('PPTX patch rejects a stale candidate hash', async (t) => {
  const harness = await createHarness(t, {
    actions: [pptxAction('pptx.patch.v1', {
      operation: 'replace_text',
      slide: 1,
      shape: 'TitleBox',
      value: 'stale',
      expectedBaseSha256: 'a'.repeat(64),
    }, ['title'], 'Reject stale patch')],
    acceptanceAssertions: [
      { type: 'pptx.text_value.v1', slide: 1, shape: 'TitleBox', value: 'stale' },
    ],
  });
  const submitted = await harness.runtime.submit({
    idempotencyKey: 'pptx-v1-stale-patch',
    manifest: harness.manifest,
  });
  const failed = await harness.runtime.waitFor(
    submitted.task.taskId,
    (task) => task.status === 'failed',
    { timeoutMs: 30_000 },
  );
  assert.equal(failed.error.code, 'PPTX_BASE_HASH_MISMATCH');
});

test('PPTX acceptance requires a business assertion and one artifact', () => {
  assert.throws(
    () => normalizePptxAcceptanceAssertions([
      { type: 'pptx.artifact.v1' },
    ]),
    /independent presentation assertion/,
  );
  assert.throws(
    () => normalizePptxAcceptanceAssertions([
      { type: 'pptx.slide_order.v1', order: [1, 1] },
    ]),
    /must not contain duplicate/,
  );
});
