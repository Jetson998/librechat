#!/usr/bin/env node
/*
 * Exercise the actual production composition without touching a deployment:
 * 7/31 mounted Agent files + this diagnostic overlay + the current
 * OfficePreparse error-code patch.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const patchRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(patchRoot, '../../..');
const productionRoot = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-31-office-preparse-result-contract-fix',
);
const productionRequestPath = path.join(productionRoot, 'office-context-patch/request.js');
const productionInitializationFailurePath = path.join(
  productionRoot,
  'office-context-patch/InitializationFailure.js',
);
const diagnosticRequestPath = path.join(
  patchRoot,
  'backend/overlay/api/server/controllers/agents/request.js',
);
const diagnosticInitializationFailurePath = path.join(
  patchRoot,
  'backend/overlay/api/server/controllers/agents/InitializationFailure.js',
);
const officeSourcePath = path.join(productionRoot, 'office-context-patch/OfficePreparse.js');
const officePatchPath = path.join(patchRoot, 'office/OfficePreparse.js.patch');
const adminBaselineRoot = path.join(
  repoRoot,
  'deployment/production-patches/2026-07-11-admin-panel-zh-cn/source',
);
const adminOverlayRoot = path.join(patchRoot, 'admin/overlay');
const contractHarnessPath = path.join(
  productionRoot,
  'scripts/test-office-preparse-result-contract.js',
);

const currentFile = {
  file_id: 'mongo-current',
  filename: 'current.xlsx',
};
const currentPrimed = {
  id: 'code-current',
  source_file_id: 'mongo-current',
  storage_session_id: 'session-current',
  name: 'current.xlsx',
};

const run = (command, args, options = {}) => {
  const result = childProcess.spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};

const assertOnlyDiagnosticAdditions = () => {
  const result = childProcess.spawnSync(
    'git',
    ['diff', '--no-index', '--', productionRequestPath, diagnosticRequestPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.strictEqual(result.status, 1, result.stderr || result.stdout);
  const removedLines = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.deepStrictEqual(removedLines, [
    "-const { saveMessage, saveConvo, getMessages, getConvo } = require('~/models');",
  ]);
  assert.strictEqual(
    fs.readFileSync(diagnosticInitializationFailurePath, 'utf8'),
    fs.readFileSync(productionInitializationFailurePath, 'utf8'),
    'The proven 7/31 initialization-failure persistence helper changed unexpectedly.',
  );

  const source = fs.readFileSync(diagnosticRequestPath, 'utf8');
  assert(source.includes('req.officePreparseSignal = job.abortController.signal;'));
  assert(source.includes('delete req.officePreparseSignal;'));
  assert(source.includes('persistInitializationFailure({'));
  assert(source.includes("event: 'generation_failed'"));
  assert(source.includes("errorCode: diagnostic.errorCode"));
  assert(source.includes("classifyAgentDiagnosticError(error, 'generation')"));
};

const copyTree = (sourceRoot, destinationRoot) => {
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true });
      copyTree(source, destination);
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
};

const assertAdminPermissionAndPrivacy = (temporaryRoot) => {
  const composedRoot = path.join(temporaryRoot, 'admin-composed');
  copyTree(adminBaselineRoot, composedRoot);
  copyTree(adminOverlayRoot, composedRoot);

  const route = fs.readFileSync(path.join(composedRoot, 'src/routes/_app/logs.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(composedRoot, 'src/components/Sidebar.tsx'), 'utf8');
  const detail = fs.readFileSync(
    path.join(composedRoot, 'src/components/logs/DiagnosticLogDetailDrawer.tsx'),
    'utf8',
  );
  const server = fs.readFileSync(
    path.join(composedRoot, 'src/server/diagnosticLogs.ts'),
    'utf8',
  );

  assert(route.includes('READ_DIAGNOSTIC_LOGS_CAPABILITY'));
  assert(!route.includes('READ_AUDIT_LOG_CAPABILITY'));
  assert(sidebar.includes('capability: READ_DIAGNOSTIC_LOGS_CAPABILITY'));
  assert(!sidebar.includes('READ_AUDIT_LOG_CAPABILITY'));
  assert(detail.includes('DiagnosticLogDetailEntry'));
  assert(!detail.includes('entry.stack'));
  assert(!detail.includes('entry.errorMessage'));
  assert(server.includes('errorSummary'));
  assert(!server.includes('errorMessage:'));
  assert(!server.includes('stack:'));
};

const copyPatchedOfficeSource = (temporaryRoot) => {
  const stagedRoot = path.join(temporaryRoot, 'governance');
  const target = path.join(
    stagedRoot,
    'deployment/production-patches/2026-07-31-office-preparse-result-contract-fix/office-context-patch/OfficePreparse.js',
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(officeSourcePath, target);
  run('git', ['-C', stagedRoot, 'apply', '--check', officePatchPath]);
  run('git', ['-C', stagedRoot, 'apply', officePatchPath]);
  return target;
};

const assertOfficeErrorCodes = async (officePreparsePath) => {
  delete require.cache[officePreparsePath];
  const office = require(officePreparsePath);
  const createHarness = (content) =>
    office.createOfficePreparse({
      createBashExecutionTool: () => ({ invoke: async () => ({ content }) }),
      getCodeApiAuthHeaders: async () => ({ Authorization: 'Bearer test' }),
      logger: { debug: () => {} },
    });
  const assertCode = async (content, code, event) => {
    const harness = createHarness(content);
    await assert.rejects(
      harness.prepareCurrentTurnOfficeContext({
        req: {},
        requestFiles: [currentFile],
        primedCodeFiles: [currentPrimed],
      }),
      (error) =>
        error?.code === code &&
        error?.diagnosticEvent === event &&
        error?.diagnosticStage === 'office_preparse',
    );
  };

  await assertCode(
    `${office.MANIFEST_MARKER}{`,
    'OFFICE_PREPARSE_INVALID_MANIFEST',
    'office_preparse_manifest_invalid',
  );
  await assertCode(
    'no office manifest was emitted',
    'OFFICE_PREPARSE_MANIFEST_MISSING',
    'office_preparse_manifest_missing',
  );
  await assertCode(
    `${office.MANIFEST_MARKER}${JSON.stringify({ files: [] })}`,
    'OFFICE_PREPARSE_MANIFEST_INCOMPLETE',
    'office_preparse_manifest_incomplete',
  );
  await assertCode(
    `${office.MANIFEST_MARKER}${JSON.stringify({
      files: [{ filename: 'current.xlsx', ok: false, error: 'corrupt archive' }],
    })}`,
    'OFFICE_PREPARSE_FILE_FAILED',
    'office_preparse_file_failed',
  );
};

const captureRejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected an Office pre-parse rejection.');
};

const assertOfficeSafetyAndRuntimeCodes = async (officePreparsePath) => {
  delete require.cache[officePreparsePath];
  const office = require(officePreparsePath);
  const createHarness = (invoke) =>
    office.createOfficePreparse({
      createBashExecutionTool: () => ({ invoke }),
      getCodeApiAuthHeaders: async () => ({ Authorization: 'Bearer test' }),
      logger: { debug: () => {} },
    });
  const assertDiagnosticError = (error, code, event, forbidden = []) => {
    assert.equal(error?.code, code);
    assert.equal(error?.diagnosticEvent, event);
    assert.equal(error?.diagnosticStage, 'office_preparse');
    for (const value of forbidden) {
      assert(!error.message.includes(value), `raw value leaked into error message: ${value}`);
    }
  };

  const rawFilename = '123-45-6789.xlsx';
  const rawToolError = 'clientToken=auth-secret';
  const failedContent =
    office.MANIFEST_MARKER +
    JSON.stringify({
      files: [{ filename: rawFilename, ok: false, error: rawToolError }],
    });
  const failed = await captureRejection(
    createHarness(async () => ({ content: failedContent })).prepareCurrentTurnOfficeContext({
      req: {},
      requestFiles: [{ ...currentFile, filename: rawFilename }],
      primedCodeFiles: [{ ...currentPrimed, name: rawFilename }],
    }),
  );
  assertDiagnosticError(
    failed,
    'OFFICE_PREPARSE_FILE_FAILED',
    'office_preparse_file_failed',
    [rawFilename, rawToolError],
  );

  const invalid = await captureRejection(
    createHarness(async () => ({ content: office.MANIFEST_MARKER + '{raw tool output}' }))
      .prepareCurrentTurnOfficeContext({
        req: {},
        requestFiles: [currentFile],
        primedCodeFiles: [currentPrimed],
      }),
  );
  assertDiagnosticError(
    invalid,
    'OFFICE_PREPARSE_INVALID_MANIFEST',
    'office_preparse_manifest_invalid',
    ['raw tool output'],
  );

  const missingReference = await captureRejection(
    createHarness(async () => ({ content: '' })).prepareCurrentTurnOfficeContext({
      req: {},
      requestFiles: [currentFile],
      primedCodeFiles: [],
    }),
  );
  assertDiagnosticError(
    missingReference,
    'OFFICE_PREPARSE_FILE_REFERENCE_MISSING',
    'office_preparse_file_reference_missing',
    [currentFile.filename],
  );

  const ambiguousReference = await captureRejection(
    createHarness(async () => ({ content: '' })).prepareCurrentTurnOfficeContext({
      req: {},
      requestFiles: [currentFile],
      primedCodeFiles: [currentPrimed, { ...currentPrimed, id: 'code-current-2' }],
    }),
  );
  assertDiagnosticError(
    ambiguousReference,
    'OFFICE_PREPARSE_FILE_REFERENCE_AMBIGUOUS',
    'office_preparse_file_reference_ambiguous',
    [currentFile.filename],
  );

  const preAborted = new AbortController();
  preAborted.abort();
  const abortedBeforeStart = await captureRejection(
    createHarness(async () => ({ content: '' })).prepareCurrentTurnOfficeContext({
      req: { officePreparseSignal: preAborted.signal },
      requestFiles: [currentFile],
      primedCodeFiles: [currentPrimed],
    }),
  );
  assertDiagnosticError(
    abortedBeforeStart,
    'OFFICE_PREPARSE_ABORTED',
    'office_preparse_aborted',
  );

  const timeout = await captureRejection(
    createHarness(() => new Promise(() => {})).prepareCurrentTurnOfficeContext({
      req: {},
      requestFiles: [currentFile],
      primedCodeFiles: [currentPrimed],
      timeoutMs: 5,
    }),
  );
  assertDiagnosticError(timeout, 'OFFICE_PREPARSE_TIMEOUT', 'office_preparse_timeout');

  const toolFailure = await captureRejection(
    createHarness(async () => {
      throw new Error('auth-secret raw tool output');
    }).prepareCurrentTurnOfficeContext({
      req: {},
      requestFiles: [currentFile],
      primedCodeFiles: [currentPrimed],
    }),
  );
  assertDiagnosticError(
    toolFailure,
    'OFFICE_PREPARSE_TOOL_FAILED',
    'office_preparse_tool_failed',
    ['auth-secret', 'raw tool output'],
  );
};

const runCurrentRequestContract = (temporaryRoot, officePreparsePath) => {
  const harnessSource = fs
    .readFileSync(contractHarnessPath, 'utf8')
    .replace(
      "const officePreparsePath = path.join(\n  patchRoot,\n  'office-context-patch/OfficePreparse.js',\n);",
      `const officePreparsePath = ${JSON.stringify(officePreparsePath)};`,
    )
    .replace(
      "const requestControllerPath = path.join(patchRoot, 'office-context-patch/request.js');",
      `const requestControllerPath = ${JSON.stringify(diagnosticRequestPath)};`,
    );
  const harnessPath = path.join(temporaryRoot, 'current-request-contract.js');
  fs.writeFileSync(harnessPath, harnessSource);
  run(process.execPath, [harnessPath]);
};

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-overlay-composition-'));

Promise.resolve()
  .then(() => assertOnlyDiagnosticAdditions())
  .then(async () => {
    assertAdminPermissionAndPrivacy(temporaryRoot);
    const officePreparsePath = copyPatchedOfficeSource(temporaryRoot);
    await assertOfficeErrorCodes(officePreparsePath);
    await assertOfficeSafetyAndRuntimeCodes(officePreparsePath);
    runCurrentRequestContract(temporaryRoot, officePreparsePath);
  })
  .then(() => process.stdout.write('diagnostic overlay composition tests passed\n'))
  .finally(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
