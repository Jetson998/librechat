export class ExecutorError extends Error {
  constructor(message, { code = 'EXECUTOR_ERROR', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
  }
}

export class ExecutorTransportError extends ExecutorError {
  constructor(message, options = {}) {
    super(message, { code: 'EXECUTOR_TRANSPORT', retryable: true, ...options });
  }
}

export class ExecutorRejectedError extends ExecutorError {
  constructor(message, options = {}) {
    super(message, { code: 'EXECUTOR_REJECTED', ...options });
  }
}

export class ExecutorExecutionError extends ExecutorError {
  constructor(message, { exitCode, stderr, ...options } = {}) {
    super(message, { code: 'EXECUTOR_EXECUTION', ...options });
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class ExecutorProtocolError extends ExecutorError {
  constructor(message, options = {}) {
    super(message, { code: 'EXECUTOR_PROTOCOL', ...options });
  }
}

export class ExecutorArtifactError extends ExecutorError {
  constructor(message, options = {}) {
    super(message, { code: 'EXECUTOR_ARTIFACT', ...options });
  }
}

export class ExecutorCanceledError extends ExecutorError {
  constructor(message = 'Executor operation was canceled', options = {}) {
    super(message, { code: 'EXECUTOR_CANCELED', ...options });
  }
}

export class ExecutorAdapter {
  prepare() {
    throw new Error('ExecutorAdapter.prepare() is not implemented');
  }

  execute() {
    throw new Error('ExecutorAdapter.execute() is not implemented');
  }

  verify() {
    throw new Error('ExecutorAdapter.verify() is not implemented');
  }

  publish() {
    throw new Error('ExecutorAdapter.publish() is not implemented');
  }
}

export function assertExecutorAdapter(executor) {
  if (!executor || typeof executor !== 'object') {
    throw new TypeError('executor must implement ExecutorAdapter');
  }
  for (const method of ['prepare', 'execute', 'verify', 'publish']) {
    if (typeof executor[method] !== 'function') {
      throw new TypeError(`executor.${method} must be a function`);
    }
  }
  return executor;
}

export function isAbortError(error) {
  return (
    error?.name === 'AbortError' ||
    error instanceof ExecutorCanceledError ||
    error?.code === 'PROVIDER_CANCELED'
  );
}
