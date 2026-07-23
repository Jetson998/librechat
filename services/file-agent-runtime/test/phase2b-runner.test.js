import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PHASE2B_CONFIRMATION,
  PHASE2B_FIXTURE_SHA256,
  runPhase2B,
} from '../scripts/phase2b-once.js';
import { IsolatedModelRelay } from './isolated-model-relay.js';

test('Phase 2B one-shot runner uses the repository fixture and emits a redacted contract report', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2b-runner-'));
  const relay = await new IsolatedModelRelay().start();
  t.after(async () => {
    await relay.stop();
    await rm(runDir, { recursive: true, force: true });
  });

  const options = {
    baseUrl: relay.baseUrl,
    apiKey: 'phase2b-local-test-secret',
    model: 'recorded-office-planner',
    allowLocalFixture: true,
    supportsIdempotency: true,
    structuredOutputMode: 'json_schema',
    runDir,
  };
  const first = await runPhase2B(options);
  assert.equal(first.task.status, 'completed');
  assert.equal(first.fixture.sha256, PHASE2B_FIXTURE_SHA256);
  assert.equal(first.fixture.customerData, false);
  assert.equal(first.budgets.observed.attemptedCalls, 2);
  assert.equal(first.budgets.observed.journaledCalls, 2);
  assert.equal(first.budgets.observed.budgetExceeded, false);
  assert.equal(first.contract.requestCount, 2);
  assert.equal(first.route.structuredOutputMode, 'json_schema');
  assert.equal(first.contract.responseFormatAccepted, true);
  assert.equal(first.contract.metadataAccepted, true);
  assert.equal(first.contract.idempotencyHeaderSent, true);
  assert.equal(first.contract.usagePresent, true);
  assert.equal(first.quality.verifiedArtifact, true);
  assert.deepEqual(first.quality.actionKinds, ['xlsx_transform', 'xlsx_patch_and_transform']);
  assert.deepEqual(first.usage, {
    inputTokens: 1_200,
    cacheReadTokens: 120,
    cacheWriteTokens: 0,
    outputTokens: 160,
  });

  const firstExecutions = [...relay.actualExecutions.values()].reduce((sum, value) => sum + value, 0);
  const second = await runPhase2B(options);
  const secondExecutions = [...relay.actualExecutions.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(second.task.taskId, first.task.taskId);
  assert.equal(secondExecutions, firstExecutions);

  const reportText = await readFile(path.join(runDir, 'phase2b-report.json'), 'utf8');
  assert.ok(!reportText.includes(options.apiKey));
  assert.ok(!reportText.includes(options.baseUrl));
});

test('Phase 2B real-mode guard requires explicit non-production approval', async () => {
  await assert.rejects(
    runPhase2B({
      baseUrl: 'https://relay.example.invalid',
      apiKey: 'phase2b-test-key',
      model: 'test-model',
      confirmation: PHASE2B_CONFIRMATION,
      keyScope: 'production',
    }),
    /KEY_SCOPE must equal non-production/,
  );
});

test('Phase 2B journals an over-budget paid response before stopping the task', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2b-budget-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  let fetchCalls = 0;
  const fetchImpl = async (_url, init) => {
    fetchCalls += 1;
    const body = JSON.parse(init.body);
    const payload = JSON.parse(body.messages.find((message) => message.role === 'user').content);
    return new Response(JSON.stringify({
      model: 'recorded-over-budget-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: '1.0',
              summary: 'Return one valid plan with excessive recorded input usage',
              needsInput: false,
              actions: [
                {
                  kind: payload.operation === 'repair'
                    ? 'xlsx_patch_and_transform'
                    : 'xlsx_transform',
                  summary: 'Use the allowed deterministic workbook action',
                },
              ],
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 6_001,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const report = await runPhase2B({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'phase2b-over-budget-secret',
    model: 'recorded-over-budget-model',
    allowLocalFixture: true,
    supportsIdempotency: false,
    fetchImpl,
    runDir,
  });
  assert.equal(report.task.status, 'failed');
  assert.equal(report.budgets.observed.attemptedCalls, 1);
  assert.equal(report.budgets.observed.journaledCalls, 1);
  assert.equal(report.budgets.observed.budgetExceeded, true);
  assert.equal(fetchCalls, 1);

  const journalDir = path.join(runDir, 'provider-journal', 'model-calls');
  const journalFiles = await readdir(journalDir);
  assert.equal(journalFiles.length, 1);
  const journal = JSON.parse(await readFile(path.join(journalDir, journalFiles[0]), 'utf8'));
  assert.equal(journal.status, 'completed_valid');
});

test('Phase 2B report retains invalid-plan usage without the raw plan', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase2b-invalid-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const fetchImpl = async () => new Response(JSON.stringify({
    model: 'recorded-invalid-model',
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            schemaVersion: '1.0',
            summary: 'Return invalid extra metadata',
            needsInput: false,
            actions: [{ kind: 'xlsx_transform', summary: 'Use the stable transform' }],
            rawUnsupportedField: 'must-not-appear-in-report-or-journal',
          }),
        },
      },
    ],
    usage: {
      prompt_tokens: 900,
      completion_tokens: 80,
      prompt_tokens_details: {
        cached_tokens: 200,
        cached_creation_tokens: 30,
      },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const report = await runPhase2B({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'phase2b-invalid-plan-secret',
    model: 'recorded-invalid-model',
    allowLocalFixture: true,
    supportsIdempotency: false,
    fetchImpl,
    runDir,
  });

  assert.equal(report.task.status, 'failed');
  assert.equal(report.contract.transportCompleted, true);
  assert.equal(report.contract.planAccepted, false);
  assert.deepEqual(report.contract.journalStatuses, ['completed_invalid']);
  assert.equal(report.contract.protocolError.code, 'PROVIDER_PROTOCOL');
  assert.equal(report.contract.usageFromInvalidReceipt, true);
  assert.equal(report.contract.responseDigests.length, 1);
  assert.deepEqual(report.usage, {
    inputTokens: 900,
    cacheReadTokens: 200,
    cacheWriteTokens: 30,
    outputTokens: 80,
  });
  const persisted = (
    await Promise.all(
      (await readdir(path.join(runDir, 'provider-journal', 'model-calls'))).map((name) =>
        readFile(path.join(runDir, 'provider-journal', 'model-calls', name), 'utf8'),
      ),
    )
  ).join('\n');
  assert.ok(!persisted.includes('must-not-appear-in-report-or-journal'));
  assert.ok(!JSON.stringify(report).includes('must-not-appear-in-report-or-journal'));
});
