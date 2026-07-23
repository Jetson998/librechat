import assert from 'node:assert/strict';
import test from 'node:test';

import { IsolatedModelRelay } from './isolated-model-relay.js';

function relayRequest(baseUrl, callId) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': callId,
    },
    body: JSON.stringify({
      model: 'recorded-office-planner',
      messages: [{ role: 'user', content: JSON.stringify({ operation: 'plan', context: {} }) }],
    }),
  }).then((response) => response.json());
}

test('isolated relay coalesces concurrent requests with the same idempotency key', async (t) => {
  const relay = await new IsolatedModelRelay({
    responseFor: async ({ operation }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { schemaVersion: '1.0', operation };
    },
  }).start();
  t.after(() => relay.stop());

  const [first, second] = await Promise.all([
    relayRequest(relay.baseUrl, 'same-call'),
    relayRequest(relay.baseUrl, 'same-call'),
  ]);

  assert.deepEqual(first, second);
  assert.equal(relay.executionCount('same-call'), 1);
  assert.equal(relay.requests.length, 2);
});
