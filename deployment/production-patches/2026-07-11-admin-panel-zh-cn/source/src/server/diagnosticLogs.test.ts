import { beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_AUDIT_LOG_CAPABILITY, READ_DIAGNOSTIC_LOGS_CAPABILITY } from '@/constants';

const apiFetchMock = vi.fn();
const requireAnyCapabilityMock = vi.fn(async () => undefined);

vi.mock('./utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  extractApiError: vi.fn(async (_response: unknown, message: string) => {
    throw new Error(message);
  }),
}));

vi.mock('./capabilities', () => ({
  requireAnyCapability: (...args: unknown[]) => requireAnyCapabilityMock(...args),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    handler: (fn: (...args: unknown[]) => unknown) => fn,
    inputValidator: () => ({
      handler: (fn: (...args: unknown[]) => unknown) => fn,
    }),
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  queryOptions: (options: unknown) => options,
}));

import {
  buildDiagnosticLogQuery,
  getDiagnosticLogPageFn,
  parseDiagnosticLogPage,
} from './diagnosticLogs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('diagnostic log client contract', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    requireAnyCapabilityMock.mockClear();
  });

  it('serializes filters and pagination without empty values', () => {
    const params = new URLSearchParams(
      buildDiagnosticLogQuery({
        q: 'manifest invalid',
        level: 'error',
        stage: 'office_preparse',
        from: '2026-07-31',
        to: '2026-08-01',
        conversationId: 'conversation-1',
        streamId: 'stream-1',
        page: 3,
        limit: 25,
      }),
    );

    expect(Object.fromEntries(params)).toEqual({
      q: 'manifest invalid',
      level: 'error',
      stage: 'office_preparse',
      from: '2026-07-31',
      to: '2026-08-01',
      conversationId: 'conversation-1',
      streamId: 'stream-1',
      page: '3',
      limit: '25',
    });
  });

  it('parses bounded metadata and discards sensitive unknown fields', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        entries: [
          {
            id: 'event-1',
            timestamp: '2026-07-31T08:14:43.655Z',
            level: 'error',
            event: 'office_preparse_manifest_invalid',
            stage: 'office_preparse',
            requestId: 'request-1',
            conversationId: 'conversation-1',
            model: 'claude-opus-5',
            errorName: 'SyntaxError',
            errorMessage: 'line one\nline two',
            prompt: 'do not return this',
            fileContent: 'private document body',
            authorization: 'Bearer secret',
            toolOutput: 'raw tool result',
          },
        ],
        total: 1,
        nextCursor: null,
        rawUserMessage: 'private message',
      }),
    );

    const result = await getDiagnosticLogPageFn({ data: { page: 2, limit: 25 } });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.entries[0]).toMatchObject({
      event: 'office_preparse_manifest_invalid',
      errorMessage: 'line one line two',
    });
    expect(result.entries[0]).not.toHaveProperty('prompt');
    expect(result.entries[0]).not.toHaveProperty('fileContent');
    expect(result.entries[0]).not.toHaveProperty('authorization');
    expect(result.entries[0]).not.toHaveProperty('toolOutput');

    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/diagnostic-events?page=2&limit=25'),
    );
    expect(requireAnyCapabilityMock).toHaveBeenCalledWith([
      READ_DIAGNOSTIC_LOGS_CAPABILITY,
      READ_AUDIT_LOG_CAPABILITY,
    ]);
  });

  it.each([
    [404, 'not_configured'],
    [503, 'unavailable'],
  ] as const)('returns an explicit fallback for HTTP %s', async (status, reason) => {
    apiFetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(getDiagnosticLogPageFn({ data: {} })).resolves.toEqual({
      available: false,
      reason,
    });
  });

  it('rejects a response with an unbounded or malformed timestamp', () => {
    expect(() =>
      parseDiagnosticLogPage({
        entries: [
          {
            id: 'event-1',
            timestamp: 'not-a-timestamp',
            level: 'error',
            event: 'bad',
            stage: 'request',
          },
        ],
        total: 1,
        nextCursor: null,
      }),
    ).toThrow();
  });
});
