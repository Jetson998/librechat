import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeWordAcceptanceAssertions,
  WORD_ACCEPTANCE_MAX_SERIALIZED_CHARS,
  WORD_ARTIFACT_LOGICAL_ID,
} from '../src/word-acceptance.js';

test('Word acceptance normalizer rejects an artifact logical ID that cannot be verified', () => {
  assert.throws(
    () => normalizeWordAcceptanceAssertions([
      { type: 'word.paragraph_append.v1', text: 'Requested paragraph' },
      { type: 'word.artifact.v1', logicalId: 'candidate:other-docx' },
    ]),
    /logicalId must be candidate:working-docx/,
  );
  const normalized = normalizeWordAcceptanceAssertions([
    { type: 'word.paragraph_append.v1', text: 'Requested paragraph' },
  ]);
  assert.equal(normalized.at(-1).logicalId, WORD_ARTIFACT_LOGICAL_ID);
});

test('Word acceptance normalizer rejects an oversized aggregate before model execution', () => {
  const text = 'x'.repeat(4_000);
  assert.throws(
    () => normalizeWordAcceptanceAssertions([
      { type: 'word.text_replace.v1', find: text, replace: text },
    ]),
    new RegExp(`exceed ${WORD_ACCEPTANCE_MAX_SERIALIZED_CHARS} serialized characters`),
  );
});
