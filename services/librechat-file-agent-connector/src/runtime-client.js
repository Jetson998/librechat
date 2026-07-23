export class RuntimeHttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'RuntimeHttpError';
    this.status = status;
    this.body = body;
  }
}

export class RuntimeClient {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    serviceToken = null,
    scopeSigner = null,
  }) {
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      throw new TypeError('RuntimeClient baseUrl is required');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('RuntimeClient fetchImpl is required');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.serviceToken = serviceToken;
    this.scopeSigner = scopeSigner;
  }

  discoverCapabilities() {
    return this.#request('/v1/capabilities');
  }

  submit({ idempotencyKey, manifest }) {
    return this.#request('/v1/tasks', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: manifest,
    });
  }

  getTask(taskId) {
    return this.#request(`/v1/tasks/${taskId}`).then((value) => value.task);
  }

  getEvents(taskId, after) {
    return this.#request(`/v1/tasks/${taskId}/events?after=${after}`);
  }

  cancel(taskId) {
    return this.#request(`/v1/tasks/${taskId}/cancel`, { method: 'POST', body: {} })
      .then((value) => value.task);
  }

  steer(taskId, instruction) {
    return this.#request(`/v1/tasks/${taskId}/steer`, { method: 'POST', body: instruction })
      .then((value) => value.task);
  }

  async #request(pathname, { method = 'GET', headers = {}, body } = {}) {
    const requestHeaders = new Headers(headers);
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (body !== undefined) {
      requestHeaders.set('content-type', 'application/json');
    }
    if (this.scopeSigner) {
      requestHeaders.set('authorization', `Bearer ${this.scopeSigner.sign({
        method,
        pathname,
        body: serializedBody ?? '',
        headers: requestHeaders,
      })}`);
    } else if (this.serviceToken) {
      requestHeaders.set('authorization', `Bearer ${this.serviceToken}`);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers: requestHeaders,
      body: serializedBody,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {}
    if (!response.ok) {
      throw new RuntimeHttpError(parsed?.error ?? `Runtime request failed with ${response.status}`, {
        status: response.status,
        body: parsed,
      });
    }
    return parsed;
  }
}
