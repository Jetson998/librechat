import path from 'node:path';

import {
  ExecutorCanceledError,
  ExecutorExecutionError,
  ExecutorProtocolError,
  ExecutorRejectedError,
  ExecutorTransportError,
} from './executor-adapter.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_TEXT = 2_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_ERROR_TEXT) : '';
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  const parsed = new URL(requiredString(value, 'LibreChat CodeAPI baseUrl'));
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('LibreChat CodeAPI baseUrl must not contain credentials, query, or fragment');
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeInjectedFile(file, defaults) {
  if (!file || typeof file !== 'object') {
    throw new TypeError('LibreChat CodeAPI injected file must be an object');
  }
  const fileId = requiredString(file.file_id ?? file.id, 'injected file file_id');
  const storageSessionId = requiredString(
    file.storage_session_id ?? file.session_id,
    'injected file storage_session_id',
  );
  const name = requiredString(file.name, 'injected file name');
  const kind = requiredString(file.kind ?? defaults.resourceKind, 'injected file kind');
  const resourceId = requiredString(
    file.resource_id ?? file.resourceId ?? defaults.resourceId,
    'injected file resource_id',
  );
  return {
    id: fileId,
    source_file_id: file.source_file_id ?? file.sourceFileId ?? fileId,
    resource_id: resourceId,
    storage_session_id: storageSessionId,
    name,
    kind,
    ...(kind === 'skill' && file.version ? { version: file.version } : {}),
  };
}

function mimeTypeFor(filename) {
  return path.posix.extname(filename).toLowerCase() === '.xlsx'
    ? XLSX_MIME
    : 'application/octet-stream';
}

function normalizeOutputFiles(value, request, responseSessionId) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ExecutorProtocolError('LibreChat CodeAPI response files must be an array');
  }
  if (!request.artifactPaths?.length) {
    return [];
  }

  const requested = request.artifactPaths.map((artifactPath) => ({
    artifactPath,
    relativeName: artifactPath.replace(/^\/mnt\/data\//, ''),
    basename: path.posix.basename(artifactPath),
  }));

  return requested.map(({ artifactPath, relativeName, basename }) => {
    const matches = value.filter((file) => {
      const name = typeof file?.name === 'string' ? file.name.replace(/^\/mnt\/data\//, '') : '';
      return name === relativeName || name === basename || file?.path === artifactPath;
    });
    if (matches.length !== 1) {
      throw new ExecutorProtocolError(
        `LibreChat CodeAPI returned ${matches.length} matches for artifact ${basename}`,
      );
    }
    const file = matches[0];
    const fileId = requiredString(file.id ?? file.file_id ?? file.fileId, 'artifact file id');
    const storageSessionId = requiredString(
      file.storage_session_id ?? file.session_id ?? responseSessionId ?? request.sessionId,
      'artifact storage session id',
    );
    return {
      name: relativeName,
      mimeType: mimeTypeFor(relativeName),
      codeEnvRef: {
        storage_session_id: storageSessionId,
        file_id: fileId,
      },
    };
  });
}

export class LibreChatCodeApiTransport {
  constructor({
    baseUrl,
    headers = {},
    resourceKind = 'user',
    resourceId,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('LibreChat CodeAPI fetchImpl must be a function');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('LibreChat CodeAPI timeoutMs must be a positive integer');
    }
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.headers = { ...headers };
    this.resourceKind = requiredString(resourceKind, 'LibreChat CodeAPI resourceKind');
    this.resourceId = requiredString(resourceId, 'LibreChat CodeAPI resourceId');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async execute(request) {
    if (!request || typeof request !== 'object') {
      throw new TypeError('LibreChat CodeAPI execute request must be an object');
    }
    const sessionId = requiredString(request.sessionId, 'CodeAPI request sessionId');
    const command = requiredString(request.command, 'CodeAPI request command');
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.timeoutMs) {
      throw new TypeError(`LibreChat CodeAPI request timeout must be between 1 and ${this.timeoutMs}`);
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;
    const files = (request.injectedFiles ?? []).map((file) =>
      normalizeInjectedFile(file, {
        resourceKind: this.resourceKind,
        resourceId: this.resourceId,
      }),
    );

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/exec`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'LibreChat-File-Agent-Runtime/1.0',
          ...this.headers,
        },
        body: JSON.stringify({
          lang: 'bash',
          code: command,
          session_id: sessionId,
          files,
        }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new ExecutorCanceledError('LibreChat CodeAPI request was canceled', { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new ExecutorTransportError(
          `LibreChat CodeAPI request timed out after ${timeoutMs} ms`,
          { code: 'EXECUTOR_TIMEOUT', cause: error },
        );
      }
      throw new ExecutorTransportError('LibreChat CodeAPI request failed', { cause: error });
    }

    const responseText = await response.text();
    if (!response.ok) {
      if (response.status >= 500) {
        throw new ExecutorTransportError(
          `LibreChat CodeAPI returned ${response.status}: ${boundedText(responseText)}`,
          { code: 'EXECUTOR_UPSTREAM_UNAVAILABLE' },
        );
      }
      throw new ExecutorRejectedError(
        `LibreChat CodeAPI rejected the request with ${response.status}: ${boundedText(responseText)}`,
      );
    }

    let value;
    try {
      value = JSON.parse(responseText);
    } catch (error) {
      throw new ExecutorProtocolError('LibreChat CodeAPI response was not valid JSON', {
        cause: error,
      });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ExecutorProtocolError('LibreChat CodeAPI response must be a JSON object');
    }

    const exitCode = value.exitCode ?? value.exit_code ?? (value.error ? 1 : 0);
    if (!Number.isInteger(exitCode)) {
      throw new ExecutorProtocolError('LibreChat CodeAPI response exit code must be an integer');
    }
    const stdout = typeof value.stdout === 'string' ? value.stdout : '';
    const stderr = typeof value.stderr === 'string' ? value.stderr : boundedText(value.error);
    if (exitCode !== 0) {
      throw new ExecutorExecutionError(`LibreChat CodeAPI command exited with code ${exitCode}`, {
        exitCode,
        stderr: boundedText(stderr),
      });
    }

    return {
      status: 'success',
      exitCode,
      stdout,
      stderr,
      artifacts: normalizeOutputFiles(value.files, request, value.session_id),
      replayed: false,
    };
  }
}
