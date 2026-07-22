'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const releaseRoot = path.resolve(__dirname, '..');
const candidatePath = path.join(releaseRoot, 'api-patch', 'api-index.cjs');
const normalizerPath = path.join(releaseRoot, 'api-patch', 'tool-call-normalizer.cjs');
const mongoPath = path.join(releaseRoot, 'scripts', 'mongo-config.js');
const { normalizeLegacyClaudeCodeToolCall } = require(normalizerPath);

const bashCall = {
  id: 'bash-1',
  name: 'Bash',
  args: { command: 'ls /mnt/data' },
  stepId: 'step-1',
  turn: 2,
  codeSessionContext: { session_id: 'sess-1', files: [{ name: 'input.docx' }] },
};
const readCall = {
  id: 'read-1',
  name: 'Read',
  args: { file_path: '/mnt/data/New_Chat.md' },
};
const skillCall = {
  id: 'skill-1',
  name: 'Skill',
  args: { skill: 'office-document-parser', args: 'read the document' },
};

const originals = JSON.parse(JSON.stringify([bashCall, readCall, skillCall]));
const normalizedBash = normalizeLegacyClaudeCodeToolCall(bashCall);
const normalizedRead = normalizeLegacyClaudeCodeToolCall(readCall);
const normalizedSkill = normalizeLegacyClaudeCodeToolCall(skillCall);

assert.equal(normalizedBash.name, 'bash_tool');
assert.deepEqual(normalizedBash.args, { command: 'ls /mnt/data' });
assert.equal(normalizedBash.id, bashCall.id);
assert.equal(normalizedBash.codeSessionContext, bashCall.codeSessionContext);

assert.equal(normalizedRead.name, 'read_file');
assert.deepEqual(normalizedRead.args, { path: '/mnt/data/New_Chat.md' });

assert.equal(normalizedSkill.name, 'skill');
assert.deepEqual(normalizedSkill.args, {
  skillName: 'office-document-parser',
  args: 'read the document',
});

assert.deepEqual([bashCall, readCall, skillCall], originals, 'input calls must not be mutated');

const canonical = { id: 'canonical', name: 'read_file', args: { path: '/mnt/data/a.md' } };
assert.equal(normalizeLegacyClaudeCodeToolCall(canonical), canonical);
const grep = { id: 'grep', name: 'Grep', args: { pattern: 'x', path: '/mnt/data' } };
assert.equal(normalizeLegacyClaudeCodeToolCall(grep), grep);
const unknown = { id: 'unknown', name: 'OtherTool', args: {} };
assert.equal(normalizeLegacyClaudeCodeToolCall(unknown), unknown);
assert.deepEqual(
  normalizeLegacyClaudeCodeToolCall({
    id: 'read-both',
    name: 'Read',
    args: { path: '/mnt/data/canonical.md', file_path: '/mnt/data/legacy.md' },
  }).args,
  { path: '/mnt/data/canonical.md' },
);
assert.deepEqual(
  normalizeLegacyClaudeCodeToolCall({
    id: 'skill-both',
    name: 'Skill',
    args: { skillName: 'canonical-skill', skill: 'legacy-skill' },
  }).args,
  { skillName: 'canonical-skill' },
);

const candidate = fs.readFileSync(candidatePath, 'utf8');
assert(candidate.includes('require("./tool-call-normalizer.cjs")'));
assert(candidate.includes('const normalizedToolCalls = toolCalls.map(normalizeLegacyClaudeCodeToolCall)'));
assert(candidate.includes('loadTools([...new Set(normalizedToolCalls.map((tc) => tc.name))]'));
assert(candidate.includes('Promise.all(normalizedToolCalls.map(async (tc) =>'));
assert(candidate.includes('Normalized legacy tool aliases'));

const mongoScript = fs.readFileSync(mongoPath, 'utf8');
for (const text of [
  "const MODEL_NAME = 'claude-fable-5'",
  'bash_tool、read_file 和 skill',
  'Bash、Read、Skill、Grep、Glob、Edit、LS',
  '调用 bash_tool 运行 Python',
  'codexConfigBackups',
]) {
  assert(mongoScript.includes(text), `missing Mongo contract text: ${text}`);
}

console.log('fable tool alias release tests passed');
