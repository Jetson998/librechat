'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const releaseRoot = path.resolve(__dirname, '..');
const candidatePath = path.join(releaseRoot, 'api-patch', 'api-index.cjs');
const contractPath = path.join(releaseRoot, 'api-patch', 'code-tool-contract.cjs');
const normalizerPath = path.join(releaseRoot, 'api-patch', 'tool-call-normalizer.cjs');

const {
  getRegisteredContractTools,
  buildCodeToolContract,
} = require(contractPath);
const { normalizeLegacyClaudeCodeToolCall } = require(normalizerPath);

assert.deepEqual(getRegisteredContractTools(undefined), []);
assert.equal(buildCodeToolContract([]), '');

const definitions = [
  { name: 'edit_file' },
  { name: 'read_file' },
  { name: 'unrelated_tool' },
  { name: 'bash_tool' },
  { name: 'read_file' },
];
assert.deepEqual(getRegisteredContractTools(definitions), [
  'bash_tool',
  'read_file',
  'edit_file',
]);

const contract = buildCodeToolContract(definitions);
assert(contract.includes('`bash_tool`, `read_file`, `edit_file`'));
assert(contract.includes('`execute_code` is a capability marker'));
assert(contract.includes('`Bash`, `Read`, `Skill`, `Grep`, `Glob`, `Edit`, or `LS`'));
assert(!contract.includes('currently registered: `skill`'));

const skillContract = buildCodeToolContract([{ name: 'skill' }, { name: 'read_file' }]);
assert(skillContract.includes('`read_file`, `skill`'));
assert(!skillContract.includes('`bash_tool`'));

assert.equal(normalizeLegacyClaudeCodeToolCall({ name: 'Bash', args: { command: 'pwd' } }).name, 'bash_tool');
assert.deepEqual(
  normalizeLegacyClaudeCodeToolCall({ name: 'Read', args: { file_path: '/mnt/data/a.md' } }),
  { name: 'read_file', args: { path: '/mnt/data/a.md' } },
);
assert.deepEqual(
  normalizeLegacyClaudeCodeToolCall({ name: 'Skill', args: { skill: 'office-document-parser' } }),
  { name: 'skill', args: { skillName: 'office-document-parser' } },
);
for (const name of ['execute_code', 'Grep', 'Glob', 'Edit', 'LS']) {
  const call = { name, args: {} };
  assert.equal(normalizeLegacyClaudeCodeToolCall(call), call);
}

const candidate = fs.readFileSync(candidatePath, 'utf8');
assert(candidate.includes('require("./code-tool-contract.cjs")'));
assert(candidate.includes('const codeToolContract = buildCodeToolContract(toolDefinitions)'));
assert(candidate.includes('if (codeToolContract) appendAdditionalInstructions(agent, codeToolContract)'));
assert(candidate.includes('const normalizedToolCalls = toolCalls.map(normalizeLegacyClaudeCodeToolCall)'));

console.log('public code tool contract release tests passed');
