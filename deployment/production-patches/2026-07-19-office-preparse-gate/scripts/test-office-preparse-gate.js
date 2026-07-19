const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../../..');
const apiIndexPath = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/api-index.cjs',
);
const baseClientPath = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/BaseClient.js',
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
  const source = read(apiIndexPath);
  const block = sliceBetween(
    source,
    'const OFFICE_PREPARSE_EXTENSIONS',
    '/**\n* Initializes an agent for use in requests.',
  );
  const factory = Function(
    '_librechat_agents',
    'getCodeApiAuthHeaders',
    `${block}\nreturn {\n` +
      '  OFFICE_PREPARSE_MARKER,\n' +
      '  buildOfficePreparsePython,\n' +
      '  selectCurrentTurnOfficeFiles,\n' +
      '  prepareCurrentTurnOfficeContext,\n' +
      '};',
  );
  return factory(
    {
      createBashExecutionTool: () => ({ invoke }),
    },
    async () => ({ Authorization: 'Bearer test' }),
  );
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
import os, zipfile
root = ${JSON.stringify('${FIXTURE_DIR}')}
with zipfile.ZipFile(os.path.join(root, 'sample.docx'), 'w') as z:
    z.writestr('word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>审计报告摘要</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(os.path.join(root, 'sample.xlsx'), 'w') as z:
    z.writestr('xl/workbook.xml', '<workbook xmlns="urn:x"><sheets><sheet name="渠道数据"/></sheets></workbook>')
    z.writestr('xl/sharedStrings.xml', '<sst xmlns="urn:x"><si><t>模型</t></si><si><t>gpt-5.6-sol</t></si></sst>')
    z.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="urn:x"><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>')
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

const testMissingReferenceBlocks = () => {
  const helpers = loadHelpers(async () => 'unused');
  assert.throws(
    () => helpers.selectCurrentTurnOfficeFiles([currentFile], []),
    /could not resolve.*current\.xlsx/,
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

Promise.resolve()
  .then(testCurrentTurnIsolation)
  .then(testSuccessfulPreparse)
  .then(testParserAgainstOfficeFixtures)
  .then(testNoFileBypass)
  .then(testFailureBlocks)
  .then(testMissingReferenceBlocks)
  .then(testIntegrationOrder)
  .then(testThinkingOnlyIsIncomplete)
  .then(() => process.stdout.write('office pre-parse gate tests passed\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
