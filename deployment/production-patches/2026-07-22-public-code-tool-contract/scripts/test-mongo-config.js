'use strict';

const assert = require('node:assert/strict');
const {
  GPT_MODEL,
  FABLE_MODEL,
  GPT_OLD_TOOL_SENTENCE,
  GPT_NEUTRAL_SENTENCE,
  FABLE_CANONICAL_TOOL_SENTENCE,
  FABLE_NEUTRAL_SENTENCE,
  CANONICAL_PROGRESS_SENTENCE,
  NEUTRAL_PROGRESS_SENTENCE,
  applyContract,
  assertConfigured,
} = require('./mongo-config.js');

const source = {
  _id: 'base',
  configVersion: 64,
  unrelated: { keep: true },
  overrides: {
    modelSpecs: {
      list: [
        {
          name: GPT_MODEL,
          preset: {
            model: GPT_MODEL,
            promptPrefix: '[CONTEXT_SAFETY_BATCH_V1]\nGPT batch rules remain.',
          },
        },
        {
          name: FABLE_MODEL,
          preset: {
            model: FABLE_MODEL,
            promptPrefix: `${FABLE_CANONICAL_TOOL_SENTENCE}\n${CANONICAL_PROGRESS_SENTENCE}\nFable Office rules remain.`,
          },
        },
        { name: 'future-model', preset: { promptPrefix: 'Do not modify me.' } },
      ],
    },
  },
};

const original = JSON.parse(JSON.stringify(source));
const candidate = applyContract(source);
assert.deepEqual(source, original, 'source document must not be mutated');
assertConfigured(candidate);
assert.deepEqual(candidate.unrelated, { keep: true });

const specs = Object.fromEntries(
  candidate.overrides.modelSpecs.list.map((spec) => [spec.name, spec]),
);
assert.equal(
  specs[GPT_MODEL].preset.promptPrefix,
  '[CONTEXT_SAFETY_BATCH_V1]\nGPT batch rules remain.',
);
assert(specs[FABLE_MODEL].preset.promptPrefix.startsWith(FABLE_NEUTRAL_SENTENCE));
assert(specs[FABLE_MODEL].preset.promptPrefix.includes(NEUTRAL_PROGRESS_SENTENCE));
assert(!specs[FABLE_MODEL].preset.promptPrefix.includes('调用 bash_tool 运行 Python'));
assert(specs[FABLE_MODEL].preset.promptPrefix.includes('Fable Office rules remain.'));
assert.equal(specs['future-model'].preset.promptPrefix, 'Do not modify me.');

const idempotent = applyContract(candidate);
assert.deepEqual(idempotent, candidate);

const legacyGptSource = JSON.parse(JSON.stringify(source));
legacyGptSource.overrides.modelSpecs.list.find(
  (spec) => spec.name === GPT_MODEL,
).preset.promptPrefix = `${GPT_OLD_TOOL_SENTENCE}\nGPT Office rules remain.`;
const legacyGptCandidate = applyContract(legacyGptSource);
assertConfigured(legacyGptCandidate);
const legacyGptPrompt = legacyGptCandidate.overrides.modelSpecs.list.find(
  (spec) => spec.name === GPT_MODEL,
).preset.promptPrefix;
assert(legacyGptPrompt.startsWith(GPT_NEUTRAL_SENTENCE));
assert(legacyGptPrompt.includes('GPT Office rules remain.'));
assert(!legacyGptPrompt.includes('Bash 或 execute_code'));

console.log('public code tool contract Mongo tests passed');
