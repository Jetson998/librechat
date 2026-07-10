const assert = require('assert');
const fs = require('fs');
const path = require('path');

const patchRoot = path.resolve(__dirname, '..');
const baseClientPath = path.join(patchRoot, 'office-context-patch', 'BaseClient.js');
const processPath = path.join(patchRoot, 'office-context-patch', 'process.js');
const toolServicePath = path.join(patchRoot, 'office-context-patch', 'ToolService.js');
const apiIndexPath = path.join(patchRoot, 'office-context-patch', 'api-index.cjs');
const skillPath = path.join(patchRoot, 'skill', 'office-document-parser', 'SKILL.md');

const read = (file) => fs.readFileSync(file, 'utf8');

const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0, `Missing start marker: ${startMarker}`);
  assert(end > start, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

const testBaseClientIsGeneric = () => {
  const source = read(baseClientPath);
  const forbidden = [
    'OFFICE_GENERATION_EMPTY_RETRY_MARKER',
    'isOfficePptDeterministicPreflightCandidate',
    'executeCodeApiPptJob',
    'buildOfficePptFallbackPython',
    'buildOfficePptTransformPython',
    'deterministicFallbackAttachment',
    'appendBusinessPreToolNotice',
    'GenerationJobManager.emitChunk',
  ];
  for (const marker of forbidden) {
    assert(!source.includes(marker), `BaseClient still contains ${marker}`);
  }
  assert(source.includes('appendDownloadableMessageFiles'), 'Generic artifact file mirror is missing');
  assert(source.includes('responseMessage.files = appendDownloadableMessageFiles'), 'Artifact files are not mirrored');
};

const testOfficeUploadAllowlist = () => {
  const source = read(processPath);
  const block = sliceBetween(
    source,
    'const officeCodeUploadExts = new Set(',
    'const isMissingStorageError',
  );
  const factory = Function('path', `${block}\nreturn { isOfficeCodeUploadFile };`);
  const { isOfficeCodeUploadFile } = factory(path);

  for (const filename of [
    'input.docx',
    'input.xlsx',
    'input.xlsm',
    'input.ppt',
    'input.pptx',
    'input.csv',
    'input.tsv',
    'input.ods',
    'input.odp',
    'UPPER.PPTX',
  ]) {
    assert.strictEqual(isOfficeCodeUploadFile({ originalname: filename }), true, filename);
  }

  for (const filename of ['input.exe', 'input.pdf', 'input.png', 'input', 'input.pptx.exe']) {
    assert.strictEqual(isOfficeCodeUploadFile({ originalname: filename }), false, filename);
  }
  assert(source.includes('messageAttachment && !isOfficeCodeUploadFile(file)'), 'Server guard is missing');
  assert(!source.includes('!!metadata.message_file'), 'String "false" would be treated as a message upload');
  assert(
    source.includes("metadata.message_file === true || metadata.message_file === 'true'"),
    'Message upload flag is not parsed explicitly',
  );
};

const testSkillUsesCurrentSandboxOnly = () => {
  const source = read(skillPath);
  assert(!/^always-apply:/m.test(source), 'Office skill is still always applied');
  assert(!source.includes('/office/'), 'Office skill still redirects users to /office/');
  assert(!source.includes('/tmp/'), 'Office skill still writes persistent work to /tmp');
  assert(!source.includes('office_to_markdown.py'), 'Office skill references a missing parser script');
  assert(source.includes('/mnt/data'), 'Office skill does not identify the current sandbox path');
};

const testPrimeCache = async () => {
  const source = read(toolServicePath);
  const block = sliceBetween(
    source,
    "const CODE_ENV_PRIME_CACHE = Symbol(",
    'const getToolResponseFormat',
  );
  const EToolResources = { execute_code: 'execute_code' };
  let primeCalls = 0;
  const primeCodeFiles = async () => {
    primeCalls += 1;
    return {
      toolContext: 'ready',
      files: [
        {
          id: 'input',
          resource_id: 'user',
          storage_session_id: 'storage-input',
          name: 'input.xlsx',
          kind: 'user',
        },
      ],
    };
  };
  const factory = Function(
    'EToolResources',
    'primeCodeFiles',
    `${block}\nreturn { getOrPrimeCodeFiles };`,
  );
  const { getOrPrimeCodeFiles } = factory(EToolResources, primeCodeFiles);
  const req = {};
  const tool_resources = { execute_code: { files: [{ file_id: 'mongo-input' }] } };

  const [first, second] = await Promise.all([
    getOrPrimeCodeFiles({ req, tool_resources, agentId: 'agent' }),
    getOrPrimeCodeFiles({ req, tool_resources, agentId: 'agent' }),
  ]);
  assert.strictEqual(primeCalls, 1, 'Underlying code upload was repeated');
  assert.deepStrictEqual(first, second);
};

const testStorageGuardScope = () => {
  const source = read(toolServicePath);
  const regexBlock = sliceBetween(
    source,
    'const CODEAPI_GLOBAL_STORAGE_RE',
    'const CODE_EXECUTION_STORAGE_GUARD_MESSAGE',
  );
  const inputBlock = sliceBetween(
    source,
    'const getToolInputCommand',
    'const wrapCodeExecutionStorageGuard',
  );
  const factory = Function(
    `${regexBlock}\n${inputBlock}\nreturn { getCodeExecutionStorageGuardViolation };`,
  );
  const { getCodeExecutionStorageGuardViolation } = factory();

  for (const command of [
    'find /mnt/data -type f',
    'ls -la /mnt/data',
    'python -c "import os; print(os.listdir(\'/mnt/data\'))"',
  ]) {
    assert.strictEqual(getCodeExecutionStorageGuardViolation({ command }), null, command);
  }

  for (const command of [
    'find / -name "*.xlsx"',
    'find /srv -name "*.xlsx"',
    'tree /opt',
    'ls -la /srv/codeapi-data/sessions',
    'cat /srv/codeapi-data/sessions/file.xlsx',
    'cat /tmp/sess_0123456789abcdef/file.xlsx',
  ]) {
    assert(getCodeExecutionStorageGuardViolation({ command }), command);
  }
};

const testRuntimeMerge = () => {
  const source = read(apiIndexPath);
  const block = sliceBetween(
    source,
    'function mergeRuntimePrimedCodeSessionContext',
    'function isSkillPrimedForAuthoring',
  );
  const factory = Function(`${block}\nreturn { mergeRuntimePrimedCodeSessionContext };`);
  const { mergeRuntimePrimedCodeSessionContext } = factory();
  const generated = {
    id: 'generated',
    storage_session_id: 'storage-generated',
    name: 'output.docx',
  };
  const uploaded = {
    id: 'uploaded',
    resource_id: 'user',
    storage_session_id: 'storage-uploaded',
    name: 'input.xlsx',
    kind: 'user',
  };

  const merged = mergeRuntimePrimedCodeSessionContext(
    { session_id: 'exec-current', files: [generated] },
    { primedCodeFiles: [uploaded, generated] },
  );
  assert.strictEqual(merged.session_id, 'exec-current');
  assert.deepStrictEqual(
    merged.files.map((file) => file.name),
    ['output.docx', 'input.xlsx'],
  );

  const recovered = mergeRuntimePrimedCodeSessionContext(undefined, {
    primedCodeFiles: [uploaded],
  });
  assert.strictEqual(recovered.session_id, 'storage-uploaded');
  assert.deepStrictEqual(recovered.files, [uploaded]);
};

Promise.resolve()
  .then(testBaseClientIsGeneric)
  .then(testOfficeUploadAllowlist)
  .then(testSkillUsesCurrentSandboxOnly)
  .then(testPrimeCache)
  .then(testStorageGuardScope)
  .then(testRuntimeMerge)
  .then(() => process.stdout.write('file pipeline simplification tests passed\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
