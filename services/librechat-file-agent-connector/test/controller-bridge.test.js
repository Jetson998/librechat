import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FileAgentControllerBridge,
  FileAgentHandoffError,
} from '../src/controller-bridge.js';

function request(overrides = {}) {
  return {
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'message-1_',
    streamId: 'conversation-1',
    instruction: '根据上传的工作簿生成汇总 Excel',
    files: [{ fileId: 'file-1' }],
    sessionId: 'session-1',
    modelRouteId: 'file-agent-primary',
    ...overrides,
  };
}

function persisted(overrides = {}) {
  return {
    userMessage: {
      messageId: 'message-1',
      conversationId: 'conversation-1',
    },
    conversation: {
      conversationId: 'conversation-1',
      title: 'New Chat',
    },
    ...overrides,
  };
}

test('ordinary chat remains native without persistence or billing writes', async () => {
  const calls = [];
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => {
        calls.push('prepare');
        return {
          suppressNativeAgent: false,
          decision: { route: 'native', reason: 'not_complex_file_intent' },
        };
      },
      submit: async () => {
        throw new Error('submit must not run');
      },
    },
    prepareRequest: async () => request({ instruction: '你好' }),
    persistUserTurn: async () => {
      calls.push('persist');
    },
    createBillingSnapshot: async () => {
      calls.push('snapshot');
    },
    scheduleReconcile: async () => {
      calls.push('schedule');
    },
  });

  const result = await bridge.tryRoute({ req: {} });

  assert.deepEqual(calls, ['prepare']);
  assert.equal(result.routed, false);
  assert.equal(result.suppressNativeAgent, false);
});

test('host turn constraints can return native before Runtime capability discovery', async () => {
  const calls = [];
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => {
        calls.push('connector');
      },
      submit: async () => {},
    },
    prepareRequest: async () => ({ route: 'native', reason: 'temporary_chat_unsupported' }),
    persistUserTurn: async () => {
      calls.push('persist');
    },
    createBillingSnapshot: async () => {
      calls.push('snapshot');
    },
    scheduleReconcile: async () => {
      calls.push('schedule');
    },
  });

  const result = await bridge.tryRoute({ req: {} });

  assert.deepEqual(calls, []);
  assert.deepEqual(result.decision, {
    route: 'native',
    reason: 'temporary_chat_unsupported',
  });
});

test('a production preflight keeps the request native before request preparation', async () => {
  const calls = [];
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => {
        calls.push('prepare-route');
        throw new Error('must not prepare a native fallback');
      },
      submit: async () => {},
    },
    preflightRequest: async () => ({ route: 'native', reason: 'user_not_allowlisted' }),
    prepareRequest: async () => {
      calls.push('prepare-request');
      throw new Error('must not hash or resolve a native fallback');
    },
    persistUserTurn: async () => {
      calls.push('persist');
    },
    createBillingSnapshot: async () => {
      calls.push('snapshot');
    },
    scheduleReconcile: async () => {
      calls.push('schedule');
    },
  });

  const result = await bridge.tryRoute({ req: {} });

  assert.deepEqual(result.decision, { route: 'native', reason: 'user_not_allowlisted' });
  assert.deepEqual(calls, []);
});

test('an explicit continuation steers the only active task without creating a new billing snapshot', async () => {
  const calls = [];
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => {
        throw new Error('prepareRoute must not run for a continuation');
      },
      submit: async () => {
        throw new Error('submit must not run for a continuation');
      },
      listActiveTasks: async (scope) => {
        calls.push(['list', scope]);
        return [{
          activeTaskId: 'active-task-1',
          taskId: 'task-1',
          capabilityProfile: 'word-edit-v1',
          status: 'needs_input',
          runtimePhase: 'needs_input',
          updatedAt: '2026-08-03T00:00:00.000Z',
        }];
      },
      submitTurn: async (submitted, options) => {
        calls.push(['turn', submitted, options]);
        return {
          accepted: true,
          suppressNativeAgent: true,
          delivery: { deliveryId: 'delivery-turn-1' },
          taskId: 'task-1',
        };
      },
    },
    prepareRequest: async () => ({
      route: 'continuation_candidate',
      userId: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-2',
      assistantMessageId: 'message-2_',
      streamId: 'stream-2',
      instruction: '继续执行。',
    }),
    persistUserTurn: async ({ request }) => {
      calls.push(['persist', request.userMessageId]);
      return {
        userMessage: { messageId: request.userMessageId, conversationId: request.conversationId },
        conversation: { conversationId: request.conversationId, title: 'Existing' },
      };
    },
    createBillingSnapshot: async () => {
      throw new Error('continuation must reuse the active task billing snapshot');
    },
    scheduleReconcile: async ({ submission }) => {
      calls.push(['schedule', submission.delivery.deliveryId]);
    },
  });

  const result = await bridge.tryRoute({ req: {} });

  assert.equal(result.routed, true);
  assert.equal(result.taskId, 'task-1');
  assert.deepEqual(calls.map((entry) => entry[0]), ['list', 'persist', 'turn', 'schedule']);
  assert.equal(calls[2][2].activeTaskId, 'active-task-1');
});

