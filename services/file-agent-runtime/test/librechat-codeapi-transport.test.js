import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutorExecutionError,
  ExecutorProtocolError,
  ExecutorRejectedError,
  ExecutorTransportError,
} from '../src/executor-adapter.js';
import { LibreChatCodeApiTransport } from '../src/librechat-codeapi-transport.js';

const request = {
  itemId: 'runtime-item-1',
  sessionId: 'session-1',
  command: 'cp /mnt/data/source.xlsx /mnt/data/output/result.xlsx',
  injectedFiles: [{
    name: 'source.xlsx',
    storage_session_id: 'session-1',
    file_id: 'input-1',
  }],
  artifactPaths: ['/mnt/data/output/result.xlsx'],
  timeoutMs: 20_000,
};

function transport(fetchImpl) {
  return new LibreChatCodeApiTransport({
    baseUrl: 'https://codeapi.test/',
    headers: { authorization: 'Bearer test-only' },
    resourceId: 'test-user',
    fetchImpl,
  });
}

test('maps Runtime execution to the LibreChat CodeAPI protocol and returns one XLSX ref', async () => {
  let observed;
  const result = await transport(async (url, init) => {
    observed = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      stdout: 'done',
      stderr: '',
      session_id: 'session-1',
      files: [{ id: 'output-1', name: 'output/result.xlsx' }],
    }), { status: 200 });
  }).execute(request);

  assert.equal(observed.url, 'https://codeapi.test/exec');
  assert.equal(observed.init.headers.authorization, 'Bearer test-only');
  assert.deepEqual(observed.body, {
    lang: 'bash',
    code: request.command,
    session_id: 'session-1',
    files: [{
      id: 'input-1',
      source_file_id: 'input-1',
      resource_id: 'test-user',
      storage_session_id: 'session-1',
      name: 'source.xlsx',
      kind: 'user',
    }],
  });
  assert.deepEqual(result, {
    status: 'success',
    exitCode: 0,
    stdout: 'done',
    stderr: '',
    artifacts: [{
      name: 'output/result.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      codeEnvRef: {
        storage_session_id: 'session-1',
        file_id: 'output-1',
      },
    }],
    replayed: false,
  });
});

test('ignores CodeAPI files until publish requests explicit artifact paths', async () => {
  const result = await transport(async () => new Response(JSON.stringify({
    stdout: 'prepared',
    stderr: '',
    session_id: 'session-1',
    files: [{ id: 'intermediate-1', name: '.agent/script.py' }],
  }), { status: 200 })).execute({ ...request, artifactPaths: undefined });
  assert.deepEqual(result.artifacts, []);
});

test('fails closed when the requested artifact is absent or ambiguous', async () => {
  await assert.rejects(
    transport(async () => new Response(JSON.stringify({
      stdout: '', stderr: '', session_id: 'session-1', files: [],
    }), { status: 200 })).execute(request),
    ExecutorProtocolError,
  );
  await assert.rejects(
    transport(async () => new Response(JSON.stringify({
      stdout: '',
      stderr: '',
      session_id: 'session-1',
      files: [
        { id: 'output-1', name: 'result.xlsx' },
        { id: 'output-2', name: 'result.xlsx' },
      ],
    }), { status: 200 })).execute(request),
    ExecutorProtocolError,
  );
});

test('maps HTTP, protocol, and execution failures without exposing response bodies beyond bounds', async () => {
  await assert.rejects(
    transport(async () => new Response('denied', { status: 403 })).execute(request),
    ExecutorRejectedError,
  );
  await assert.rejects(
    transport(async () => new Response('unavailable', { status: 503 })).execute(request),
    (error) => error instanceof ExecutorTransportError && error.retryable === true,
  );
  await assert.rejects(
    transport(async () => new Response('not-json', { status: 200 })).execute(request),
    ExecutorProtocolError,
  );
  await assert.rejects(
    transport(async () => new Response(JSON.stringify({
      exit_code: 7,
      stdout: '',
      stderr: 'fixture failure',
      files: [],
    }), { status: 200 })).execute(request),
    (error) => error instanceof ExecutorExecutionError && error.exitCode === 7,
  );
});

test('requires bounded timeouts and complete resource identity', async () => {
  assert.throws(
    () => new LibreChatCodeApiTransport({ baseUrl: 'https://codeapi.test', resourceId: '' }),
    /resourceId is required/,
  );
  await assert.rejects(
    transport(async () => new Response('{}', { status: 200 })).execute({
      ...request,
      timeoutMs: 31_000,
    }),
    /timeout must be between/,
  );
});
