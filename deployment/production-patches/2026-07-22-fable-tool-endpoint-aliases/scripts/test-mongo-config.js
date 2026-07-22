'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, 'mongo-config.js'), 'utf8');
const oldToolSentence =
  '你运行在 LibreChat 网页会话里，不是 Claude Code CLI。需要读写、分析或生成文件时，使用本会话实际提供的代码执行工具；当前 Anthropic 端可用的代码工具名通常显示为 Bash。不要调用 Glob、Read、Edit、LS 这类 Claude Code 专用工具名。';
const oldProgressSentence = '然后在同一轮紧接着调用 Bash 运行 Python。';

const original = {
  _id: 'base-config',
  principalType: 'role',
  principalId: '__base__',
  isActive: true,
  configVersion: 77,
  unrelated: { keep: true },
  overrides: {
    endpoints: { agents: { maxToolResultChars: 32000 } },
    modelSpecs: {
      list: [
        {
          name: 'gpt-5.6-sol',
          preset: { promptPrefix: 'unchanged GPT prompt' },
        },
        {
          name: 'claude-fable-5',
          preset: {
            promptPrefix: `${oldToolSentence}\n保持其它说明。\n${oldProgressSentence}\n完成。`,
          },
        },
      ],
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function run(mode, state) {
  const prints = [];
  const configs = {
    find(query) {
      return {
        toArray() {
          const row = state.document;
          return row.principalType === query.principalType &&
            row.principalId === query.principalId &&
            row.isActive === query.isActive
            ? [clone(row)]
            : [];
        },
      };
    },
    replaceOne(query, document) {
      assert.equal(query._id, state.document._id);
      state.document = clone(document);
      return { acknowledged: true, matchedCount: 1 };
    },
  };
  const backups = {
    countDocuments(query) {
      return state.backups.has(query.backupId) ? 1 : 0;
    },
    insertOne(entry) {
      state.backups.set(entry.backupId, clone(entry));
      return { acknowledged: true };
    },
    findOne(query) {
      return clone(state.backups.get(query.backupId) || null);
    },
  };

  vm.runInNewContext(script, {
    db: { configs, codexConfigBackups: backups },
    EJSON: { parse: JSON.parse, stringify: JSON.stringify },
    process: {
      env: {
        FABLE_TOOL_ALIAS_MODE: mode,
        FABLE_TOOL_ALIAS_BACKUP_ID: 'test-backup',
      },
    },
    print(value) {
      prints.push(String(value));
    },
    Date,
    JSON,
  });
  return prints;
}

const state = { document: clone(original), backups: new Map() };
assert.match(run('preflight', state).at(-1), /^preflight=ok/);
assert.deepEqual(state.document, original, 'preflight must not mutate configuration');

assert.match(run('apply', state).at(-1), /^apply=ok/);
assert.equal(state.document.configVersion, 78);
assert.equal(state.document.unrelated.keep, true);
assert.equal(
  state.document.overrides.modelSpecs.list[0].preset.promptPrefix,
  'unchanged GPT prompt',
);
const fablePrompt = state.document.overrides.modelSpecs.list[1].preset.promptPrefix;
assert(fablePrompt.includes('bash_tool、read_file 和 skill'));
assert(fablePrompt.includes('调用 bash_tool 运行 Python'));
assert(!fablePrompt.includes('通常显示为 Bash'));

assert.match(run('verify', state).at(-1), /^verify=ok/);
assert.match(run('apply', state).at(-1), /^apply=already_configured/);
assert.match(run('rollback', state).at(-1), /^rollback=ok/);
assert.deepEqual(state.document, original);

console.log('fable tool alias Mongo tests passed');
