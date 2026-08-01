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
  assert(source.includes("? { event: 'generation_failed', stage: 'generation' }"));
  assert(source.includes("classifyAgentDiagnosticError(error, 'generation')"));
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
    const officePreparsePath = copyPatchedOfficeSource(temporaryRoot);
    await assertOfficeErrorCodes(officePreparsePath);
    runCurrentRequestContract(temporaryRoot, officePreparsePath);
  })
  .then(() => process.stdout.write('diagnostic overlay composition tests passed\n'))
  .finally(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
