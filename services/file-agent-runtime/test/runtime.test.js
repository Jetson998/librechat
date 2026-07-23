import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { FakeExecutor, FakeProvider } from '../src/fake-adapters.js';
import { handleRuntimeFetch } from '../src/http-server.js';
import { FileAgentRuntime } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';

function manifest(overrides = {}) {
  return {
    schemaVersion: '1.0',
    taskContractVersion: 'office-file-agent.v1',
    taskType: 'office_transform',
    intent: 'Run the Phase 0 deterministic fixture',
    ...overrides,
  };
}

async function createHarness(t, { providerDelayMs = 0, executorDelayMs = 0, rootDir } = {}) {
  const ownedRoot = rootDir ?? (await mkdtemp(path.join(tmpdir(), 'file-agent-runtime-')));
  const store = new FileTaskStore(ownedRoot);
  const executor = new FakeExecutor({ delayMs: executorDelayMs });
  const runtime = new FileAgentRuntime({
    store,
    executor,
    provider: new FakeProvider({ delayMs: providerDelayMs }),
  });
  await runtime.start();

  if (!rootDir) {
    t.after(async () => {
      await runtime.stop();
      await rm(ownedRoot, { recursive: true, force: true });
    });
  }

  return { executor, rootDir: ownedRoot, runtime, store };
}

test('idempotent submission creates one task and one accepted event', async (t) => {
  const { runtime } = await createHarness(t);

  const first = await runtime.submit({ idempotencyKey: 'same-request', manifest: manifest() });
  const second = await runtime.submit({ idempotencyKey: 'same-request', manifest: manifest() });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.task.taskId, first.task.taskId);

  const completed = await runtime.waitFor(first.task.taskId, (task) => task.status === 'completed');
  const accepted = completed.events.filter((event) => event.type === 'task.accepted');
  assert.equal(accepted.length, 1);
  assert.deepEqual(
    completed.events.map((event) => event.sequence),
    completed.events.map((_, index) => index + 1),
  );
});

test('idempotency key rejects a different canonical task manifest', async (t) => {
  const { runtime } = await createHarness(t);
  const original = manifest({ intent: 'Original request', extra: { beta: 2, alpha: 1 } });
  const reordered = {
    extra: { alpha: 1, beta: 2 },
    intent: 'Original request',
    taskType: 'office_transform',
    taskContractVersion: 'office-file-agent.v1',
    schemaVersion: '1.0',
  };

  const first = await runtime.submit({ idempotencyKey: 'manifest-conflict', manifest: original });
  const same = await runtime.submit({ idempotencyKey: 'manifest-conflict', manifest: reordered });
  assert.equal(same.task.taskId, first.task.taskId);

  await assert.rejects(
    runtime.submit({
      idempotencyKey: 'manifest-conflict',
      manifest: manifest({ intent: 'Different request' }),
    }),
    /different task manifest/,
  );
});

test('event cursor returns only events after the requested sequence', async (t) => {
  const { runtime } = await createHarness(t);
  const { task } = await runtime.submit({ idempotencyKey: 'event-cursor', manifest: manifest() });
  const completed = await runtime.waitFor(task.taskId, (current) => current.status === 'completed');
  const pivot = completed.events[Math.floor(completed.events.length / 2)].sequence;

  const events = await runtime.getEvents(task.taskId, pivot);
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.sequence > pivot));
  assert.equal(events.at(-1).type, 'task.completed');
});

test('needs_input task resumes after an idempotent steer instruction', async (t) => {
  const { runtime } = await createHarness(t);
  const { task } = await runtime.submit({
    idempotencyKey: 'needs-input',
    manifest: manifest({ testScenario: 'needs_input' }),
  });

  await runtime.waitFor(task.taskId, (current) => current.status === 'needs_input');
  await runtime.steer(task.taskId, {
    instructionId: 'instruction-1',
    text: 'Continue with the default deterministic output.',
  });
  await runtime.steer(task.taskId, {
    instructionId: 'instruction-1',
    text: 'Continue with the default deterministic output.',
  });

  const completed = await runtime.waitFor(task.taskId, (current) => current.status === 'completed');
  assert.equal(completed.instructionRevision, 1);
  assert.equal(completed.events.filter((event) => event.type === 'task.steered').length, 1);
  assert.ok(completed.planRevision >= 2);
});

