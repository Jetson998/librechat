const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../../..');
const apiIndexPath = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/api-index.cjs',
);
const baseClientPath = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/BaseClient.js',
);
const codeProcessPath = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/code-process.js',
);
const requestControllerPath = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/request.js',
);
const officePreparsePath = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-20-office-file-identity/office-context-patch/OfficePreparse.js',
);

const read = (file) => fs.readFileSync(file, 'utf8');

const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0, `Missing start marker: ${startMarker}`);
  assert(end > start, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

const loadHelpers = (invoke) => {
  const {
    MANIFEST_MARKER,
    buildParser,
    createOfficePreparse,
    getRegeneratedRequestFileIds,
    selectCurrentTurnOfficeFiles,
  } = require(officePreparsePath);
  const { prepareCurrentTurnOfficeContext } = createOfficePreparse({
    createBashExecutionTool: () => ({ invoke }),
    getCodeApiAuthHeaders: async () => ({ Authorization: 'Bearer test' }),
    logger: { debug: () => {} },
  });
  return {
    OFFICE_PREPARSE_MARKER: MANIFEST_MARKER,
    buildOfficePreparsePython: buildParser,
    getRegeneratedRequestFileIds,
    selectCurrentTurnOfficeFiles,
    prepareCurrentTurnOfficeContext,
  };
};

const currentFile = {
  file_id: 'mongo-current',
  filename: 'current.xlsx',
  metadata: {
    codeEnvRef: {
      file_id: 'code-current',
      storage_session_id: 'session-current',
    },
  },
};
const currentPrimed = {
  id: 'code-current',
  source_file_id: 'mongo-current',
  storage_session_id: 'session-current',
  name: 'current.xlsx',
  resource_id: 'user-1',
};
const historicalPrimed = {
  id: 'code-history',
  storage_session_id: 'session-history',
  name: 'history.docx',
  resource_id: 'user-1',
};

const testCurrentTurnIsolation = () => {
  const helpers = loadHelpers(async () => 'unused');
  const selected = helpers.selectCurrentTurnOfficeFiles(
    [currentFile, { file_id: 'note', filename: 'note.txt' }],
    [currentPrimed, historicalPrimed],
  );
  assert.deepStrictEqual(selected.map((item) => item.filename), ['current.xlsx']);
  assert.strictEqual(selected[0].primed, currentPrimed);
};

const testRotatedReferenceUsesFreshPrimedFile = () => {
  const helpers = loadHelpers(async () => 'unused');
  const rotated = {
    id: 'code-fresh',
    storage_session_id: 'session-fresh',
    name: 'current.xlsx',
    source_file_id: 'mongo-current',
  };
  const selected = helpers.selectCurrentTurnOfficeFiles([currentFile], [rotated, historicalPrimed]);
  assert.strictEqual(selected[0].primed.id, 'code-fresh');
  assert.strictEqual(selected[0].primed.storage_session_id, 'session-fresh');
};

const testStableIdentityHandlesDuplicateRefsAndNames = () => {
  const helpers = loadHelpers(async () => 'unused');
  const secondFile = { file_id: 'mongo-second', filename: 'current.xlsx' };
  const secondPrimed = {
    id: 'code-second',
    source_file_id: 'mongo-second',
    storage_session_id: 'session-second',
    name: 'current.xlsx',
  };
  const selected = helpers.selectCurrentTurnOfficeFiles(
    [currentFile, secondFile],
    [currentPrimed, { ...currentPrimed }, secondPrimed],
  );
  assert.deepStrictEqual(selected.map((item) => item.primed.id), ['code-current', 'code-second']);
};

const testAmbiguousLegacyFilenameBlocks = () => {
  const helpers = loadHelpers(async () => 'unused');
  const staleFile = {
    ...currentFile,
    file_id: 'mongo-unknown',
    metadata: { codeEnvRef: { file_id: 'stale', storage_session_id: 'stale-session' } },
  };
  assert.throws(
    () => helpers.selectCurrentTurnOfficeFiles(
      [staleFile],
      [
        { id: 'fresh-1', storage_session_id: 'session-1', name: 'current.xlsx' },
        { id: 'fresh-2', storage_session_id: 'session-2', name: 'current.xlsx' },
      ],
    ),
    /missing stable CodeAPI reference.*current\.xlsx/,
  );
};

const testProducerCarriesStableFileId = () => {
  const source = read(codeProcessPath);
  assert(source.includes('source_file_id: file.file_id'), 'primeFiles does not return the stable LibreChat file ID');
  assert(source.includes('id: overrideId ?? id'), 'primeFiles no longer emits the fresh CodeAPI file ID');
};

const testRegenerationRestoresParentFiles = () => {
  const source = read(apiIndexPath);
  assert(source.includes('office_preparse.getRegeneratedRequestFileIds'));
  assert(source.includes('isRegenerate: req.body?.isRegenerate'));
  assert(source.includes('Office regeneration could not resolve every file'));
  assert(source.includes('requestFileSet: new Set(currentRequestFiles.map((file) => file.file_id))'));
};

const testRegenerationSelectsOnlyParentUserFiles = () => {
  const helpers = loadHelpers(async () => 'unused');
  const ids = helpers.getRegeneratedRequestFileIds({
    isRegenerate: true,
    requestFiles: [],
    parentMessageId: 'user-parent',
    messages: [
      { messageId: 'older-user', isCreatedByUser: true, files: [{ file_id: 'older-file' }] },
      { messageId: 'assistant-parent', isCreatedByUser: false, files: [{ file_id: 'assistant-file' }] },
      {
        messageId: 'user-parent',
        isCreatedByUser: true,
        files: [{ file_id: 'current-file' }, { file_id: 'current-file' }],
      },
    ],
  });
  assert.deepStrictEqual(ids, ['current-file']);
};

const testControllerPropagatesAbortSignal = () => {
  const source = read(requestControllerPath);
  assert(source.includes('req.officePreparseSignal = job.abortController.signal'));
  assert(source.includes('delete req.officePreparseSignal'));
};

const testLiveBundlePreservesPricingSupport = () => {
  const source = read(apiIndexPath);
  assert(source.includes('CUSTOM_ENDPOINT_TOKEN_CONFIG_PATH'));
  assert(source.includes('toBillingTokenConfig'));
};

const testSuccessfulPreparse = async () => {
  let invocation;
  const manifest = {
    files: [
      {
        filename: 'current.xlsx',
        ok: true,
        kind: 'spreadsheet',
        sheets: [{ name: 'Data', preview_rows: 2 }],
        preview: '渠道 | 模型\nAWS | gpt-5.6-sol',
      },
    ],
  };
  const helpers = loadHelpers(async (args, config) => {
    invocation = { args, config };
    return { content: `stdout\n${helpers.OFFICE_PREPARSE_MARKER}${JSON.stringify(manifest)}` };
  });
  const context = await helpers.prepareCurrentTurnOfficeContext({
    req: { user: { id: 'user-1' } },
    requestFiles: [currentFile],
    primedCodeFiles: [currentPrimed, historicalPrimed],
  });
  assert(context.includes('<office_preparse_manifest>'));
  assert(context.includes('current.xlsx'));
  assert.strictEqual(invocation.config.toolCall.session_id, 'session-current');
  assert.deepStrictEqual(invocation.config.toolCall._injected_files, [currentPrimed]);
  assert(invocation.args.command.includes('python3 -c'));
};

const testParserAgainstOfficeFixtures = () => {
  const helpers = loadHelpers(async () => 'unused');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-office-preparse-'));
  const createFixtures = String.raw`
import os
from docx import Document
from openpyxl import Workbook
root = ${JSON.stringify('${FIXTURE_DIR}')}
document = Document()
document.add_paragraph('审计报告摘要')
document.save(os.path.join(root, 'sample.docx'))
workbook = Workbook()
sheet = workbook.active
sheet.title = '渠道数据'
sheet.append(['模型', 'gpt-5.6-sol'])
workbook.save(os.path.join(root, 'sample.xlsx'))
`.replace('${FIXTURE_DIR}', fixtureDir.replaceAll('\\', '\\\\'));
  const created = childProcess.spawnSync('python3', ['-c', createFixtures], { encoding: 'utf8' });
  assert.strictEqual(created.status, 0, created.stderr);

  const parser = helpers
    .buildOfficePreparsePython(['sample.docx', 'sample.xlsx'])
    .replace('os.path.join("/mnt/data", filename)', `os.path.join(${JSON.stringify(fixtureDir)}, filename)`);
  const parsed = childProcess.spawnSync('python3', ['-c', parser], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.strictEqual(parsed.status, 0, parsed.stderr);
  const markerIndex = parsed.stdout.lastIndexOf(helpers.OFFICE_PREPARSE_MARKER);
  assert(markerIndex >= 0, parsed.stdout);
  const manifest = JSON.parse(
    parsed.stdout.slice(markerIndex + helpers.OFFICE_PREPARSE_MARKER.length).trim(),
  );
  assert.strictEqual(manifest.files.length, 2);
  assert(manifest.files.every((file) => file.ok === true), JSON.stringify(manifest));
  assert(manifest.files[0].preview.includes('审计报告摘要'));
  assert(manifest.files[1].preview.includes('gpt-5.6-sol'));
  fs.rmSync(fixtureDir, { recursive: true, force: true });
};

const testNoFileBypass = async () => {
  let calls = 0;
  const helpers = loadHelpers(async () => {
    calls += 1;
  });
  const context = await helpers.prepareCurrentTurnOfficeContext({
    req: {},
    requestFiles: [],
    primedCodeFiles: [],
  });
  assert.strictEqual(context, undefined);
  assert.strictEqual(calls, 0);
};

const testFailureBlocks = async () => {
  const helpers = loadHelpers(async () => ({
    content:
      '__LIBRECHAT_OFFICE_MANIFEST__' +
      JSON.stringify({ files: [{ filename: 'current.xlsx', ok: false, error: 'corrupt zip' }] }),
  }));
  await assert.rejects(
    helpers.prepareCurrentTurnOfficeContext({
      req: {},
      requestFiles: [currentFile],
      primedCodeFiles: [currentPrimed],
    }),
    /current\.xlsx.*corrupt zip/,
  );
};

const testPreparseTimeout = async () => {
  const helpers = loadHelpers(() => new Promise(() => {}));
  await assert.rejects(
    helpers.prepareCurrentTurnOfficeContext({
      req: {},
      requestFiles: [currentFile],
      primedCodeFiles: [currentPrimed],
      timeoutMs: 5,
    }),
    /timed out after/,
  );
};

const testPreparseAbort = async () => {
  const controller = new AbortController();
  const helpers = loadHelpers(() => new Promise(() => {}));
  const pending = helpers.prepareCurrentTurnOfficeContext({
    req: { officePreparseSignal: controller.signal },
    requestFiles: [currentFile],
    primedCodeFiles: [currentPrimed],
  });
  controller.abort();
  await assert.rejects(pending, /aborted before completion/);
};

const testMissingReferenceBlocks = () => {
  const helpers = loadHelpers(async () => 'unused');
  assert.throws(
    () => helpers.selectCurrentTurnOfficeFiles([currentFile], []),
    /missing stable CodeAPI reference.*current\.xlsx/,
  );
};

const testIntegrationOrder = () => {
  const source = read(apiIndexPath);
  const initializeBlock = sliceBetween(source, 'async function initializeAgent(', '//#endregion');
  const loadIndex = initializeBlock.indexOf('const { toolRegistry');
  const preparseIndex = initializeBlock.indexOf('await prepareCurrentTurnOfficeContext');
  const optionsIndex = initializeBlock.indexOf('const { getOptions');
  assert(loadIndex >= 0, 'Tool loading marker is missing');
  assert(preparseIndex > loadIndex, 'Office pre-parse runs before CodeAPI files are primed');
  assert(optionsIndex > preparseIndex, 'Model provider initialization can start before Office pre-parse');
};

const testThinkingOnlyIsIncomplete = () => {
  const source = read(baseClientPath);
  const block = sliceBetween(
    source,
    'const hasSemanticContentPart =',
    'const hasAssistantSemanticContent =',
  );
  assert(
    /part\.type === ContentTypes\.THINK\) \{\s*return false;/.test(block),
    'Thinking-only content is still accepted as a final response',
  );
};

const testDeployRunnerContract = () => {
  const deployPath = path.join(
    repoRoot,
    'deployment/production-patches/2026-07-20-office-file-identity/scripts/deploy.sh',
  );
  const remoteApplyPath = path.join(
    repoRoot,
    'deployment/production-patches/2026-07-20-office-file-identity/scripts/remote-apply.sh',
  );
  const deploy = read(deployPath);
  const remoteApply = read(remoteApplyPath);
  assert(deploy.includes('release-governance:scoped-deployment'));
  assert(deploy.includes('release-governance:targets=LibreChat-API,LibreChat-CodeAPI'));
  assert(deploy.includes('release-governance:target-lock'));
  assert(deploy.includes('SSH_PASS'));
  assert(!deploy.includes('u72]!kWllc|q'), 'SSH password was written into the repository');
  assert(remoteApply.includes('--force-recreate api'));
  assert(!remoteApply.includes('docker restart LibreChat-CodeAPI'));
  assert(remoteApply.includes('/app/api/server/services/Files/Code/process.js'));
  assert(remoteApply.includes('/app/api/server/controllers/agents/request.js'));
  assert(remoteApply.includes('/app/api/server/services/Files/OfficePreparse.js'));
  assert(remoteApply.includes('docker exec LibreChat-API sha256sum'));
};

Promise.resolve()
  .then(testCurrentTurnIsolation)
  .then(testRotatedReferenceUsesFreshPrimedFile)
  .then(testStableIdentityHandlesDuplicateRefsAndNames)
  .then(testAmbiguousLegacyFilenameBlocks)
  .then(testProducerCarriesStableFileId)
  .then(testRegenerationRestoresParentFiles)
  .then(testRegenerationSelectsOnlyParentUserFiles)
  .then(testControllerPropagatesAbortSignal)
  .then(testLiveBundlePreservesPricingSupport)
  .then(testSuccessfulPreparse)
  .then(testParserAgainstOfficeFixtures)
  .then(testNoFileBypass)
  .then(testFailureBlocks)
  .then(testPreparseTimeout)
  .then(testPreparseAbort)
  .then(testMissingReferenceBlocks)
  .then(testIntegrationOrder)
  .then(testThinkingOnlyIsIncomplete)
  .then(testDeployRunnerContract)
  .then(() => process.stdout.write('office file identity tests passed\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
