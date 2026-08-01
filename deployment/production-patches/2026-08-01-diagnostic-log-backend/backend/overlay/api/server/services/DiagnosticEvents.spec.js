const {
  buildDiagnosticFilter,
  hashUserId,
  requestContext,
  sanitizeDiagnosticText,
  sanitizeStack,
} = require('./DiagnosticEvents');

describe('DiagnosticEvents', () => {
  const originalHashSecret = process.env.DIAGNOSTIC_LOG_HASH_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterAll(() => {
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

  it('redacts credentials and sandbox file paths from error text', () => {
    const sanitized = sanitizeDiagnosticText(
      'parser failed secret=topsecret /mnt/data/private.docx',
    );

    expect(sanitized).toBe('parser failed secret=[redacted] /mnt/data/[redacted-file]');
    expect(sanitized).not.toContain('topsecret');
    expect(sanitized).not.toContain('private.docx');
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
        user: { id: 'user-1' },
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

  it('builds an escaped, indexed correlation filter', () => {
    const filter = buildDiagnosticFilter({
      q: 'manifest.+',
      level: 'error',
      stage: 'office_preparse',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      from: '2026-07-31',
      to: '2026-08-01',
    });

    expect(filter).toMatchObject({
      level: 'error',
      stage: 'office_preparse',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      timestamp: {
        $gte: new Date('2026-07-31T00:00:00.000Z'),
        $lte: new Date('2026-08-01T23:59:59.999Z'),
      },
    });
    expect(filter.$or).toEqual(
      expect.arrayContaining([
        { event: { $regex: 'manifest\\.\\+', $options: 'i' } },
        { requestId: expect.any(Object) },
      ]),
    );
  });
});
