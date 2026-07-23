export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
  }
}

export class ProviderRouteError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'PROVIDER_ROUTE', ...options });
  }
}

export class ProviderTransportError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'PROVIDER_TRANSPORT', retryable: true, ...options });
  }
}

export class ProviderRejectedError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'PROVIDER_REJECTED', ...options });
  }
}

export class ProviderProtocolError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'PROVIDER_PROTOCOL', ...options });
  }
}

export class ProviderCallConflictError extends ProviderError {
  constructor(message = 'Provider callId was reused with a different request', options = {}) {
    super(message, { code: 'PROVIDER_CALL_CONFLICT', ...options });
  }
}

export class ProviderAmbiguousCommitError extends ProviderError {
  constructor(message = 'Provider call completion is ambiguous', options = {}) {
    super(message, { code: 'PROVIDER_AMBIGUOUS_COMMIT', ...options });
  }
}

export class ProviderCanceledError extends ProviderError {
  constructor(message = 'Provider operation was canceled', options = {}) {
    super(message, { code: 'PROVIDER_CANCELED', ...options });
  }
}

export class ProviderAdapter {
  plan() {
    throw new Error('ProviderAdapter.plan() is not implemented');
  }

  repair() {
    throw new Error('ProviderAdapter.repair() is not implemented');
  }
}

export function assertProviderAdapter(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('provider must implement ProviderAdapter');
  }
  for (const method of ['plan', 'repair']) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`provider.${method} must be a function`);
    }
  }
  return provider;
}
