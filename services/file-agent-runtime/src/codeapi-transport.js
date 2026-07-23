import {
  ExecutorCanceledError,
  ExecutorExecutionError,
  ExecutorProtocolError,
  ExecutorRejectedError,
  ExecutorTransportError,
} from './executor-adapter.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_TEXT = 2_000;

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_ERROR_TEXT) : '';
}

function validateExecuteRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('CodeAPI execute request must be an object');
  }
  for (const field of ['itemId', 'sessionId', 'command']) {
    if (typeof request[field] !== 'string' || request[field].trim() === '') {
      throw new TypeError(`CodeAPI execute request ${field} is required`);
    }
  }
}

function validateExecuteResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutorProtocolError('CodeAPI response must be a JSON object');
  }
  if (!['success', 'error'].includes(value.status)) {
    throw new ExecutorProtocolError('CodeAPI response status must be success or error');
  }
  if (!Number.isInteger(value.exitCode)) {
    throw new ExecutorProtocolError('CodeAPI response exitCode must be an integer');
  }
  if (value.artifacts != null && !Array.isArray(value.artifacts)) {
    throw new ExecutorProtocolError('CodeAPI response artifacts must be an array');
  }
}

export class CodeApiHttpTransport {
  constructor({ baseUrl, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      throw new TypeError('CodeAPI baseUrl is required');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('CodeAPI fetchImpl must be a function');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('CodeAPI timeoutMs must be a positive integer');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = { ...headers };
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async execute(request) {
    validateExecuteRequest(request);
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/exec`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify({
          item_id: request.itemId,
          session_id: request.sessionId,
          command: request.command,
          injected_files: request.injectedFiles ?? [],
          artifact_paths: request.artifactPaths ?? [],
          timeout_ms: timeoutMs,
        }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new ExecutorCanceledError('CodeAPI request was canceled', { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new ExecutorTransportError(`CodeAPI request timed out after ${timeoutMs} ms`, {
          code: 'EXECUTOR_TIMEOUT',
          cause: error,
        });
      }
      throw new ExecutorTransportError('CodeAPI request failed', { cause: error });
    }

    const responseText = await response.text();
    if (!response.ok) {
      if (response.status >= 500) {
        throw new ExecutorTransportError(
          `CodeAPI returned ${response.status}: ${boundedText(responseText)}`,
          { code: 'EXECUTOR_UPSTREAM_UNAVAILABLE' },
        );
      }
      throw new ExecutorRejectedError(
        `CodeAPI rejected the request with ${response.status}: ${boundedText(responseText)}`,
      );
    }

    let value;
    try {
      value = JSON.parse(responseText);
    } catch (error) {
      throw new ExecutorProtocolError('CodeAPI response was not valid JSON', { cause: error });
    }
    validateExecuteResponse(value);

    const normalized = {
      status: value.status,
      exitCode: value.exitCode,
      stdout: typeof value.stdout === 'string' ? value.stdout : '',
      stderr: typeof value.stderr === 'string' ? value.stderr : '',
      artifacts: value.artifacts ?? [],
      replayed: value.replayed === true,
    };
    if (normalized.status !== 'success' || normalized.exitCode !== 0) {
      throw new ExecutorExecutionError(
        `CodeAPI command exited with code ${normalized.exitCode}`,
        {
          exitCode: normalized.exitCode,
          stderr: boundedText(normalized.stderr),
        },
      );
    }
    return normalized;
  }
}
