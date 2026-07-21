'use strict';

const assert = require('assert');
const {
  buildGeneratedFilesPipeline,
  createGeneratedFilesHandler,
  escapeRegex,
  formatResult,
  parseQuery,
} = require('../api/generated-files');

async function run() {
  assert.deepStrictEqual(parseQuery({}), { page: 1, limit: 20, query: '' });
  assert.deepStrictEqual(parseQuery({ page: '-5', limit: '500', query: '  report.*  ' }), {
    page: 1,
    limit: 50,
    query: 'report.*',
  });
  assert.strictEqual(escapeRegex('report.*(final)'), 'report\\.\\*\\(final\\)');

  const ownerId = { marker: 'owner-object-id' };
  const pipeline = buildGeneratedFilesPipeline({
    userId: 'owner-string-id',
    fileOwnerId: ownerId,
    tenantId: 'tenant-1',
    options: { page: 2, limit: 20, query: 'final.pptx' },
  });
  const serialized = JSON.stringify(pipeline);
  assert(serialized.includes('"isCreatedByUser":false'));
  assert(serialized.includes('"refs.metadata.artifactRole":{"$ne":"intermediate"}'));
  assert(serialized.includes('"from":"files"'));
  assert(serialized.includes('"file.context":"execute_code"'));
  assert(serialized.includes('"$skip":20'));
  assert(serialized.includes('final\\\\.pptx'));
  assert(serialized.includes('tenant-1'));

  const result = formatResult(
    {
      rows: [
        {
          file_id: 'file/1',
          filename: 'deliverable.pptx',
          conversationId: 'conversation/1',
        },
      ],
      pagination: [{ total: 1 }],
    },
    { page: 1, limit: 20 },
    'user/1',
  );
  assert.strictEqual(result.pagination.pages, 1);
  assert.strictEqual(result.files[0].downloadPath, '/api/files/download/user%2F1/file%2F1');
  assert.strictEqual(result.files[0].conversationPath, '/c/conversation%2F1');
  assert(!serialized.includes('"text":'));
  assert(!serialized.includes('"content":'));

  const invalidResponses = [];
  const invalidHandler = createGeneratedFilesHandler({
    mongoose: { Types: { ObjectId: { isValid: () => false } }, models: {} },
    logger: { error: () => {} },
  });
  await invalidHandler(
    { user: { id: 'invalid' }, query: {} },
    {
      status(code) {
        invalidResponses.push(code);
        return this;
      },
      json(payload) {
        invalidResponses.push(payload);
        return payload;
      },
    },
  );
  assert.deepStrictEqual(invalidResponses, [401, { error: 'Unauthorized' }]);

  let capturedPipeline;
  class ObjectId {
    constructor(value) {
      this.value = value;
    }
    static isValid(value) {
      return value === '507f1f77bcf86cd799439011';
    }
  }
  const handler = createGeneratedFilesHandler({
    mongoose: {
      Types: { ObjectId },
      models: {
        Message: {
          aggregate(nextPipeline) {
            capturedPipeline = nextPipeline;
            return {
              allowDiskUse(value) {
                assert.strictEqual(value, false);
                return this;
              },
              async exec() {
                return [{ rows: [{ file_id: 'file-1', conversationId: 'convo-1' }], pagination: [{ total: 1 }] }];
              },
            };
          },
        },
      },
    },
    logger: { error: () => {} },
  });
  let payload;
  await handler(
    {
      user: { id: '507f1f77bcf86cd799439011', tenantId: 'tenant-1' },
      query: { page: '1', limit: '10' },
    },
    {
      status() {
        throw new Error('valid request should not set an error status');
      },
      json(value) {
        payload = value;
        return value;
      },
    },
  );
  assert.strictEqual(payload.pagination.total, 1);
  assert.strictEqual(payload.files[0].downloadPath, '/api/files/download/507f1f77bcf86cd799439011/file-1');
  assert(JSON.stringify(capturedPipeline).includes('tenant-1'));

  console.log('generated-files contract tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
