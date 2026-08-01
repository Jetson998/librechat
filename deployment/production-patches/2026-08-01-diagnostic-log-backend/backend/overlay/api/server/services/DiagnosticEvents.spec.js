const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  MAX_CONCURRENT_WRITES,
  MAX_QUEUE_DEPTH,
  buildDiagnosticFilter,
  getDiagnosticEventQueueDepth,
  hashUserId,
  listDiagnosticEventPage,
  recordDiagnosticEvent,
  requestContext,
  sanitizeDiagnosticText,
  sanitizeStack,
} = require('./DiagnosticEvents');

const waitFor = async (predicate, attempts = 400) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out while waiting for diagnostic-event queue to drain.');
};

describe('DiagnosticEvents', () => {
  const originalHashSecret = process.env.DIAGNOSTIC_LOG_HASH_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    jest.spyOn(logger, 'debug').mockImplementation(() => {});
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
    if (originalHashSecret === undefined) delete process.env.DIAGNOSTIC_LOG_HASH_SECRET;
    else process.env.DIAGNOSTIC_LOG_HASH_SECRET = originalHashSecret;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('redacts credentials and sandbox file paths from stack text', () => {
    const sanitized = sanitizeStack(
      'Bearer abc.def secret=topsecret api-key: sk-test sk-standalone /mnt/data/private.docx',
    );

    expect(sanitized).toContain('Bearer [redacted]');
    expect(sanitized).toContain('secret=[redacted]');
    expect(sanitized).toContain('api-key=[redacted]');
    expect(sanitized).toContain('[redacted-key]');
    expect(sanitized).toContain('/mnt/data/[redacted-file]');
    expect(sanitized).not.toContain('topsecret');
    expect(sanitized).not.toContain('private.docx');
  });

  it('redacts JSON-form credentials before any diagnostic text is persisted', () => {
    const input = JSON.stringify({
      password: 'secret-value',
      access_token: 'jwt-value',
      cookie: 'sid-value',
      nested: { clientSecret: 'nested-secret' },
    });
    const sanitized = sanitizeDiagnosticText(input);
    const stack = sanitizeStack(`upstream error: ${input}`);

    expect(sanitized).toContain('"password":"[redacted]"');
    expect(sanitized).toContain('"access_token":"[redacted]"');
    expect(sanitized).toContain('"cookie":"[redacted]"');
    expect(sanitized).toContain('"clientSecret":"[redacted]"');
    expect(stack).not.toContain('secret-value');
    expect(stack).not.toContain('jwt-value');
    expect(stack).not.toContain('sid-value');
    expect(stack).not.toContain('nested-secret');
  });

  it('uses the configured HMAC secret and omits user hashes without one', () => {
    delete process.env.DIAGNOSTIC_LOG_HASH_SECRET;
    delete process.env.JWT_SECRET;
    expect(hashUserId('user-1')).toBeUndefined();

    process.env.DIAGNOSTIC_LOG_HASH_SECRET = 'diagnostic-test-secret';
    const first = hashUserId('user-1');
    const second = hashUserId('user-1');
    expect(first).toMatch(/^[a-f0-9]{24}$/);
    expect(second).toBe(first);
    expect(hashUserId('user-2')).not.toBe(first);
  });

  it('keeps only bounded correlation metadata in the request context', () => {
    process.env.DIAGNOSTIC_LOG_HASH_SECRET = 'diagnostic-test-secret';
    const context = requestContext(
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

    expect(context).toMatchObject({
      tenantId: 'tenant-a',
      requestId: 'request-1',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      messageId: 'message-1',
      model: 'claude-opus-5',
    });
    expect(context).toHaveProperty('userIdHash');
    expect(context).not.toHaveProperty('text');
    expect(context).not.toHaveProperty('authorization');
  });

  it('uses exact, indexed lookups and never treats a missing tenant as global access', () => {
    const filter = buildDiagnosticFilter({
      lookup: 'OFFICE_PREPARSE_INVALID_MANIFEST',
      tenantId: 'tenant-a',
      level: 'error',
      stage: 'office_preparse',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      from: '2026-07-31',
      to: '2026-08-01',
    });

    expect(filter).toMatchObject({
      tenantId: 'tenant-a',
      level: 'error',
      stage: 'office_preparse',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      timestamp: {
        $gte: new Date('2026-07-31T00:00:00.000Z'),
        $lte: new Date('2026-08-01T23:59:59.999Z'),
      },
    });
    expect(filter.$or).toEqual([
      { requestId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
      { conversationId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
      { streamId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
      { messageId: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
      { event: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
      { errorCode: 'OFFICE_PREPARSE_INVALID_MANIFEST' },
    ]);
    expect(JSON.stringify(filter)).not.toContain('$regex');
    expect(buildDiagnosticFilter({ lookup: 'request-1' }).tenantId).toBeNull();
  });

  it('uses one stack-free indexed list query instead of page-level counts', async () => {
    const previousModel = mongoose.models.DiagnosticEvent;
    const lean = jest.fn().mockResolvedValue([
      {
        _id: { toString: () => '64f000000000000000000001' },
        timestamp: new Date('2026-08-01T00:00:00.000Z'),
        level: 'error',
        event: 'office_preparse_manifest_invalid',
        stage: 'office_preparse',
        stack: 'must not be selected for list responses',
      },
    ]);
    const query = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean,
    };
    const model = { find: jest.fn(() => query) };
    mongoose.models.DiagnosticEvent = model;

    try {
      const page = await listDiagnosticEventPage({ tenantId: 'tenant-a', limit: 50 });
      expect(model.find).toHaveBeenCalledTimes(1);
      expect(model.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
      expect(query.select).toHaveBeenCalledWith('-stack');
      expect(query.sort).toHaveBeenCalledWith({ timestamp: -1, _id: -1 });
      expect(query.limit).toHaveBeenCalledWith(51);
      expect(page).toEqual({
        entries: [
          expect.objectContaining({
            id: '64f000000000000000000001',
            event: 'office_preparse_manifest_invalid',
          }),
        ],
        nextCursor: null,
      });
      expect(page.entries[0]).not.toHaveProperty('stack');
      expect(page).not.toHaveProperty('total');
    } finally {
      if (previousModel === undefined) delete mongoose.models.DiagnosticEvent;
      else mongoose.models.DiagnosticEvent = previousModel;
    }
  });

  it('accepts at most 256 outstanding writes and runs no more than four creates at once', async () => {
    const previousModel = mongoose.models.DiagnosticEvent;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let creates = 0;
    const model = {
      createIndexes: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(
        () =>
          new Promise((resolve) => {
            creates += 1;
            activeWrites += 1;
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            setImmediate(() => {
              activeWrites -= 1;
              resolve();
            });
          }),
      ),
    };
    mongoose.models.DiagnosticEvent = model;

    try {
      const accepted = Array.from({ length: 300 }, (_, index) =>
        recordDiagnosticEvent({
          event: 'generation_failed',
          stage: 'generation',
          tenantId: 'tenant-a',
          requestId: `request-${index}`,
        }),
      ).filter(Boolean).length;

      expect(accepted).toBe(MAX_QUEUE_DEPTH);
      await waitFor(() => getDiagnosticEventQueueDepth() === 0);
      expect(creates).toBe(MAX_QUEUE_DEPTH);
      expect(maxActiveWrites).toBeLessThanOrEqual(MAX_CONCURRENT_WRITES);
      expect(maxActiveWrites).toBe(MAX_CONCURRENT_WRITES);
    } finally {
      if (previousModel === undefined) delete mongoose.models.DiagnosticEvent;
      else mongoose.models.DiagnosticEvent = previousModel;
    }
  });
});
