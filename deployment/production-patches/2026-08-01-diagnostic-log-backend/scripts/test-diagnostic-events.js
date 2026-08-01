#!/usr/bin/env node

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../backend/overlay/api/server/services/DiagnosticEvents.js',
);

class Schema {
  index() {}
}

const mongoose = {
  Schema,
  models: {},
  isValidObjectId: (value) => /^[a-f0-9]{24}$/i.test(String(value)),
  Types: {
    ObjectId: class ObjectId {
      constructor(value) {
        this.value = String(value);
      }

      toString() {
        return this.value;
      }
    },
  },
};
const logger = { error() {}, info() {}, warn() {} };

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'mongoose') return mongoose;
  if (request === '@librechat/data-schemas') return { logger };
  return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[servicePath];
const service = require(servicePath);
Module._load = originalLoad;

const waitForQueue = async () => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (service.getDiagnosticEventQueueDepth() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Diagnostic event queue did not drain.');
};

const testRedaction = () => {
  const input = JSON.stringify({
    password: 'secret-value',
    access_token: 'jwt-value',
    cookie: 'sid-value',
    nested: { clientSecret: 'nested-secret' },
  });
  const sanitized = service.sanitizeDiagnosticText(input);
  assert.match(sanitized, /"password":"\[redacted\]"/);
  assert.match(sanitized, /"access_token":"\[redacted\]"/);
  assert.match(sanitized, /"cookie":"\[redacted\]"/);
  assert.match(sanitized, /"clientSecret":"\[redacted\]"/);
  assert(!sanitized.includes('secret-value'));
  assert(!sanitized.includes('jwt-value'));
  assert(!sanitized.includes('sid-value'));
  assert(!sanitized.includes('nested-secret'));
};

const testExactTenantLookup = () => {
  const filter = service.buildDiagnosticFilter({
    tenantId: 'tenant-a',
    lookup: 'OFFICE_PREPARSE_INVALID_MANIFEST',
  });
  assert.equal(filter.tenantId, 'tenant-a');
  assert.deepEqual(filter.$or, [
    { requestId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
    { conversationId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
    { streamId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
    { messageId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
    { event: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
    { errorCode: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
  ]);
  assert(!JSON.stringify(filter).includes('$regex'));
  assert.equal(service.buildDiagnosticFilter({}).tenantId, null);
};

const testOneReadList = async () => {
  const lean = async () => [
    {
      _id: { toString: () => '64f000000000000000000001' },
      timestamp: new Date('2026-08-01T00:00:00.000Z'),
      level: 'error',
      event: 'office_preparse_manifest_invalid',
      stage: 'office_preparse',
      stack: 'not selected',
    },
  ];
  const calls = [];
  const query = {
    select(value) {
      calls.push(['select', value]);
      return this;
    },
    sort(value) {
      calls.push(['sort', value]);
      return this;
    },
    limit(value) {
      calls.push(['limit', value]);
      return this;
    },
    lean,
  };
  mongoose.models.DiagnosticEvent = {
    find(filter) {
      calls.push(['find', filter]);
      return query;
    },
  };

  const page = await service.listDiagnosticEventPage({ tenantId: 'tenant-a', limit: 50 });
  assert.equal(calls.filter(([name]) => name === 'find').length, 1);
  assert.deepEqual(calls[0], ['find', { tenantId: 'tenant-a' }]);
  assert.deepEqual(calls[1], ['select', '-stack']);
  assert.deepEqual(calls[2], ['sort', { timestamp: -1, _id: -1 }]);
  assert.deepEqual(calls[3], ['limit', 51]);
  assert.equal(page.entries[0].stack, undefined);
  assert.equal('total' in page, false);
};

const testQueueLimitAndConcurrency = async () => {
  let active = 0;
  let maxActive = 0;
  let creates = 0;
  mongoose.models.DiagnosticEvent = {
    async createIndexes() {},
    create() {
      creates += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        setImmediate(() => {
          active -= 1;
          resolve();
        });
      });
    },
  };

  let accepted = 0;
  for (let index = 0; index < 300; index += 1) {
    if (
      service.recordDiagnosticEvent({
        tenantId: 'tenant-a',
        requestId: `request-${index}`,
        event: 'generation_failed',
        stage: 'generation',
      })
    ) {
      accepted += 1;
    }
  }
  await waitForQueue();
  assert.equal(accepted, 256);
  assert.equal(creates, 256);
  assert.equal(maxActive, 4);
};

Promise.resolve()
  .then(testRedaction)
  .then(testExactTenantLookup)
  .then(testOneReadList)
  .then(testQueueLimitAndConcurrency)
  .then(() => process.stdout.write('diagnostic event focused tests passed\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
