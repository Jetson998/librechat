import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSteerTurn } from '../src/turn-delivery.js';

const activeTask = {
  activeTaskId: 'active-1',
  taskId: 'task-1',
  user: 'user-1',
  tenantId: 'tenant-1',
  conversationId: 'conversation-1',
  taskContractVersion: 'office-file-agent.v1.1',
  capabilityProfile: 'word-edit-v1',
  billingSnapshotRef: 'billing-1',
  modelRouteId: 'file-agent-primary',
  runtimePhase: 'needs_input',
  latestSequence: 18,
  usageReceipts: { 'usage-1': 'completed' },
  artifactReceipts: {},
};

test('steer turn keeps task identity, starts after the task cursor, and is idempotent', () => {
  const first = buildSteerTurn({
    activeTask,
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-2',
    assistantMessageId: 'assistant-message-2',
    streamId: 'stream-2',
    instructionId: 'instruction-2',
    instruction: '继续修改表格并保留原有格式。',
    billingSnapshotRef: 'billing-1',
    modelRouteId: 'file-agent-primary',
  });
  const replay = buildSteerTurn({
    activeTask,
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-2',
    assistantMessageId: 'assistant-message-2',
    streamId: 'stream-2',
    instructionId: 'instruction-2',
    instruction: '继续修改表格并保留原有格式。',
    billingSnapshotRef: 'billing-1',
    modelRouteId: 'file-agent-primary',
  });
  assert.equal(first.idempotencyKey, replay.idempotencyKey);
  assert.equal(first.record.taskId, 'task-1');
  assert.equal(first.record.lastSequence, 18);
  assert.deepEqual(first.record.usageReceipts, { 'usage-1': 'completed' });
  assert.equal(first.manifest.turnType, 'steer');
});

test('steer turn rejects scope, billing, and route changes', () => {
  const base = {
    activeTask,
    userId: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-2',
    assistantMessageId: 'assistant-message-2',
    streamId: 'stream-2',
    instruction: '继续',
  };
  assert.throws(() => buildSteerTurn({ ...base, tenantId: 'tenant-2' }), /active task scope/);
  assert.throws(() => buildSteerTurn({ ...base, billingSnapshotRef: 'billing-2' }), /billing snapshot/);
  assert.throws(() => buildSteerTurn({ ...base, modelRouteId: 'other-route' }), /model route/);
});