test('cancel is terminal and stops the in-flight fake executor', async (t) => {
  const { runtime } = await createHarness(t, { executorDelayMs: 100 });
  const { task } = await runtime.submit({ idempotencyKey: 'cancel-task', manifest: manifest() });

  await runtime.waitFor(task.taskId, (current) => current.status === 'preparing');
  const canceled = await runtime.cancel(task.taskId);
  assert.equal(canceled.status, 'canceled');

  await delay(150);
  const persisted = await runtime.getTask(task.taskId);
  assert.equal(persisted.status, 'canceled');
  assert.equal(persisted.events.at(-1).type, 'task.canceled');
});

test('restart resumes a non-terminal task from the persisted checkpoint', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-runtime-restart-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const first = await createHarness(t, { executorDelayMs: 100, rootDir });
  const submitted = await first.runtime.submit({
    idempotencyKey: 'restart-task',
    manifest: manifest(),
  });
  await first.runtime.waitFor(
    submitted.task.taskId,
    (current) => current.status === 'preparing' || current.status === 'executing',
  );
  await first.runtime.stop();

  const beforeRestart = await first.store.requireTask(submitted.task.taskId);
  assert.notEqual(beforeRestart.status, 'completed');

  const second = await createHarness(t, { rootDir });
  t.after(() => second.runtime.stop());
  const completed = await second.runtime.waitFor(
    submitted.task.taskId,
    (current) => current.status === 'completed',
  );

  assert.equal(completed.status, 'completed');
  assert.equal(completed.events.filter((event) => event.type === 'task.accepted').length, 1);
  assert.equal(completed.events.at(-1).type, 'task.completed');
});

test('failed verification creates a repair plan instead of repeating the original plan', async (t) => {
  const { runtime } = await createHarness(t);
  const { task } = await runtime.submit({
    idempotencyKey: 'repair-once',
    manifest: manifest({ testScenario: 'repair_once' }),
  });

  const completed = await runtime.waitFor(task.taskId, (current) => current.status === 'completed');
  assert.equal(completed.planRevision, 2);
  assert.ok(completed.events.some((event) => event.type === 'plan.updated' && event.data.repair));
  assert.equal(completed.events.at(-1).type, 'task.completed');
});

test('executor failure persists item.failed and task.failed terminal events', async (t) => {
  const { runtime } = await createHarness(t);
  const { task } = await runtime.submit({
    idempotencyKey: 'executor-failure',
    manifest: manifest({ failActionKind: 'transform' }),
  });

  const failed = await runtime.waitFor(task.taskId, (current) => current.status === 'failed');
  assert.equal(failed.error.message, 'Fake executor failure for action kind: transform');
  assert.ok(failed.events.some((event) => event.type === 'item.failed'));
  assert.equal(failed.events.at(-1).type, 'task.failed');
});

test('HTTP API exposes submit, task lookup, and durable event cursor', async (t) => {
  const { runtime } = await createHarness(t);
  const baseUrl = 'http://phase0.local';

  const health = await handleRuntimeFetch(runtime, new Request(`${baseUrl}/healthz`));
  assert.equal(health.status, 200);

  const capabilitiesResponse = await handleRuntimeFetch(
    runtime,
    new Request(`${baseUrl}/v1/capabilities`),
  );
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.ok(capabilities.taskContractVersions.includes('office-file-agent.v1'));
  assert.equal(capabilities.maxVisibleArtifacts, 3);

  const submit = await handleRuntimeFetch(runtime, new Request(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'http-task',
    },
    body: JSON.stringify(manifest()),
  }));
  assert.equal(submit.status, 202);
  const submitted = await submit.json();

  await runtime.waitFor(submitted.task.taskId, (current) => current.status === 'completed');
  const taskResponse = await handleRuntimeFetch(
    runtime,
    new Request(`${baseUrl}/v1/tasks/${submitted.task.taskId}`),
  );
  assert.equal(taskResponse.status, 200);

  const eventsResponse = await handleRuntimeFetch(
    runtime,
    new Request(`${baseUrl}/v1/tasks/${submitted.task.taskId}/events?after=1`),
  );
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.ok(events.events.every((event) => event.sequence > 1));
  assert.equal(events.events.at(-1).type, 'task.completed');

  const invalidCursor = await handleRuntimeFetch(
    runtime,
    new Request(`${baseUrl}/v1/tasks/${submitted.task.taskId}/events?after=-1`),
  );
  assert.equal(invalidCursor.status, 400);

  const terminalSteer = await handleRuntimeFetch(
    runtime,
    new Request(`${baseUrl}/v1/tasks/${submitted.task.taskId}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Too late' }),
    }),
  );
  assert.equal(terminalSteer.status, 409);
});
