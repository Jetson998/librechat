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
const logger = {
  errors: [],
  infos: [],
  warnings: [],
  error(...args) {
    this.errors.push(args);
  },
  info(...args) {
    this.infos.push(args);
  },
  warn(...args) {
    this.warnings.push(args);
  },
  reset() {
    this.errors = [];
    this.infos = [];
    this.warnings = [];
  },
};

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

const testAllowlistedPrivacyBoundary = () => {
  const secretInput = {
    authToken: 'auth-secret',
    databasePassword: 'db-secret',
    clientToken: 'client-secret',
    ssn: '123-45-6789',
    prompt: 'private user prompt fragment',
  };
  const doc = service.normalizeDiagnosticEvent({
    tenantId: 'tenant-a',
    requestId: 'request-1',
    userId: 'user-1',
    conversationId: 'conversation-1',
    streamId: 'stream-1',
    messageId: 'message-1',
    model: 'claude-opus-5',
    event: 'office_preparse_file_failed',
    stage: 'generation',
    error: {
      code: 'CLIENT_TOKEN',
      name: 'PrivatePromptError',
      message: JSON.stringify(secretInput),
      stack: `stack: ${JSON.stringify(secretInput)}`,
    },
    errorMessage: JSON.stringify(secretInput),
    stack: JSON.stringify(secretInput),
  });

  assert.equal(doc.event, 'office_preparse_file_failed');
  assert.equal(doc.stage, 'office_preparse');
  assert.equal(doc.errorCode, 'OFFICE_PREPARSE_FILE_FAILED');
  assert.equal(doc.errorSummary, 'Office pre-parse could not process a selected file.');
  assert(!Object.hasOwn(doc, 'errorMessage'));
  assert(!Object.hasOwn(doc, 'errorName'));
  assert(!Object.hasOwn(doc, 'stack'));

  const serialized = JSON.stringify(doc);
  for (const secret of Object.values(secretInput)) {
    assert(!serialized.includes(secret));
  }
  assert.throws(
    () => service.normalizeDiagnosticEvent({ event: 'arbitrary_user_supplied_event' }),
    /not allowed/,
  );
  assert.throws(() => service.normalizeDiagnosticEvent({ event: '__proto__' }), /not allowed/);
};

const testRequestContext = () => {
  process.env.DIAGNOSTIC_LOG_HASH_SECRET = 'diagnostic-test-secret';
  const context = service.requestContext(
    {
      id: 'request-1',
      headers: { authorization: 'Bearer should-not-be-stored' },
      user: { id: 'user-1', tenantId: 'tenant-a' },
      body: {
        conversationId: 'conversation-1',
        streamId: 'stream-1',
        messageId: 'message-1',
        endpointOption: { modelOptions: { model: 'claude-opus-5' } },
        text: 'private prompt',
      },
    },
    {},
  );

  assert.deepEqual(context, {
    tenantId: 'tenant-a',
    requestId: 'request-1',
    userIdHash: service.hashUserId('user-1'),
    conversationId: 'conversation-1',
    streamId: 'stream-1',
    messageId: 'message-1',
    model: 'claude-opus-5',
  });
  assert(!JSON.stringify(context).includes('private prompt'));
  assert(!JSON.stringify(context).includes('should-not-be-stored'));
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
      errorSummary: 'Office pre-parse manifest is invalid.',
      errorMessage: 'legacy raw error must not leave the service',
      stack: 'legacy raw stack must not leave the service',
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
  assert.deepEqual(calls[1], ['select', '-stack -errorMessage -errorName']);
  assert.deepEqual(calls[2], ['sort', { timestamp: -1, _id: -1 }]);
  assert.deepEqual(calls[3], ['limit', 51]);
  assert.equal(page.entries[0].errorSummary, 'Office pre-parse manifest is invalid.');
  assert.equal(page.entries[0].stack, undefined);
  assert.equal(page.entries[0].errorMessage, undefined);
  assert.equal('total' in page, false);
};

const testQueueLimitConcurrencyAndRateLimitedOverflow = async () => {
  service.resetDiagnosticEventQueueStats();
  logger.reset();
  let active = 0;
  let maxActive = 0;
  let creates = 0;
  mongoose.models.DiagnosticEvent = {
    async createIndexes() {},
    create(doc) {
      creates += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      assert(!JSON.stringify(doc).includes('auth-secret'));
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
        error: {
          message: 'private user prompt fragment auth-secret 123-45-6789',
          stack: 'private stack auth-secret',
        },
      })
    ) {
      accepted += 1;
    }
  }
  await waitForQueue();

  const stats = service.getDiagnosticEventQueueStats();
  assert.equal(accepted, 256);
  assert.equal(creates, 256);
  assert.equal(maxActive, 4);
  assert.equal(stats.droppedWrites, 44);
  assert.equal(stats.pendingWrites, 0);
  assert.equal(
    logger.warnings.filter(([label]) => label === '[diagnostic-event] persistence queue overflow')
      .length,
    1,
  );

  const stdoutPayload = JSON.stringify([...logger.errors, ...logger.infos, ...logger.warnings]);
  assert(!stdoutPayload.includes('auth-secret'));
  assert(!stdoutPayload.includes('private user prompt fragment'));
  assert(!stdoutPayload.includes('123-45-6789'));
  assert(!stdoutPayload.includes('private stack'));
};

Promise.resolve()
  .then(testAllowlistedPrivacyBoundary)
  .then(testRequestContext)
  .then(testExactTenantLookup)
  .then(testOneReadList)
  .then(testQueueLimitConcurrencyAndRateLimitedOverflow)
  .then(() => process.stdout.write('diagnostic event focused tests passed\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
