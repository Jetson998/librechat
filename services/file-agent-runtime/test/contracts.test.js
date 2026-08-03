import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionSignature,
  normalizeActionEnvelope,
} from '../src/action-envelope.js';
import { buildProgressVector, evaluateProgress } from '../src/progress-evaluator.js';
import { normalizeVerificationResult, verificationFingerprint } from '../src/verification-result.js';

function wordAction(overrides = {}) {
  return {
    schemaVersion: '1.0',
    objective: 'Apply the requested document change',
    worker: 'word.transform.v1',
    inputRefs: ['input:source-docx'],
    targetRef: 'candidate:working-docx',
    parameters: { operation: 'replace_text', target: 'heading', replacement: 'Updated heading' },
    expectedChange: ['document.text'],
    verificationProfile: 'word-structure-v1',
    onFailure: 'replan',
    summary: 'Display-only summary',
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    schemaVersion: '1.0',
    profile: 'word-structure-v1',
    profileVersion: '1.0.0',
    passed: false,
    requiredAssertionCount: 2,
    passedAssertionCodes: ['xml.parts.parseable'],
    failedAssertions: [
      {
        code: 'word.required_changes.applied',
        class: 'CONTENT',
        summary: 'The required change is not present',
        evidenceRef: 'workspace://verification/one.json',
      },
    ],
    artifact: {
      logicalId: 'candidate:working-docx',
      revision: 1,
      sha256: 'a'.repeat(64),
    },
    metrics: { tableCount: 1 },
    summary: 'Display-only verification summary',
    errorClass: 'CONTENT_ASSERTION',
    ...overrides,
  };
}

test('Action Envelope validates logical references and bounded parameters', () => {
  const normalized = normalizeActionEnvelope(wordAction(), {
    allowedWorkers: new Set(['word.transform.v1']),
  });
  assert.equal(normalized.worker, 'word.transform.v1');
  assert.equal(normalized.targetRef, 'candidate:working-docx');
  assert.throws(
    () => normalizeActionEnvelope(wordAction({ parameters: { command: 'python tool.py' } })),
    /not allowed/,
  );
  assert.throws(
    () => normalizeActionEnvelope(wordAction({ parameters: { outputPath: '/tmp/result.docx' } })),
    /absolute path/,
  );
  assert.throws(
    () => normalizeActionEnvelope(wordAction({ parameters: { reference: 'https://example.test' } })),
    /absolute path or URL/,
  );
});

test('Action signature ignores display text but includes target and normalized parameters', () => {
  const first = actionSignature({ actions: [wordAction({ summary: 'first summary' })] });
  const sameAction = actionSignature({ actions: [wordAction({ summary: 'different summary' })] });
  const differentTarget = actionSignature({
    actions: [wordAction({ summary: 'different summary', targetRef: 'candidate:other-docx' })],
  });
  const differentParameters = actionSignature({
    actions: [wordAction({ parameters: { operation: 'replace_text', target: 'body', replacement: 'Changed' } })],
  });
  assert.equal(first, sameAction);
  assert.notEqual(first, differentTarget);
  assert.notEqual(first, differentParameters);
});

test('Verification fingerprint excludes summary, evidence, revision and artifact hash', () => {
  const first = verificationFingerprint(verification());
  const sameFacts = verificationFingerprint(verification({
    summary: 'A different wording',
    failedAssertions: [{
      code: 'word.required_changes.applied',
      class: 'CONTENT',
      summary: 'Another diagnostic explanation',
      evidenceRef: 'workspace://verification/two.json',
    }],
    artifact: {
      logicalId: 'candidate:working-docx',
      revision: 9,
      sha256: 'b'.repeat(64),
    },
  }));
  assert.equal(first, sameFacts);
  assert.notEqual(
    first,
    verificationFingerprint(verification({
      failedAssertions: [{ code: 'word.relationships.resolved', class: 'STRUCTURE' }],
    })),
  );
  assert.notEqual(
    first,
    verificationFingerprint(verification({ metrics: { tableCount: 2 } })),
  );
});

test('Progress evaluator treats assertion improvement as progress, not hash churn', () => {
  const first = buildProgressVector({
    phase: 'verifying',
    verification: verification(),
    scriptHash: 'script-a',
    artifactHash: 'artifact-a',
  });
  const hashOnly = buildProgressVector({
    phase: 'verifying',
    verification: verification({ artifact: { logicalId: 'candidate:working-docx', revision: 2 } }),
    scriptHash: 'script-b',
    artifactHash: 'artifact-b',
  });
  const improved = buildProgressVector({
    phase: 'verifying',
    verification: verification({
      passedAssertionCodes: ['xml.parts.parseable', 'word.required_changes.applied'],
      failedAssertions: [],
      passed: true,
    }),
    scriptHash: 'script-b',
    artifactHash: 'artifact-b',
  });
  assert.equal(evaluateProgress(first, hashOnly).progressed, false);
  assert.equal(evaluateProgress(first, improved).progressed, true);
  assert.equal(evaluateProgress(null, first).reason, 'initial_verification');
});

test('Legacy verification results normalize without placing summary in fingerprint metrics', () => {
  const normalized = normalizeVerificationResult({
    passed: false,
    summary: 'Legacy verifier failure',
    outputHash: 'same-output',
  });
  assert.deepEqual(normalized.metrics, {});
  assert.equal(normalized.errorClass, 'VERIFICATION_FAILED');
  assert.equal(normalized.passed, false);
});
