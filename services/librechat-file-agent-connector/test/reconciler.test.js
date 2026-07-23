import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { FileAgentReconciler } from '../src/reconciler.js';

test('reconciler deduplicates immediate delivery wakes', async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const reconciler = new FileAgentReconciler({
    connector: {
      reconcile: async (deliveryId) => {
        calls += 1;
        await blocked;
        return deliveryId;
      },
      reconcileAll: async () => [],
    },
  });

  const first = reconciler.wake('delivery-1');
  const second = reconciler.wake('delivery-1');
  assert.equal(first, second);
  release();
  assert.equal(await first, 'delivery-1');
  assert.equal(calls, 1);
});

test('reconciler periodically scans recoverable deliveries and stops cleanly', async () => {
  let scans = 0;
  const reconciler = new FileAgentReconciler({
    intervalMs: 50,
    connector: {
      reconcile: async () => null,
      reconcileAll: async () => {
        scans += 1;
        return [];
      },
    },
  });

  reconciler.start();
  await delay(125);
  await reconciler.stop();
  const stoppedAt = scans;
  await delay(75);

  assert.ok(stoppedAt >= 2);
  assert.equal(scans, stoppedAt);
});
