const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  MAX_CONCURRENT_WRITES,
  MAX_QUEUE_DEPTH,
  buildDiagnosticFilter,
  getDiagnosticEventQueueDepth,
  getDiagnosticEventQueueStats,
  hashUserId,
  listDiagnosticEventPage,
  normalizeDiagnosticEvent,
  recordDiagnosticEvent,
  requestContext,
  resetDiagnosticEventQueueStats,
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
  let errorSpy;
  let warnSpy;

  beforeAll(() => {
    jest.spyOn(logger, 'debug').mockImplementation(() => {});
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
    if (originalHashSecret === undefined) delete process.env.DIAGNOSTIC_LOG_HASH_SECRET;
    else process.env.DIAGNOSTIC_LOG_HASH_SECRET = originalHashSecret;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('persists only a static allowlisted summary for an arbitrary Error object', () => {
    const secrets = {
      authToken: 'auth-secret',
      databasePassword: 'db-secret',
      clientToken: 'client-secret',
      ssn: '123-45-6789',
      prompt: 'private user prompt fragment',
    };
    const doc = normalizeDiagnosticEvent({
      tenantId: 'tenant-a',
      requestId: 'request-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      messageId: 'message-1',
      model: 'claude-opus-5',
      event: 'office_preparse_file_failed',
      error: {
        code: 'CLIENT_TOKEN',
        name: 'PrivatePromptError',
        message: JSON.stringify(secrets),
        stack: JSON.stringify(secrets),
      },
      errorMessage: JSON.stringify(secrets),
      stack: JSON.stringify(secrets),
    });

    expect(doc).toMatchObject({
      event: 'office_preparse_file_failed',
      stage: 'office_preparse',
      errorCode: 'OFFICE_PREPARSE_FILE_FAILED',
      errorSummary: 'Office pre-parse could not process a selected file.',
    });
    expect(doc).not.toHaveProperty('errorName');
    expect(doc).not.toHaveProperty('errorMessage');
    expect(doc).not.toHaveProperty('stack');
    for (const secret of Object.values(secrets)) {
      expect(JSON.stringify(doc)).not.toContain(secret);
    }
    expect(() =>
      normalizeDiagnosticEvent({ event: 'arbitrary_user_supplied_event' }),
    ).toThrow(/not allowed/);
    expect(() => normalizeDiagnosticEvent({ event: '__proto__' })).toThrow(/not allowed/);
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
    expect(JSON.stringify(context)).not.toContain('private prompt');
    expect(JSON.stringify(context)).not.toContain('should-not-be-stored');
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

  it('uses one indexed list read and excludes legacy raw fields', async () => {
    const previousModel = mongoose.models.DiagnosticEvent;
    const lean = jest.fn().mockResolvedValue([
      {
        _id: { toString: () => '64f000000000000000000001' },
        timestamp: new Date('2026-08-01T00:00:00.000Z'),
        level: 'error',
        event: 'office_preparse_manifest_invalid',
        stage: 'office_preparse',
        errorSummary: 'Office pre-parse manifest is invalid.',
        errorMessage: 'legacy raw error must not be returned',
        stack: 'legacy raw stack must not be returned',
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
      expect(query.select).toHaveBeenCalledWith('-stack -errorMessage -errorName');
      expect(query.sort).toHaveBeenCalledWith({ timestamp: -1, _id: -1 });
      expect(query.limit).toHaveBeenCalledWith(51);
      expect(page.entries[0]).toMatchObject({
        id: '64f000000000000000000001',
        event: 'office_preparse_manifest_invalid',
        errorSummary: 'Office pre-parse manifest is invalid.',
      });
      expect(page.entries[0]).not.toHaveProperty('stack');
      expect(page.entries[0]).not.toHaveProperty('errorMessage');
      expect(page).not.toHaveProperty('total');
    } finally {
      if (previousModel === undefined) delete mongoose.models.DiagnosticEvent;
      else mongoose.models.DiagnosticEvent = previousModel;
    }
  });

  it('rate-limits overflow warnings while bounding writes at four workers', async () => {
    const previousModel = mongoose.models.DiagnosticEvent;
    resetDiagnosticEventQueueStats();
    errorSpy.mockClear();
    warnSpy.mockClear();
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let creates = 0;
    const model = {
      createIndexes: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(
        (doc) =>
          new Promise((resolve) => {
            creates += 1;
            activeWrites += 1;
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            expect(JSON.stringify(doc)).not.toContain('auth-secret');
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
          requestId: 'request-' + index,
          error: {
            message: 'private user prompt fragment auth-secret 123-45-6789',
            stack: 'private stack auth-secret',
          },
        }),
      ).filter(Boolean).length;

      expect(accepted).toBe(MAX_QUEUE_DEPTH);
      await waitFor(() => getDiagnosticEventQueueDepth() === 0);
      expect(creates).toBe(MAX_QUEUE_DEPTH);
      expect(maxActiveWrites).toBeLessThanOrEqual(MAX_CONCURRENT_WRITES);
      expect(maxActiveWrites).toBe(MAX_CONCURRENT_WRITES);
      expect(getDiagnosticEventQueueStats()).toMatchObject({
        pendingWrites: 0,
        droppedWrites: 44,
      });
      expect(
        warnSpy.mock.calls.filter(([label]) => label === '[diagnostic-event] persistence queue overflow'),
      ).toHaveLength(1);

      const structuredOutput = JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(structuredOutput).not.toContain('auth-secret');
      expect(structuredOutput).not.toContain('private user prompt fragment');
      expect(structuredOutput).not.toContain('123-45-6789');
      expect(structuredOutput).not.toContain('private stack');
    } finally {
      if (previousModel === undefined) delete mongoose.models.DiagnosticEvent;
      else mongoose.models.DiagnosticEvent = previousModel;
    }
  });
});