test('eligible work persists before snapshot and Runtime submission', async () => {
  const calls = [];
  const preparedRoute = {
    suppressNativeAgent: true,
    decision: { route: 'runtime', reason: 'eligible_complex_file_task' },
  };
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => {
        calls.push('prepare');
        return preparedRoute;
      },
      submit: async (submitted, options) => {
        calls.push('submit');
        assert.equal(submitted.billingSnapshotRef, 'snapshot-1');
        assert.equal(options.preparedRoute, preparedRoute);
        return {
          accepted: true,
          suppressNativeAgent: true,
          decision: preparedRoute.decision,
          delivery: { deliveryId: 'delivery-1' },
          taskId: 'task-1',
        };
      },
    },
    prepareRequest: async () => request(),
    persistUserTurn: async () => {
      calls.push('persist');
      return persisted();
    },
    createBillingSnapshot: async () => {
      calls.push('snapshot');
      return { snapshotId: 'snapshot-1' };
    },
    scheduleReconcile: async ({ submission }) => {
      calls.push('schedule');
      assert.equal(submission.delivery.deliveryId, 'delivery-1');
    },
  });

  const result = await bridge.tryRoute({ req: {} });

  assert.deepEqual(calls, ['prepare', 'persist', 'snapshot', 'submit', 'schedule']);
  assert.equal(result.routed, true);
  assert.equal(result.suppressNativeAgent, true);
  assert.equal(result.deliveryId, 'delivery-1');
  assert.equal(result.taskId, 'task-1');
});

test('a post-persistence handoff failure never falls back to the native Agent', async () => {
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => ({
        suppressNativeAgent: true,
        decision: { route: 'runtime', reason: 'eligible_complex_file_task' },
      }),
      submit: async () => {
        throw new Error('delivery store unavailable');
      },
    },
    prepareRequest: async () => request(),
    persistUserTurn: async () => persisted(),
    createBillingSnapshot: async () => 'snapshot-1',
    scheduleReconcile: async () => {},
  });

  await assert.rejects(
    bridge.tryRoute({ req: {} }),
    (error) => {
      assert.ok(error instanceof FileAgentHandoffError);
      assert.equal(error.userTurnPersisted, true);
      assert.deepEqual(error.persisted, persisted());
      assert.match(error.message, /after user turn persistence/);
      return true;
    },
  );
});

test('a reconcile scheduling failure keeps the durable Runtime delivery authoritative', async () => {
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => ({
        suppressNativeAgent: true,
        decision: { route: 'runtime', reason: 'eligible_complex_file_task' },
      }),
      submit: async () => ({
        accepted: true,
        suppressNativeAgent: true,
        decision: { route: 'runtime', reason: 'eligible_complex_file_task' },
        delivery: { deliveryId: 'delivery-1' },
        taskId: 'task-1',
      }),
    },
    prepareRequest: async () => request(),
    persistUserTurn: async () => persisted(),
    createBillingSnapshot: async () => 'snapshot-1',
    scheduleReconcile: async () => {
      throw new Error('worker queue unavailable');
    },
  });

  const result = await bridge.tryRoute({ req: {} });

  assert.equal(result.routed, true);
  assert.equal(result.suppressNativeAgent, true);
  assert.deepEqual(result.scheduleError, {
    name: 'Error',
    message: 'worker queue unavailable',
  });
});

test('persisted identities must match the prepared LibreChat turn', async () => {
  const bridge = new FileAgentControllerBridge({
    connector: {
      prepareRoute: async () => ({
        suppressNativeAgent: true,
        decision: { route: 'runtime', reason: 'eligible_complex_file_task' },
      }),
      submit: async () => {
        throw new Error('submit must not run');
      },
    },
    prepareRequest: async () => request(),
    persistUserTurn: async () => persisted({
      userMessage: { messageId: 'other-message', conversationId: 'conversation-1' },
    }),
    createBillingSnapshot: async () => 'snapshot-1',
    scheduleReconcile: async () => {},
  });

  await assert.rejects(
    bridge.tryRoute({ req: {} }),
    (error) => {
      assert.ok(error instanceof FileAgentHandoffError);
      assert.equal(error.userTurnPersisted, false);
      assert.match(error.cause.message, /message identity/);
      return true;
    },
  );
});
